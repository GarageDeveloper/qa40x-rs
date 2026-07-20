//! Calibration characterization: dump the factory cal page and measure the
//! loopback digital gain across several input/output range combinations, to
//! derive the model that converts our uncalibrated digital transfer function
//! into a real voltage gain (a resistive loopback must read ~0 dB).
//!
//! Wiring: OUT L+ -> IN L+, OUT R+ -> IN R+, IN L-/R- terminated.
//! Run with: cargo run --example hw_calibrate

use tauri_app_lib::qa40x::{
    CalibrationData, Channel, InputGain, OutputGain, QA40xDevice, SampleRate,
};

fn mid_band_mean(freqs: &[f32], mags: &[f32]) -> f32 {
    let band: Vec<f32> = freqs
        .iter()
        .zip(mags.iter())
        .filter(|(f, _)| **f >= 300.0 && **f <= 3000.0)
        .map(|(_, m)| *m)
        .collect();
    if band.is_empty() {
        return f32::NAN;
    }
    band.iter().sum::<f32>() / band.len() as f32
}

fn read_record(page: &[u8], off: usize) -> Option<(i16, f32)> {
    if off + 6 <= page.len() {
        let level = i16::from_le_bytes([page[off], page[off + 1]]);
        let db = f32::from_le_bytes([page[off + 2], page[off + 3], page[off + 4], page[off + 5]]);
        Some((level, db))
    } else {
        None
    }
}

#[tokio::main]
async fn main() {
    env_logger::init();

    let device = QA40xDevice::new();
    println!("== Connecting ==");
    device.connect().await.expect("connect failed");
    device.set_sample_rate(SampleRate::Rate48kHz).await.unwrap();

    // ---- Dump the calibration page ----
    println!("\n== Calibration page ==");
    match device.read_calibration_page().await {
        Ok(page) => {
            println!("page length: {} bytes", page.len());
            print!("first 24 bytes:");
            for b in &page[..24.min(page.len())] {
                print!(" {:02X}", b);
            }
            println!();
            println!("ADC records (input full-scale dBV -> level, dB correction):");
            for dbv in [0, 6, 12, 18, 24, 30, 36, 42] {
                if let Some(off) = CalibrationData::adc_offset(dbv) {
                    let l = read_record(&page, off);
                    let r = read_record(&page, off + 6);
                    println!("  in {:>3} dBV @off {:>3}: L={:?}  R={:?}", dbv, off, l, r);
                }
            }
            println!("DAC records (output full-scale dBV -> level, dB correction):");
            for dbv in [-12, -2, 8, 18] {
                if let Some(off) = CalibrationData::dac_offset(dbv) {
                    let l = read_record(&page, off);
                    let r = read_record(&page, off + 6);
                    println!("  out {:>3} dBV @off {:>3}: L={:?}  R={:?}", dbv, off, l, r);
                }
            }
        }
        Err(e) => println!("cal page read failed: {}", e),
    }

    // ---- Loopback digital gain across range combos ----
    // For each combo, a resistive loopback's TRUE voltage gain is 0 dB, so the
    // measured uncalibrated digital mean tells us the offset the calibration
    // must remove. Level fixed at -12 dBFS to stay clear of any clipping.
    println!("\n== Loopback digital gain vs range (level -12 dBFS, L->L) ==");
    println!("  {:>6} {:>7} | {:>10}", "outFS", "inFS", "digital dB");
    let out_ranges = [
        OutputGain::GainMinus12dBV,
        OutputGain::GainMinus2dBV,
        OutputGain::Gain8dBV,
        OutputGain::Gain18dBV,
    ];
    let in_ranges = [
        InputGain::Gain0dBV,
        InputGain::Gain6dBV,
        InputGain::Gain12dBV,
        InputGain::Gain18dBV,
        InputGain::Gain24dBV,
    ];
    for og in out_ranges {
        for ig in in_ranges {
            device.set_output_gain(og).await.unwrap();
            device.set_input_gain(ig).await.unwrap();
            let fr = device
                .measure_frequency_response(
                    300.0,
                    3000.0,
                    Channel::Left,
                    Channel::Left,
                    0.5,
                    -12.0,
                )
                .await;
            match fr {
                Ok(fr) => {
                    let m = mid_band_mean(&fr.frequencies, &fr.magnitudes_db);
                    println!("  {:>6} {:>7} | {:>10.2}", og.as_dbv(), ig.as_dbv(), m);
                }
                Err(e) => println!("  {:>6} {:>7} | ERR {}", og.as_dbv(), ig.as_dbv(), e),
            }
        }
    }

    device.disconnect().await.unwrap();
    println!("\nDone.");
}

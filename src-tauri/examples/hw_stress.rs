//! Single-connection stress test mirroring real app usage: connect once, then
//! loop many acquisitions + frequency responses over the SAME connection.
//!
//! Wiring: OUT L+ -> IN L+, OUT R+ -> IN R+, IN L-/R- terminated.
//! Run with: cargo run --example hw_stress

use tauri_app_lib::qa40x::{Channel, InputGain, OutputGain, QA40xDevice, SampleRate};

fn mid_band_std(freqs: &[f32], mags: &[f32]) -> (f32, f32, usize) {
    let band: Vec<f32> = freqs
        .iter()
        .zip(mags.iter())
        .filter(|(f, _)| **f >= 100.0 && **f <= 10000.0)
        .map(|(_, m)| *m)
        .collect();
    if band.is_empty() {
        return (0.0, 0.0, 0);
    }
    let mean = band.iter().sum::<f32>() / band.len() as f32;
    let var = band.iter().map(|m| (m - mean).powi(2)).sum::<f32>() / band.len() as f32;
    (mean, var.sqrt(), band.len())
}

#[tokio::main]
async fn main() {
    env_logger::init();
    let iterations: usize = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(10);

    let device = QA40xDevice::new();
    println!("== Connecting (once) ==");
    device.connect().await.expect("connect failed");
    device.set_input_gain(InputGain::Gain6dBV).await.unwrap();
    device
        .set_output_gain(OutputGain::GainMinus2dBV)
        .await
        .unwrap();
    device.set_sample_rate(SampleRate::Rate48kHz).await.unwrap();

    // Validate the sample-rate register fix (index vs Hz) at each rate.
    println!("\n== Sample-rate sweep ==");
    for rate in [SampleRate::Rate48kHz, SampleRate::Rate96kHz, SampleRate::Rate192kHz] {
        device.set_sample_rate(rate).await.unwrap();
        let cfg = device.read_config_from_device().await.unwrap();
        let fr = device
            .measure_frequency_response(20.0, 20000.0, Channel::Left, Channel::Left, 1.0, -6.0)
            .await;
        match fr {
            Ok(fr) => {
                let (mean, std, _) = mid_band_std(&fr.frequencies, &fr.magnitudes_db);
                println!(
                    "  set {} Hz -> read {} Hz | FR mid {mean:.2} dB std {std:.3} dB ({} pts)",
                    rate.as_hz(),
                    cfg.sample_rate.as_hz(),
                    fr.frequencies.len()
                );
            }
            Err(e) => println!("  set {} Hz -> read {} Hz | FR FAIL: {e}", rate.as_hz(), cfg.sample_rate.as_hz()),
        }
    }
    device.set_sample_rate(SampleRate::Rate48kHz).await.unwrap();

    let mut acq_ok = 0;
    let mut fr_ok = 0;
    let mut fail = 0;

    for i in 1..=iterations {
        match device.acquire_data(16384).await {
            Ok(a) => {
                let rms = (a.left_channel.iter().map(|x| x * x).sum::<f32>()
                    / a.left_channel.len() as f32)
                    .sqrt();
                acq_ok += 1;
                print!(
                    "iter {i:2}: acq OK ({} smp, {:.0} dBFS) | ",
                    a.left_channel.len(),
                    20.0 * rms.max(1e-12).log10()
                );
            }
            Err(e) => {
                fail += 1;
                println!("iter {i:2}: ACQ FAIL: {e}");
                continue;
            }
        }

        match device
            .measure_frequency_response(20.0, 20000.0, Channel::Left, Channel::Left, 1.0, -6.0)
            .await
        {
            Ok(fr) => {
                let (mean, std, n) = mid_band_std(&fr.frequencies, &fr.magnitudes_db);
                fr_ok += 1;
                println!(
                    "FR OK ({} pts, mid {mean:.2} dB std {std:.3} dB, lat {:.1})",
                    fr.frequencies.len(),
                    fr.latency_samples
                );
                let _ = n;
            }
            Err(e) => {
                fail += 1;
                println!("FR FAIL: {e}");
            }
        }
    }

    println!("\n== Summary: acq_ok={acq_ok} fr_ok={fr_ok} fail={fail} over {iterations} iters ==");
    device.disconnect().await.unwrap();
}

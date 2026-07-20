//! Confirm the per-converter dBV reference frame on hardware (task #51).
//!
//! #51 fixed a bug where an Output (stimulus) trace was displayed with the
//! INPUT's dBFS→dBV offset. The fix gives each trace its own converter's offset:
//! an Input trace uses `input_dbv_offset` (ADC range + ADC cal), an Output trace
//! uses `output_dbv_offset` (DAC range + DAC cal). Two claims to verify against
//! the device, in loopback:
//!
//!   A. An Input trace's ABSOLUTE dBV is range-INVARIANT. Drive a fixed sine,
//!      step the input range, and the captured fundamental's absolute dBV must
//!      not move (the offset compensates the range). If it tracked the range,
//!      the offset was not being applied — the bug.
//!
//!   B. The loopback identity: through a resistive loopback the Input trace and
//!      the Output (stimulus) trace of the same signal must sit at the SAME
//!      absolute dBV, within factory-trim tolerance (~0.3 dB). This is the two
//!      references agreeing — the heart of #51.
//!
//! Loopback required (OUT L -> IN L). Close the desktop app first.
//! Run with: cargo run --example hw_level_reference_frame [--release]

use tauri_app_lib::qa40x::types::{Channel, InputGain, OutputGain, SampleRate};
use tauri_app_lib::qa40x::QA40xDevice;
use tauri_app_lib::utils::SignalGenerator;

const SR: u32 = 48_000;
const N: usize = 16_384;
const OUT_RANGE_DBV: i32 = 8;
const LEVEL_DBV: f32 = -12.0;

/// Digital peak that produces `level` dBV RMS for a sine out of output range `r`
/// (the sine-RMS full-scale convention: FS peak = 10^(r/20)·√2, verified in #48).
fn app_amplitude(level_dbv: f32, r: i32) -> f32 {
    10f32.powf((level_dbv - r as f32).clamp(-120.0, 0.0) / 20.0)
}

fn rms_dbfs(x: &[f32]) -> f32 {
    let sum: f64 = x.iter().map(|&v| (v as f64) * (v as f64)).sum();
    20.0 * ((sum / x.len() as f64).sqrt().max(1e-12)).log10() as f32
}

fn snap(freq: f32) -> f32 {
    let bin = ((freq * N as f32) / SR as f32).round().max(1.0);
    bin * SR as f32 / N as f32
}

#[tokio::main]
async fn main() {
    env_logger::init();
    let device = QA40xDevice::new();
    println!("== Per-converter dBV reference-frame probe (task #51) ==");
    if let Err(e) = device.connect().await {
        eprintln!("connect failed: {e}");
        eprintln!("If the desktop app is open it holds the single connection — close it and retry.");
        std::process::exit(1);
    }

    device.set_sample_rate(SampleRate::try_from(SR).unwrap()).await.expect("rate");
    device
        .set_output_gain(OutputGain::from_dbv(OUT_RANGE_DBV).unwrap())
        .await
        .expect("out range");

    let freq = snap(1000.0);
    let amp = app_amplitude(LEVEL_DBV, OUT_RANGE_DBV);
    let tone = SignalGenerator::sine(freq, amp, SR, N);
    let silence = vec![0.0f32; N];

    let (out_off, out_cal) = device.output_dbv_offset(Channel::Left).await;
    // The Output trace displays the stimulus RMS in dBFS + the output offset.
    // Measure the stimulus RMS from the buffer itself (do NOT model it as
    // peak−range — that reintroduces the 3.01 dB crest-factor error the sine-RMS
    // convention exists to avoid).
    let stim_dbfs = rms_dbfs(&tone);
    let out_abs = stim_dbfs + out_off;
    println!(
        "output range {OUT_RANGE_DBV:+} dBV | tone {freq:.1} Hz @ {LEVEL_DBV:+} dBV\n\
         output offset {out_off:+.3} dB (cal {out_cal}) -> Output trace shows {out_abs:+.2} dBV\n"
    );

    println!("{:>10} | {:>10} | {:>12} | {:>10}", "in range", "cap dBFS", "in offset", "In abs dBV");
    println!("{}", "-".repeat(52));

    // Input ranges with headroom for a −12 dBV signal, spanning the attenuator
    // boundary (18→24) so the ADC-cal path is exercised on both sides.
    let mut in_abs = Vec::new();
    for in_range in [6, 18, 24, 42] {
        device.set_input_gain(InputGain::from_dbv(in_range).unwrap()).await.expect("in range");
        // The relays need no settle (measured, #46), but the capture path's own
        // start-up covers it anyway; one throwaway capture to be safe.
        let _ = device.generate_and_capture(&tone, &silence).await;
        let cap = device.generate_and_capture(&tone, &silence).await.expect("capture");
        let cap_dbfs = rms_dbfs(&cap.left_channel);
        let (in_off, _cal) = device.input_dbv_offset(Channel::Left).await;
        let abs = cap_dbfs + in_off;
        in_abs.push(abs);
        println!("{in_range:>+9} | {cap_dbfs:>+9.2} | {in_off:>+11.3} | {abs:>+9.2}");
    }

    // --- Verdicts.
    let max = in_abs.iter().cloned().fold(f32::MIN, f32::max);
    let min = in_abs.iter().cloned().fold(f32::MAX, f32::min);
    let spread = max - min;
    let mean_in = in_abs.iter().sum::<f32>() / in_abs.len() as f32;

    println!("\n== Verdict ==");
    println!("A. Input absolute dBV across ranges: spread {spread:.3} dB");
    if spread < 0.5 {
        println!("   -> RANGE-INVARIANT. The ADC offset compensates the input range (#51 holds).");
    } else {
        println!("   -> DRIFTS with range ({spread:.2} dB) — the per-range ADC offset is NOT applied.");
    }
    let loopback = mean_in - out_abs;
    println!("B. In abs {mean_in:+.2} dBV vs Output abs {out_abs:+.2} dBV -> loopback delta {loopback:+.2} dB");
    if loopback.abs() < 0.6 {
        println!("   -> The two converter references AGREE within trim (#51's core is correct).");
    } else {
        println!("   -> {loopback:+.2} dB gap — the references disagree; investigate before trusting levels.");
    }

    device.set_input_gain(InputGain::from_dbv(42).unwrap()).await.ok();
    device.disconnect().await.ok();
}

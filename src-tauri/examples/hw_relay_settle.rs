//! Measure how long the output-range relay actually needs to settle (task #46).
//!
//! The range registers drive mechanical relays. We assume a capture taken too
//! soon after a range change is wrong — but "too soon" was a working value, not
//! a measurement. This probes it.
//!
//! Method: hold the analog output CONSTANT across a range change (re-scale the
//! digital amplitude so `level` is the same in both ranges), then capture at an
//! increasing delay after the switch and compare against a fully-settled
//! reference. A relay still in flight shows up as an RMS error and/or excess
//! THD+N. The delay at which both collapse to the reference IS the settle time.
//!
//! Run from the checkout WITHOUT the settle deadlines (i.e. `main`), otherwise
//! the driver inserts its own wait and this measures nothing.
//!
//! Loopback required (OUT L -> IN L). Close the desktop app first.
//!
//! Run with: cargo run --example hw_relay_settle [--release]

use std::time::Duration;

use tauri_app_lib::audio::AudioAnalyzer;
use tauri_app_lib::qa40x::types::{Channel, InputGain, OutputGain, SampleRate};
use tauri_app_lib::qa40x::QA40xDevice;
use tauri_app_lib::utils::SignalGenerator;

const SR: u32 = 48_000;
/// Short block: the capture window itself blurs the measurement, so keep it well
/// under the settle times we expect. 4096 @ 48k = 85 ms.
const N: usize = 4_096;
const LEVEL_DBV: f32 = -12.0;
const IN_RANGE_DBV: i32 = 6;
const RANGE_A: i32 = 8;
const RANGE_B: i32 = 18;
/// Long enough that the relay is certainly done — the baseline for "settled".
const FULLY_SETTLED: Duration = Duration::from_millis(2500);

/// Digital peak amplitude giving `level` dBV out of output range `r` — so the
/// ANALOG output is identical in both ranges and any difference is the relay.
fn amp_for(level_dbv: f32, r: i32) -> f32 {
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
    println!("== Output-relay settle probe (task #46) ==");
    if let Err(e) = device.connect().await {
        eprintln!("connect failed: {e}");
        eprintln!("If the desktop app is open it holds the single connection — close it and retry.");
        std::process::exit(1);
    }

    device.set_sample_rate(SampleRate::try_from(SR).unwrap()).await.expect("rate");
    device
        .set_input_gain(InputGain::from_dbv(IN_RANGE_DBV).expect("in range"))
        .await
        .expect("set input");
    tokio::time::sleep(FULLY_SETTLED).await;

    let (dbv_off, calibrated) = device.input_dbv_offset(Channel::Left).await;
    let freq = snap(996.0);
    let silence = vec![0.0f32; N];
    println!(
        "level {LEVEL_DBV:+} dBV | input {IN_RANGE_DBV:+} dBV (never moves) | tone {freq:.1} Hz | \
         block {N} ({:.0} ms) | cal {calibrated}",
        N as f32 * 1000.0 / SR as f32
    );
    println!("switching output range {RANGE_A:+} <-> {RANGE_B:+} dBV, analog output held constant\n");

    async fn measure(
        device: &QA40xDevice,
        freq: f32,
        amp: f32,
        silence: &[f32],
        dbv_off: f32,
    ) -> (f32, f32) {
        let wave = SignalGenerator::sine(freq, amp, SR, N);
        let cap = device.generate_and_capture(&wave, silence).await.expect("capture");
        let rms = rms_dbfs(&cap.left_channel) + dbv_off;
        let (_, thdn, _) = AudioAnalyzer::thd_suite(&cap.left_channel, SR, freq, 7);
        (rms, 20.0 * thdn.max(1e-12).log10())
    }

    // Baseline: range B, fully settled.
    device.set_output_gain(OutputGain::from_dbv(RANGE_B).unwrap()).await.expect("out B");
    tokio::time::sleep(FULLY_SETTLED).await;
    let (ref_rms, ref_thdn) = measure(&device, freq, amp_for(LEVEL_DBV, RANGE_B), &silence, dbv_off).await;
    println!("settled reference @ {RANGE_B:+} dBV: RMS {ref_rms:+.3} dBV | THD+N {ref_thdn:.1} dB\n");

    println!("{:>7} | {:>10} | {:>9} | {:>10} | {:>9}", "delay", "RMS", "dRMS", "THD+N", "dTHD+N");
    println!("{}", "-".repeat(56));

    for delay_ms in [0u64, 25, 50, 100, 200, 350, 500, 750] {
        // Park on A, fully settled, so every trial starts from the same place.
        device.set_output_gain(OutputGain::from_dbv(RANGE_A).unwrap()).await.expect("out A");
        tokio::time::sleep(FULLY_SETTLED).await;

        // The switch under test, then capture after exactly `delay_ms`.
        device.set_output_gain(OutputGain::from_dbv(RANGE_B).unwrap()).await.expect("out B");
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        let (rms, thdn) = measure(&device, freq, amp_for(LEVEL_DBV, RANGE_B), &silence, dbv_off).await;

        let flag = if (rms - ref_rms).abs() > 0.1 || (thdn - ref_thdn) > 3.0 { "  <-- not settled" } else { "" };
        println!(
            "{delay_ms:>5} ms | {rms:>+9.3} | {:>+8.3} | {thdn:>9.1} | {:>+8.1}{flag}",
            rms - ref_rms,
            thdn - ref_thdn
        );
    }

    println!(
        "\nRead: the smallest delay whose dRMS and dTHD+N are both ~0 is the real settle time.\n\
         Note the capture block itself is {:.0} ms wide, so it integrates over that window —\n\
         this measures an UPPER bound on when the relay is quiet, not the instant it lands.",
        N as f32 * 1000.0 / SR as f32
    );

    device.set_output_gain(OutputGain::from_dbv(RANGE_A).unwrap()).await.ok();
    device.disconnect().await.ok();
}

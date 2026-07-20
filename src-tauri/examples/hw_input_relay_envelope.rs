//! Same envelope method as `hw_relay_envelope`, but for the INPUT relay (reg 5)
//! — including the group crossing where the analogue attenuator engages, which
//! is the transition we assumed was the expensive one (task #46).
//!
//! Method: hold a steady tone, switch the input range, start ONE long capture
//! immediately, and walk the RMS envelope through it in short windows, each
//! compared to the block's own settled tail. A CONTROL pass with no range change
//! establishes the capture's own start-up artifact, so we do not mistake it for
//! the relay — without that control, the artifact reads as a settle time.
//!
//! The attenuator is engaged by the hardware at input ranges >= 24 dBV. We do
//! not control it and there is no attenuator register; it is simply what
//! crossing the 18/24 boundary does.
//!
//! Run from the checkout WITHOUT the settle deadlines (i.e. `main`).
//! Loopback required (OUT L -> IN L). Close the desktop app first.
//!
//! Run with: cargo run --example hw_input_relay_envelope [--release]

use std::time::{Duration, Instant};

use tauri_app_lib::qa40x::types::{InputGain, OutputGain, SampleRate};
use tauri_app_lib::qa40x::QA40xDevice;
use tauri_app_lib::utils::SignalGenerator;

const SR: u32 = 48_000;
const N: usize = 32_768; // 683 ms
const WIN: usize = 512; // 10.7 ms
const OUT_RANGE_DBV: i32 = 8;
const LEVEL_DBV: f32 = -12.0;
const FULLY_SETTLED: Duration = Duration::from_millis(2500);

fn rms(x: &[f32]) -> f64 {
    let sum: f64 = x.iter().map(|&v| (v as f64) * (v as f64)).sum();
    (sum / x.len() as f64).sqrt()
}

fn snap(freq: f32) -> f32 {
    let bin = ((freq * N as f32) / SR as f32).round().max(1.0);
    bin * SR as f32 / N as f32
}

fn envelope(sig: &[f32]) -> Vec<(f32, f64)> {
    let tail = rms(&sig[sig.len() * 3 / 4..]).max(1e-12);
    sig.chunks_exact(WIN)
        .enumerate()
        .map(|(i, w)| {
            let t_ms = (i * WIN) as f32 * 1000.0 / SR as f32;
            (t_ms, 20.0 * (rms(w).max(1e-12) / tail).log10())
        })
        .collect()
}

fn show(label: &str, env: &[(f32, f64)], control_w0: Option<f64>) {
    print!("  first 8 windows (dB vs settled tail): ");
    for (_, d) in env.iter().take(8) {
        print!("{d:+.3} ");
    }
    println!();
    // Window 0 always carries the capture's start-up artifact, so judge the
    // relay on windows 1.. — and on how far window 0 strays from the control's.
    let worst_after_w0 = env
        .iter()
        .skip(1)
        .max_by(|a, b| a.1.abs().partial_cmp(&b.1.abs()).unwrap())
        .copied()
        .unwrap_or((0.0, 0.0));
    println!(
        "  worst deviation after window 0: {:+.3} dB at t = {:.1} ms",
        worst_after_w0.1, worst_after_w0.0
    );
    if let Some(c0) = control_w0 {
        let excess = env[0].1 - c0;
        println!("  window 0 vs control's window 0: {excess:+.3} dB (relay's own contribution)");
        // The ripple floor of a 512-sample window on this tone is ~0.05 dB.
        if worst_after_w0.1.abs() < 0.08 && excess.abs() < 0.08 {
            println!("  -> {label}: NO relay transient above the measurement floor.");
        } else {
            println!("  -> {label}: a transient IS present — see the shape above.");
        }
    }
}

#[tokio::main]
async fn main() {
    env_logger::init();
    let device = QA40xDevice::new();
    println!("== Input-relay envelope probe, incl. the attenuator group crossing (task #46) ==");
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

    let freq = snap(996.0);
    let amp = 10f32.powf((LEVEL_DBV - OUT_RANGE_DBV as f32) / 20.0);
    let wave = SignalGenerator::sine(freq, amp, SR, N);
    let silence = vec![0.0f32; N];
    println!(
        "tone {freq:.1} Hz @ {LEVEL_DBV:+} dBV (constant) | block {N} ({:.0} ms) | window {WIN} ({:.1} ms)",
        N as f32 * 1000.0 / SR as f32,
        WIN as f32 * 1000.0 / SR as f32
    );
    println!("attenuator engages at input range >= 24 dBV (hardware's doing, no register)\n");

    // CONTROLS: no input-range change at all. These establish the capture's own
    // start-up artifact — and they must be taken AT the destination range,
    // because a capture's window-0 scatter depends on that range's SNR, not on
    // any relay. Comparing a "landed at 42 dBV" case against a control taken at
    // 12 dBV would attribute the 42 dBV noise floor to the relay.
    let mut controls = std::collections::BTreeMap::new();
    for park in [0, 12, 42] {
        device.set_input_gain(InputGain::from_dbv(park).unwrap()).await.expect("park");
        tokio::time::sleep(FULLY_SETTLED).await;
        let cap = device.generate_and_capture(&wave, &silence).await.expect("control");
        let env = envelope(&cap.left_channel);
        println!("--- CONTROL @ {park:+} dBV: no range change, relay untouched");
        show("control", &env, None);
        controls.insert(park, env[0].1);
        println!();
    }
    let c0 = controls[&12];
    let _ = c0;

    let cases = [
        (12, 18, "12 -> 18 dBV (same group, no attenuator)"),
        (18, 24, "18 -> 24 dBV (GROUP CROSSING, attenuator engages)"),
        (24, 18, "24 -> 18 dBV (GROUP CROSSING, attenuator releases)"),
        (24, 42, "24 -> 42 dBV (same group, attenuator stays in)"),
        // The violent one: attenuated all the way down to the MOST SENSITIVE
        // range in one write. Biggest swing of the whole front-end, and the
        // transition an intermediate-step design would exist to protect.
        (42, 0, "42 -> 0 dBV (GROUP CROSSING, atten -> most sensitive, worst case)"),
        (0, 42, "0 -> 42 dBV (GROUP CROSSING, most sensitive -> atten)"),
    ];
    for (from, to, label) in cases {
        device.set_input_gain(InputGain::from_dbv(from).unwrap()).await.expect("park");
        tokio::time::sleep(FULLY_SETTLED).await;

        let t0 = Instant::now();
        device.set_input_gain(InputGain::from_dbv(to).unwrap()).await.expect("switch");
        let write_us = t0.elapsed().as_micros();
        let cap = device.generate_and_capture(&wave, &silence).await.expect("capture");
        println!("--- {label} (register write {write_us} us)");
        // Nearest control at or below the destination range: like-for-like SNR.
        let ctl = controls
            .range(..=to)
            .next_back()
            .or_else(|| controls.iter().next())
            .map(|(k, v)| (*k, *v))
            .expect("a control exists");
        println!("  (compared against the CONTROL taken at {:+} dBV)", ctl.0);
        show(label, &envelope(&cap.left_channel), Some(ctl.1));
        println!();
    }

    println!(
        "Caveat: this cannot see a transient that ends BEFORE the stream's first\n\
         sample. It bounds the settle at < (switch -> first sample), it does not\n\
         prove the relay is instant."
    );

    device.set_input_gain(InputGain::from_dbv(42).unwrap()).await.ok();
    device.disconnect().await.ok();
}

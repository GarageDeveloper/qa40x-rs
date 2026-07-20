//! Look INSIDE one capture taken immediately after a range change (task #46).
//!
//! `hw_relay_settle` compares whole captures at increasing delays, but "0 ms
//! delay" is not 0 ms of analog time: the USB register write, the stream start
//! and any pre-buffer sit between the relay and the first captured sample, and
//! that unknown latency can hide the settle entirely.
//!
//! This removes the confound: switch the range, start ONE long capture at once,
//! then walk the RMS envelope through it in short windows. A relay still moving
//! shows up as early windows differing from the late ones. If the envelope is
//! flat from the very first window, then by the time the stream delivers its
//! first sample the relay is ALREADY quiet — and a settle deadline buys nothing.
//!
//! The analog output is held constant across the switch (the digital amplitude
//! is re-scaled per range), so a flat envelope means "no transient", not "no
//! change".
//!
//! Run from the checkout WITHOUT the settle deadlines (i.e. `main`).
//! Loopback required (OUT L -> IN L). Close the desktop app first.
//!
//! Run with: cargo run --example hw_relay_envelope [--release]

use std::time::{Duration, Instant};

use tauri_app_lib::qa40x::types::{InputGain, OutputGain, SampleRate};
use tauri_app_lib::qa40x::QA40xDevice;
use tauri_app_lib::utils::SignalGenerator;

const SR: u32 = 48_000;
/// Long enough to contain any plausible settle: 32768 @ 48k = 683 ms.
const N: usize = 32_768;
/// Envelope resolution: 512 @ 48k = 10.7 ms per window.
const WIN: usize = 512;
const LEVEL_DBV: f32 = -12.0;
const IN_RANGE_DBV: i32 = 6;
const FULLY_SETTLED: Duration = Duration::from_millis(2500);

fn amp_for(level_dbv: f32, r: i32) -> f32 {
    10f32.powf((level_dbv - r as f32).clamp(-120.0, 0.0) / 20.0)
}

fn rms(x: &[f32]) -> f64 {
    let sum: f64 = x.iter().map(|&v| (v as f64) * (v as f64)).sum();
    (sum / x.len() as f64).sqrt()
}

fn snap(freq: f32) -> f32 {
    let bin = ((freq * N as f32) / SR as f32).round().max(1.0);
    bin * SR as f32 / N as f32
}

/// Walk the RMS envelope and report it relative to the block's LAST quarter
/// (certainly settled), in dB.
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

#[tokio::main]
async fn main() {
    env_logger::init();
    let device = QA40xDevice::new();
    println!("== Relay envelope probe (task #46) ==");
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

    let freq = snap(996.0);
    let silence = vec![0.0f32; N];
    println!(
        "tone {freq:.1} Hz | block {N} ({:.0} ms) | window {WIN} ({:.1} ms) | \
         level {LEVEL_DBV:+} dBV held constant across the switch\n",
        N as f32 * 1000.0 / SR as f32,
        WIN as f32 * 1000.0 / SR as f32
    );

    // CONTROL FIRST. Any transient in the first window of a capture that had NO
    // range change is a capture artifact (stream start-up), not the relay — and
    // without this we would read that artifact as a settle time.
    device.set_output_gain(OutputGain::from_dbv(8).unwrap()).await.expect("park");
    tokio::time::sleep(FULLY_SETTLED).await;
    {
        let wave = SignalGenerator::sine(freq, amp_for(LEVEL_DBV, 8), SR, N);
        let cap = device.generate_and_capture(&wave, &silence).await.expect("control capture");
        let env = envelope(&cap.left_channel);
        println!("--- CONTROL: no range change at all, relay untouched");
        print!("  first 8 windows (dB vs settled tail): ");
        for (_, d) in env.iter().take(8) {
            print!("{d:+.3} ");
        }
        println!("\n");
    }

    for (from, to, label) in [(8, 18, "+8 -> +18 dBV"), (18, 8, "+18 -> +8 dBV")] {
        // Park on `from`, fully settled.
        device.set_output_gain(OutputGain::from_dbv(from).unwrap()).await.expect("park");
        tokio::time::sleep(FULLY_SETTLED).await;

        // Switch, then capture IMMEDIATELY — no delay at all.
        let t0 = Instant::now();
        device.set_output_gain(OutputGain::from_dbv(to).unwrap()).await.expect("switch");
        let write_us = t0.elapsed().as_micros();
        let wave = SignalGenerator::sine(freq, amp_for(LEVEL_DBV, to), SR, N);
        let cap = device.generate_and_capture(&wave, &silence).await.expect("capture");
        let total_ms = t0.elapsed().as_millis();

        println!("--- {label} (register write took {write_us} us; switch->capture-done {total_ms} ms)");
        let env = envelope(&cap.left_channel);
        // Print the first 8 windows (the first ~85 ms) plus the extremes.
        print!("  first 8 windows (dB vs settled tail): ");
        for (_, d) in env.iter().take(8) {
            print!("{d:+.3} ");
        }
        println!();
        let worst = env
            .iter()
            .max_by(|a, b| a.1.abs().partial_cmp(&b.1.abs()).unwrap())
            .copied()
            .unwrap_or((0.0, 0.0));
        println!("  worst deviation anywhere: {:+.3} dB at t = {:.1} ms", worst.1, worst.0);
        if worst.1.abs() < 0.05 {
            println!("  -> FLAT: no transient anywhere in the block. The relay was already quiet");
            println!("     by the first delivered sample; a settle deadline changes nothing here.");
        } else {
            println!("  -> a transient IS present — read the first-window values above for its shape.");
        }
        println!();
    }

    println!(
        "Caveat: this cannot see a transient that ends BEFORE the stream's first\n\
         sample. It bounds the settle at < (switch -> first sample), it does not\n\
         prove the relay is instant."
    );

    device.set_output_gain(OutputGain::from_dbv(8).unwrap()).await.ok();
    device.disconnect().await.ok();
}

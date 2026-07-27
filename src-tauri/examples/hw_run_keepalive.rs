//! Contention test — keepalive / register I/O interleaved with the capture loop.
//!
//! HISTORY: this test originally failed ~2 ok/28 err ("transfer was cancelled"
//! on every capture after the first failure), which was misread as "any register
//! op between frames wedges the stream". ROOT CAUSE (fixed 2026-07-12): on a
//! pump failure the error path cancelled the transfer queues but drained at most
//! ONE completion — nusb keeps completed-but-uncollected transfers queued per
//! endpoint, so the ~29 stale cancelled completions were handed to every
//! subsequent stream's next_complete(), failing them all. With cancel_and_drain
//! (device.rs) fully emptying both data endpoints on failure, serialized
//! register I/O between frames is safe: this test passes 30/30.
//!
//! What this validates today:
//!  1. a bare 0x00 link-write AND a full keepalive (link write + telemetry
//!     reads) between generate_and_capture frames — the pattern of the
//!     between-frame LINK-LED keepalive — leave every capture intact;
//!  2. (issue #54) the IN-CAPTURE keepalive: on long captures (~10 s at
//!     48 kHz, then ~5 s at the unit's top rate for maximum bus load) the
//!     pump fires the same cycle at ~1 Hz between data completions, i.e.
//!     overlapping the armed stream like the official app does. The test
//!     asserts on COMPLETED keepalive cycles (not attempts), and gates the
//!     captured audio spectrally: the residual after least-squares removal
//!     of the played tone must stay at the loopback noise floor — a single
//!     dropped or repeated ADC block breaks the tone's phase and blows the
//!     residual by tens of dB, which a sample-count or harmonics-only check
//!     would miss. Watch the unit: the LINK LED must stay lit for the whole
//!     long capture.
//!
//! Run with: cargo run --example hw_run_keepalive
//! REQUIRES a wired loopback (OUT L+ -> IN L+, OUT R+ -> IN R+): the
//! spectral gate of phase 2 measures the loopback tone.

use std::sync::Arc;
use tauri_app_lib::qa40x::register::{registers, RegisterOps};
use tauri_app_lib::qa40x::{InputGain, OutputGain, QA40xDevice, SampleRate};

#[tokio::main]
async fn main() {
    env_logger::init();
    let device = Arc::new(QA40xDevice::new());
    println!("== Connecting ==");
    device.connect().await.expect("connect failed");

    // A 1 kHz sine stimulus (normalized), 8192 samples.
    let n = 8192usize;
    let sr = 48000.0f32;
    let mut wave = vec![0.0f32; n];
    for (i, s) in wave.iter_mut().enumerate() {
        *s = 0.25 * (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / sr).sin();
    }

    // SERIALIZED interleave: keepalive between frames, in the same task (awaited),
    // never overlapping a capture — the way the live loop injects it.
    println!("== 30 captures, keepalive interleaved between frames (serialized) ==");
    let mut cap_ok = 0u32;
    let mut cap_err = 0u32;
    let mut ka_ok = 0u32;
    let mut ka_err = 0u32;
    for i in 0..30 {
        match device.generate_and_capture(&wave, &wave).await {
            Ok(a) => {
                cap_ok += 1;
                if i % 10 == 0 {
                    let rms = (a.left_channel.iter().map(|x| x * x).sum::<f32>()
                        / a.left_channel.len().max(1) as f32)
                        .sqrt();
                    println!("  capture {i}: OK ({} samp, L rms {rms:.4})", a.left_channel.len());
                }
            }
            Err(e) => {
                cap_err += 1;
                println!("  capture {i}: ERROR {e}");
            }
        }
        // Alternate the two register-op shapes between captures:
        //  - every 3rd frame: a BARE link write (0x00), the minimal LED ping;
        //  - every 3rd frame, offset by 1: a FULL keepalive (0x00 write + echo
        //    read + 5 telemetry reads) — what the app's in-run keepalive does.
        if i % 3 == 0 {
            match device
                .write_register(registers::LINK_KEEPALIVE, &0x1234_5678u32.to_be_bytes())
                .await
            {
                Ok(_) => ka_ok += 1,
                Err(e) => {
                    ka_err += 1;
                    println!("  link-write @ {i}: ERROR {e}");
                }
            }
        } else if i % 3 == 1 {
            match device.keepalive().await {
                Ok(_) => ka_ok += 1,
                Err(e) => {
                    ka_err += 1;
                    println!("  full keepalive @ {i}: ERROR {e}");
                }
            }
        }
    }

    // MID-STREAM variant (issue #54): LONG captures during which the pump
    // itself fires the keepalive at ~1 Hz between data completions —
    // overlapping the armed stream, exactly like the official app. Asserted
    // on COMPLETED cycles (keepalive_ok_count), because the rate-limit stamp
    // is taken before each attempt and would count failures as successes.
    // Known ranges so the spectral gate has a meaningful floor (hw_loopback's
    // configuration: THD ≈ −100 dB on a wired loopback).
    device
        .set_input_gain(InputGain::Gain6dBV)
        .await
        .expect("set input gain");
    device
        .set_output_gain(OutputGain::GainMinus2dBV)
        .await
        .expect("set output gain");

    let max_rate = *device
        .device_meta()
        .await
        .expect("device meta")
        .sample_rates
        .last()
        .expect("sample rates");
    let mut midstream_pass = true;
    // Per-rate residual gates: the residual integrates noise over the FULL
    // Nyquist band, and at high rates that includes the delta-sigma ADC's
    // shaped ultrasonic noise (measured clean floors: ≈ −86 dB @ 48 kHz,
    // ≈ −79 dB @ 192 kHz on a wired QA402 loopback). Block-level corruption
    // lands around −20 dB (a phase step re-tunes half the capture), so both
    // gates keep > 40 dB of detection margin.
    for (rate, hz, secs, gate_db) in [
        (SampleRate::Rate48kHz, 48_000u32, 10u32, -80.0f32),
        (
            SampleRate::from_hz(max_rate).expect("max rate variant"),
            max_rate,
            5,
            -70.0,
        ),
    ] {
        println!("\n== Long capture ({secs} s @ {hz} Hz), in-capture keepalive at ~1 Hz (issue #54) ==");
        device.set_sample_rate(rate).await.expect("set sample rate");
        let long_n = (hz * secs) as usize;
        // 1 kHz divides both rates exactly (48/192-sample period), so wrap
        // the phase per period: sin() over a monotonically growing f32
        // argument (up to ~63 000 rad here) loses enough precision to smear
        // ~-55 dB of phase noise over the buffer, which the residual gate
        // below would blame on the capture.
        let period = (hz / 1000) as usize;
        let mut long_wave = vec![0.0f32; long_n];
        for (i, s) in long_wave.iter_mut().enumerate() {
            let ph = (i % period) as f32 / period as f32;
            *s = 0.5 * (2.0 * std::f32::consts::PI * ph).sin();
        }

        let ok_before = device.keepalive_ok_count();
        let t0 = std::time::Instant::now();
        let long_res = device.generate_and_capture(&long_wave, &long_wave).await;
        let elapsed = t0.elapsed();
        // Completed cycles during the capture window: the in-pump ones, plus
        // at most one pre-stream ping. Without the in-capture keepalive this
        // delta cannot exceed 1; with it, ~1 per second.
        let ok_during = device.keepalive_ok_count() - ok_before;
        let expect_min = (secs as u64 / 2).max(3);

        let (long_ok, long_desc) = match &long_res {
            Ok(a) => {
                // Spectral gate: least-squares fit of the played 1 kHz tone
                // (integer cycles once 0.1 s is trimmed from both edges), then
                // the residual (noise + harmonics + any glitch) relative to
                // the tone. A dropped or repeated ADC block shifts the tone's
                // phase mid-capture and blows this by tens of dB; the clean
                // loopback floor sits near −95 dB.
                let res_db = tone_residual_db(&a.left_channel, 1000.0, hz as f32);
                let ok = a.left_channel.len() == long_n && res_db < gate_db;
                (
                    ok,
                    format!(
                        "OK ({} samp, tone residual {res_db:.1} dB, gate < {gate_db:.0})",
                        a.left_channel.len()
                    ),
                )
            }
            Err(e) => (false, format!("ERROR {e}")),
        };
        // The register path must come out of the capture healthy: one full
        // keepalive (0x00 write + telemetry reads) right after.
        let post_ka_ok = device.keepalive().await.is_ok();
        println!("  capture  : {long_desc} in {:.1} s", elapsed.as_secs_f32());
        println!("  completed keepalives in-capture: {ok_during} (expected ≥ {expect_min})");
        println!("  post-capture keepalive: {}", if post_ka_ok { "OK" } else { "ERROR" });
        midstream_pass &= long_ok && post_ka_ok && ok_during >= expect_min;
    }
    device
        .set_sample_rate(SampleRate::Rate48kHz)
        .await
        .expect("restore sample rate");

    println!("\n== Result ==");
    println!("  captures : {cap_ok} ok, {cap_err} err");
    println!("  keepalive: {ka_ok} ok, {ka_err} err");
    println!(
        "  serialized interleave: {}",
        if cap_err == 0 && ka_err == 0 {
            "PASS"
        } else {
            "FAIL — contention caused errors"
        }
    );
    println!(
        "  in-capture keepalive : {}",
        if midstream_pass {
            "PASS — LINK keepalive completes mid-stream, capture spectrally clean"
        } else {
            "FAIL"
        }
    );
    if cap_err != 0 || ka_err != 0 || !midstream_pass {
        std::process::exit(1);
    }
}

/// Residual after least-squares removal of the played tone (plus DC), in dB
/// relative to the tone itself. 0.1 s trimmed from both edges keeps the fit
/// clear of the capture's start/stop transients and leaves an integer number
/// of 1 kHz cycles, so the sin/cos basis stays orthogonal.
fn tone_residual_db(sig: &[f32], freq: f32, sr: f32) -> f32 {
    let trim = (sr / 10.0) as usize;
    if sig.len() <= 2 * trim {
        return 0.0;
    }
    let s = &sig[trim..sig.len() - trim];
    let n = s.len() as f64;
    let w = 2.0 * std::f64::consts::PI * freq as f64 / sr as f64;
    let (mut sa, mut sb, mut mean) = (0.0f64, 0.0f64, 0.0f64);
    for (i, x) in s.iter().enumerate() {
        let (sin, cos) = (w * i as f64).sin_cos();
        sa += *x as f64 * sin;
        sb += *x as f64 * cos;
        mean += *x as f64;
    }
    let (a, b, dc) = (2.0 * sa / n, 2.0 * sb / n, mean / n);
    let mut res_pow = 0.0f64;
    for (i, x) in s.iter().enumerate() {
        let (sin, cos) = (w * i as f64).sin_cos();
        let r = *x as f64 - a * sin - b * cos - dc;
        res_pow += r * r;
    }
    let tone_rms = ((a * a + b * b) / 2.0).sqrt();
    let res_rms = (res_pow / n).sqrt();
    (20.0 * (res_rms / tone_rms.max(1e-12)).log10()) as f32
}

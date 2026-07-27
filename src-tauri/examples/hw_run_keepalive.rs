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
//!  2. (issue #54) the IN-CAPTURE keepalive: on one long capture (~10 s) the
//!     pump fires the same cycle at ~1 Hz between data completions, i.e.
//!     overlapping the armed stream like the official app does. The test
//!     counts the keepalive stamps landing inside the capture window and
//!     checks the capture comes back intact. Watch the unit: the LINK LED
//!     must stay lit for the whole long capture.
//!
//! Run with: cargo run --example hw_run_keepalive
//! (Needs a QA40x connected; a wired loopback makes the RMS check meaningful.)

use std::sync::Arc;
use std::time::Duration;
use tauri_app_lib::qa40x::register::{registers, RegisterOps};
use tauri_app_lib::qa40x::QA40xDevice;

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

    // MID-STREAM variant (issue #54): one LONG capture during which the pump
    // itself fires the keepalive at ~1 Hz between data completions —
    // overlapping the armed stream, exactly like the official app. A watcher
    // polls the keepalive stamp (a cache read, no device I/O) and counts the
    // ones landing inside the capture window; the LINK LED should visibly
    // stay lit the whole time.
    println!("\n== Long capture (~10 s), in-capture keepalive at ~1 Hz (issue #54) ==");
    let long_n = 480_000usize; // 10 s @ 48 kHz
    let mut long_wave = vec![0.0f32; long_n];
    for (i, s) in long_wave.iter_mut().enumerate() {
        *s = 0.25 * (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / sr).sin();
    }

    let watcher_dev = device.clone();
    let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<()>();
    let watcher = tokio::spawn(async move {
        let mut stamps: Vec<std::time::Instant> = Vec::new();
        loop {
            if let Some(t) = watcher_dev.last_keepalive_at().await {
                if stamps.last() != Some(&t) {
                    stamps.push(t);
                }
            }
            tokio::select! {
                _ = &mut stop_rx => break,
                _ = tokio::time::sleep(Duration::from_millis(100)) => {}
            }
        }
        stamps
    });

    let t0 = std::time::Instant::now();
    let long_res = device.generate_and_capture(&long_wave, &long_wave).await;
    let elapsed = t0.elapsed();
    let _ = stop_tx.send(());
    let stamps = watcher.await.unwrap_or_default();
    // Stamps strictly inside the capture window. The pre-stream ping (before
    // STREAM_CTRL=5) is one of them; the in-pump ones are the rest — without
    // the in-capture keepalive this count is exactly 1.
    let in_window = stamps
        .iter()
        .filter(|s| **s >= t0 && **s <= t0 + elapsed)
        .count();
    // ~1 per second expected; generous floor to stay robust to timing noise.
    let expect_min = (elapsed.as_secs() as usize / 2).max(3);

    let (long_ok, long_desc) = match &long_res {
        Ok(a) => {
            let rms = (a.left_channel.iter().map(|x| x * x).sum::<f32>()
                / a.left_channel.len().max(1) as f32)
                .sqrt();
            (
                a.left_channel.len() == long_n,
                format!("OK ({} samp, L rms {rms:.4})", a.left_channel.len()),
            )
        }
        Err(e) => (false, format!("ERROR {e}")),
    };
    // The register path must come out of the capture healthy: one full
    // keepalive (0x00 write + telemetry reads) right after.
    let post_ka_ok = device.keepalive().await.is_ok();
    println!("  capture  : {long_desc} in {:.1} s", elapsed.as_secs_f32());
    println!("  keepalive stamps in-window: {in_window} (expected ≥ {expect_min})");
    println!("  post-capture keepalive: {}", if post_ka_ok { "OK" } else { "ERROR" });
    let midstream_pass = long_ok && post_ka_ok && in_window >= expect_min;

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
            "PASS — LINK keepalive runs mid-stream, capture intact"
        } else {
            "FAIL"
        }
    );
    if cap_err != 0 || ka_err != 0 || !midstream_pass {
        std::process::exit(1);
    }
}

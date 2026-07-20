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
//! What this validates today: a bare 0x00 link-write AND a full keepalive
//! (link write + telemetry reads) between generate_and_capture frames — the
//! pattern the in-run LINK-LED keepalive uses — leave every capture intact.
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

    let _ = Duration::from_millis(0);
    println!("\n== Result ==");
    println!("  captures : {cap_ok} ok, {cap_err} err");
    println!("  keepalive: {ka_ok} ok, {ka_err} err");
    println!(
        "  {}",
        if cap_err == 0 && ka_err == 0 {
            "PASS — interleaving is safe"
        } else {
            "FAIL — contention caused errors"
        }
    );
}

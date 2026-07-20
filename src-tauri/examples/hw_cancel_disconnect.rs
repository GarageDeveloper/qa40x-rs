//! Reproduce the quit-hang: cancel a 1M-FFT capture mid-flight, then
//! immediately disconnect() — the exact sequence safe_shutdown runs on quit.
//! Every step is timed and announced BEFORE it runs, so when a step hangs the
//! last printed line names it. A watchdog thread hard-exits after 60 s so the
//! repro never needs a force-quit.
//!
//! Run with: RUST_LOG=debug cargo run --example hw_cancel_disconnect
//! (device must be free — close the app first)

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use tauri_app_lib::qa40x::QA40xDevice;

fn step(t0: Instant, msg: &str) {
    println!("[{:8.3}s] {}", t0.elapsed().as_secs_f64(), msg);
}

#[tokio::main]
async fn main() {
    env_logger::init();
    let t0 = Instant::now();

    // Watchdog: if anything below wedges, name the situation and exit hard.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(60));
        eprintln!("!! WATCHDOG: still not done after 60 s — the hang reproduced; exiting");
        std::process::exit(2);
    });

    let device = Arc::new(QA40xDevice::new());
    step(t0, "connecting…");
    if let Err(e) = device.connect().await {
        eprintln!("connect failed: {e} (close the app first — single connection)");
        std::process::exit(1);
    }
    step(t0, "connected");

    // 1M-FFT-sized capture (same as the app's 1M frame incl. guards), silence.
    let n = 1_056_768usize;
    let left = vec![0.0f32; n];
    let right = vec![0.0f32; n];
    let cancel = Arc::new(AtomicBool::new(false));

    step(t0, "starting 1M generate_and_capture (cancellable)…");
    let dev2 = device.clone();
    let cancel2 = cancel.clone();
    let capture = tokio::spawn(async move {
        let r = dev2
            .generate_and_capture_cancellable(&left, &right, Some(&cancel2))
            .await;
        match &r {
            Ok(_) => println!("    capture: completed (unexpected — should be cancelled)"),
            Err(e) => println!("    capture: ended with: {e}"),
        }
        r.is_err()
    });

    // Let it get well into the transfer queue, then cancel — like Cmd+Q at 3 s.
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    step(t0, "setting cancel flag");
    cancel.store(true, Ordering::SeqCst);

    step(t0, "awaiting capture task…");
    let _ = capture.await;
    step(t0, "capture task done — now disconnect() (the step the app hangs on)");

    step(t0, "  disconnect: is_connected()…");
    let conn = device.is_connected().await;
    step(t0, &format!("  disconnect: is_connected = {conn}; calling disconnect()…"));
    match device.disconnect().await {
        Ok(_) => step(t0, "  disconnect: OK"),
        Err(e) => step(t0, &format!("  disconnect: ERR {e}")),
    }
    step(t0, "ALL DONE — no hang. If the app still hangs, the blocker is app-side (locks/Channel), not the device layer.");
    std::process::exit(0);
}

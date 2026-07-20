//! Hardware smoke-test of the Rhai scripting engine (#22): connect a real QA40x
//! (coax loopback), then run a MEASUREMENT script through the SAME path the
//! app uses — the sandboxed engine on a blocking thread, driving an exclusive
//! device session (Traces V2 Phase E) — exercising acquire() + the measurement
//! functions against the device. Validates the one path the unit tests can't
//! (live acquisition + real-calibration measurements).
//!
//! Run with: cargo run --example hw_script

use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tauri_app_lib::measurement::Session;
use tauri_app_lib::qa40x::QA40xDevice;
use tauri_app_lib::script::{run_measurement_script, ScriptEnv};
use tokio::sync::Mutex;

#[tokio::main]
async fn main() {
    env_logger::init();

    let device = Arc::new(Mutex::new(QA40xDevice::new()));
    println!("== Connecting ==");
    if let Err(e) = device.lock().await.connect().await {
        eprintln!("connect failed: {e} (plug the QA40x / close the app)");
        std::process::exit(1);
    }

    // Print sink (stands in for the script output log).
    let sink: Arc<dyn Fn(&str, bool) + Send + Sync> =
        Arc::new(|line: &str, err: bool| println!("  {}{}", if err { "ERR " } else { "" }, line));
    // Frame sink (stands in for the `script-frame` event feeding the dashboard).
    let frame_sink: Arc<dyn Fn(&tauri_app_lib::dashboard::Frame) + Send + Sync> =
        Arc::new(|frame| {
            let tag = match frame {
                tauri_app_lib::dashboard::Frame::Td { samples, .. } => format!("td ({} samples)", samples.len()),
                tauri_app_lib::dashboard::Frame::Fd { freqs, .. } => format!("fd ({} bins)", freqs.len()),
                tauri_app_lib::dashboard::Frame::Sweep { freqs, curves } => {
                    format!("sweep ({} points, {} curves)", freqs.len(), curves.len())
                }
            };
            println!("  [frame] {tag}");
        });
    // Capture sink (stands in for the `script-acquire` event feeding the
    // hardware Input/Output traces).
    let capture_sink: Arc<dyn Fn(&tauri_app_lib::script::ScriptCapture) + Send + Sync> =
        Arc::new(|cap| {
            println!(
                "  [acquire] {} samples @ {} Hz (stimulus: {})",
                cap.left.len(),
                cap.sample_rate,
                if cap.stimulus.is_some() { "yes" } else { "monitor" }
            );
        });

    let session = Session::new(
        device.clone(),
        Arc::new(AtomicBool::new(false)), // generator_running
        Arc::new(AtomicBool::new(false)), // generator_stop
    );
    let env = Arc::new(ScriptEnv::new(
        session,
        tokio::runtime::Handle::current(),
        Arc::new(AtomicBool::new(false)), // cancel
        sink,
        frame_sink,
        capture_sink,
    ));

    // A script that drives a real acquisition + measurements, like a user would.
    let script = r#"
        set_input_range(6);
        set_output_range(-2);
        set_sample_rate(48000);
        set_gen(true, 1000.0, -6.0);
        print("model=" + model() + " fw=" + firmware_version());
        acquire();
        let pk  = peak_hz(20.0, 20000.0);
        let thd = thd_db(pk.left);
        let tdn = thdn_db(pk.left);
        let rms = rms_dbv(20.0, 20000.0);
        print("peak  L=" + pk.left  + " Hz  R=" + pk.right + " Hz");
        print("THD   L=" + thd.left + " dB  R=" + thd.right + " dB");
        print("THD+N L=" + tdn.left + " dB  R=" + tdn.right + " dB");
        print("RMS   L=" + rms.left + " dBV R=" + rms.right + " dBV");
    "#;

    println!("== Running script (acquire + measure) ==");
    let res = tokio::task::spawn_blocking(move || run_measurement_script(env, script))
        .await
        .expect("join");
    match res {
        Ok(()) => println!("== Script OK =="),
        Err(e) => {
            println!("== Script FAILED: {e} ==");
            std::process::exit(1);
        }
    }
}

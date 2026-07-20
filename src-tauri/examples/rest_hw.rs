//! Headless harness to exercise the REST server against real QA402 hardware,
//! without launching the Tauri GUI. Connects the device, starts the REST
//! server on localhost (default) and stays up so endpoints can be curled.
//!
//! Run:  cargo run --example rest_hw
//! Then: curl http://127.0.0.1:9402/Status/Connection   (etc.)

use std::sync::Arc;

use tauri_app_lib::qa40x::QA40xDevice;
use tauri_app_lib::rest::RestControl;
use tokio::sync::Mutex;

#[tokio::main]
async fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let device = Arc::new(Mutex::new(QA40xDevice::new()));

    // Claim the device (the GUI app must not be running — single connection).
    match device.lock().await.connect().await {
        Ok(()) => println!("[hw] connected"),
        Err(e) => {
            eprintln!("[hw] connect failed: {e}");
            std::process::exit(1);
        }
    }

    {
        let dev = device.lock().await;
        if let Some(meta) = dev.device_meta().await {
            println!(
                "[hw] model={} serial={} fw={}",
                meta.product, meta.serial, meta.firmware_version
            );
        }
        let cfg = dev.get_config().await;
        println!(
            "[hw] input={} dBV  output={} dBV  rate={} Hz",
            cfg.input_gain.as_dbv(), cfg.output_gain.as_dbv(), cfg.sample_rate.as_hz()
        );
    }

    let mut ctl = RestControl::new(device);
    let expose = RestControl::expose_from_env();
    match ctl.set_exposed(expose).await {
        Ok(s) => println!("[hw] REST on http://{}:{}/ (exposed={})", s.host, s.port, s.exposed),
        Err(e) => {
            eprintln!("[hw] REST bind failed: {e}");
            std::process::exit(1);
        }
    }

    // Optional runtime-rebind self-test: flip localhost⇄network in place, the
    // same path the UI toggle drives, to confirm same-port re-bind works.
    if std::env::var("QA40X_REST_SELFTEST").is_ok() {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        let flip = !expose;
        println!("[hw] self-test: rebinding exposed={flip}");
        match ctl.set_exposed(flip).await {
            Ok(s) => println!("[hw] rebound to http://{}:{}/ (exposed={})", s.host, s.port, s.exposed),
            Err(e) => println!("[hw] rebind failed: {e}"),
        }
    }

    println!("[hw] ready — Ctrl-C to stop");
    // Park forever; the accept loop runs in a background task.
    futures_forever().await;
}

async fn futures_forever() {
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
    }
}

//! Integration of the per-device runtime (issue #25 lot C) over the built-in
//! virtual source: quiesce hands the device back with the loops stopped but
//! the device still open; shutdown adds the device-side safe state and
//! returns within its budget with everything stopped. No hardware, no USB.

use tauri_app_lib::device::DeviceRegistry;
use tauri_app_lib::stream::{
    MeasureRequest, SpectraRequest, StreamAveraging, StreamConfig, StreamMsg, StreamWindow,
    TriggerRequest,
};

/// Same rationale as `device_registry.rs`: each test owns its Simulator; the
/// lock only serializes the realtime-paced simulators so timing-sensitive
/// assertions don't share CPU.
static SIM_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn stream_config() -> StreamConfig {
    StreamConfig {
        buffer_size: 4096,
        slots: Vec::new(),
        window: StreamWindow::Hann,
        averaging: StreamAveraging { coherent: false, count: 1 },
        spectra: SpectraRequest {
            input_l: false,
            input_r: false,
            output_l: false,
            output_r: false,
        },
        output_range_dbv: None,
        triggers: TriggerRequest::default(),
        measures: MeasureRequest::default(),
    }
}

async fn open_virtual(reg: &DeviceRegistry) {
    let id = reg
        .enumerate()
        .await
        .into_iter()
        .find(|d| d.identity.is_virtual)
        .expect("virtual unit enumerated")
        .id;
    reg.open(&id).await.expect("open virtual unit");
}

/// quiesce(): the stream loop is stopped and waited out, the device is NOT
/// torn down — the "hand the device back to a program" half, observably
/// distinct from shutdown()'s teardown.
#[tokio::test(flavor = "multi_thread")]
async fn quiesce_stops_the_loops_but_keeps_the_device_open() {
    let _sim = SIM_LOCK.lock().await;
    let reg = DeviceRegistry::new();
    open_virtual(&reg).await;
    let rt = reg.default_runtime();

    let on_frame = tauri::ipc::Channel::new(|_| Ok(()));
    rt.stream().start(stream_config(), on_frame).await.expect("stream start");
    assert!(rt.stream().is_running());

    rt.quiesce().await;

    assert!(!rt.stream().is_running(), "quiesce must wait the stream loop out");
    assert!(!rt.generator().is_running());
    assert!(
        rt.handle().lock().await.is_connected().await,
        "quiesce must NOT tear the device down — that is shutdown()'s half"
    );
    assert!(rt.current().is_some(), "still open, bookkeeping intact");

    reg.close().await.expect("close");
}

/// shutdown() with a live stream returns within the per-device budget with
/// the loops stopped, the device disconnected and the bookkeeping cleared —
/// the safe_shutdown path, minus Tauri.
#[tokio::test(flavor = "multi_thread")]
async fn shutdown_within_budget_leaves_everything_stopped_and_closed() {
    let _sim = SIM_LOCK.lock().await;
    let reg = DeviceRegistry::new();
    open_virtual(&reg).await;
    let rt = reg.default_runtime();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<StreamMsg>();
    let on_frame = tauri::ipc::Channel::new(move |body| {
        // Deserialize so the Stopped sentinel is observable below.
        if let tauri::ipc::InvokeResponseBody::Json(s) = body {
            if let Ok(msg) = serde_json::from_str::<serde_json::Value>(&s) {
                if msg.get("type").and_then(|t| t.as_str()) == Some("stopped") {
                    let _ = tx.send(StreamMsg::Stopped);
                }
            }
        }
        Ok(())
    });
    rt.stream().start(stream_config(), on_frame).await.expect("stream start");
    assert!(rt.stream().is_running());

    // The whole exit half must fit the per-device budget by a wide margin on
    // a 4k-FFT virtual stream (the 20 s budget is for 1M-FFT captures).
    tokio::time::timeout(tokio::time::Duration::from_secs(20), rt.shutdown())
        .await
        .expect("shutdown within the per-device budget");

    assert!(!rt.stream().is_running());
    assert!(!rt.generator().is_running());
    assert!(!rt.handle().lock().await.is_connected().await, "device torn down");
    assert!(rt.current().is_none(), "bookkeeping cleared");
    assert!(
        rx.try_recv().is_ok(),
        "the stream channel got its clean Stopped BEFORE the teardown finished"
    );
}

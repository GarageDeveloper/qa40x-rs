pub mod qa40x;
pub mod audio;
pub mod utils;
pub mod storage;
pub mod firmware;
pub mod inno;
pub mod flash;
pub mod dashboard;
pub mod rest;
pub mod script;
pub mod sources;
pub mod measurement;
pub mod measurements;
pub mod mixer;
pub mod stream;

use qa40x::{QA40xDevice, DeviceConfig, InputGain, Model, OutputGain, SampleRate};
use utils::SignalGenerator;
use std::sync::Arc;
use tokio::sync::Mutex;
use log::info;
use tauri::{Emitter, Manager};
use std::sync::atomic::{AtomicBool, Ordering};

/// Application state
pub struct AppState {
    device: Arc<Mutex<QA40xDevice>>,
    /// True while the continuous signal generator loop is running.
    generator_running: Arc<AtomicBool>,
    /// Set to request the continuous generator loop to stop.
    generator_stop: Arc<AtomicBool>,
    /// Carved firmware image bytes, keyed by SHA-256 hex, for a later flash
    /// phase. Populated by the firmware extraction commands.
    firmware_images: firmware::FirmwareStore,
    /// QA40x-compatible REST automation server, sharing the device above.
    /// Bound localhost-only by default; the UI can expose it on the network.
    rest: Arc<Mutex<rest::RestControl>>,
    /// In-app Rhai scripting (task #22) — the scripting counterpart to the
    /// REST server, sharing the same device handle.
    script: script::ScriptControl,
    /// The signal mixer (Traces V2 Phase F): N enabled signal sources summed
    /// into the one DAC buffer the live loop streams. Pure CPU — no device
    /// access; the streaming loop renders here, fits the output range to the
    /// summed peak, then plays the frame.
    mixer: Arc<std::sync::Mutex<mixer::Mixer>>,
    /// True while a USB-monitoring task is alive. Guards `connect_device`
    /// against spawning a second monitor: a reconnect inside the monitor's
    /// 2 s tick used to leak one task per cycle, and every leaked task then
    /// emitted its own `device-disconnected` on unplug (duplicate toasts).
    usb_monitor_active: Arc<AtomicBool>,
    /// The backend live run loop: render → fit → capture → analyze in a tokio
    /// task, frames pushed over a Tauri Channel. Drives the on-screen views;
    /// discrete generate-and-capture (measurement programs / sweeps) stays on
    /// the device handle.
    stream: stream::StreamControl,
    /// Cooperative cancel for the batched sweeps (one long stream
    /// transaction): `sweep_stop` sets it, `run_thd_batch` clears it on
    /// entry and hands it to the capture pump, which aborts between USB
    /// blocks through the clean STREAM_STOP + drain exit.
    sweep_cancel: Arc<AtomicBool>,
    /// The device's telemetry cache cell, cloned out at construction so the
    /// UI's in-run poll (`last_telemetry`) reads it WITHOUT queuing on the
    /// exclusive device mutex (see the quit-hang post-mortem: waiters queued
    /// behind a 22 s capture were part of the deadlock chain at exit).
    telemetry: Arc<Mutex<Option<qa40x::Telemetry>>>,
}

impl AppState {
    fn new() -> Self {
        let raw_device = QA40xDevice::new();
        let telemetry = raw_device.telemetry_cell();
        let device = Arc::new(Mutex::new(raw_device));
        let generator_running = Arc::new(AtomicBool::new(false));
        let generator_stop = Arc::new(AtomicBool::new(false));
        let mixer = Arc::new(std::sync::Mutex::new(mixer::Mixer::default()));
        Self {
            device: device.clone(),
            generator_running: generator_running.clone(),
            generator_stop: generator_stop.clone(),
            firmware_images: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            rest: Arc::new(Mutex::new(rest::RestControl::new(device.clone()))),
            script: script::ScriptControl::new(
                device.clone(),
                generator_running.clone(),
                generator_stop.clone(),
            ),
            mixer: mixer.clone(),
            usb_monitor_active: Arc::new(AtomicBool::new(false)),
            stream: stream::StreamControl::new(device, generator_running, generator_stop, mixer),
            sweep_cancel: Arc::new(AtomicBool::new(false)),
            telemetry,
        }
    }
}

/// Service the current (main) thread's event machinery for ~50 ms. Used while
/// waiting out the exit teardown: webview IPC responses reach the main thread
/// via its run loop / dispatch queue, so simply parking (block_on, join)
/// starves them — and one of them may be exactly what the teardown's lock
/// queue is waiting on (see the RunEvent::Exit comment).
#[cfg(target_os = "macos")]
fn pump_main_thread_briefly() {
    // CoreFoundation is already linked by tao; declare the two symbols
    // directly rather than pulling a crate for one call.
    #[allow(non_upper_case_globals)]
    extern "C" {
        static kCFRunLoopDefaultMode: *const std::ffi::c_void;
        fn CFRunLoopRunInMode(
            mode: *const std::ffi::c_void,
            seconds: f64,
            return_after_source_handled: u8,
        ) -> i32;
    }
    unsafe {
        CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.05, 0);
    }
}

/// Non-macOS: nothing main-thread-bound to service in this codebase's exit
/// path (the GTK equivalent would be `gtk::main_iteration_do`); just avoid a
/// busy spin.
#[cfg(not(target_os = "macos"))]
fn pump_main_thread_briefly() {
    std::thread::sleep(std::time::Duration::from_millis(50));
}

/// THE safe-shutdown path — the ONLY definition of the exit safe state
/// (maintainer rule: one path, never re-coded per exit route). Every way out
/// of the process funnels here: the Tauri run-loop exit events (Cmd+Q,
/// window close) and the POSIX signal task (Ctrl-C on `tauri dev`, kill).
/// Idempotent — the first caller does the work, later callers return.
///
/// Order matters: stop the run loops first (v2 stream task + continuous
/// generator — otherwise the DAC keeps playing after the process dies), THEN
/// `disconnect()` performs the device-side safe state: 42 dBV max-headroom
/// input range + STREAM_STOP + teardown, same as the in-app disconnect.
/// Stopping the loops first means the register writes go through the normal
/// locked path, never spliced into an in-flight capture. Best-effort.
async fn safe_shutdown(state: Arc<Mutex<AppState>>) {
    static DONE: AtomicBool = AtomicBool::new(false);
    if DONE.swap(true, Ordering::SeqCst) {
        return;
    }
    log::info!("exit: safe-teardown entered");
    let (device, stream, gen_running, gen_stop, sweep_cancel) = {
        let s = state.lock().await;
        (
            s.device.clone(),
            s.stream.clone(),
            s.generator_running.clone(),
            s.generator_stop.clone(),
            s.sweep_cancel.clone(),
        )
    };
    // A batched sweep holds the device for its WHOLE run (one long stream
    // transaction); trip its cooperative cancel first or the device.lock
    // below waits the sweep out — minutes, felt as a hang on quit.
    sweep_cancel.store(true, Ordering::SeqCst);
    stream.stop_and_wait().await;
    ensure_generator_stopped(&gen_running, &gen_stop).await;
    log::info!("exit: loops stopped");
    log::info!("exit: acquiring device lock");
    let d = device.lock().await;
    log::info!("exit: device lock acquired; checking connection");
    if d.is_connected().await {
        match d.disconnect().await {
            Ok(_) => log::info!("exit: device left safe (42 dBV, stream stopped)"),
            Err(e) => log::warn!("exit: safe teardown failed: {e}"),
        }
    } else {
        log::info!("exit: no device connected, nothing to do");
    }
}

/// Stop the continuous generator (if running) and wait until its loop exits, so
/// a measurement can take exclusive control of the device. Shared with the
/// Rhai scripting engine (`crate::script`), whose acquisitions need the same
/// exclusivity.
pub(crate) async fn ensure_generator_stopped(
    generator_running: &Arc<AtomicBool>,
    generator_stop: &Arc<AtomicBool>,
) {
    if !generator_running.load(Ordering::SeqCst) {
        return;
    }
    generator_stop.store(true, Ordering::SeqCst);
    for _ in 0..200 {
        if !generator_running.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(25)).await;
    }
}

// Background USB monitoring task. At most ONE instance runs at a time: a
// monitor survives a disconnect+reconnect that lands inside its 2 s tick
// (it just sees "still connected"), so respawning on every connect would
// accumulate tasks — and each one emits `device-disconnected` on unplug.
fn start_usb_monitoring(
    app_handle: tauri::AppHandle,
    device: Arc<Mutex<QA40xDevice>>,
    active: Arc<AtomicBool>,
) {
    if active.swap(true, Ordering::SeqCst) {
        // A monitor is already watching this (re)connection.
        return;
    }
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

            log::debug!("usb-monitor: tick — acquiring device lock");
            let guard = device.lock().await;
            log::debug!("usb-monitor: lock acquired — checking physical presence");
            let still_connected = guard.check_physical_connection().await;
            drop(guard);
            log::debug!("usb-monitor: check done → {still_connected}");

            if !still_connected {
                info!("Device disconnected - emitting event");
                // Emit event to frontend
                let _ = app_handle.emit("device-disconnected", ());
                // Exit the monitoring loop
                active.store(false, Ordering::SeqCst);
                break;
            }
        }
    });
}

// Tauri commands

#[tauri::command]
async fn connect_device(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<String, String> {
    info!("Connect device command called");
    let app_state = state.lock().await;
    let device = app_state.device.clone();
    let monitor_active = app_state.usb_monitor_active.clone();

    {
        let device_lock = device.lock().await;
        device_lock.connect().await
            .map_err(|e| format!("Failed to connect: {}", e))?;
    }

    // Start monitoring after successful connection (no-op if one is alive)
    start_usb_monitoring(app_handle, device, monitor_active);

    Ok("Connected successfully".to_string())
}

/// Connect to the embedded virtual QA40x (demo mode). The simulator runs
/// in-process behind the same endpoint queues as the hardware, so the whole
/// app works on it; no USB monitor is started — a virtual device never
/// unplugs, it only disconnects through `disconnect_device`.
#[tauri::command]
async fn connect_virtual_device(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<String, String> {
    info!("Connect virtual device (demo mode) command called");
    let device = state.lock().await.device.clone();
    let device_lock = device.lock().await;
    device_lock
        .connect_virtual()
        .await
        .map_err(|e| format!("Failed to connect to the virtual device: {}", e))?;
    Ok("Connected to the virtual QA40x (demo mode)".to_string())
}

#[tauri::command]
async fn disconnect_device(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<String, String> {
    info!("Disconnect device command called");
    let (stream, device, gen_running, gen_stop) = {
        let app_state = state.lock().await;
        (
            app_state.stream.clone(),
            app_state.device.clone(),
            app_state.generator_running.clone(),
            app_state.generator_stop.clone(),
        )
    };
    // The stream loop (or the gap-free generator) owns captures; closing the
    // device underneath it would only manufacture a capture error. Hand the
    // device back first — stop_and_wait returns once the loop fully exited,
    // so its channel gets a clean Stopped, never an Error.
    stream.stop_and_wait().await;
    ensure_generator_stopped(&gen_running, &gen_stop).await;
    let device = device.lock().await;

    device.disconnect().await
        .map(|_| "Disconnected successfully".to_string())
        .map_err(|e| format!("Failed to disconnect: {}", e))
}

#[tauri::command]
async fn is_device_connected(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<bool, String> {
    let app_state = state.lock().await;
    let device = app_state.device.lock().await;
    Ok(device.is_connected().await)
}

/// Device identity (firmware version + serial + product), read at connect.
/// Returns null when not connected.
#[tauri::command]
async fn get_device_info(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<Option<qa40x::DeviceMeta>, String> {
    let app_state = state.lock().await;
    let device = app_state.device.lock().await;
    Ok(device.device_meta().await)
}

/// Whether a QA40x (QA402 or QA403) is present on the USB bus (for auto-connect),
/// regardless of whether we are connected to it.
#[tauri::command]
async fn is_device_present(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<bool, String> {
    let app_state = state.lock().await;
    let device = app_state.device.lock().await;
    Ok(device.is_present().await)
}

/// Whether REAL hardware is on the USB bus — the virtual device never counts.
/// Polled by the frontend during a demo session so a newly plugged QA40x
/// takes over from the simulator.
#[tauri::command]
async fn is_hardware_present(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<bool, String> {
    let app_state = state.lock().await;
    let device = app_state.device.lock().await;
    Ok(device.is_hardware_present().await)
}

#[tauri::command]
async fn set_input_gain(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    gain_dbv: i32,
) -> Result<String, String> {
    let app_state = state.lock().await;
    let device = app_state.device.lock().await;

    let gain = InputGain::from_dbv(gain_dbv)
        .ok_or_else(|| format!("Invalid input gain: {}", gain_dbv))?;

    device.set_input_gain(gain).await
        .map(|_| format!("Input gain set to {} dBV", gain_dbv))
        .map_err(|e| format!("Failed to set input gain: {}", e))
}

#[tauri::command]
async fn set_output_gain(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    gain_dbv: i32,
) -> Result<String, String> {
    let app_state = state.lock().await;
    let device = app_state.device.lock().await;

    let gain = OutputGain::from_dbv(gain_dbv)
        .ok_or_else(|| format!("Invalid output gain: {}", gain_dbv))?;

    device.set_output_gain(gain).await
        .map(|_| format!("Output gain set to {} dBV", gain_dbv))
        .map_err(|e| format!("Failed to set output gain: {}", e))
}

#[tauri::command]
async fn set_sample_rate(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    rate_hz: u32,
) -> Result<String, String> {
    let app_state = state.lock().await;
    let device = app_state.device.lock().await;

    let rate = SampleRate::from_hz(rate_hz)
        .ok_or_else(|| format!("Invalid sample rate: {}", rate_hz))?;

    device.set_sample_rate(rate).await
        .map(|_| format!("Sample rate set to {} Hz", rate_hz))
        .map_err(|e| format!("Failed to set sample rate: {}", e))
}

/// Current REST automation-server binding (running / host / port / exposed).
#[tauri::command]
async fn rest_status(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<rest::RestStatus, String> {
    let ctl = state.lock().await.rest.clone();
    let status = ctl.lock().await.current();
    Ok(status)
}

/// Switch the REST server between localhost-only (`false`) and network-exposed
/// on `0.0.0.0` (`true`). Rebinds the listener and returns the new status.
#[tauri::command]
async fn rest_set_exposed(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    exposed: bool,
) -> Result<rest::RestStatus, String> {
    let ctl = state.lock().await.rest.clone();
    let mut guard = ctl.lock().await;
    guard.set_exposed(exposed).await
}

/// Set or clear (`None`/blank) the user's fixed REST bearer token. Applies
/// immediately (hot rebind) when the server is network-exposed; otherwise on
/// the next exposure. Returns the new status.
#[tauri::command]
async fn rest_set_token(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    token: Option<String>,
) -> Result<rest::RestStatus, String> {
    let ctl = state.lock().await.rest.clone();
    let mut guard = ctl.lock().await;
    guard.set_token(token).await
}

/// Run a Rhai automation script (task #22). Returns immediately; the run
/// streams `script-log` / `script-state` events. One script at a time. The
/// `role` selects the family (Traces V2 Phase E): a "source" script produces
/// a signal (no device access); a "measurement" script (the default, for old
/// callers) drives the instrument through an exclusive session.
#[tauri::command]
async fn script_run(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    source: String,
    role: Option<dashboard::ScriptRole>,
) -> Result<(), String> {
    let ctl = { state.lock().await.script.clone() };
    ctl.start(app, source, role.unwrap_or_default())
}

/// Request the running script to stop (takes effect at its next operation).
#[tauri::command]
async fn script_stop(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<(), String> {
    let ctl = { state.lock().await.script.clone() };
    ctl.stop();
    Ok(())
}

/// Whether a script is currently running (for the panel's initial state).
#[tauri::command]
async fn script_status(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<bool, String> {
    let ctl = { state.lock().await.script.clone() };
    Ok(ctl.is_running())
}

/// Measure a trace's frames for the per-graph readout strip (RMS / peak /
/// crest / DC / loudest bin). The frontend caches the result by trace seq and
/// only formats — the math lives in `measurements::`.
#[tauri::command]
fn measure_frames(
    td: Option<dashboard::Frame>,
    fd: Option<dashboard::Frame>,
) -> dashboard::FrameMeasures {
    dashboard::measure_frames(&td, &fd)
}

/// Apply a full transform chain (weighting / notch / deconvolve / script) to
/// an endpoint's input frames — the single authoritative implementation of
/// the dashboard transformer DSP (measurements-extraction refactor). Pure
/// CPU; runs on a blocking thread so a heavy chain can't stall the runtime.
#[tauri::command]
async fn apply_transform_chain(
    td: Option<dashboard::Frame>,
    fd: Option<dashboard::Frame>,
    steps: Vec<dashboard::TransformStep>,
    refs: std::collections::HashMap<dashboard::TraceId, dashboard::Frame>,
) -> Result<dashboard::TransformChainResult, String> {
    tokio::task::spawn_blocking(move || dashboard::apply_transform_chain(td, fd, &steps, &refs))
        .await
        .map_err(|e| format!("transform chain task failed: {e}"))
}

#[tauri::command]
async fn get_device_config(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<DeviceConfig, String> {
    let app_state = state.lock().await;
    let device = app_state.device.lock().await;
    Ok(device.get_config().await)
}

#[tauri::command]
async fn read_device_config(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<DeviceConfig, String> {
    let app_state = state.lock().await;
    let device = app_state.device.lock().await;
    device.read_config_from_device().await
        .map_err(|e| format!("Failed to read config from device: {}", e))
}

/// Start the v2 backend run loop (rewrite-v2 B-2): a tokio task renders the
/// declared sources, fits the output range, captures, analyzes, and pushes
/// every frame over `on_frame`. One stream at a time; the frame carries the
/// per-converter level offsets of its own register state (B-3).
#[tauri::command]
async fn stream_start(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    config: stream::StreamConfig,
    on_frame: tauri::ipc::Channel<stream::StreamMsg>,
) -> Result<(), String> {
    let ctl = { state.lock().await.stream.clone() };
    ctl.start(config, on_frame).await
}

/// Swap the running stream's configuration (sources, FFT size, window,
/// averaging, spectra request, output-range policy). Takes effect at the
/// next frame. Also valid while stopped: the next `stream_start` config wins.
#[tauri::command]
async fn stream_update(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    config: stream::StreamConfig,
) -> Result<(), String> {
    let ctl = { state.lock().await.stream.clone() };
    ctl.update(config)
}

/// Stop the stream loop and wait until it has fully exited (so a restart —
/// or a measurement program taking the device — is deterministic).
#[tauri::command]
async fn stream_stop(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<(), String> {
    let ctl = { state.lock().await.stream.clone() };
    ctl.stop_and_wait().await;
    Ok(())
}

/// Whether the v2 stream loop is currently running.
#[tauri::command]
async fn stream_status(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<bool, String> {
    let ctl = { state.lock().await.stream.clone() };
    Ok(ctl.is_running())
}

/// Abort an in-flight batched sweep (THD vs freq/level): the capture pump
/// checks this flag between USB blocks and closes its stream through the
/// normal STREAM_STOP + drain path — the command then rejects with
/// "sweep cancelled". No-op when nothing sweeps (the next batch clears it).
#[tauri::command]
async fn sweep_stop(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<(), String> {
    let flag = { state.lock().await.sweep_cancel.clone() };
    flag.store(true, Ordering::SeqCst);
    Ok(())
}

/// Empty the spectrum-averaging accumulators (both input channels) so the
/// rolling window restarts from the next frame — the user's "Reset avg"
/// after changing something on the bench. Config untouched; no-op when idle.
#[tauri::command]
async fn stream_reset_averaging(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<(), String> {
    let ctl = { state.lock().await.stream.clone() };
    ctl.reset_averaging();
    Ok(())
}

/// Spawn the gap-free DAC loop: the buffer repeats until the stop flag is
/// set. The caller has already stopped any previous loop and checked the
/// connection; this flips the running/stop flags and detaches the task.
fn spawn_generator_loop(
    device: Arc<Mutex<QA40xDevice>>,
    running: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    left: Vec<f32>,
    right: Vec<f32>,
) {
    stop.store(false, Ordering::SeqCst);
    running.store(true, Ordering::SeqCst);
    tokio::spawn(async move {
        while !stop.load(Ordering::SeqCst) {
            let dev = device.lock().await;
            let res = dev.generate_signal(&left, &right).await;
            drop(dev);
            if let Err(e) = res {
                info!("Generator loop stopped on error: {}", e);
                break;
            }
        }
        running.store(false, Ordering::SeqCst);
        info!("Generator loop exited");
    });
}

/// Start the gap-free output-only generator from a declared slot set
/// (rewrite-v2 M2): the summed mix drives the DAC continuously with NO
/// capture — for feeding an external DUT. The whole render → range-fit →
/// scale path runs backend-side (the mixer.ts port); a 1 s loop buffer keeps
/// multitone / chirp seamless when repeated. The v2 stream loop and any
/// previous generator are stopped first — one DAC owner at a time.
#[tauri::command]
async fn output_only_start(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    slots: Vec<mixer::MixerSlotDesc>,
) -> Result<mixer::OutputOnlyStatus, String> {
    if slots.is_empty() {
        return Err("output-only: no signal source is playing".into());
    }
    let (device, running, stop, mx, stream_ctl) = {
        let app_state = state.lock().await;
        (
            app_state.device.clone(),
            app_state.generator_running.clone(),
            app_state.generator_stop.clone(),
            app_state.mixer.clone(),
            app_state.stream.clone(),
        )
    };
    stream_ctl.stop_and_wait().await;
    ensure_generator_stopped(&running, &stop).await;
    if !device.lock().await.is_connected().await {
        return Err("Device not connected".into());
    }
    let sample_rate = device.lock().await.get_config().await.sample_rate.as_hz();

    // Declare the slots and render the loop buffer in one blocking hop (pure
    // CPU; scripts may take a while to compile).
    let (mut frame, mut errors) = tokio::task::spawn_blocking(move || {
        let mut m = mx.lock().map_err(|_| "mixer lock poisoned".to_string())?;
        let errors = m.set_slots(slots);
        let frame = m.render(sample_rate, sample_rate as usize);
        Ok::<_, String>((frame, errors))
    })
    .await
    .map_err(|e| format!("mixer task failed: {e}"))??;
    errors.append(&mut frame.errors);

    // Fit the output range to the summed peak (fresh start: the plain
    // margined policy, no hysteresis to carry) and write reg 6 on a change —
    // strictly before the DAC loop starts.
    let sigma_peak_dbv = (frame.peak > 0.0).then(|| 20.0 * frame.peak.log10());
    let current = device.lock().await.get_config().await.output_gain.as_dbv();
    let range = sigma_peak_dbv.map(mixer::auto_output_range).unwrap_or(current);
    if range != current {
        let gain = OutputGain::from_dbv(range)
            .ok_or_else(|| format!("output-only: invalid output range {range}"))?;
        let dev = device.lock().await;
        dev.set_output_gain(gain)
            .await
            .map_err(|e| format!("output-only: set output range: {e}"))?;
    }
    let clipped = mixer::scale_mix_to_range(&mut frame.left, &mut frame.right, range);

    spawn_generator_loop(device, running, stop, frame.left, frame.right);
    Ok(mixer::OutputOnlyStatus {
        sigma_peak_dbv,
        clipped,
        fitted_output_range_dbv: range,
        errors,
    })
}

/// Stop the continuous signal generator.
#[tauri::command]
async fn stop_generator(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<String, String> {
    let (running, stop) = {
        let app_state = state.lock().await;
        (
            app_state.generator_running.clone(),
            app_state.generator_stop.clone(),
        )
    };
    ensure_generator_stopped(&running, &stop).await;
    Ok("Generator stopped".into())
}

/// Whether the continuous generator is currently running.
#[tauri::command]
async fn is_generator_running(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<bool, String> {
    let app_state = state.lock().await;
    Ok(app_state.generator_running.load(Ordering::SeqCst))
}

#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export)]
struct InputDbvOffset {
    offset_db: f32,
    calibrated: bool,
}

/// dB offset to add to a dBFS spectrum bin to display it in absolute dBV, for
/// the current input range + factory calibration. Lets the UI offer a dBV axis.
#[tauri::command]
async fn get_input_dbv_offset(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    input_channel: qa40x::Channel,
) -> Result<InputDbvOffset, String> {
    let device = {
        let app_state = state.lock().await;
        app_state.device.clone()
    };
    let device = device.lock().await;
    let (offset_db, calibrated) = device.input_dbv_offset(input_channel).await;
    Ok(InputDbvOffset { offset_db, calibrated })
}

/// dB offset to add to a dBFS reading of the generated stimulus to display it
/// in absolute output dBV, for the current output range + factory calibration
/// — the DAC-side mirror of `get_input_dbv_offset`. Each converter's dBFS
/// reference moves with its OWN range register, so Output traces must never
/// borrow the ADC's offset (task #51).
#[tauri::command]
async fn get_output_dbv_offset(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    output_channel: qa40x::Channel,
) -> Result<InputDbvOffset, String> {
    let device = {
        let app_state = state.lock().await;
        app_state.device.clone()
    };
    let device = device.lock().await;
    let (offset_db, calibrated) = device.output_dbv_offset(output_channel).await;
    Ok(InputDbvOffset { offset_db, calibrated })
}

/// Live hardware telemetry (USB voltage/current, ISO current, temperature).
/// The frontend polls this while connected and idle.
#[tauri::command]
async fn read_telemetry(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<qa40x::Telemetry, String> {
    let device = {
        let app_state = state.lock().await;
        app_state.device.clone()
    };
    let device = device.lock().await;
    device.read_telemetry().await.map_err(|e| e.to_string())
}

/// LINK-LED keepalive: ping the link register + read telemetry, mirroring the
/// official app's ~1 s poll so the LINK LED stays lit while connected and idle.
#[tauri::command]
async fn keepalive(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<qa40x::Telemetry, String> {
    let device = {
        let app_state = state.lock().await;
        app_state.device.clone()
    };
    let device = device.lock().await;
    device.keepalive().await.map_err(|e| e.to_string())
}

/// Telemetry from the most recent keepalive (idle poll or the in-run keepalive
/// that `stream_io` fires between frames), with NO USB I/O of its own — the UI
/// polls this while a run owns the stream. `None` until a keepalive has run.
#[tauri::command]
async fn last_telemetry(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<Option<qa40x::Telemetry>, String> {
    // Pure cache read — deliberately NOT through the exclusive device mutex:
    // this polls every second during a run, and queuing it behind a long
    // capture both delays the readout and lengthens the lock's FIFO queue.
    let cell = {
        let app_state = state.lock().await;
        app_state.telemetry.clone()
    };
    let t = cell.lock().await.clone();
    Ok(t)
}

/// Dry-run of a firmware flash: build the exact byte sequence that a real flash
/// would send and validate it, WITHOUT touching any device. `sha256` selects a
/// previously extracted image held in memory.
#[tauri::command]
async fn flash_dry_run(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    sha256: String,
) -> Result<flash::DryRun, String> {
    let store = { state.lock().await.firmware_images.clone() };
    let image = {
        let guard = store.lock().map_err(|_| "firmware store lock poisoned".to_string())?;
        guard.get(&sha256).cloned()
    };
    let image = image.ok_or_else(|| {
        "That image is not in memory — extract it first (Choose file / a release).".to_string()
    })?;
    Ok(flash::dry_run(&image))
}

#[derive(Clone, serde::Serialize, ts_rs::TS)]
#[ts(export)]
struct FlashProgress {
    sent: usize,
    total: usize,
}

/// REAL firmware flash — DEVICE-MUTATING. Re-verifies the image signature and
/// that it matches the connected model, enters the NXP bootloader, then streams
/// the image over USB-HID, emitting `firmware-flash-progress` / `-phase` events.
/// On success the device is NOT auto-reset — the frontend asks the user to
/// unplug/replug. Only ever call from an explicit, confirmed user action.
#[tauri::command]
async fn flash_firmware(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    sha256: String,
) -> Result<(), String> {
    use tauri::Emitter;
    // Real flashing is enabled: the KBOOT HID transport is confirmed against NXP's
    // reference (spsdk + pyMBoot) and the capture cross-checks its shape. The
    // command still re-verifies the signature + connected model below, and the
    // frontend requires an explicit confirmation — never auto-invoked.
    let (store, device) = {
        let s = state.lock().await;
        (s.firmware_images.clone(), s.device.clone())
    };
    let image = {
        let g = store.lock().map_err(|_| "firmware store lock poisoned".to_string())?;
        g.get(&sha256).cloned()
    }
    .ok_or_else(|| "That image is not in memory — extract it first.".to_string())?;

    if !firmware::verify_sb2_signature(&image).valid {
        return Err("Refusing to flash: the image's signature is not valid.".into());
    }
    // Trust anchor (audit S4/S5): the SB2 signature is verified against the leaf
    // cert embedded in the same image, so a self-signed forgery would pass. Require
    // the image to also be byte-identical to a KNOWN official build (registry hash
    // match) before a real flash — that registry hit is the actual provenance proof.
    if firmware::lookup_sha256(&sha256).is_none() {
        return Err(
            "Refusing to flash: this image is not a recognised official build \
             (no registry hash match). Only verified official firmware can be flashed."
                .into(),
        );
    }
    let dev = device.lock().await;
    let model = dev
        .model()
        .await
        .ok_or_else(|| "No QA40x is connected.".to_string())?;
    // Flashing is only verified on the QA402 — refuse on any other model since we
    // can't confirm its flash transport.
    if !model.supports_flash() {
        return Err(format!(
            "Firmware flashing is not supported on the {} (transport unverified).",
            model.name()
        ));
    }
    // The QA402 firmware is invariably 52724 B; anything else is the QA403 image.
    let img_device = if image.len() == 52724 { Model::Qa402 } else { Model::Qa403 };
    if model != img_device {
        return Err(format!(
            "Refusing to flash: this is the {} firmware but a {} is connected.",
            img_device.name(),
            model.name()
        ));
    }

    // Enter the bootloader, then release the USB claim so the unit can detach and
    // re-enumerate as the NXP bootloader.
    let _ = app.emit("firmware-flash-phase", "entering-bootloader");
    dev.enter_bootloader()
        .await
        .map_err(|e| format!("Could not enter the bootloader: {e}"))?;
    drop(dev);
    device.lock().await.mark_disconnected().await;

    let plan = flash::build_flash_plan(&image);
    let _ = app.emit("firmware-flash-phase", "waiting-for-bootloader");
    let app2 = app.clone();
    let res = tokio::task::spawn_blocking(move || {
        flash::flash_via_hid(&plan, std::time::Duration::from_secs(10), |sent, total| {
            let _ = app2.emit("firmware-flash-progress", FlashProgress { sent, total });
        })
    })
    .await
    .map_err(|e| format!("flash task failed to run: {e}"))?;

    match &res {
        Ok(()) => {
            let _ = app.emit("firmware-flash-phase", "succeeded");
        }
        Err(e) => {
            let _ = app.emit("firmware-flash-phase", format!("failed: {e}"));
        }
    }
    res
}

/// Measure the frequency response driving one or both output channels and
/// returning one trace per selected input channel (Left / Right / Both).
/// Runs as a [`measurement::FrSweepProgram`] (Traces V2 Phase E): an
/// exclusive begin → chirp + deconvolve → end session bracket.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command: args map 1:1 to the UI form.
async fn measure_frequency_response_multi(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    start_freq: f32,
    end_freq: f32,
    drive_left: bool,
    drive_right: bool,
    want_left: bool,
    want_right: bool,
    duration_secs: f32,
    amplitude_dbfs: f32,
) -> Result<Vec<qa40x::FrequencyResponseTrace>, String> {
    use measurement::MeasurementProgram;
    let (device, running, stop) = {
        let app_state = state.lock().await;
        (
            app_state.device.clone(),
            app_state.generator_running.clone(),
            app_state.generator_stop.clone(),
        )
    };
    let mut session = measurement::Session::new(device, running, stop);
    let mut program = measurement::FrSweepProgram::new(measurement::FrequencyResponseRequest {
        start_freq,
        end_freq,
        duration_secs,
        amplitude_dbfs,
        drive_left,
        drive_right,
        want_left,
        want_right,
    });
    // No cancellation yet: the chirp is one synchronized stream transaction,
    // exactly as before this refactor.
    program.run(&mut session, &measurement::CancelToken::new()).await?;
    program
        .result
        .ok_or_else(|| "frequency-response program produced no result".to_string())
}

/// Sweep THD / THD+N across frequency (log-spaced). Emits a `thd-sweep-progress`
/// Run a THD sweep as a SINGLE synchronized stream: all per-point tones are
/// concatenated into one buffer, played + captured in one go, then each point's
/// segment is sliced out and analysed. This avoids one STREAM_CTRL start/stop
/// (and its relay click) per point — a 25-point sweep is 1 stream, not 25.
///
/// Each point uses a coherent (bin-snapped) tone of `N_FFT + 2*GUARD` samples;
/// the analysis window is the pure-tone interior, clear of the round-trip
/// latency (which is far smaller than GUARD).
async fn run_thd_batch(
    app: &tauri::AppHandle,
    device: &QA40xDevice,
    pts_spec: Vec<(f32, f32)>, // (frequency, amplitude_dbfs)
    output_channel: qa40x::Channel,
    input_channel: qa40x::Channel,
    swept: &str,
    cancel: &Arc<AtomicBool>,
) -> Result<audio::ThdSweepResult, String> {
    // A fresh batch consumes any stale stop click from a previous run.
    cancel.store(false, Ordering::SeqCst);
    const N_FFT: usize = 32768;
    const GUARD: usize = 2048;
    let seg = N_FFT + 2 * GUARD;
    let sr = device.get_config().await.sample_rate.as_hz();

    let total = pts_spec.len();
    let _ = app.emit(
        "thd-sweep-progress",
        serde_json::json!({ "done": 0, "total": total }),
    );

    // Build one concatenated tone buffer of coherent (bin-snapped) segments.
    let mut tone = Vec::with_capacity(total * seg);
    let mut bins = Vec::with_capacity(total);
    for (f, dbfs) in &pts_spec {
        let amp = 10f32.powf(dbfs.clamp(-80.0, 0.0) / 20.0);
        let bin = (f * N_FFT as f32 / sr as f32).round().max(1.0);
        let f_bin = bin * sr as f32 / N_FFT as f32;
        bins.push(f_bin);
        tone.extend(SignalGenerator::sine(f_bin, amp, sr, seg));
    }
    let silence = vec![0.0f32; tone.len()];
    let (left, right) = match output_channel {
        qa40x::Channel::Left => (tone.as_slice(), silence.as_slice()),
        qa40x::Channel::Right => (silence.as_slice(), tone.as_slice()),
    };

    let captured = device
        .generate_and_capture_cancellable(left, right, Some(cancel))
        .await
        .map_err(|e| match e {
            qa40x::QA40xError::Cancelled => "sweep cancelled".to_string(),
            e => format!("THD sweep capture failed: {}", e),
        })?;
    let sig = match input_channel {
        qa40x::Channel::Left => &captured.left_channel,
        qa40x::Channel::Right => &captured.right_channel,
    };

    let to_db = |r: f32| if r > 0.0 { (20.0 * r.log10()).max(-200.0) } else { -200.0 };
    let mut points = Vec::with_capacity(total);
    for (i, (f_bin, (_, dbfs))) in bins.iter().zip(pts_spec.iter()).enumerate() {
        let start = (i * seg + GUARD).min(sig.len());
        let end = (start + N_FFT).min(sig.len());
        let (thd, thd_n, fund) = if end > start + 1024 {
            audio::AudioAnalyzer::thd_suite(&sig[start..end], sr, *f_bin, 7)
        } else {
            (0.0, 0.0, 0.0)
        };
        points.push(audio::ThdSweepPoint {
            frequency: *f_bin,
            level_dbfs: *dbfs,
            thd_percent: thd * 100.0,
            thd_db: to_db(thd),
            thd_n_percent: thd_n * 100.0,
            thd_n_db: to_db(thd_n),
            fundamental_dbfs: to_db(fund),
        });
        let _ = app.emit(
            "thd-sweep-progress",
            serde_json::json!({ "done": i + 1, "total": total, "frequency": *f_bin, "level": *dbfs }),
        );
    }

    Ok(audio::ThdSweepResult {
        points,
        swept: swept.to_string(),
    })
}

/// event { done, total, frequency } per point so the UI can show progress.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command: args map 1:1 to the UI form.
async fn measure_thd_vs_frequency(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    start_freq: f32,
    end_freq: f32,
    num_points: usize,
    amplitude_dbfs: f32,
    output_channel: qa40x::Channel,
    input_channel: qa40x::Channel,
) -> Result<audio::ThdSweepResult, String> {
    let (device, running, stop, sweep_cancel) = {
        let app_state = state.lock().await;
        (
            app_state.device.clone(),
            app_state.generator_running.clone(),
            app_state.generator_stop.clone(),
            app_state.sweep_cancel.clone(),
        )
    };
    ensure_generator_stopped(&running, &stop).await;
    let device = device.lock().await;

    let sr = device.get_config().await.sample_rate.as_hz() as f32;
    let nyquist = sr / 2.0;
    let n = num_points.clamp(2, 200);
    // THD needs at least the 2nd harmonic below Nyquist, so cap the fundamental
    // at ~0.45*Nyquist (2nd harmonic lands at ~0.9*Nyquist). Above that THD is
    // unmeasurable — raise the sample rate to sweep higher.
    let fmax = nyquist * 0.45;
    let lo = start_freq.max(1.0).min(fmax * 0.9);
    let hi = end_freq.clamp(lo * 1.01, fmax);

    info!(
        "THD vs frequency: {:.1}-{:.1} Hz, {} points, {} dBFS",
        lo, hi, n, amplitude_dbfs
    );

    let pts_spec: Vec<(f32, f32)> = (0..n)
        .map(|i| {
            let f = lo * (hi / lo).powf(i as f32 / (n - 1) as f32);
            (f, amplitude_dbfs)
        })
        .collect();
    run_thd_batch(
        &app,
        &device,
        pts_spec,
        output_channel,
        input_channel,
        "frequency",
        &sweep_cancel,
    )
    .await
}


// ---- Test plans (reusable measurement recipes) ----

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();
    info!("Starting QA40x Analyzer application");

    let app_state = Arc::new(Mutex::new(AppState::new()));

    // Start the QA40x-compatible REST automation server (task #21). It shares
    // the device handle with the UI. Localhost-only by default; exposed on the
    // network only if QA40X_REST_EXPOSE is set (the UI can also toggle it).
    let rest_ctl = {
        // AppState::new() built everything synchronously above, so this is
        // uncontended.
        app_state.blocking_lock().rest.clone()
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            tauri::async_runtime::spawn(async move {
                let expose = rest::RestControl::expose_from_env();
                if let Err(e) = rest_ctl.lock().await.set_exposed(expose).await {
                    log::warn!("QA40x REST server not started: {e}");
                }
            });
            // Ctrl-C on `tauri dev`, `kill`, terminal hang-up: none of these
            // reach the run-loop exit events — without this task the process
            // dies with the device streaming on a sensitive range. Same
            // single `safe_shutdown` path as the normal exits; `exit(0)`
            // afterwards fires the run-loop events, whose call no-ops.
            #[cfg(unix)]
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    use tokio::signal::unix::{signal, SignalKind};
                    let (mut int, mut term, mut hup) = match (
                        signal(SignalKind::interrupt()),
                        signal(SignalKind::terminate()),
                        signal(SignalKind::hangup()),
                    ) {
                        (Ok(i), Ok(t), Ok(h)) => (i, t, h),
                        _ => {
                            log::warn!("exit: could not install signal handlers");
                            return;
                        }
                    };
                    tokio::select! {
                        _ = int.recv() => log::info!("exit: SIGINT"),
                        _ = term.recv() => log::info!("exit: SIGTERM"),
                        _ = hup.recv() => log::info!("exit: SIGHUP"),
                    }
                    let state = handle.state::<Arc<Mutex<AppState>>>();
                    if tokio::time::timeout(
                        tokio::time::Duration::from_secs(20),
                        safe_shutdown(state.inner().clone()),
                    )
                    .await
                    .is_err()
                    {
                        log::warn!("exit: safe teardown timed out after 20 s — exiting anyway");
                    }
                    handle.exit(0);
                });
            }
            Ok(())
        })
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            connect_device,
            connect_virtual_device,
            disconnect_device,
            is_hardware_present,
            is_device_connected,
            is_device_present,
            set_input_gain,
            set_output_gain,
            set_sample_rate,
            get_device_config,
            read_device_config,
            rest_status,
            rest_set_exposed,
            rest_set_token,
            script_run,
            script_stop,
            apply_transform_chain,
            measure_frames,
            script_status,
            stream_start,
            stream_update,
            stream_stop,
            stream_status,
            stream_reset_averaging,
            sweep_stop,
            output_only_start,
            stop_generator,
            is_generator_running,
            get_input_dbv_offset,
            get_output_dbv_offset,
            get_device_info,
            read_telemetry,
            keepalive,
            last_telemetry,
            measure_frequency_response_multi,
            measure_thd_vs_frequency,
            firmware::extract_firmware_from_exe,
            firmware::extract_firmware_from_setup,
            firmware::list_qa40x_releases,
            firmware::download_qa40x_setup,
            flash_dry_run,
            flash_firmware,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Hooked on BOTH ExitRequested and Exit: depending on how the app
            // quits on macOS (Cmd+Q vs last window closed) one of the two may
            // be the only event delivered before the process dies. The signal
            // path (Ctrl-C/SIGTERM, see setup) leads here too via exit(0) —
            // `safe_shutdown` is idempotent, everyone funnels through it.
            match &event {
                tauri::RunEvent::ExitRequested { code, .. } => {
                    log::info!("exit: RunEvent::ExitRequested (code {code:?})");
                }
                tauri::RunEvent::Exit => log::info!("exit: RunEvent::Exit"),
                _ => {}
            }
            match event {
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                    let state = app_handle.state::<Arc<Mutex<AppState>>>();
                    let state = state.inner().clone();
                    // NEVER block_on(safe_shutdown) here. This handler runs on
                    // the MAIN thread; delivering a Tauri command RESPONSE to
                    // the webview also needs the main thread, and tokio's
                    // LIFO-slot is not work-stealable — so parking main while
                    // an invoke response is in flight left the device mutex
                    // owned by a task no worker could ever run (measured:
                    // sample of the hung app, 2026-07-18; quit during a
                    // capture froze until force-quit). Instead the teardown
                    // runs on the runtime while THIS thread keeps servicing
                    // its run loop, so main-thread work keeps draining.
                    let (tx, rx) = std::sync::mpsc::channel::<()>();
                    tauri::async_runtime::spawn(async move {
                        if tokio::time::timeout(
                            tokio::time::Duration::from_secs(20),
                            safe_shutdown(state),
                        )
                        .await
                        .is_err()
                        {
                            log::warn!(
                                "exit: safe teardown timed out after 20 s — exiting anyway"
                            );
                        }
                        let _ = tx.send(());
                    });
                    let deadline =
                        std::time::Instant::now() + std::time::Duration::from_secs(21);
                    while rx.try_recv().is_err() && std::time::Instant::now() < deadline {
                        pump_main_thread_briefly();
                    }
                }
                _ => {}
            }
        });
}

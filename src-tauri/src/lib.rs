pub mod qa40x;
pub mod device;
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
pub mod export;

use qa40x::{QA40xDevice, DeviceConfig, InputGain, Model, OutputGain, SampleRate};
use utils::SignalGenerator;
use std::sync::Arc;
use tokio::sync::Mutex;
use log::info;
use tauri::{Emitter, Manager};
use std::sync::atomic::{AtomicBool, Ordering};

/// Application state
pub struct AppState {
    /// The device registry (issue #25 lots B/C/E): enumerates units across
    /// sources (USB bus + built-in virtual) and owns the runtime SLOTS —
    /// each a [`device::DeviceRuntime`] (device handle, telemetry cell,
    /// mixer, generator flags, sweep cancel, stream control). Slot 0 is the
    /// default device (REST/scripting/unrouted commands); additional units
    /// open onto further slots via `connect_additional_device`.
    devices: device::DeviceRegistry,
    /// Carved firmware image bytes, keyed by SHA-256 hex, for a later flash
    /// phase. Populated by the firmware extraction commands.
    firmware_images: firmware::FirmwareStore,
    /// QA40x-compatible REST automation server, built over the default
    /// runtime's device handle (device selection for REST is lot F; the
    /// QA40x-compatible scheme stays default-device-bound by specification).
    /// Bound localhost-only by default; the UI can expose it on the network.
    rest: Arc<Mutex<rest::RestControl>>,
    /// In-app Rhai scripting (task #22) — the scripting counterpart to the
    /// REST server, sharing the default runtime's device handle (per-device
    /// script selection is lot F).
    script: script::ScriptControl,
}

impl AppState {
    fn new() -> Self {
        // The registry creates the default device's RUNTIME (issue #25
        // lot C): every per-device object lives there. REST and scripting
        // capture Arcs out of it at construction — sound because the
        // runtime is created once and never replaced.
        let devices = device::DeviceRegistry::new();
        let rt = devices.default_runtime();
        let device = rt.handle();
        Self {
            firmware_images: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            rest: Arc::new(Mutex::new(rest::RestControl::new(device.clone()))),
            script: script::ScriptControl::new(
                device,
                rt.generator().running_flag().clone(),
                rt.generator().stop_flag().clone(),
            ),
            devices,
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
    let registry = { state.lock().await.devices.clone() };
    // Per-device budget, equal to the callers' outer 20 s timeout so
    // single-device behavior is unchanged; the slots tear down CONCURRENTLY
    // (issue #25 lot E) so one wedged device never starves its siblings'
    // teardown window. The sweep-cancel / stream / generator ordering lives
    // in DeviceRuntime::shutdown.
    const DEVICE_SHUTDOWN_BUDGET: tokio::time::Duration = tokio::time::Duration::from_secs(20);
    registry.shutdown_all(DEVICE_SHUTDOWN_BUDGET).await;
}

/// Stop the continuous generator (if running) and wait until its loop exits, so
/// a measurement can take exclusive control of the device. Shared with the
/// Rhai scripting engine (`crate::script`), whose acquisitions need the same
/// exclusivity.
pub(crate) async fn ensure_generator_stopped(
    generator_running: &Arc<AtomicBool>,
    generator_stop: &Arc<AtomicBool>,
) {
    // Shim over the moved body (issue #25 lot C): `script.rs` and
    // `measurement.rs` keep their loose-flag signatures for the examples'
    // sake; the semantics live in [`device::GeneratorFlags::ensure_stopped`].
    device::GeneratorFlags::from_parts(generator_running.clone(), generator_stop.clone())
        .ensure_stopped()
        .await;
}

// Tauri commands

/// Resolve a command's optional `device_id` (issue #25 lot C): `None` ⇒ the
/// default device — REST/scripting and every pre-lot-C caller unchanged;
/// `Some(id)` that names anything but an open device is an error, never a
/// silent fallback. Scoped AppState guard around a cheap std-lock read.
async fn runtime_for_command(
    state: &tauri::State<'_, Arc<Mutex<AppState>>>,
    device_id: Option<&str>,
) -> Result<device::DeviceRuntime, String> {
    let s = state.lock().await;
    s.devices.runtime_for(device_id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn connect_device(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    device_id: Option<String>,
) -> Result<String, String> {
    info!("Connect device command called");
    let devices = { state.lock().await.devices.clone() };

    // `device_id` picks a SPECIFIC enumerated unit (issue #25 lot C — the
    // lot-D device bar's path, any source incl. virtual); `None` keeps the
    // pre-registry behavior: first physical unit any source offers (the
    // registry's USB source releases the prior claim, rescans and opens by
    // unit key).
    let desc = match &device_id {
        Some(id) => devices
            .open(&device::DeviceId::from_wire(id.clone()))
            .await
            .map_err(|e| format!("Failed to connect: {}", e))?,
        None => devices
            .open_first_physical()
            .await
            .map_err(|e| format!("Failed to connect: {}", e))?,
    };

    // Watch THIS open for unplug (a no-op when a monitor already watches
    // this generation). The monitor lives in device::runtime — Tauri only
    // provides the event emission. A virtual unit never unplugs; it only
    // disconnects through disconnect_device (the connect_virtual_device
    // rule, kept for a virtual unit opened by id). Resolve the runtime BY
    // the unit just opened, not "the default" (review F3): if a racing
    // connect already superseded this open, there is nothing left for this
    // command to monitor — the winner spawned its own.
    if !desc.identity.is_virtual {
        if let Ok(rt) = devices.runtime_for(Some(desc.id.as_str())) {
            device::spawn_liveness_monitor(rt, move |lost| {
                let _ = app_handle.emit("device-disconnected", lost);
            });
        }
    }

    Ok("Connected successfully".to_string())
}

/// Open `device_id` as an ADDITIONAL device on a free runtime slot (issue
/// #25 lot E — the traces panel's add-device path). Unlike `connect_device`,
/// the id is REQUIRED and a unit already open anywhere is rejected
/// (`Device already open: <id>`) instead of superseded — adding must never
/// steal an open unit's claim. Any enumerated unit qualifies, virtual
/// included (a virtual unit never unplugs, so no monitor is spawned for it).
#[tauri::command]
async fn connect_additional_device(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    device_id: String,
) -> Result<String, String> {
    info!("Connect additional device command called ({device_id})");
    let devices = { state.lock().await.devices.clone() };
    let desc = devices
        .open_additional(&device::DeviceId::from_wire(device_id))
        .await
        .map_err(|e| format!("Failed to connect: {}", e))?;

    // Watch THIS open for unplug — same rules as connect_device: resolved by
    // the unit just opened (never "the default"), physical units only.
    if !desc.identity.is_virtual {
        if let Ok(rt) = devices.runtime_for(Some(desc.id.as_str())) {
            device::spawn_liveness_monitor(rt, move |lost| {
                let _ = app_handle.emit("device-disconnected", lost);
            });
        }
    }

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
    let devices = state.lock().await.devices.clone();
    devices
        .open_virtual()
        .await
        .map_err(|e| format!("Failed to connect to the virtual device: {}", e))?;
    Ok("Connected to the virtual QA40x (demo mode)".to_string())
}

#[tauri::command]
async fn disconnect_device(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    device_id: Option<String>,
) -> Result<String, String> {
    info!("Disconnect device command called");
    let devices = { state.lock().await.devices.clone() };
    let rt = runtime_for_command(&state, device_id.as_deref()).await?;
    // The stream loop (or the gap-free generator) owns captures; closing the
    // device underneath it would only manufacture a capture error. Hand the
    // device back first — quiesce returns once the loops fully exited, so
    // the stream channel gets a clean Stopped, never an Error. (quiesce also
    // trips the sweep cancel — the PR #35 follow-up: disconnect during a
    // batched sweep no longer waits the sweep out.) close_runtime keeps the
    // teardown on the SAME runtime the command routed to (review F3).
    rt.quiesce().await;

    devices.close_runtime(&rt).await
        .map(|_| "Disconnected successfully".to_string())
        .map_err(|e| format!("Failed to disconnect: {}", e))
}

#[tauri::command]
async fn is_device_connected(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    device_id: Option<String>,
) -> Result<bool, String> {
    // Scoped guard: never hold the AppState lock while awaiting the device
    // mutex — a long capture would otherwise park this command holding
    // AppState, stalling every sibling command behind it.
    let device = runtime_for_command(&state, device_id.as_deref()).await?.handle();
    let connected = device.lock().await.is_connected().await;
    Ok(connected)
}

/// Device identity (firmware version + serial + product), read at connect.
/// Returns null when not connected.
#[tauri::command]
async fn get_device_info(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    device_id: Option<String>,
) -> Result<Option<qa40x::DeviceMeta>, String> {
    // Scoped guard — same rule as is_device_connected.
    let device = runtime_for_command(&state, device_id.as_deref()).await?.handle();
    let meta = device.lock().await.device_meta().await;
    Ok(meta)
}

/// Every unit the registry can currently offer (USB + built-in virtual), with
/// the open unit's entry enriched (issue #25 lot D — the device bar's feed).
#[tauri::command]
async fn list_devices(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<device::DeviceList, String> {
    // Scoped guard, then scan — same rule as is_hardware_present: never hold
    // the AppState lock across a bus scan.
    let devices = state.lock().await.devices.clone();
    Ok(devices.list().await)
}

/// Whether a QA40x (QA402 or QA403) is present on the USB bus (for auto-connect),
/// regardless of whether we are connected to it.
#[tauri::command]
async fn is_device_present(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<bool, String> {
    let devices = state.lock().await.devices.clone();
    Ok(devices.any_present().await)
}

/// Whether REAL hardware is on the USB bus — the virtual device never counts.
/// Polled by the frontend during a demo session so a newly plugged QA40x
/// takes over from the simulator.
#[tauri::command]
async fn is_hardware_present(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<bool, String> {
    // Registry-side scan: same bus predicate as before, but no longer queued
    // on the exclusive device mutex (this is polled during demo sessions,
    // and a long capture used to delay the hand-over poll).
    let devices = state.lock().await.devices.clone();
    Ok(devices.physical_present().await)
}

#[tauri::command]
async fn set_input_gain(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    gain_dbv: i32,
    device_id: Option<String>,
) -> Result<String, String> {
    let device = runtime_for_command(&state, device_id.as_deref()).await?.handle();
    let device = device.lock().await;

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
    device_id: Option<String>,
) -> Result<String, String> {
    let device = runtime_for_command(&state, device_id.as_deref()).await?.handle();
    let device = device.lock().await;

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
    device_id: Option<String>,
) -> Result<String, String> {
    let device = runtime_for_command(&state, device_id.as_deref()).await?.handle();
    let device = device.lock().await;

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
async fn get_device_config(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    device_id: Option<String>,
) -> Result<DeviceConfig, String> {
    let device = runtime_for_command(&state, device_id.as_deref()).await?.handle();
    let device = device.lock().await;
    Ok(device.get_config().await)
}

#[tauri::command]
async fn read_device_config(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    device_id: Option<String>,
) -> Result<DeviceConfig, String> {
    let device = runtime_for_command(&state, device_id.as_deref()).await?.handle();
    let device = device.lock().await;
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
    device_id: Option<String>,
) -> Result<(), String> {
    let ctl = runtime_for_command(&state, device_id.as_deref()).await?.stream();
    ctl.start(config, on_frame).await
}

/// Swap the running stream's configuration (sources, FFT size, window,
/// averaging, spectra request, output-range policy). Takes effect at the
/// next frame. Also valid while stopped: the next `stream_start` config wins.
#[tauri::command]
async fn stream_update(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    config: stream::StreamConfig,
    device_id: Option<String>,
) -> Result<(), String> {
    let ctl = runtime_for_command(&state, device_id.as_deref()).await?.stream();
    ctl.update(config)
}

/// Stop the stream loop and wait until it has fully exited (so a restart —
/// or a measurement program taking the device — is deterministic).
#[tauri::command]
async fn stream_stop(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    device_id: Option<String>,
) -> Result<(), String> {
    let ctl = runtime_for_command(&state, device_id.as_deref()).await?.stream();
    ctl.stop_and_wait().await;
    Ok(())
}

/// Whether the v2 stream loop is currently running.
#[tauri::command]
async fn stream_status(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    device_id: Option<String>,
) -> Result<bool, String> {
    let ctl = runtime_for_command(&state, device_id.as_deref()).await?.stream();
    Ok(ctl.is_running())
}

/// Abort an in-flight batched sweep (THD vs freq/level): the capture pump
/// checks this flag between USB blocks and closes its stream through the
/// normal STREAM_STOP + drain path — the command then rejects with
/// "sweep cancelled". No-op when nothing sweeps (the next batch clears it).
#[tauri::command]
async fn sweep_stop(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    device_id: Option<String>,
) -> Result<(), String> {
    // New behavior confined to the new arg: an unknown `device_id` errors
    // where the arg-less call stays the unconditional no-op it always was.
    let rt = runtime_for_command(&state, device_id.as_deref()).await?;
    rt.cancel_sweep();
    Ok(())
}

/// Empty the spectrum-averaging accumulators (both input channels) so the
/// rolling window restarts from the next frame — the user's "Reset avg"
/// after changing something on the bench. Config untouched; no-op when idle.
#[tauri::command]
async fn stream_reset_averaging(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    device_id: Option<String>,
) -> Result<(), String> {
    let ctl = runtime_for_command(&state, device_id.as_deref()).await?.stream();
    ctl.reset_averaging();
    Ok(())
}

/// Drop every scope-measurement stats window (all four endpoints) so the
/// avg/min/max/σ readouts restart from the next frame — the user's "Reset
/// stats" after retuning the signal (issue #26 lot B). No-op when idle.
#[tauri::command]
async fn stream_reset_measure_stats(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    device_id: Option<String>,
) -> Result<(), String> {
    let ctl = runtime_for_command(&state, device_id.as_deref()).await?.stream();
    ctl.reset_measure_stats();
    Ok(())
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
    device_id: Option<String>,
) -> Result<mixer::OutputOnlyStatus, String> {
    if slots.is_empty() {
        return Err("output-only: no signal source is playing".into());
    }
    let rt = runtime_for_command(&state, device_id.as_deref()).await?;
    let device = rt.handle();
    let mx = rt.mixer();
    rt.stream().stop_and_wait().await;
    rt.generator().ensure_stopped().await;
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
    // Per-unit DAC trims (issue #8) — read AFTER the range write above: the
    // trim record follows the active output range.
    let (dac_trims, _) = device.lock().await.dac_trims().await;
    let clipped = mixer::scale_mix_to_range(&mut frame.left, &mut frame.right, range, dac_trims);

    rt.spawn_generator_loop(frame.left, frame.right);
    Ok(mixer::OutputOnlyStatus {
        sigma_peak_dbv,
        clipped,
        fitted_output_range_dbv: range,
        errors,
    })
}

/// Stop the continuous signal generator.
#[tauri::command]
async fn stop_generator(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    device_id: Option<String>,
) -> Result<String, String> {
    let rt = runtime_for_command(&state, device_id.as_deref()).await?;
    rt.generator().ensure_stopped().await;
    Ok("Generator stopped".into())
}

/// Whether the continuous generator is currently running.
#[tauri::command]
async fn is_generator_running(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    device_id: Option<String>,
) -> Result<bool, String> {
    let rt = runtime_for_command(&state, device_id.as_deref()).await?;
    Ok(rt.generator().is_running())
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
    device_id: Option<String>,
) -> Result<InputDbvOffset, String> {
    let device = runtime_for_command(&state, device_id.as_deref()).await?.handle();
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
    device_id: Option<String>,
) -> Result<InputDbvOffset, String> {
    let device = runtime_for_command(&state, device_id.as_deref()).await?.handle();
    let device = device.lock().await;
    let (offset_db, calibrated) = device.output_dbv_offset(output_channel).await;
    Ok(InputDbvOffset { offset_db, calibrated })
}

/// Live hardware telemetry (USB voltage/current, ISO current, temperature).
/// The frontend polls this while connected and idle.
#[tauri::command]
async fn read_telemetry(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    device_id: Option<String>,
) -> Result<qa40x::Telemetry, String> {
    let device = runtime_for_command(&state, device_id.as_deref()).await?.handle();
    let device = device.lock().await;
    device.read_telemetry().await.map_err(|e| e.to_string())
}

/// LINK-LED keepalive: ping the link register + read telemetry, mirroring the
/// official app's ~1 s poll so the LINK LED stays lit while connected and idle.
#[tauri::command]
async fn keepalive(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    device_id: Option<String>,
) -> Result<qa40x::Telemetry, String> {
    let device = runtime_for_command(&state, device_id.as_deref()).await?.handle();
    let device = device.lock().await;
    device.keepalive().await.map_err(|e| e.to_string())
}

/// Telemetry from the most recent keepalive (idle poll, the between-frame
/// ping, or the in-capture keepalive the stream pump fires at ~1 Hz — issue
/// #54), with NO USB I/O of its own — the UI polls this while a run owns the
/// stream. `None` until a keepalive has run.
#[tauri::command]
async fn last_telemetry(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    device_id: Option<String>,
) -> Result<Option<qa40x::Telemetry>, String> {
    // Pure cache read — deliberately NOT through the exclusive device mutex:
    // this polls every second during a run, and queuing it behind a long
    // capture both delays the readout and lengthens the lock's FIFO queue.
    let cell = runtime_for_command(&state, device_id.as_deref()).await?.telemetry_cell();
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
    device_id: Option<String>,
) -> Result<(), String> {
    use tauri::Emitter;
    // Real flashing is enabled: the KBOOT HID transport is confirmed against NXP's
    // reference (spsdk + pyMBoot) and the capture cross-checks its shape. The
    // command still re-verifies the signature + connected model below, and the
    // frontend requires an explicit confirmation — never auto-invoked.
    let store = { state.lock().await.firmware_images.clone() };
    let rt = runtime_for_command(&state, device_id.as_deref()).await?;
    let device = rt.handle();
    // The open generation at command entry: the bootloader detach below must
    // clear THIS open's bookkeeping, never a newer one's (a reconnect racing
    // the flash).
    let flash_gen = rt.generation();
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
    // The unit is detaching to re-enumerate as the bootloader — the registry
    // must not keep reporting it open. Generation-keyed: a stale flash can't
    // wipe a newer open's bookkeeping. Whoever applies the clear OWNS the
    // user notification (the note_closed_at token contract): the liveness
    // monitor will see `current` already empty and stay silent, so the event
    // must be emitted HERE — review F1: without it the UI stays "connected"
    // to a unit that detached into the bootloader, and the post-flash replug
    // never auto-reconnects (autoConnectTick only runs while disconnected).
    let lost_id = rt.device_id().map(|id| id.as_str().to_string());
    if rt.note_closed_at(flash_gen) {
        let _ = app.emit("device-disconnected", device::DeviceLost { device_id: lost_id });
    }

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
    device_id: Option<String>,
) -> Result<Vec<qa40x::FrequencyResponseTrace>, String> {
    use measurement::MeasurementProgram;
    let rt = runtime_for_command(&state, device_id.as_deref()).await?;
    let mut session = measurement::Session::new(
        rt.handle(),
        rt.generator().running_flag().clone(),
        rt.generator().stop_flag().clone(),
    );
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
    device_id: Option<String>,
) -> Result<audio::ThdSweepResult, String> {
    let rt = runtime_for_command(&state, device_id.as_deref()).await?;
    let sweep_cancel = rt.sweep_cancel().clone();
    rt.generator().ensure_stopped().await;
    let device = rt.handle();
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

/// event { done, total, level } per point so the UI can show progress.
/// Sibling of `measure_thd_vs_frequency` (issue #27): sweeps the stimulus
/// level at a FIXED tone frequency instead of sweeping frequency at a fixed
/// level. Same one-stream batched capture, same `run_thd_batch` plumbing —
/// only the swept axis differs ("level" vs "frequency").
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command: args map 1:1 to the UI form.
async fn measure_thd_vs_level(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    start_level_dbfs: f32,
    end_level_dbfs: f32,
    num_points: usize,
    frequency_hz: f32,
    output_channel: qa40x::Channel,
    input_channel: qa40x::Channel,
    device_id: Option<String>,
) -> Result<audio::ThdSweepResult, String> {
    let rt = runtime_for_command(&state, device_id.as_deref()).await?;
    let sweep_cancel = rt.sweep_cancel().clone();
    rt.generator().ensure_stopped().await;
    let device = rt.handle();
    let device = device.lock().await;

    let sr = device.get_config().await.sample_rate.as_hz() as f32;
    let nyquist = sr / 2.0;
    // Same fundamental ceiling as the frequency sweep: the 2nd harmonic must
    // clear Nyquist for THD to be measurable at all.
    let fmax = nyquist * 0.45;
    let freq = frequency_hz.max(1.0).min(fmax);
    let n = num_points.clamp(2, 200);
    let levels = level_points(start_level_dbfs, end_level_dbfs, n);

    info!(
        "THD vs level: {:.1} Hz, {:.1}..{:.1} dBFS, {} points",
        freq,
        levels.first().copied().unwrap_or(0.0),
        levels.last().copied().unwrap_or(0.0),
        n
    );

    let pts_spec: Vec<(f32, f32)> = levels.into_iter().map(|lvl| (freq, lvl)).collect();
    run_thd_batch(
        &app,
        &device,
        pts_spec,
        output_channel,
        input_channel,
        "level",
        &sweep_cancel,
    )
    .await
}

/// Measure wow & flutter (issue #28) on a reference tone (DIN/IEC 386
/// approximation, typically 3150 Hz). Session-scoped like the other
/// discrete measurement commands: no state survives the call besides the
/// device handle itself, and channels are named per-endpoint (issue #25 —
/// never "the device"). Cancellable through the SAME `sweep_cancel` flag /
/// `sweep_stop` command the batched THD sweep uses — safe to share because
/// only one exclusive measurement program runs at a time.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command: args map 1:1 to the UI form.
async fn measure_wow_flutter(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    reference_freq: f32,
    duration_secs: f32,
    output_channel: qa40x::Channel,
    input_channel: qa40x::Channel,
    generate: bool,
    device_id: Option<String>,
) -> Result<audio::WowFlutterResult, String> {
    let rt = runtime_for_command(&state, device_id.as_deref()).await?;
    let sweep_cancel = rt.sweep_cancel().clone();
    rt.generator().ensure_stopped().await;
    // A fresh call consumes any stale Stop click from a previous run (same
    // rule as run_thd_batch's "a fresh batch consumes any stale stop click").
    sweep_cancel.store(false, Ordering::SeqCst);
    let device = rt.handle();
    let device = device.lock().await;
    device
        .measure_wow_flutter(
            reference_freq,
            duration_secs,
            output_channel,
            input_channel,
            generate,
            Some(&sweep_cancel),
        )
        .await
        .map_err(|e| match e {
            qa40x::QA40xError::Cancelled => "wow & flutter measurement cancelled".to_string(),
            e => format!("wow & flutter measurement failed: {e}"),
        })
}

/// Measure signal/noise levels on `input_channel`: unweighted / A / C RMS +
/// peak (dBFS), plus absolute Vrms/dBV/dBu via calibration (issue #29 — the
/// UI's counterpart to the THD/FR sweeps: a single exclusive-device
/// generate+capture, no progress events). With `generate` a stimulus tone
/// plays (self-test); otherwise silence is sent and the input is monitored
/// (e.g. a DUT's own noise floor).
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command: args map 1:1 to the UI form.
async fn measure_levels(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    input_channel: qa40x::Channel,
    output_channel: qa40x::Channel,
    duration_secs: f32,
    generate: bool,
    stimulus_freq: f32,
    stimulus_dbfs: f32,
    device_id: Option<String>,
) -> Result<audio::LevelResult, String> {
    let rt = runtime_for_command(&state, device_id.as_deref()).await?;
    rt.generator().ensure_stopped().await;
    let device = rt.handle();
    let device = device.lock().await;
    device
        .measure_levels(
            input_channel,
            output_channel,
            duration_secs,
            generate,
            stimulus_freq,
            stimulus_dbfs,
        )
        .await
        .map_err(|e| format!("levels measurement failed: {}", e))
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
            connect_additional_device,
            connect_virtual_device,
            disconnect_device,
            is_hardware_present,
            is_device_connected,
            is_device_present,
            list_devices,
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
            stream_reset_measure_stats,
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
            measure_thd_vs_level,
            measure_wow_flutter,
            measure_levels,
            firmware::extract_firmware_from_exe,
            firmware::extract_firmware_from_setup,
            firmware::list_qa40x_releases,
            firmware::download_qa40x_setup,
            flash_dry_run,
            flash_firmware,
            export::export_write_file,
            export::export_copy_image,
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

/// Ascending dB level sequence for a THD-vs-level sweep: `n` points spanning
/// `start_dbfs`..`end_dbfs`, clamped to the digital-full-scale ceiling
/// [-80, 0] dBFS. Extracted from `measure_thd_vs_level` (issue #27 review
/// finding #2) so its edge cases are directly testable:
///
/// - order-independent: a descending request (`end < start`, e.g. "sweep
///   down from 0 to -40") is SWAPPED to ascending rather than crushed —
///   the old code forced `hi >= lo` by clamping `hi` up towards `lo`
///   (mirroring the frequency sweep's `lo * 1.01` guard), which silently
///   replaced the requested span with a near-zero one (or, when
///   `start > end` by a lot, inverted it into a vertical/degenerate one).
///   The chart only needs the x-axis ascending, not the request order
///   preserved, so swapping keeps the full requested span;
/// - NaN in either bound is ABSORBED, not propagated: `.max()`/`.min()`
///   return the non-NaN operand (finding #6) — unlike `f32::clamp`, which
///   returns NaN unchanged when its `self` is NaN (only panics on a NaN
///   *bound*), so a NaN `self` used to poison the whole sweep;
/// - `n == 1` returns a single point (`lo`) instead of dividing by
///   `n - 1 == 0` — unreachable through the command today (`num_points`
///   is clamped to >= 2 first) but pinned here so a future refactor can't
///   quietly reintroduce the panic.
fn level_points(start_dbfs: f32, end_dbfs: f32, n: usize) -> Vec<f32> {
    // NOT `.clamp()`: clippy's manual_clamp lint wants that rewrite, but its
    // own note says why it's wrong HERE — "clamp returns NaN if the input is
    // NaN". `.max().min()` is the whole point: it ABSORBS a NaN bound
    // (returns the other, non-NaN operand) instead of propagating it
    // (finding #6).
    #[allow(clippy::manual_clamp)]
    let clamp = |v: f32| v.max(-80.0).min(0.0);
    let mut lo = clamp(start_dbfs);
    let mut hi = clamp(end_dbfs);
    if hi < lo {
        std::mem::swap(&mut lo, &mut hi);
    }
    if n <= 1 {
        return vec![lo];
    }
    (0..n)
        .map(|i| lo + (hi - lo) * i as f32 / (n - 1) as f32)
        .collect()
}

#[cfg(test)]
mod app_state_tests {
    use super::*;

    #[tokio::test]
    async fn the_runtime_and_its_handle_are_created_once_and_never_replaced() {
        // Lot-B invariant, extended to the whole runtime (lot C): REST,
        // scripting, the stream loop and the measurement sessions capture
        // Arcs out of the default runtime at construction — a registry that
        // ever replaced the runtime (or any object inside it) would
        // silently detach them from the device the connection commands
        // drive.
        let state = AppState::new();
        let rt = state.devices.default_runtime();
        assert!(Arc::ptr_eq(&rt.handle(), &state.devices.handle()));
        assert!(Arc::ptr_eq(&rt.telemetry_cell(), &state.devices.telemetry_cell()));
        let rt2 = state.devices.default_runtime();
        assert!(Arc::ptr_eq(&rt.handle(), &rt2.handle()));
        assert!(Arc::ptr_eq(&rt.mixer(), &rt2.mixer()));
        assert!(Arc::ptr_eq(rt.generator().running_flag(), rt2.generator().running_flag()));
        assert!(Arc::ptr_eq(rt.sweep_cancel(), rt2.sweep_cancel()));
    }
}

#[cfg(test)]
mod command_arg_tests {
    use super::*;

    fn invoke(
        webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
        cmd: &str,
        body: serde_json::Value,
    ) -> Result<tauri::ipc::InvokeResponseBody, serde_json::Value> {
        tauri::test::get_ipc_response(
            webview,
            tauri::webview::InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                // The app origin per platform (the tauri::test doc example):
                // anything else is treated as a REMOTE origin and refused by
                // the capability check before deserialization even runs.
                url: if cfg!(any(windows, target_os = "android")) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .expect("url"),
                body: tauri::ipc::InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
        )
    }

    /// The lot-C plan's risk R1, pinned through the REAL IPC layer (mock
    /// runtime, actual command deserialization): an OMITTED `device_id`
    /// resolves to `None` — every pre-lot-C caller (frontend, e2e, REST-side
    /// invokes) sends no such key and must behave exactly as before — while
    /// an explicit id that names nothing open errors, never falls back.
    #[test]
    fn an_omitted_device_id_deserializes_to_none_through_the_real_ipc_layer() {
        let app = tauri::test::mock_builder()
            .manage(Arc::new(Mutex::new(AppState::new())))
            .invoke_handler(tauri::generate_handler![sweep_stop])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview");

        // No `deviceId` key at all — the pre-lot-C wire shape. sweep_stop
        // with no id is the unconditional no-op it always was.
        invoke(&webview, "sweep_stop", serde_json::json!({}))
            .expect("an omitted Option arg must deserialize to None, not error");

        // An explicit id with nothing open: UnknownDevice, surfaced as the
        // command's error string.
        let err = invoke(
            &webview,
            "sweep_stop",
            serde_json::json!({ "deviceId": "usb/NOPE" }),
        )
        .expect_err("an unknown device id must be an error");
        assert!(
            format!("{err:?}").contains("Unknown device: usb/NOPE"),
            "unexpected error payload: {err:?}"
        );
    }

    /// Issue #25 lot E: `open_additional` never treats an empty/garbage id as
    /// "pick something" — the guard against `connect_additional_device`'s
    /// `device_id: String` (REQUIRED, unlike every other device command's
    /// `Option<String>`) ever degrading into a silent default (e.g. an
    /// `unwrap_or_default()` regression feeding it `""`). NOTE: the command
    /// layer's OWN arg deserialization (a missing `deviceId` key failing the
    /// IPC call) could not be pinned through `command_arg_tests`' mock-IPC
    /// pattern the way `sweep_stop`'s is: `connect_additional_device` takes
    /// `app_handle: tauri::AppHandle`, which resolves to the concrete
    /// `AppHandle<Wry>` (`#[default_runtime(crate::Wry, wry)]`) and cannot
    /// satisfy `CommandArg<MockRuntime>` — `tauri::generate_handler!` simply
    /// fails to compile with it under `tauri::test::mock_builder()`. This is
    /// the same pre-existing limitation `connect_device` already has (never
    /// unit-tested this way either), not something lot E introduced; fixing
    /// it would mean making the command generic over `R: Runtime`, a
    /// production-code change outside a test-only pass.
    #[tokio::test]
    async fn open_additional_with_an_empty_id_never_silently_opens_something() {
        let state = Arc::new(Mutex::new(AppState::new()));
        let devices = { state.lock().await.devices.clone() };
        devices.open_virtual().await.expect("demo unit opens on slot 0");

        let err = devices
            .open_additional(&device::DeviceId::from_wire(""))
            .await
            .expect_err("an empty id must never resolve to some open unit");
        assert!(matches!(err, device::DeviceError::NotFound));
        // NOT `runtimes().len() == 1`: `open_additional` reserves a free slot
        // BEFORE attempting the open (`free_or_new_runtime`, then
        // `open_locked`), so a failed open still grows the vector by one —
        // consistent with the "slots never shrink" invariant. The reserved
        // slot stays genuinely empty and gets reused by the NEXT
        // open_additional call (`free_or_new_runtime` picks any runtime with
        // nothing open first), so repeated bogus ids do not keep burning
        // fresh slots toward MAX_DEVICES. What must hold is: nothing is
        // open on it, and the default device is untouched.
        assert_eq!(devices.runtimes().len(), 2, "a slot was reserved for the attempt, then left empty");
        assert!(devices.runtimes()[1].current().is_none(), "the reserved slot has nothing open");
        assert_eq!(devices.current().expect("slot 0 untouched").id.source(), "virtual");
    }

    /// Issue #25 lot E acceptance test through the REAL command/IPC layer
    /// (mock runtime, actual `#[tauri::command]` deserialization + `State`
    /// extraction for the command UNDER TEST): with a demo unit on slot 0
    /// (opened through the real `connect_virtual_device` IPC call) and a
    /// SECOND unit added directly through the registry (`open_additional` —
    /// see the note on `connect_additional_device`'s AppHandle above for why
    /// its own wrapper can't run under this harness; its body is exactly
    /// this call), a keyed command naming the second device's id must reach
    /// ITS runtime, never fall back to the default slot. `sweep_cancel` is a
    /// per-runtime flag readable without going through the command layer
    /// again, so it pins the routing precisely: if `sweep_stop`'s
    /// `device_id` threading or `runtime_for_command` ever regressed to
    /// always resolving slot 0 regardless of the id, this test would catch
    /// it (rt0's flag would flip instead of rt1's, or both, or neither).
    #[tokio::test]
    async fn sweep_stop_with_the_second_devices_id_cancels_only_that_runtimes_flag() {
        let app_state = Arc::new(Mutex::new(AppState::new()));
        let app = tauri::test::mock_builder()
            .manage(app_state.clone())
            .invoke_handler(tauri::generate_handler![connect_virtual_device, sweep_stop])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview");

        invoke(&webview, "connect_virtual_device", serde_json::json!({}))
            .expect("the demo unit opens on slot 0 through the real command");
        {
            let devices = { app_state.lock().await.devices.clone() };
            devices
                .open_additional(&device::DeviceId::from_wire("virtual/0DE0_0002"))
                .await
                .expect("the built-in second virtual unit opens on a fresh slot");
        }

        let devices = { app_state.lock().await.devices.clone() };
        let rt0 = devices.runtime_for(None).expect("default routes to slot 0");
        let rt1 = devices
            .runtime_for(Some("virtual/0DE0_0002"))
            .expect("the second id routes to slot 1");
        assert!(!rt0.sweep_cancel().load(Ordering::SeqCst), "nothing cancelled yet");
        assert!(!rt1.sweep_cancel().load(Ordering::SeqCst), "nothing cancelled yet");

        invoke(
            &webview,
            "sweep_stop",
            serde_json::json!({ "deviceId": "virtual/0DE0_0002" }),
        )
        .expect("sweep_stop routes to the second device");

        assert!(
            rt1.sweep_cancel().load(Ordering::SeqCst),
            "the SECOND runtime's sweep-cancel flag must be set"
        );
        assert!(
            !rt0.sweep_cancel().load(Ordering::SeqCst),
            "the DEFAULT (slot 0) runtime must be untouched by a keyed sweep_stop"
        );
    }

    /// Companion to the sweep_stop routing test, over `disconnect_device` +
    /// `is_device_connected` (both AppHandle-free, so both go through the
    /// real IPC layer end to end): a keyed LIFECYCLE command (closing a
    /// runtime, not just flipping a flag on it) must also target only the
    /// named device. Disconnecting the second unit must leave the default
    /// device connected and reachable by `None`; the second id must then be
    /// gone (its slot freed, `UnknownDevice`) rather than the default device
    /// having been torn down instead.
    #[tokio::test]
    async fn disconnect_device_with_the_second_devices_id_leaves_the_default_device_connected() {
        let app_state = Arc::new(Mutex::new(AppState::new()));
        let app = tauri::test::mock_builder()
            .manage(app_state.clone())
            .invoke_handler(tauri::generate_handler![
                connect_virtual_device,
                disconnect_device,
                is_device_connected,
            ])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview");

        invoke(&webview, "connect_virtual_device", serde_json::json!({}))
            .expect("the demo unit opens on slot 0 through the real command");
        {
            let devices = { app_state.lock().await.devices.clone() };
            devices
                .open_additional(&device::DeviceId::from_wire("virtual/0DE0_0002"))
                .await
                .expect("the second unit opens on a fresh slot");
        }

        let connected =
            |body: tauri::ipc::InvokeResponseBody| -> bool { body.deserialize().expect("bool response") };
        assert!(connected(
            invoke(&webview, "is_device_connected", serde_json::json!({})).expect("default connected")
        ));
        assert!(connected(
            invoke(
                &webview,
                "is_device_connected",
                serde_json::json!({ "deviceId": "virtual/0DE0_0002" })
            )
            .expect("second device connected")
        ));

        invoke(
            &webview,
            "disconnect_device",
            serde_json::json!({ "deviceId": "virtual/0DE0_0002" }),
        )
        .expect("disconnecting the second device by id");

        // The default device (slot 0) must be entirely untouched.
        assert!(
            connected(
                invoke(&webview, "is_device_connected", serde_json::json!({}))
                    .expect("default still routes")
            ),
            "a keyed disconnect must never tear down the default runtime"
        );
        // The second device is gone — its slot freed, so naming it now errors.
        invoke(
            &webview,
            "is_device_connected",
            serde_json::json!({ "deviceId": "virtual/0DE0_0002" }),
        )
        .expect_err("the disconnected second device's id must no longer route anywhere");
    }
}

#[cfg(test)]
mod level_points_tests {
    use super::level_points;

    #[test]
    fn ascending_request_is_unchanged() {
        assert_eq!(level_points(-60.0, 0.0, 5), vec![-60.0, -45.0, -30.0, -15.0, 0.0]);
    }

    #[test]
    fn descending_request_is_swapped_not_crushed() {
        // The exact bug report: start=-6, end=-60 must NOT collapse to a
        // ~0.1 dB span around -6 — it must span the full 54 dB, ascending.
        assert_eq!(
            level_points(-6.0, -60.0, 5),
            vec![-60.0, -46.5, -33.0, -19.5, -6.0]
        );
    }

    #[test]
    fn start_zero_end_very_negative_is_not_a_vertical_line() {
        // The second bug report: start=0, end=-40 used to collapse to
        // lo == hi == 0 (a degenerate flat/vertical sweep).
        let pts = level_points(0.0, -40.0, 5);
        assert_eq!(pts, vec![-40.0, -30.0, -20.0, -10.0, 0.0]);
        assert!(pts[0] < pts[4], "must be a real, non-degenerate span");
    }

    #[test]
    fn equal_bounds_are_a_legitimate_flat_sweep() {
        // Not a bug: the user asked for one level, n times.
        assert_eq!(level_points(-6.0, -6.0, 5), vec![-6.0; 5]);
    }

    #[test]
    fn out_of_range_bounds_clamp_to_the_dbfs_ceiling() {
        assert_eq!(level_points(10.0, -100.0, 3), vec![-80.0, -40.0, 0.0]);
    }

    #[test]
    fn n_equals_one_returns_a_single_point_without_dividing_by_zero() {
        assert_eq!(level_points(-60.0, 0.0, 1), vec![-60.0]);
        assert_eq!(level_points(-60.0, 0.0, 0), vec![-60.0]); // n=0 degrades the same way
    }

    #[test]
    fn nan_in_either_bound_is_absorbed_to_the_clamp_floor_not_propagated() {
        let pts = level_points(f32::NAN, -6.0, 3);
        assert_eq!(pts, vec![-80.0, -43.0, -6.0]);
        assert!(pts.iter().all(|v| v.is_finite()), "no NaN must survive");

        let pts2 = level_points(-6.0, f32::NAN, 3);
        assert_eq!(pts2, vec![-80.0, -43.0, -6.0]);
    }
}

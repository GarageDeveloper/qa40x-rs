//! The `device()` verb end to end over the real registry (issue #25 lot F6):
//! a script bound to an ADDITIONAL device's runtime reads THAT unit's
//! identity — never the default device's — through exactly the wiring
//! `script_run` installs (a Session on the resolved runtime + a
//! `DeviceInfoFn` over the same runtime's bookkeeping). No hardware: the
//! built-in virtual units.
//!
//! Runtime shape (the F1/E1 findings): a MULTI-thread runtime built by the
//! test, with the script run driven from the test thread through the
//! runtime's handle — the virtual endpoint workers are spawned on the
//! ambient runtime, and blocking the only worker starves them.

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex as StdMutex};

use tauri_app_lib::device::{DeviceId, DeviceRegistry, DeviceRuntime};
use tauri_app_lib::measurement::Session;
use tauri_app_lib::script::{run_measurement_script, ScriptEnv};

/// Same rationale as `device_runtime.rs`: each test owns its simulators; the
/// lock serializes the realtime-paced ones.
static SIM_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn test_rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("test runtime")
}

/// Exactly `script_run`'s per-runtime construction: the session from the
/// resolved runtime's handle + generator flags, the `device()` provider from
/// the same runtime's live bookkeeping.
fn env_for(
    rt: &DeviceRuntime,
    handle: tokio::runtime::Handle,
    lines: Arc<StdMutex<Vec<String>>>,
) -> Arc<ScriptEnv> {
    let session = Session::new(
        rt.handle(),
        rt.generator().running_flag().clone(),
        rt.generator().stop_flag().clone(),
    );
    let sunk = lines.clone();
    let rt_for_info = rt.clone();
    Arc::new(
        ScriptEnv::new(
            session,
            handle,
            Arc::new(AtomicBool::new(false)),
            Arc::new(move |s: &str, _e: bool| sunk.lock().unwrap().push(s.to_string())),
            Arc::new(|_f| {}),
            Arc::new(|_c| {}),
        )
        .with_device_info(Arc::new(move || rt_for_info.current())),
    )
}

#[test]
fn a_script_running_on_slot_1_sees_slot_1s_device() {
    let rt = test_rt();
    let _guard = rt.block_on(SIM_LOCK.lock());
    let reg = DeviceRegistry::new();
    rt.block_on(reg.open_virtual()).expect("the default virtual unit opens on slot 0");
    rt.block_on(reg.open_additional(&DeviceId::from_wire("virtual/0DE0_0002"), None))
        .expect("the second virtual unit opens on a fresh slot");
    let rt1 = reg.runtime_for(Some("virtual/0DE0_0002")).expect("slot 1 resolves");

    let lines = Arc::new(StdMutex::new(Vec::new()));
    let env = env_for(&rt1, rt.handle().clone(), lines.clone());
    run_measurement_script(
        env,
        r#"let d = device();
           print(d.id); print(d.model); print(d.connected); print(d.is_virtual);"#,
    )
    .expect("the script runs");
    let out = lines.lock().unwrap().clone();
    assert_eq!(out[0], "virtual/0DE0_0002", "device() names the BOUND unit, not the default");
    assert_eq!(out[1], "QA403");
    assert_eq!(out[2], "true");
    assert_eq!(out[3], "true");
}

#[test]
fn a_script_on_the_default_device_names_the_default_unit() {
    let rt = test_rt();
    let _guard = rt.block_on(SIM_LOCK.lock());
    let reg = DeviceRegistry::new();
    rt.block_on(reg.open_virtual()).expect("the default virtual unit opens on slot 0");
    rt.block_on(reg.open_additional(&DeviceId::from_wire("virtual/0DE0_0002"), None))
        .expect("the second virtual unit opens on a fresh slot");
    let rt0 = reg.runtime_for(None).expect("None resolves to the default runtime");

    let lines = Arc::new(StdMutex::new(Vec::new()));
    let env = env_for(&rt0, rt.handle().clone(), lines.clone());
    run_measurement_script(env, r#"print(device().id); print(device().connected);"#)
        .expect("the script runs");
    let out = lines.lock().unwrap().clone();
    assert_ne!(out[0], "virtual/0DE0_0002", "the default run must not see the added unit");
    assert!(out[0].starts_with("virtual/"), "got: {}", out[0]);
    assert_eq!(out[1], "true");
}

/// Two module-doc claims pinned together against one real virtual open
/// (issue #25 lot F6 coverage hunt — `script.rs`'s `device()` doc):
///
/// (a) `device()` is read LIVE, not a run-start snapshot — a
/// `set_sample_rate()`/`set_input_range()`/`set_output_range()` earlier in
/// the SAME script shows up in the very next `device()` call. The unit
/// tests only ever call `device()` without reconfiguring first (a bare
/// `Session` can't accept a range change unless it matches the default —
/// see `changing_a_range_needs_the_device` in `script.rs`), so this is the
/// first pin that actually changes a value and reads it back.
///
/// (b) `caps.calibration` on a REAL registry open of the built-in virtual
/// unit is `"factory"`, not `"unknown"` — the embedded sim serves a genuine
/// factory calibration page (already established by
/// `tests/virtual_device.rs`'s `dbv_stimulus_lands_at_the_commanded_level_once_trimmed`,
/// which prices a real DAC/ADC trim off it). The `script.rs` unit tests only
/// ever exercise `caps.calibration` off `device::testing::fake_descriptor`,
/// whose calibration is deliberately left `Unknown` — never off a real open.
#[test]
fn a_reconfiguring_script_sees_the_live_change_and_the_sims_real_calibration_tag() {
    let rt = test_rt();
    let _guard = rt.block_on(SIM_LOCK.lock());
    let reg = DeviceRegistry::new();
    rt.block_on(reg.open_virtual()).expect("the default virtual unit opens on slot 0");
    let rt0 = reg.runtime_for(None).expect("None resolves to the default runtime");

    let lines = Arc::new(StdMutex::new(Vec::new()));
    let env = env_for(&rt0, rt.handle().clone(), lines.clone());
    run_measurement_script(
        env,
        r#"set_sample_rate(96000);
           set_input_range(18);
           set_output_range(18);
           let d = device();
           print(d.sample_rate); print(d.input_range); print(d.output_range);
           print(d.caps.calibration);"#,
    )
    .expect("the script runs");
    let out = lines.lock().unwrap().clone();
    assert_eq!(out, vec!["96000", "18", "18", "factory"]);
}

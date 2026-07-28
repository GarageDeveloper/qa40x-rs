//! Integration of the device registry (issue #25 lot B) over the built-in
//! virtual source: enumerate without booting the simulator, open by id, read
//! identity/capabilities through the seam AND through the legacy device
//! getters, close, reopen (simulator state and single-attach guard). No
//! hardware, no USB.

use tauri_app_lib::device::{Analyzer, CalibrationSource, DeviceRegistry, SourceKind};

/// Each test builds its own registry, hence its own Simulator (the exclusive
/// attach guard is per instance, so tests could not collide on it). The lock
/// only serializes the realtime-paced simulators so timing-sensitive
/// assertions don't share CPU, and failures stay readable.
static SIM_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The pinned demo serial (see `qa40x::transport::DEMO_SERIAL`).
const DEMO_SERIAL: &str = tauri_app_lib::qa40x::transport::DEMO_SERIAL;

#[tokio::test(flavor = "multi_thread")]
async fn enumeration_lists_the_virtual_unit_with_full_capabilities() {
    let _sim = SIM_LOCK.lock().await;
    let reg = DeviceRegistry::new();

    // A dev bench may have real hardware plugged in — assert on the virtual
    // subset: the pinned demo unit FIRST (open_virtual picks the first free
    // one, so the demo path lands on it), plus lot E's second unit.
    let descs = reg.enumerate().await;
    let virt: Vec<_> = descs.iter().filter(|d| d.identity.is_virtual).collect();
    assert_eq!(virt.len(), 2, "the built-in virtual units: demo + lot E's second");
    assert_eq!(
        virt[1].id.as_str(),
        "virtual/0DE0_0002",
        "the second unit's serial is pinned and distinct"
    );
    let d = virt[0];
    assert_eq!(d.id.as_str(), format!("virtual/{DEMO_SERIAL}"));
    assert_eq!(d.id.source(), "virtual");
    assert_eq!(d.identity.serial, DEMO_SERIAL);
    assert_eq!(d.identity.firmware_version, None, "unopened: identity is bus-side only");
    assert_eq!(d.capabilities.calibration, CalibrationSource::Unknown);
    assert_eq!(d.capabilities.sample_rates_hz, vec![48_000, 96_000, 192_000, 384_000]);
    assert_eq!(d.capabilities.input_ranges_dbv, vec![0, 6, 12, 18, 24, 30, 36, 42]);
    assert_eq!(d.capabilities.output_ranges_dbv, vec![-12, -2, 8, 18]);
    assert!(!d.capabilities.supports_flash);

    // Enumeration must be side-effect free: nothing opened, nothing current.
    assert!(reg.current().is_none());
    assert!(!reg.handle().lock().await.is_connected().await);
}

#[tokio::test(flavor = "multi_thread")]
async fn open_close_reopen_the_virtual_unit_by_id() {
    let _sim = SIM_LOCK.lock().await;
    let reg = DeviceRegistry::new();
    let id = reg
        .enumerate()
        .await
        .into_iter()
        .find(|d| d.identity.is_virtual)
        .expect("virtual unit enumerated")
        .id;

    // Open by id — the descriptor comes back enriched by the bring-up.
    let opened = reg.open(&id).await.expect("open virtual unit");
    assert_eq!(
        opened.identity.serial, DEMO_SERIAL,
        "the register-0x1D read-back must reproduce the pinned serial"
    );
    assert!(opened.identity.firmware_version.is_some(), "opened: firmware known");
    assert_eq!(
        opened.capabilities.calibration,
        CalibrationSource::FactoryEeprom { page_bytes: 512 },
        "the simulator serves a real factory calibration page"
    );

    // The legacy device surface agrees (DeviceMeta parity at runtime).
    let handle = reg.handle();
    {
        let dev = handle.lock().await;
        let meta = dev.device_meta().await.expect("meta after open");
        assert!(meta.is_virtual);
        assert_eq!(meta.model, "QA403");
        assert_eq!(meta.serial, DEMO_SERIAL);
        assert!(!meta.supports_flash);

        // And the Analyzer seam reads the same unit.
        let analyzer: &dyn Analyzer = &*dev;
        assert!(analyzer.is_connected().await);
        let identity = analyzer.identity().await.expect("identity via the trait");
        assert_eq!(identity.serial, DEMO_SERIAL);
        let caps = analyzer.capabilities().await.expect("caps via the trait");
        assert_eq!(caps.calibration, CalibrationSource::FactoryEeprom { page_bytes: 512 });
    }

    // Bookkeeping + presence semantics.
    let current = reg.current().expect("current open device");
    assert_eq!(current.id, id);
    assert!(reg.any_present().await, "the open virtual device counts as present");

    // Close: safe teardown + cleared bookkeeping.
    reg.close().await.expect("close");
    assert!(reg.current().is_none());
    assert!(!handle.lock().await.is_connected().await);

    // Reopen through the demo-mode door: the source reuses ITS simulator, so
    // the exclusive-attach guard must have been released by close().
    let again = reg.open_virtual().await.expect("reopen after close");
    assert_eq!(again.identity.serial, DEMO_SERIAL);
    assert!(handle.lock().await.is_connected().await);
    reg.close().await.expect("second close");
}

#[tokio::test(flavor = "multi_thread")]
async fn every_analyzer_trait_method_runs_on_a_live_device_without_recursing() {
    // The trait impl delegates to the INHERENT methods purely by method-
    // resolution precedence (same names). If an inherent method were renamed,
    // the identical call would bind to the trait method itself — infinite
    // recursion at runtime, not a compile error. Driving the FULL trait
    // surface on a live device pins every delegation.
    use tauri_app_lib::qa40x::{InputGain, OutputGain, SampleRate};

    let _sim = SIM_LOCK.lock().await;
    let reg = DeviceRegistry::new();
    reg.open_virtual().await.expect("open virtual");
    let handle = reg.handle();
    let dev = handle.lock().await;
    let analyzer: &dyn Analyzer = &*dev;

    assert!(analyzer.is_connected().await);
    assert!(analyzer.identity().await.is_some());
    assert!(analyzer.capabilities().await.is_some());
    analyzer.set_input_range(InputGain::Gain18dBV).await.expect("set input range");
    analyzer.set_output_range(OutputGain::Gain8dBV).await.expect("set output range");
    analyzer.set_sample_rate(SampleRate::Rate96kHz).await.expect("set sample rate");
    let cfg = analyzer.config().await;
    assert_eq!(cfg.input_gain, InputGain::Gain18dBV);
    assert_eq!(cfg.output_gain, OutputGain::Gain8dBV);
    assert_eq!(cfg.sample_rate, SampleRate::Rate96kHz);
    // No keepalive ran in this session — the cache read must be None, not I/O.
    assert!(analyzer.last_telemetry().await.is_none());
    analyzer.disconnect().await.expect("disconnect via the trait");
    assert!(!analyzer.is_connected().await);
    drop(dev);
    reg.note_closed();
}

/// Issue #25 lot E, end to end over the built-in virtual source: TWO devices
/// live at once without any hardware — the demo unit on slot 0 plus the
/// second virtual unit added on slot 1 — each with its own device object and
/// register state; closing one leaves the other untouched.
#[tokio::test(flavor = "multi_thread")]
async fn two_virtual_units_live_simultaneously_with_independent_state() {
    use tauri_app_lib::qa40x::SampleRate;

    let _sim = SIM_LOCK.lock().await;
    let reg = DeviceRegistry::new();

    // Demo path first (slot 0), then add the second unit (slot 1).
    let demo = reg.open_virtual().await.expect("demo on slot 0");
    assert_eq!(demo.identity.serial, DEMO_SERIAL);
    let second_id = reg
        .enumerate()
        .await
        .into_iter()
        .find(|d| d.identity.is_virtual && d.identity.serial != DEMO_SERIAL)
        .expect("the second virtual unit enumerates")
        .id;
    let added = reg.open_additional(&second_id, None).await.expect("second unit on slot 1");
    assert_eq!(added.identity.serial, "0DE0_0002", "0x1D round-trip of the pinned serial");

    let rt0 = reg.runtime_for(Some(demo.id.as_str())).expect("slot 0 routes");
    let rt1 = reg.runtime_for(Some(added.id.as_str())).expect("slot 1 routes");

    // Both genuinely connected, on DISTINCT device objects.
    assert!(rt0.handle().lock().await.is_connected().await);
    assert!(rt1.handle().lock().await.is_connected().await);
    assert!(!std::sync::Arc::ptr_eq(&rt0.handle(), &rt1.handle()));

    // Independent register state: a rate set on one never leaks to the other.
    rt1.handle()
        .lock()
        .await
        .set_sample_rate(SampleRate::Rate192kHz)
        .await
        .expect("set rate on slot 1");
    let rate0 = rt0.handle().lock().await.get_config().await.sample_rate;
    let rate1 = rt1.handle().lock().await.get_config().await.sample_rate;
    assert_eq!(rate1, SampleRate::Rate192kHz);
    assert_ne!(rate0, SampleRate::Rate192kHz, "slot 0 must keep its own rate");

    // Close slot 1 only: the demo session survives untouched.
    reg.close_runtime(&rt1).await.expect("close slot 1");
    assert!(!rt1.handle().lock().await.is_connected().await);
    assert!(rt0.handle().lock().await.is_connected().await, "slot 0 survives slot 1's close");
    assert_eq!(reg.current().expect("slot 0 still open").id, demo.id);

    reg.close().await.expect("close slot 0");
    assert!(reg.slot_of(demo.id.as_str()).is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_virtual_source_is_never_physically_present() {
    let _sim = SIM_LOCK.lock().await;
    let reg = DeviceRegistry::new();
    reg.open_virtual().await.expect("open virtual");
    // Whatever the bus holds, the OPEN VIRTUAL unit must not satisfy the
    // hardware predicate (the demo hand-over relies on this): with a QA40x
    // plugged in this is true for the right reason, without one it must be
    // false even though a device is open.
    let hw = reg.physical_present().await;
    let bus_has_hw = tauri_app_lib::device::usb::any_unit_present().await;
    assert_eq!(hw, bus_has_hw, "physical presence must reflect the bus, not the open device");
    reg.close().await.expect("close");
}

#[tokio::test(flavor = "multi_thread")]
async fn source_kinds_are_wired() {
    // Cheap sanity on the app registry's composition: one physical USB
    // source, one virtual — via their enumerations' source ids.
    let _sim = SIM_LOCK.lock().await;
    let reg = DeviceRegistry::new();
    let descs = reg.enumerate().await;
    for d in descs.iter().filter(|d| d.identity.is_virtual) {
        assert_eq!(d.source.as_str(), "virtual");
    }
    for d in descs.iter().filter(|d| !d.identity.is_virtual) {
        assert_eq!(d.source.as_str(), "usb");
    }
    // SourceKind is exported and matchable (lot D consumes it).
    let _ = SourceKind::Usb;
}

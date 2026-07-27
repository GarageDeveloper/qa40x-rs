//! The [`DeviceRegistry`]: owns the session's device handle, unions its
//! sources' enumerations, and opens units onto the handle.
//!
//! Lot B invariants:
//! - the handle is created ONCE at construction and never replaced — every
//!   consumer (REST, scripting, stream loop, measurement sessions) holds the
//!   same `Arc`, so swapping it would silently detach them;
//! - still exactly one open device (`current` is an `Option`, not a map —
//!   lot E changes that);
//! - `current()` is bookkeeping, not authority: the device's own state
//!   (`is_connected`) remains the truth, and unplug/bootloader paths call
//!   [`DeviceRegistry::note_closed`] so the two never disagree for long.

use std::sync::Arc;

use log::warn;
use tokio::sync::Mutex;

use crate::qa40x::Telemetry;

use super::error::DeviceError;
use super::id::{DeviceDescriptor, DeviceId, SourceKind};
use super::runtime::DeviceRuntime;
use super::source::{DeviceHandle, DeviceSource};
use super::usb::UsbDeviceSource;
use super::virt::VirtualDeviceSource;

/// The unit currently open on the handle.
#[derive(Clone, Debug)]
pub struct OpenDevice {
    pub id: DeviceId,
    pub descriptor: DeviceDescriptor,
}

struct RegistryInner {
    sources: Vec<Arc<dyn DeviceSource>>,
    /// Lot C: exactly one runtime — the default device slot. Lot E: a map
    /// keyed by `DeviceId` plus this one as the default slot. The open/close
    /// bookkeeping (current unit, generation, serialization gate) lives on
    /// the runtime itself.
    runtime: DeviceRuntime,
}

#[derive(Clone)]
pub struct DeviceRegistry {
    inner: Arc<RegistryInner>,
}

impl DeviceRegistry {
    /// The app's registry: the local USB bus + the built-in virtual source.
    pub fn new() -> Self {
        Self::with_sources(vec![
            Arc::new(UsbDeviceSource::new()),
            Arc::new(VirtualDeviceSource::builtin()),
        ])
    }

    /// Registry over arbitrary sources (tests).
    pub fn with_sources(sources: Vec<Arc<dyn DeviceSource>>) -> Self {
        Self {
            inner: Arc::new(RegistryInner {
                sources,
                runtime: DeviceRuntime::new(),
            }),
        }
    }

    /// The default device's runtime — the same runtime instance on every
    /// call (the never-replaced invariant, now covering the whole runtime).
    pub fn default_runtime(&self) -> DeviceRuntime {
        self.inner.runtime.clone()
    }

    /// Every runtime the registry owns (lot C: exactly one). The shutdown
    /// path iterates this so lot E's N-runtime map is a routing change.
    pub fn runtimes(&self) -> Vec<DeviceRuntime> {
        vec![self.inner.runtime.clone()]
    }

    /// Resolve a command's optional `device_id` to its runtime. `None` ⇒ the
    /// default device (the REST/scripting/e2e path, unchanged). `Some(id)`
    /// that is not currently open ⇒ [`DeviceError::UnknownDevice`], never a
    /// silent fallback: a caller naming a device that isn't there must fail.
    /// Cheap std-lock read — never queues behind a capture.
    pub fn runtime_for(&self, device_id: Option<&str>) -> Result<DeviceRuntime, DeviceError> {
        match device_id {
            None => Ok(self.default_runtime()),
            Some(id) => match self.inner.runtime.device_id() {
                Some(open) if open.as_str() == id => Ok(self.default_runtime()),
                _ => Err(DeviceError::UnknownDevice(id.to_string())),
            },
        }
    }

    /// The one device object of the session — the same `Arc` on every call.
    pub fn handle(&self) -> DeviceHandle {
        self.inner.runtime.handle()
    }

    /// The device's telemetry cache cell (readable without the device mutex).
    pub fn telemetry_cell(&self) -> Arc<Mutex<Option<Telemetry>>> {
        self.inner.runtime.telemetry_cell()
    }

    /// Union of all sources' enumerations, in source registration order,
    /// deduped by id. A source failing to enumerate is logged and skipped —
    /// one broken source must not blind the others.
    pub async fn enumerate(&self) -> Vec<DeviceDescriptor> {
        let mut seen = std::collections::HashSet::new();
        let mut all = Vec::new();
        for source in &self.inner.sources {
            match source.enumerate().await {
                Ok(descs) => {
                    for d in descs {
                        if seen.insert(d.id.clone()) {
                            all.push(d);
                        } else {
                            // Never silent: a dropped duplicate is a unit the
                            // user cannot select (two sources claiming the
                            // same id, or a key-collision bug upstream).
                            warn!("device id {} enumerated more than once — keeping the first", d.id);
                        }
                    }
                }
                Err(e) => warn!("device source {} failed to enumerate: {}", source.id(), e),
            }
        }
        all
    }

    /// Open the unit `id` onto the session handle. A second open supersedes
    /// the first (the source releases the handle's prior claim first —
    /// exactly what the pre-registry `connect()` did on reconnect). Held
    /// under the runtime's lifecycle gate for its WHOLE duration, so
    /// concurrent opens serialize and a concurrent `close()` waits this one
    /// out (lot-B review finding #1).
    pub async fn open(&self, id: &DeviceId) -> Result<DeviceDescriptor, DeviceError> {
        let _gate = self.inner.runtime.lifecycle_gate().lock().await;
        self.open_locked(id).await
    }

    /// The open body, ASSUMING the lifecycle gate is already held by the
    /// caller. `open_first_physical`/`open_virtual` call this — calling the
    /// public `open()` from them would re-enter the gate and deadlock.
    async fn open_locked(&self, id: &DeviceId) -> Result<DeviceDescriptor, DeviceError> {
        let source = self
            .inner
            .sources
            .iter()
            .find(|s| s.id().as_str() == id.source())
            .ok_or(DeviceError::NotFound)?;
        // The previous unit is gone the moment the source starts releasing
        // the handle — clear the bookkeeping BEFORE delegating, so a failed
        // open (unit unplugged mid-open, claim raced by another app) never
        // leaves `current` reporting a device that was already torn down.
        // An unknown SOURCE errored out above without touching the device,
        // so whatever was open before is honestly still open.
        self.inner.runtime.note_closed();
        let desc = source.open(id, &self.inner.runtime.handle()).await?;
        self.inner.runtime.note_open(id.clone(), desc.clone());
        Ok(desc)
    }

    /// Open the first physical unit any source offers — the `connect_device`
    /// behavior (auto-connect to "the" QA40x). When nothing physical is on
    /// the bus, the handle's prior claim is still released, exactly like the
    /// legacy `connect()` which released before scanning. A bus-scan FAILURE
    /// is not "not found": the first scan error is returned so the user sees
    /// the actual diagnostic (permission-denied backend, broken hub), as the
    /// legacy `connect()` surfaced it.
    pub async fn open_first_physical(&self) -> Result<DeviceDescriptor, DeviceError> {
        // One gate acquisition for the whole scan+open (open_locked, NOT the
        // public open(), which would re-enter the gate and deadlock).
        let _gate = self.inner.runtime.lifecycle_gate().lock().await;
        let mut scan_err: Option<DeviceError> = None;
        for source in &self.inner.sources {
            if !source.is_physical() {
                continue;
            }
            match source.enumerate().await {
                Ok(descs) => {
                    if let Some(d) = descs.first() {
                        return self.open_locked(&d.id).await;
                    }
                }
                Err(e) => {
                    warn!("device source {} failed to enumerate: {}", source.id(), e);
                    scan_err.get_or_insert(e);
                }
            }
        }
        self.inner.runtime.handle().lock().await.release_claim().await;
        self.inner.runtime.note_closed();
        Err(scan_err.unwrap_or(DeviceError::NotFound))
    }

    /// Open the first built-in virtual unit — the `connect_virtual_device`
    /// (demo mode) behavior.
    pub async fn open_virtual(&self) -> Result<DeviceDescriptor, DeviceError> {
        // Same single gate acquisition as open_first_physical.
        let _gate = self.inner.runtime.lifecycle_gate().lock().await;
        for source in &self.inner.sources {
            if source.kind() != SourceKind::Virtual {
                continue;
            }
            match source.enumerate().await {
                Ok(descs) => {
                    if let Some(d) = descs.first() {
                        return self.open_locked(&d.id).await;
                    }
                }
                Err(e) => warn!("device source {} failed to enumerate: {}", source.id(), e),
            }
        }
        Err(DeviceError::NotFound)
    }

    /// Close the DEFAULT device (safe-state teardown included) — the
    /// unrouted legacy form; the routed form is [`Self::close_runtime`].
    pub async fn close(&self) -> Result<(), DeviceError> {
        let rt = self.default_runtime();
        self.close_runtime(&rt).await
    }

    /// Close a SPECIFIC runtime's device (safe-state teardown included). The
    /// caller has already stopped that runtime's loops, same as before.
    /// Waits out an in-flight open on the runtime's lifecycle gate first, so
    /// a close racing a connect can never interleave with it. Taking the
    /// runtime (not an id) keeps `disconnect_device` routing and teardown on
    /// the SAME device — the lot-E "routing, not refactor" premise
    /// (review F3).
    pub async fn close_runtime(&self, rt: &DeviceRuntime) -> Result<(), DeviceError> {
        let _gate = rt.lifecycle_gate().lock().await;
        let res = rt.teardown().await;
        // Bookkeeping is cleared even on a failed teardown: the intent was to
        // close, and the device's own state has been torn down best-effort.
        rt.note_closed();
        res
    }

    /// The unit currently open, per the default runtime's bookkeeping.
    pub fn current(&self) -> Option<OpenDevice> {
        self.inner.runtime.current()
    }

    /// Record that the device closed OUTSIDE `close()` — unplug detected by
    /// the USB monitor, bootloader detach during a flash. Generation-blind
    /// (kept for the lot-B call sites); the generation-keyed form is
    /// [`DeviceRuntime::note_closed_at`].
    pub fn note_closed(&self) {
        self.inner.runtime.note_closed();
    }

    /// Whether REAL hardware is present on any physical source — never
    /// satisfied by the virtual source (the demo hand-over predicate).
    pub async fn physical_present(&self) -> bool {
        for source in &self.inner.sources {
            if !source.is_physical() {
                continue;
            }
            if matches!(source.enumerate().await, Ok(descs) if !descs.is_empty()) {
                return true;
            }
        }
        false
    }

    /// Whether any device is present for auto-connect purposes: the open
    /// virtual device counts (it lives in-process, not on the bus), else the
    /// bus is scanned — the pre-registry `is_present` semantics, unchanged.
    pub async fn any_present(&self) -> bool {
        self.inner.runtime.handle().lock().await.is_present().await
    }
}

impl Default for DeviceRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device::testing::FakeSource;

    fn registry(sources: Vec<Arc<dyn DeviceSource>>) -> DeviceRegistry {
        DeviceRegistry::with_sources(sources)
    }

    #[tokio::test]
    async fn enumeration_unions_sources_in_order_and_dedupes_by_id() {
        let reg = registry(vec![
            Arc::new(FakeSource::new("usb", true, &["A", "B"])),
            Arc::new(FakeSource::new("virtual", false, &["V"])),
            // A second source claiming an id the first already offered.
            Arc::new(FakeSource::new("usb", true, &["A"])),
        ]);
        let ids: Vec<String> = reg.enumerate().await.iter().map(|d| d.id.as_str().to_string()).collect();
        assert_eq!(ids, vec!["usb/A", "usb/B", "virtual/V"]);
    }

    #[tokio::test]
    async fn a_failing_source_is_skipped_not_fatal() {
        let reg = registry(vec![
            Arc::new(FakeSource::failing("usb", true)),
            Arc::new(FakeSource::new("virtual", false, &["V"])),
        ]);
        let descs = reg.enumerate().await;
        assert_eq!(descs.len(), 1, "the healthy source must still enumerate");
        assert_eq!(descs[0].id.as_str(), "virtual/V");
    }

    #[tokio::test]
    async fn open_unknown_id_is_not_found() {
        let reg = registry(vec![Arc::new(FakeSource::new("usb", true, &["A"]))]);
        let missing_unit = reg.open(&DeviceId::new(&crate::device::SourceId::new("usb"), "Z")).await;
        assert!(matches!(missing_unit, Err(DeviceError::NotFound)));
        let missing_source = reg.open(&DeviceId::new(&crate::device::SourceId::new("nope"), "A")).await;
        assert!(matches!(missing_source, Err(DeviceError::NotFound)));
        assert!(reg.current().is_none(), "a failed open must not record a current device");
    }

    #[tokio::test]
    async fn a_failed_open_after_a_successful_one_does_not_keep_lying_about_the_old_device() {
        // Review finding (#25 lot B): the USB source releases the prior claim
        // BEFORE it can fail (unit unplugged mid-open, claim raced), so once
        // the source was engaged, the previously open unit is gone —
        // `current` must not keep reporting it.
        let reg = registry(vec![Arc::new(FakeSource::new("usb", true, &["A"]))]);
        let a = reg.enumerate().await[0].id.clone();
        reg.open(&a).await.expect("open A");
        assert_eq!(reg.current().expect("current").id, a);

        // Unknown SOURCE: rejected before any source touches the device —
        // the prior unit is honestly still open.
        let missing_source = reg.open(&DeviceId::new(&crate::device::SourceId::new("nope"), "A")).await;
        assert!(matches!(missing_source, Err(DeviceError::NotFound)));
        assert_eq!(reg.current().expect("survives an unrouted open").id, a);

        // Known source, unknown UNIT: the source was engaged (a real USB
        // source has already released the claim by the time it notices), so
        // the bookkeeping must be cleared, not left pointing at A.
        let missing_unit = reg.open(&DeviceId::new(&crate::device::SourceId::new("usb"), "Z")).await;
        assert!(matches!(missing_unit, Err(DeviceError::NotFound)));
        assert!(reg.current().is_none(), "a failed open must clear the stale bookkeeping");
    }

    #[tokio::test]
    async fn a_total_scan_failure_surfaces_the_scan_error_not_not_found() {
        // Review finding (#25 lot B): a user whose USB backend is broken
        // (permissions, dead hub) must see the OS diagnostic, not be told
        // there is no device — the legacy connect() surfaced the scan error.
        let reg = registry(vec![
            Arc::new(FakeSource::failing("usb1", true)),
            Arc::new(FakeSource::new("usb2", true, &[])),
            Arc::new(FakeSource::new("virtual", false, &["V"])),
        ]);
        let err = reg.open_first_physical().await.expect_err("no unit to open");
        assert_eq!(err.to_string(), "fake enumeration failure", "the first scan error must survive");
    }

    #[tokio::test]
    async fn a_second_open_supersedes_the_first() {
        let reg = registry(vec![
            Arc::new(FakeSource::new("usb", true, &["A", "B"])),
        ]);
        let a = reg.enumerate().await[0].id.clone();
        let b = reg.enumerate().await[1].id.clone();
        reg.open(&a).await.expect("open A");
        assert_eq!(reg.current().expect("current").id, a);
        reg.open(&b).await.expect("open B");
        let cur = reg.current().expect("current");
        assert_eq!(cur.id, b, "exactly one open device, the last one opened");
    }

    #[tokio::test]
    async fn open_first_physical_skips_virtual_sources() {
        let reg = registry(vec![
            Arc::new(FakeSource::new("virtual", false, &["V"])),
            Arc::new(FakeSource::new("usb", true, &["A"])),
        ]);
        let d = reg.open_first_physical().await.expect("open");
        assert_eq!(d.id.as_str(), "usb/A");
    }

    #[tokio::test]
    async fn open_first_physical_with_nothing_on_the_bus_is_not_found() {
        let reg = registry(vec![
            Arc::new(FakeSource::new("usb", true, &[])),
            Arc::new(FakeSource::new("virtual", false, &["V"])),
        ]);
        assert!(matches!(reg.open_first_physical().await, Err(DeviceError::NotFound)));
        assert!(reg.current().is_none());
    }

    #[tokio::test]
    async fn open_first_physical_falls_through_an_empty_source_to_the_next_physical_one() {
        // Two physical sources: the first enumerates OK but offers nothing.
        // The scan must not stop there — an empty physical source is not the
        // same as "no physical units anywhere".
        let reg = registry(vec![
            Arc::new(FakeSource::new("usb1", true, &[])),
            Arc::new(FakeSource::new("usb2", true, &["A"])),
        ]);
        let d = reg.open_first_physical().await.expect("open from the second source");
        assert_eq!(d.id.as_str(), "usb2/A");
    }

    #[tokio::test]
    async fn open_first_physical_skips_a_failing_physical_source_and_tries_the_next() {
        // A source erroring on enumerate (bus scan failure) must be logged
        // and skipped, exactly like `enumerate()`'s union — but this is the
        // open_first_physical loop's OWN skip-on-error path, not that one.
        let reg = registry(vec![
            Arc::new(FakeSource::failing("usb1", true)),
            Arc::new(FakeSource::new("usb2", true, &["A"])),
        ]);
        let d = reg.open_first_physical().await.expect("open from the healthy source");
        assert_eq!(d.id.as_str(), "usb2/A");
    }

    #[tokio::test]
    async fn open_virtual_picks_the_first_virtual_unit() {
        let reg = registry(vec![
            Arc::new(FakeSource::new("usb", true, &["A"])),
            Arc::new(FakeSource::new("virtual", false, &["V1", "V2"])),
        ]);
        let d = reg.open_virtual().await.expect("open");
        assert_eq!(d.id.as_str(), "virtual/V1");
    }

    #[tokio::test]
    async fn open_virtual_with_no_virtual_source_is_not_found_and_leaves_bookkeeping_untouched() {
        // No virtual source at all. Unlike `open_first_physical` (which
        // explicitly releases the handle's claim and clears bookkeeping on a
        // failed scan — the legacy `connect()` behavior), `open_virtual` has
        // no such teardown: a failed demo hand-over must not detach whatever
        // physical unit is already open.
        let reg = registry(vec![Arc::new(FakeSource::new("usb", true, &["A"]))]);
        let a = reg.enumerate().await[0].id.clone();
        reg.open(&a).await.expect("open the physical unit first");
        assert!(reg.current().is_some());

        assert!(matches!(reg.open_virtual().await, Err(DeviceError::NotFound)));
        assert_eq!(
            reg.current().expect("the prior open must survive a failed open_virtual").id,
            a
        );
    }

    #[tokio::test]
    async fn physical_present_ignores_virtual_only_sources() {
        let virtual_only = registry(vec![Arc::new(FakeSource::new("virtual", false, &["V"]))]);
        assert!(!virtual_only.physical_present().await);

        let with_hw = registry(vec![
            Arc::new(FakeSource::new("virtual", false, &["V"])),
            Arc::new(FakeSource::new("usb", true, &["A"])),
        ]);
        assert!(with_hw.physical_present().await);
    }

    #[tokio::test]
    async fn close_without_ever_opening_is_ok_and_bookkeeping_stays_clear() {
        // `disconnect_device` can be invoked when nothing is open (e.g. a
        // stale frontend action, or teardown running twice); the underlying
        // `QA40xDevice::disconnect()` is documented best-effort and must not
        // error just because there was nothing to tear down.
        let reg = registry(vec![Arc::new(FakeSource::new("usb", true, &["A"]))]);
        assert!(reg.current().is_none());
        reg.close().await.expect("closing an already-closed registry must not error");
        assert!(reg.current().is_none());
    }

    #[tokio::test]
    async fn note_closed_clears_the_bookkeeping() {
        let reg = registry(vec![Arc::new(FakeSource::new("usb", true, &["A"]))]);
        let a = reg.enumerate().await[0].id.clone();
        reg.open(&a).await.expect("open");
        assert!(reg.current().is_some());
        reg.note_closed();
        assert!(reg.current().is_none());
    }

    /* ---- lot C: lifecycle gate + generations --------------------------- */

    #[tokio::test]
    async fn a_failed_teardown_still_clears_the_bookkeeping() {
        // The lot-B review's untestable branch, now pinned through the
        // runtime's teardown seam: `close()` must clear `current` even when
        // the device-side teardown errors — the intent was to close.
        let reg = registry(vec![Arc::new(FakeSource::new("usb", true, &["A"]))]);
        let a = reg.enumerate().await[0].id.clone();
        reg.open(&a).await.expect("open");
        assert!(reg.current().is_some());

        reg.default_runtime()
            .inject_teardown_fault(DeviceError::Source("teardown blew up".into()));
        let err = reg.close().await.expect_err("the injected fault must surface");
        assert_eq!(err.to_string(), "teardown blew up");
        assert!(reg.current().is_none(), "bookkeeping cleared even on failed teardown");
        assert!(reg.default_runtime().open_unit().get().is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn close_waits_for_an_in_flight_open() {
        // Lot-B review finding #1: a close racing an in-flight open must
        // wait the open out on the lifecycle gate — never interleave with
        // it (end state: closed, not "closed then re-opened by the loser").
        let reg = registry(vec![Arc::new(FakeSource::slow(
            "usb",
            true,
            &["A"],
            std::time::Duration::from_millis(150),
        ))]);
        let a = reg.enumerate().await[0].id.clone();

        let opener = {
            let reg = reg.clone();
            let a = a.clone();
            tokio::spawn(async move { reg.open(&a).await })
        };
        // Let the open reach the source's in-flight delay, then close.
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        reg.close().await.expect("close");

        opener.await.expect("join").expect("the open itself succeeded first");
        assert!(
            reg.current().is_none(),
            "close ran AFTER the in-flight open completed — final state must be closed"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn two_concurrent_opens_serialize_and_leave_exactly_one_open() {
        let src = Arc::new(FakeSource::slow(
            "usb",
            true,
            &["A", "B"],
            std::time::Duration::from_millis(50),
        ));
        let reg = registry(vec![src.clone()]);
        let a = reg.enumerate().await[0].id.clone();
        let b = reg.enumerate().await[1].id.clone();

        let g0 = reg.default_runtime().generation();
        let (ra, rb) = tokio::join!(
            { let r = reg.clone(); let a = a.clone(); async move { r.open(&a).await } },
            { let r = reg.clone(); let b = b.clone(); async move { r.open(&b).await } },
        );
        ra.expect("open A");
        rb.expect("open B");

        // Serialized: both opens ran to completion (no interleave), the
        // generation advanced once per open, exactly one unit is current.
        assert_eq!(src.opened.lock().expect("opened").len(), 2);
        let cur = reg.current().expect("one unit open");
        assert!(cur.id == a || cur.id == b);
        assert_eq!(reg.default_runtime().generation().0, g0.0 + 2);
    }

    #[tokio::test]
    async fn runtime_for_resolves_none_to_the_default_and_rejects_an_unknown_id() {
        let reg = registry(vec![Arc::new(FakeSource::new("usb", true, &["A"]))]);
        // `None` always resolves to the default runtime, open or not — the
        // REST/scripting/e2e path must behave exactly as before lot C.
        assert!(reg.runtime_for(None).is_ok());
        // A named unit that is not open is an error, never a fallback.
        let err = match reg.runtime_for(Some("usb/A")) {
            Err(e) => e,
            Ok(_) => panic!("nothing open yet — Some(id) must not resolve"),
        };
        assert_eq!(err.to_string(), "Unknown device: usb/A");

        let a = reg.enumerate().await[0].id.clone();
        reg.open(&a).await.expect("open");
        let rt = reg.runtime_for(Some("usb/A")).expect("the open unit resolves");
        assert!(Arc::ptr_eq(&rt.handle(), &reg.handle()));
        assert!(matches!(
            reg.runtime_for(Some("usb/Z")),
            Err(DeviceError::UnknownDevice(_))
        ));
    }

    #[tokio::test]
    async fn note_closed_at_ignores_a_stale_generation() {
        // The anti-regression for lot-B review finding #2: a monitor that
        // observed generation N must not wipe the bookkeeping once a newer
        // open (generation N+1) superseded it.
        let reg = registry(vec![Arc::new(FakeSource::new("usb", true, &["A", "B"]))]);
        let rt = reg.default_runtime();
        let a = reg.enumerate().await[0].id.clone();
        let b = reg.enumerate().await[1].id.clone();

        reg.open(&a).await.expect("open A");
        let gen_a = rt.generation();

        reg.open(&b).await.expect("open B supersedes A");
        assert!(!rt.note_closed_at(gen_a), "a stale generation must not apply");
        assert_eq!(rt.current().expect("B survives the stale note").id, b);

        // The CURRENT generation applies — once. The second call reports
        // "already closed" so a racing observer can't double-report.
        let gen_b = rt.generation();
        assert!(rt.note_closed_at(gen_b));
        assert!(rt.current().is_none());
        assert!(!rt.note_closed_at(gen_b), "nothing left to close");
    }

    #[tokio::test]
    async fn the_handle_is_created_once_and_never_replaced() {
        let reg = registry(vec![Arc::new(FakeSource::new("usb", true, &["A"]))]);
        let h1 = reg.handle();
        let a = reg.enumerate().await[0].id.clone();
        reg.open(&a).await.expect("open");
        let h2 = reg.handle();
        assert!(Arc::ptr_eq(&h1, &h2), "every consumer must keep holding the same device object");
        // And the clone shares the same registry (bookkeeping included).
        let clone = reg.clone();
        assert!(Arc::ptr_eq(&clone.handle(), &h1));
        assert_eq!(clone.current().expect("current").id, a);
    }
}

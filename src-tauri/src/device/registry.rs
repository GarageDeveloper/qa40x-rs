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
use std::sync::Mutex as StdMutex;

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
    /// keyed by `DeviceId` plus this one as the default slot.
    runtime: DeviceRuntime,
    /// std Mutex held only for a clone/replace, never across an await (the
    /// `StreamControl::config` rule).
    current: StdMutex<Option<OpenDevice>>,
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
                current: StdMutex::new(None),
            }),
        }
    }

    /// The default device's runtime — the same runtime instance on every
    /// call (the never-replaced invariant, now covering the whole runtime).
    pub fn default_runtime(&self) -> DeviceRuntime {
        self.inner.runtime.clone()
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
    /// exactly what the pre-registry `connect()` did on reconnect).
    pub async fn open(&self, id: &DeviceId) -> Result<DeviceDescriptor, DeviceError> {
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
        self.note_closed();
        let desc = source.open(id, &self.inner.runtime.handle()).await?;
        *self.inner.current.lock().expect("current lock") =
            Some(OpenDevice { id: id.clone(), descriptor: desc.clone() });
        // The runtime's own copy of "what is open on me" — readable without
        // the device mutex; the stream loop stamps it into every frame.
        self.inner.runtime.open_unit().set(Some(id.clone()));
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
        let mut scan_err: Option<DeviceError> = None;
        for source in &self.inner.sources {
            if !source.is_physical() {
                continue;
            }
            match source.enumerate().await {
                Ok(descs) => {
                    if let Some(d) = descs.first() {
                        return self.open(&d.id).await;
                    }
                }
                Err(e) => {
                    warn!("device source {} failed to enumerate: {}", source.id(), e);
                    scan_err.get_or_insert(e);
                }
            }
        }
        self.inner.runtime.handle().lock().await.release_claim().await;
        self.note_closed();
        Err(scan_err.unwrap_or(DeviceError::NotFound))
    }

    /// Open the first built-in virtual unit — the `connect_virtual_device`
    /// (demo mode) behavior.
    pub async fn open_virtual(&self) -> Result<DeviceDescriptor, DeviceError> {
        for source in &self.inner.sources {
            if source.kind() != SourceKind::Virtual {
                continue;
            }
            match source.enumerate().await {
                Ok(descs) => {
                    if let Some(d) = descs.first() {
                        return self.open(&d.id).await;
                    }
                }
                Err(e) => warn!("device source {} failed to enumerate: {}", source.id(), e),
            }
        }
        Err(DeviceError::NotFound)
    }

    /// Close the open device (safe-state teardown included). The caller has
    /// already stopped the stream/generator loops, same as before.
    pub async fn close(&self) -> Result<(), DeviceError> {
        let handle = self.inner.runtime.handle();
        let dev = handle.lock().await;
        let res = dev.disconnect().await.map(|_| ()).map_err(DeviceError::from);
        // Bookkeeping is cleared even on a failed teardown: the intent was to
        // close, and the device's own state has been torn down best-effort.
        self.note_closed();
        res
    }

    /// The unit currently open, per the registry's bookkeeping.
    pub fn current(&self) -> Option<OpenDevice> {
        self.inner.current.lock().expect("current lock").clone()
    }

    /// Record that the device closed OUTSIDE `close()` — unplug detected by
    /// the USB monitor, bootloader detach during a flash.
    pub fn note_closed(&self) {
        *self.inner.current.lock().expect("current lock") = None;
        self.inner.runtime.open_unit().set(None);
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

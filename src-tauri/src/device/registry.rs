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

use crate::qa40x::{QA40xDevice, Telemetry};

use super::error::DeviceError;
use super::id::{DeviceDescriptor, DeviceId, SourceKind};
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
    handle: DeviceHandle,
    telemetry: Arc<Mutex<Option<Telemetry>>>,
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
        let device = QA40xDevice::new();
        // Grab the telemetry cell BEFORE the device goes behind the mutex, so
        // pure cache readers never queue on the exclusive device lock (the
        // quit-hang rule — see `AppState`).
        let telemetry = device.telemetry_cell();
        Self {
            inner: Arc::new(RegistryInner {
                sources,
                handle: Arc::new(Mutex::new(device)),
                telemetry,
                current: StdMutex::new(None),
            }),
        }
    }

    /// The one device object of the session — the same `Arc` on every call.
    pub fn handle(&self) -> DeviceHandle {
        self.inner.handle.clone()
    }

    /// The device's telemetry cache cell (readable without the device mutex).
    pub fn telemetry_cell(&self) -> Arc<Mutex<Option<Telemetry>>> {
        self.inner.telemetry.clone()
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
        let desc = source.open(id, &self.inner.handle).await?;
        *self.inner.current.lock().expect("current lock") =
            Some(OpenDevice { id: id.clone(), descriptor: desc.clone() });
        Ok(desc)
    }

    /// Open the first physical unit any source offers — the `connect_device`
    /// behavior (auto-connect to "the" QA40x). When nothing physical is on
    /// the bus, the handle's prior claim is still released, exactly like the
    /// legacy `connect()` which released before scanning.
    pub async fn open_first_physical(&self) -> Result<DeviceDescriptor, DeviceError> {
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
                Err(e) => warn!("device source {} failed to enumerate: {}", source.id(), e),
            }
        }
        self.inner.handle.lock().await.release_claim().await;
        self.note_closed();
        Err(DeviceError::NotFound)
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
        let dev = self.inner.handle.lock().await;
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
        self.inner.handle.lock().await.is_present().await
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
    async fn open_virtual_picks_the_first_virtual_unit() {
        let reg = registry(vec![
            Arc::new(FakeSource::new("usb", true, &["A"])),
            Arc::new(FakeSource::new("virtual", false, &["V1", "V2"])),
        ]);
        let d = reg.open_virtual().await.expect("open");
        assert_eq!(d.id.as_str(), "virtual/V1");
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

//! The [`DeviceRegistry`]: owns the session's device runtimes, unions its
//! sources' enumerations, and opens units onto runtime slots.
//!
//! Lot B/E invariants:
//! - slot 0 is THE default runtime, created ONCE at construction and never
//!   replaced — every default-device consumer (REST, scripting, stream loop,
//!   measurement sessions) holds `Arc`s out of it, so swapping it would
//!   silently detach them. Lot E extends the rule to every slot: the slot
//!   vector GROWS and never shrinks within a session, and a slot's runtime
//!   is never replaced — slot indices stay stable so slot-keyed trace ids
//!   (lot E3) survive a disconnect/reconnect of the same slot;
//! - `current()` is bookkeeping, not authority: the device's own state
//!   (`is_connected`) remains the truth, and unplug/bootloader paths call
//!   [`DeviceRegistry::note_closed`] so the two never disagree for long.
//!
//! Lock order: registry `open_gate` → runtime `lifecycle_gate` → device
//! mutex. `close_runtime` takes only the runtime gate, so a close never
//! cycles with an open.

use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use log::warn;
use tokio::sync::Mutex;

use crate::qa40x::Telemetry;

use super::error::DeviceError;
use super::id::{DeviceDescriptor, DeviceId, SourceKind, Transport};
use super::runtime::DeviceRuntime;
use super::source::{DeviceHandle, DeviceSource};
use super::usb::UsbDeviceSource;
use super::virt::VirtualDeviceSource;
use super::wire::{DeviceEntry, DeviceList};

/// Ceiling on simultaneously allocated runtime slots (issue #25 lot E) — a
/// backstop far above any real bench, so a UI bug can't leak runtimes
/// unbounded.
pub const MAX_DEVICES: usize = 8;

/// The unit currently open on the handle.
#[derive(Clone, Debug)]
pub struct OpenDevice {
    pub id: DeviceId,
    pub descriptor: DeviceDescriptor,
}

/// The exact bus position of a USB transport, if any — the scan-stable unit
/// identity (`usb::matches_port` rationale).
fn usb_port(t: &Transport) -> Option<(&str, &[u8])> {
    match t {
        Transport::Usb { bus_id, port_chain, .. } => Some((bus_id.as_str(), port_chain.as_slice())),
        Transport::Virtual => None,
    }
}

/// A unit key's serial part — everything before the first collision
/// separator (`usb::keys_for` builds `<serial>@<path>` keys when serial
/// twins collide; a plain serial has no `@`).
fn base_unit_key(id: &DeviceId) -> &str {
    id.unit_key().split('@').next().unwrap_or("")
}

/// Whether `candidate` is the OPEN unit under a re-keyed identity (lot-D
/// review #2): same source, same exact bus position, and the SAME serial
/// base — the shape `usb::keys_for` produces when a serial twin appears
/// (`S` → `S@path-…`) or disappears (`S@path-…` → `S`). A DIFFERENT unit
/// swapped onto the same physical port (the everyday one-cable bench swap)
/// carries its own serial and must NEVER match — substituting it would hide
/// the newly plugged unit behind the stale open descriptor (adversarial
/// review, MUST-FIX #1).
fn rekeyed_twin_of(open: &DeviceDescriptor, candidate: &DeviceDescriptor) -> bool {
    candidate.id.source() == open.id.source()
        && usb_port(&candidate.transport).is_some()
        && usb_port(&candidate.transport) == usb_port(&open.transport)
        && base_unit_key(&candidate.id) == base_unit_key(&open.id)
}

struct RegistryInner {
    sources: Vec<Arc<dyn DeviceSource>>,
    /// The runtime slots (issue #25 lot E). Slot 0 exists from construction
    /// and is the default device; the vector grows on demand (up to
    /// [`MAX_DEVICES`]) and NEVER shrinks — see the module doc. std Mutex
    /// held only for reads/pushes, never across an await.
    runtimes: StdMutex<Vec<DeviceRuntime>>,
    /// Serializes slot SELECTION + open across the whole registry: an open
    /// holds it for its WHOLE duration, so two concurrent opens can neither
    /// interleave on one runtime nor race each other onto the same free
    /// slot. Deliberate cost (documented, accepted): a wedged USB open
    /// blocks adding another device for its duration — exactly the
    /// serialization the single lifecycle gate imposed before lot E.
    open_gate: Mutex<()>,
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
                runtimes: StdMutex::new(vec![DeviceRuntime::new()]),
                open_gate: Mutex::new(()),
            }),
        }
    }

    /// The default device's runtime (slot 0) — the same runtime instance on
    /// every call (the never-replaced invariant, covering the whole runtime).
    pub fn default_runtime(&self) -> DeviceRuntime {
        self.inner.runtimes.lock().expect("runtimes lock")[0].clone()
    }

    /// Every runtime slot the registry has allocated, in slot order. The
    /// shutdown path tears all of them down concurrently.
    pub fn runtimes(&self) -> Vec<DeviceRuntime> {
        self.inner.runtimes.lock().expect("runtimes lock").clone()
    }

    /// The slot index of the runtime with `id` open, if any.
    pub fn slot_of(&self, id: &str) -> Option<usize> {
        self.inner
            .runtimes
            .lock()
            .expect("runtimes lock")
            .iter()
            .position(|rt| rt.device_id().is_some_and(|open| open.as_str() == id))
    }

    /// Resolve a command's optional `device_id` to its runtime. `None` ⇒ the
    /// default device (the REST/scripting/e2e path, unchanged). `Some(id)`
    /// that is not currently open on ANY slot ⇒
    /// [`DeviceError::UnknownDevice`], never a silent fallback: a caller
    /// naming a device that isn't there must fail. Cheap std-lock read —
    /// never queues behind a capture.
    pub fn runtime_for(&self, device_id: Option<&str>) -> Result<DeviceRuntime, DeviceError> {
        match device_id {
            None => Ok(self.default_runtime()),
            Some(id) => self
                .inner
                .runtimes
                .lock()
                .expect("runtimes lock")
                .iter()
                .find(|rt| rt.device_id().is_some_and(|open| open.as_str() == id))
                .cloned()
                .ok_or_else(|| DeviceError::UnknownDevice(id.to_string())),
        }
    }

    /// The DEFAULT device object of the session — the same `Arc` on every
    /// call (slot 0's handle).
    pub fn handle(&self) -> DeviceHandle {
        self.default_runtime().handle()
    }

    /// The default device's telemetry cache cell (readable without the
    /// device mutex).
    pub fn telemetry_cell(&self) -> Arc<Mutex<Option<Telemetry>>> {
        self.default_runtime().telemetry_cell()
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

    /// The frontend device bar's answer (issue #25 lot D): the enumeration
    /// union with each OPEN unit's entry substituted by its ENRICHED
    /// descriptor (firmware version + calibration source, knowable only from
    /// an open — [`DeviceSource::open`] returns it and the runtime keeps it),
    /// carrying its runtime slot. An open unit that stopped enumerating
    /// (unplugged mid-teardown, or its whole source erroring) is appended
    /// rather than dropped, in slot order: the bar must keep showing what
    /// the app is still connected to.
    ///
    /// Substitution matches on the exact wire id first, then — for an open
    /// unit whose id no longer enumerates — on the USB bus position (lot E,
    /// closing lot-D review #2): when a serial-twin appears, `usb::keys_for`
    /// promotes both twins' keys to path-suffixed ids, so the open unit's
    /// OLD id vanishes from the enumeration while the unit itself still sits
    /// at its port. The port-matched enumeration entry is REPLACED by the
    /// enriched open descriptor under its stable open id (the id every
    /// routed command still resolves), so the bar shows no ghost pair; the
    /// twin at the other port lists normally under its suffixed id.
    pub async fn list(&self) -> DeviceList {
        // Open units in slot order, keyed for substitution.
        let mut open_descs: std::collections::HashMap<String, (DeviceDescriptor, u32)> =
            std::collections::HashMap::new();
        let mut open_ids = Vec::new();
        for (slot, rt) in self.runtimes().iter().enumerate() {
            if let Some(cur) = rt.current() {
                open_ids.push(cur.id.as_str().to_string());
                open_descs.insert(cur.id.as_str().to_string(), (cur.descriptor, slot as u32));
            }
        }

        // One enumerate per source, gathered up front: the port-based
        // substitution below needs to know whether an open id appears
        // ANYWHERE in the union before any entry is emitted.
        let mut per_source: Vec<(SourceKind, String, Vec<DeviceDescriptor>)> = Vec::new();
        for source in &self.inner.sources {
            match source.enumerate().await {
                Ok(descs) => per_source.push((source.kind(), source.label(), descs)),
                Err(e) => warn!("device source {} failed to enumerate: {}", source.id(), e),
            }
        }
        let enumerated: std::collections::HashSet<&str> = per_source
            .iter()
            .flat_map(|(_, _, descs)| descs.iter().map(|d| d.id.as_str()))
            .collect();

        // Open ids absent from the union, matched to their RE-KEYED twin
        // entry: same bus position AND same serial base (`rekeyed_twin_of`).
        // Position alone is not identity — a different unit swapped onto the
        // same port must list as itself, never be hidden behind the stale
        // open descriptor.
        let mut port_sub: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        for (open_id, (desc, _)) in &open_descs {
            if enumerated.contains(open_id.as_str()) {
                continue;
            }
            if let Some(twin) = per_source
                .iter()
                .flat_map(|(_, _, descs)| descs.iter())
                .find(|d| rekeyed_twin_of(desc, d))
            {
                port_sub.insert(twin.id.as_str().to_string(), open_id.clone());
            }
        }

        let mut seen = std::collections::HashSet::new();
        let mut devices = Vec::new();
        for (kind, label, descs) in per_source {
            for d in descs {
                if !seen.insert(d.id.clone()) {
                    // Same never-silent rule as `enumerate()`.
                    warn!("device id {} enumerated more than once — keeping the first", d.id);
                    continue;
                }
                let hit = match open_descs.remove(d.id.as_str()) {
                    Some(hit) => Some(hit),
                    None => port_sub
                        .get(d.id.as_str())
                        .and_then(|open_id| open_descs.remove(open_id)),
                };
                let (desc, open, slot) = match hit {
                    Some((enriched, slot)) => {
                        // Defensive: the enriched id replaces the enumerated
                        // one — never list both.
                        seen.insert(enriched.id.clone());
                        (enriched, true, Some(slot))
                    }
                    None => (d, false, None),
                };
                devices.push(DeviceEntry::from_descriptor(&desc, kind, label.clone(), open, slot));
            }
        }

        // Whatever is open but no longer enumerable (nor port-matched) stays
        // listed — iterated in SLOT order so the appended tail is stable
        // across refreshes and the frontend's option list never jitters.
        for id in &open_ids {
            let Some((desc, slot)) = open_descs.remove(id) else { continue };
            if !seen.insert(desc.id.clone()) {
                continue; // already listed (defensive)
            }
            let (kind, label) = self
                .inner
                .sources
                .iter()
                .find(|s| s.id().as_str() == desc.source.as_str())
                .map(|s| (s.kind(), s.label()))
                // Sources are fixed at construction and opens route through
                // them, so this arm is unreachable today — degrade via the
                // transport rather than panic if that ever changes.
                .unwrap_or_else(|| {
                    let kind = match desc.transport {
                        Transport::Virtual => SourceKind::Virtual,
                        Transport::Usb { .. } => SourceKind::Usb,
                    };
                    (kind, desc.source.as_str().to_string())
                });
            devices.push(DeviceEntry::from_descriptor(&desc, kind, label, true, Some(slot)));
        }

        DeviceList { devices, open: open_ids }
    }

    /// Open the unit `id` onto the DEFAULT slot (slot 0). A second open
    /// supersedes the first (the source releases the handle's prior claim
    /// first — exactly what the pre-registry `connect()` did on reconnect);
    /// re-opening the unit already on slot 0 remains the legacy reconnect.
    /// A unit open on ANOTHER slot is rejected (`AlreadyOpen`) — this was
    /// the one open path left able to steal an open unit's claim, and its
    /// failure mode was worse: `open_locked` clears slot 0's bookkeeping
    /// before the source engages, so a doomed steal would ALSO destroy
    /// whatever slot 0 was running (adversarial review, MUST-FIX #2).
    /// Held under the registry's open gate + the runtime's lifecycle gate
    /// for its WHOLE duration, so concurrent opens serialize and a
    /// concurrent `close()` waits this one out (lot-B review finding #1).
    pub async fn open(&self, id: &DeviceId) -> Result<DeviceDescriptor, DeviceError> {
        let _open_gate = self.inner.open_gate.lock().await;
        let rt = self.default_runtime();
        if self.open_elsewhere(&rt).contains(id.as_str()) {
            return Err(DeviceError::AlreadyOpen(id.as_str().to_string()));
        }
        let _gate = rt.lifecycle_gate().lock().await;
        self.open_locked(&rt, id).await
    }

    /// Open the unit `id` onto a FREE slot, as an ADDITIONAL device (issue
    /// #25 lot E — the traces panel's add-device path). Never a supersede:
    /// a unit already open on any slot is rejected with
    /// [`DeviceError::AlreadyOpen`] — silently re-opening it onto a second
    /// runtime would steal its claim out from under the first (planner
    /// finding F2). The first free slot is reused (slot indices stay
    /// stable); a fresh runtime is allocated only when every slot is
    /// occupied, up to [`MAX_DEVICES`].
    ///
    /// `preferred_slot` (lot E4, the revive-a-dormant-group gesture): a
    /// NON-DEFAULT slot to reuse if it is free — slot-keyed trace ids make
    /// "which slot" user-visible, and reviving `Input L #2`'s group must
    /// land its unit back on slot 1, not on whatever happens to be free
    /// first. A hint that is occupied, slot 0, or out of range falls back
    /// to the normal first-free allocation (the answered slot is
    /// authoritative either way); a hint beyond the current vector grows it
    /// with idle runtimes (indices are stable, the vector never shrinks).
    pub async fn open_additional(
        &self,
        id: &DeviceId,
        preferred_slot: Option<usize>,
    ) -> Result<DeviceDescriptor, DeviceError> {
        let _open_gate = self.inner.open_gate.lock().await;
        if self.slot_of(id.as_str()).is_some() {
            return Err(DeviceError::AlreadyOpen(id.as_str().to_string()));
        }
        let rt = self.free_or_new_runtime(preferred_slot)?;
        let _gate = rt.lifecycle_gate().lock().await;
        self.open_locked(&rt, id).await
    }

    /// The preferred free slot when hinted (see [`Self::open_additional`]),
    /// else the first NON-DEFAULT runtime with nothing open, else a freshly
    /// allocated slot. Additional devices never occupy slot 0 (adversarial
    /// review #5): the default slot belongs to the connect/demo flows —
    /// REST, scripting and every unrouted command drive it, and
    /// `open_first_physical`/`open_virtual` may supersede it, so an added
    /// unit landing there would silently become the default AND be silently
    /// supersedable by the auto-connect tick. Only ever called under the
    /// open gate, so two concurrent opens cannot race onto the same free
    /// slot.
    fn free_or_new_runtime(
        &self,
        preferred_slot: Option<usize>,
    ) -> Result<DeviceRuntime, DeviceError> {
        let mut slots = self.inner.runtimes.lock().expect("runtimes lock");
        if let Some(p) = preferred_slot {
            if p >= 1 && p < MAX_DEVICES {
                while slots.len() <= p {
                    slots.push(DeviceRuntime::new());
                }
                if slots[p].current().is_none() {
                    return Ok(slots[p].clone());
                }
                // Occupied hint: fall through to the normal allocation.
            }
        }
        if let Some(rt) = slots.iter().skip(1).find(|rt| rt.current().is_none()) {
            return Ok(rt.clone());
        }
        if slots.len() >= MAX_DEVICES {
            return Err(DeviceError::NoFreeSlot);
        }
        let rt = DeviceRuntime::new();
        slots.push(rt.clone());
        Ok(rt)
    }

    /// The open body, ASSUMING the open gate and `rt`'s lifecycle gate are
    /// already held by the caller. `open_first_physical`/`open_virtual` call
    /// this — calling the public `open()` from them would re-enter the gates
    /// and deadlock.
    async fn open_locked(&self, rt: &DeviceRuntime, id: &DeviceId) -> Result<DeviceDescriptor, DeviceError> {
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
        rt.note_closed();
        let desc = source.open(id, &rt.handle()).await?;
        rt.note_open(id.clone(), desc.clone());
        Ok(desc)
    }

    /// Every id currently open on a runtime OTHER than `target` — the units
    /// an open on `target` must never steal (planner F2).
    fn open_elsewhere(&self, target: &DeviceRuntime) -> std::collections::HashSet<String> {
        self.inner
            .runtimes
            .lock()
            .expect("runtimes lock")
            .iter()
            .filter(|rt| !rt.same_as(target))
            .filter_map(|rt| rt.device_id().map(|id| id.as_str().to_string()))
            .collect()
    }

    /// Open the first physical unit any source offers onto the DEFAULT slot
    /// — the `connect_device` behavior (auto-connect to "the" QA40x). Units
    /// open on ANOTHER slot are skipped (lot E: re-opening one would steal
    /// its claim); re-opening the unit already on slot 0 itself remains the
    /// legacy reconnect semantics. When nothing physical is available, the
    /// handle's prior claim is still released, exactly like the legacy
    /// `connect()` which released before scanning. A bus-scan FAILURE is not
    /// "not found": the first scan error is returned so the user sees the
    /// actual diagnostic (permission-denied backend, broken hub), as the
    /// legacy `connect()` surfaced it.
    pub async fn open_first_physical(&self) -> Result<DeviceDescriptor, DeviceError> {
        // One gate acquisition for the whole scan+open (open_locked, NOT the
        // public open(), which would re-enter the gates and deadlock).
        let _open_gate = self.inner.open_gate.lock().await;
        let rt = self.default_runtime();
        let _gate = rt.lifecycle_gate().lock().await;
        let skip = self.open_elsewhere(&rt);
        let mut scan_err: Option<DeviceError> = None;
        for source in &self.inner.sources {
            if !source.is_physical() {
                continue;
            }
            match source.enumerate().await {
                Ok(descs) => {
                    if let Some(d) = descs.iter().find(|d| !skip.contains(d.id.as_str())) {
                        return self.open_locked(&rt, &d.id).await;
                    }
                }
                Err(e) => {
                    warn!("device source {} failed to enumerate: {}", source.id(), e);
                    scan_err.get_or_insert(e);
                }
            }
        }
        rt.handle().lock().await.release_claim().await;
        rt.note_closed();
        Err(scan_err.unwrap_or(DeviceError::NotFound))
    }

    /// Open the first available built-in virtual unit onto the DEFAULT slot
    /// — the `connect_virtual_device` (demo mode) behavior. Same
    /// skip-open-elsewhere rule as [`Self::open_first_physical`]: a virtual
    /// unit added on another slot must not be stolen by the Demo button —
    /// the next free virtual unit is used instead.
    pub async fn open_virtual(&self) -> Result<DeviceDescriptor, DeviceError> {
        // Same single gate acquisition as open_first_physical.
        let _open_gate = self.inner.open_gate.lock().await;
        let rt = self.default_runtime();
        let _gate = rt.lifecycle_gate().lock().await;
        let skip = self.open_elsewhere(&rt);
        for source in &self.inner.sources {
            if source.kind() != SourceKind::Virtual {
                continue;
            }
            match source.enumerate().await {
                Ok(descs) => {
                    if let Some(d) = descs.iter().find(|d| !skip.contains(d.id.as_str())) {
                        return self.open_locked(&rt, &d.id).await;
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

    /// The unit currently open, per the DEFAULT runtime's bookkeeping.
    pub fn current(&self) -> Option<OpenDevice> {
        self.default_runtime().current()
    }

    /// Record that the DEFAULT device closed OUTSIDE `close()` — unplug
    /// detected by the USB monitor, bootloader detach during a flash.
    /// Generation-blind (kept for the lot-B call sites); the
    /// generation-keyed form is [`DeviceRuntime::note_closed_at`].
    pub fn note_closed(&self) {
        self.default_runtime().note_closed();
    }

    /// Tear down every allocated runtime CONCURRENTLY, each under its own
    /// `budget` (issue #25 lot E): one wedged device must never starve its
    /// siblings of their teardown window. Best-effort, like the runtimes'
    /// own [`DeviceRuntime::shutdown`] — the process is leaving.
    pub async fn shutdown_all(&self, budget: std::time::Duration) {
        let tasks: Vec<_> = self
            .runtimes()
            .into_iter()
            .enumerate()
            .map(|(slot, rt)| {
                tokio::spawn(async move {
                    if tokio::time::timeout(budget, rt.shutdown()).await.is_err() {
                        log::warn!("exit: device slot {slot}'s safe teardown exceeded its budget");
                    }
                })
            })
            .collect();
        for t in tasks {
            let _ = t.await;
        }
    }

    /// Whether REAL hardware is present on any physical source — never
    /// satisfied by the virtual source (the demo hand-over predicate).
    pub async fn physical_present(&self) -> bool {
        // Units already open on some slot don't count (lot E, adversarial
        // review #8): the demo hand-over ACTION (`open_first_physical`)
        // skips them, so the hand-over PREDICATE must too — otherwise a
        // bench whose only QA40x is added on another slot would tear the
        // demo down and then fail to connect anything.
        let open: std::collections::HashSet<String> = self
            .runtimes()
            .iter()
            .filter_map(|rt| rt.device_id().map(|id| id.as_str().to_string()))
            .collect();
        for source in &self.inner.sources {
            if !source.is_physical() {
                continue;
            }
            if matches!(
                source.enumerate().await,
                Ok(descs) if descs.iter().any(|d| !open.contains(d.id.as_str()))
            ) {
                return true;
            }
        }
        false
    }

    /// Whether any device is present for auto-connect purposes: the open
    /// virtual device counts (it lives in-process, not on the bus), else the
    /// bus is scanned — the pre-registry `is_present` semantics, unchanged.
    pub async fn any_present(&self) -> bool {
        self.default_runtime().handle().lock().await.is_present().await
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

    /* ---- lot D: the frontend device list ------------------------------- */

    #[tokio::test]
    async fn list_offers_the_virtual_unit_with_nothing_on_the_bus_and_nothing_open() {
        let reg = registry(vec![
            Arc::new(FakeSource::new("usb", true, &[])),
            Arc::new(FakeSource::new("virtual", false, &["V"])),
        ]);
        let list = reg.list().await;
        assert_eq!(list.devices.len(), 1);
        assert_eq!(list.devices[0].id, "virtual/V");
        assert_eq!(list.devices[0].source_kind, crate::device::SourceKind::Virtual);
        assert!(!list.devices[0].open);
        assert!(list.open.is_empty());
    }

    #[tokio::test]
    async fn list_substitutes_the_open_units_enriched_descriptor() {
        let reg = registry(vec![Arc::new(FakeSource::new("usb", true, &["A", "B"]))]);
        let a = reg.enumerate().await[0].id.clone();
        reg.open(&a).await.expect("open A");

        let list = reg.list().await;
        assert_eq!(list.open, vec!["usb/A".to_string()]);
        let entry_a = list.devices.iter().find(|d| d.id == "usb/A").expect("A listed");
        let entry_b = list.devices.iter().find(|d| d.id == "usb/B").expect("B listed");
        // The open unit carries what only an open can know…
        assert!(entry_a.open);
        assert_eq!(entry_a.firmware_version, Some(42));
        assert_eq!(
            entry_a.capabilities.calibration,
            crate::device::CalibrationSource::FactoryEeprom { page_bytes: 512 }
        );
        // …while the unopened one honestly does not.
        assert!(!entry_b.open);
        assert_eq!(entry_b.firmware_version, None);
        assert_eq!(entry_b.capabilities.calibration, crate::device::CalibrationSource::Unknown);
    }

    #[tokio::test]
    async fn list_keeps_an_open_unit_that_stopped_enumerating() {
        let src = Arc::new(FakeSource::new("usb", true, &["A"]));
        let reg = registry(vec![src.clone()]);
        let a = reg.enumerate().await[0].id.clone();
        reg.open(&a).await.expect("open A");

        // The unit unplugs but the registry's bookkeeping hasn't caught up
        // (monitor tick pending) — the bar must keep showing it as open.
        src.vanish("A");
        let list = reg.list().await;
        assert_eq!(list.open, vec!["usb/A".to_string()]);
        let entry = list.devices.iter().find(|d| d.id == "usb/A").expect("still listed");
        assert!(entry.open);
        assert_eq!(entry.firmware_version, Some(42), "the enriched descriptor survives");
    }

    #[tokio::test]
    async fn list_keeps_an_open_unit_whose_source_starts_failing_to_enumerate() {
        // Distinct from `list_keeps_an_open_unit_that_stopped_enumerating`:
        // there the source keeps answering Ok, just without that unit. Here
        // the WHOLE enumerate() call errors (bus reset, backend permission
        // flip) — the `Err` arm must not silently drop the open unit's entry
        // along with the rest of that source's union, since `open_descs`
        // still holds its enriched descriptor from `runtimes()`.
        let src = Arc::new(FakeSource::new("usb", true, &["A"]));
        let reg = registry(vec![src.clone()]);
        let a = reg.enumerate().await[0].id.clone();
        reg.open(&a).await.expect("open A");

        src.fail_from_now_on();
        let list = reg.list().await;
        assert_eq!(list.open, vec!["usb/A".to_string()]);
        let entry = list.devices.iter().find(|d| d.id == "usb/A").expect("still listed despite the scan error");
        assert!(entry.open);
        assert_eq!(entry.firmware_version, Some(42), "the enriched descriptor survives a scan error too");
    }

    #[tokio::test]
    async fn list_dedupes_by_id_keeping_the_first() {
        let reg = registry(vec![
            Arc::new(FakeSource::new("usb", true, &["A"])),
            Arc::new(FakeSource::new("usb", true, &["A"])),
        ]);
        let list = reg.list().await;
        assert_eq!(list.devices.len(), 1);
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

    /* ---- lot E: N runtime slots ----------------------------------------- */

    #[tokio::test]
    async fn open_additional_lands_on_a_fresh_slot_with_distinct_runtime_state() {
        let reg = registry(vec![Arc::new(FakeSource::new("usb", true, &["A", "B"]))]);
        let a = reg.enumerate().await[0].id.clone();
        let b = reg.enumerate().await[1].id.clone();
        reg.open(&a).await.expect("open A on slot 0");
        reg.open_additional(&b, None).await.expect("open B on a fresh slot");

        assert_eq!(reg.slot_of("usb/A"), Some(0));
        assert_eq!(reg.slot_of("usb/B"), Some(1));
        let rts = reg.runtimes();
        assert_eq!(rts.len(), 2);
        // Fully distinct per-device state — device object, mixer, stream
        // control flags: nothing may be shared between two live units.
        assert!(!Arc::ptr_eq(&rts[0].handle(), &rts[1].handle()));
        assert!(!Arc::ptr_eq(&rts[0].mixer(), &rts[1].mixer()));
        assert!(!Arc::ptr_eq(rts[0].sweep_cancel(), rts[1].sweep_cancel()));
        assert!(!rts[0].same_as(&rts[1]));
        // And slot 0 is still the untouched default runtime.
        assert!(reg.default_runtime().same_as(&rts[0]));
        assert_eq!(reg.current().expect("slot 0 keeps A").id, a);
    }

    #[tokio::test]
    async fn the_add_answer_slot_agrees_with_the_enumerations_entry() {
        // Lot E4: `connect_additional_device` answers `slot_of()` right
        // after the open — the value the frontend mints its session from
        // must be the SAME slot the next `list_devices` reports for that
        // unit (the id-adoption invariant), and never the default slot.
        let reg = registry(vec![Arc::new(FakeSource::new("usb", true, &["A", "B"]))]);
        let a = reg.enumerate().await[0].id.clone();
        let b = reg.enumerate().await[1].id.clone();
        reg.open(&a).await.expect("open A on slot 0");
        reg.open_additional(&b, None).await.expect("open B");

        let slot = reg.slot_of("usb/B").expect("B has a slot");
        assert!(slot >= 1, "an additional open never lands on the default slot");
        let list = reg.list().await;
        let entry = list
            .devices
            .iter()
            .find(|d| d.id == "usb/B")
            .expect("B enumerated");
        assert!(entry.open);
        assert_eq!(entry.slot, Some(slot as u32));
    }

    #[tokio::test]
    async fn a_preferred_slot_hint_is_honored_when_free_and_falls_back_when_not() {
        // Lot E4 revive gesture: a dormant group asks for ITS slot back.
        let reg = registry(vec![Arc::new(FakeSource::new("usb", true, &["A", "B", "C"]))]);
        let ids: Vec<_> = reg.enumerate().await.iter().map(|d| d.id.clone()).collect();
        reg.open(&ids[0]).await.expect("A on slot 0");

        // A hint beyond the current vector grows it with idle runtimes —
        // a fresh boot has only slot 0, yet the doc's dormant group can
        // name slot 2.
        reg.open_additional(&ids[1], Some(2)).await.expect("B on slot 2");
        assert_eq!(reg.slot_of("usb/B"), Some(2));
        assert_eq!(reg.runtimes().len(), 3, "slot 1 exists, idle");

        // An OCCUPIED hint falls back to the normal first-free allocation.
        reg.open_additional(&ids[2], Some(2)).await.expect("C falls back");
        assert_eq!(reg.slot_of("usb/C"), Some(1));

        // Slot 0 is never a valid hint (the default slot stays the
        // connect/demo flows' — the review-#5 rule).
        let rt_c = reg.runtime_for(Some("usb/C")).expect("C routes");
        reg.close_runtime(&rt_c).await.expect("free slot 1");
        reg.open_additional(&ids[2], Some(0)).await.expect("C re-added");
        assert_eq!(reg.slot_of("usb/C"), Some(1), "hint 0 ignored");
    }

    #[tokio::test]
    async fn open_additional_rejects_a_unit_already_open_anywhere() {
        // Planner finding F2's command-level guard: re-opening an open unit
        // onto a second runtime would steal its claim out from under the
        // first — reject loudly, change nothing.
        let reg = registry(vec![Arc::new(FakeSource::new("usb", true, &["A"]))]);
        let a = reg.enumerate().await[0].id.clone();
        reg.open(&a).await.expect("open A");

        let err = reg.open_additional(&a, None).await.expect_err("A is already open");
        assert_eq!(err.to_string(), "Device already open: usb/A");
        assert_eq!(reg.runtimes().len(), 1, "no slot may have been allocated");
        assert_eq!(reg.current().expect("A untouched").id, a);
    }

    #[tokio::test]
    async fn a_supersede_stays_on_slot_zero_and_never_allocates() {
        // `connect_device` semantics are frozen: picking another unit while
        // one is open REPLACES it on the default slot — the additional-slot
        // path is only ever entered through open_additional.
        let reg = registry(vec![Arc::new(FakeSource::new("usb", true, &["A", "B"]))]);
        let a = reg.enumerate().await[0].id.clone();
        let b = reg.enumerate().await[1].id.clone();
        reg.open(&a).await.expect("open A");
        reg.open(&b).await.expect("open B supersedes A");
        assert_eq!(reg.runtimes().len(), 1);
        assert_eq!(reg.slot_of("usb/B"), Some(0));
        assert_eq!(reg.slot_of("usb/A"), None);
    }

    #[tokio::test]
    async fn slots_are_stable_and_additional_opens_never_take_the_default_slot() {
        // The E3 premise: slot indices never move under a trace id — a
        // closed slot is REUSED by the next additional open, and slot 0 is
        // never a candidate (an added unit landing there would silently
        // become the default device REST/scripting drive, and be silently
        // supersedable by the auto-connect — adversarial review #5).
        let reg = registry(vec![Arc::new(FakeSource::new("usb", true, &["A", "B", "C", "D"]))]);
        let ids: Vec<_> = reg.enumerate().await.iter().map(|d| d.id.clone()).collect();
        reg.open(&ids[0]).await.expect("A on slot 0");
        reg.open_additional(&ids[1], None).await.expect("B on slot 1");
        reg.open_additional(&ids[2], None).await.expect("C on slot 2");
        assert_eq!(reg.slot_of("usb/C"), Some(2));

        // Close B (slot 1): D reuses ITS slot, C keeps slot 2.
        let rt_b = reg.runtime_for(Some("usb/B")).expect("B routes");
        reg.close_runtime(&rt_b).await.expect("close slot 1");
        reg.open_additional(&ids[3], None).await.expect("D reuses the freed slot");
        assert_eq!(reg.slot_of("usb/D"), Some(1), "reuse, not growth");
        assert_eq!(reg.slot_of("usb/C"), Some(2), "C keeps its slot throughout");
        assert_eq!(reg.runtimes().len(), 3);
        // The reused slot is the SAME runtime object (never replaced).
        assert!(rt_b.same_as(&reg.runtimes()[1]));

        // Slot 0 freed: an additional open must STILL not take it.
        reg.close().await.expect("close slot 0");
        reg.open_additional(&ids[1], None).await.expect("B re-added");
        assert_eq!(reg.slot_of("usb/B"), Some(3), "never slot 0 — a fresh slot instead");
        assert!(reg.default_runtime().current().is_none(), "slot 0 stays free for connect/demo");
    }

    #[tokio::test]
    async fn the_slot_ceiling_rejects_further_additional_opens() {
        // MAX_DEVICES bounds the SLOTS (default included): slot 0 + up to
        // MAX_DEVICES-1 additional units.
        let units: Vec<String> = (0..=MAX_DEVICES).map(|i| format!("U{i}")).collect();
        let unit_refs: Vec<&str> = units.iter().map(String::as_str).collect();
        let reg = registry(vec![Arc::new(FakeSource::new("usb", true, &unit_refs))]);
        let descs = reg.enumerate().await;
        reg.open(&descs[0].id).await.expect("the default unit on slot 0");
        for d in descs.iter().skip(1).take(MAX_DEVICES - 1) {
            reg.open_additional(&d.id, None).await.expect("fill a slot");
        }
        assert_eq!(reg.runtimes().len(), MAX_DEVICES);
        let err = reg
            .open_additional(&descs[MAX_DEVICES].id, None)
            .await
            .expect_err("the ceiling must hold");
        assert!(matches!(err, DeviceError::NoFreeSlot));
        assert_eq!(err.to_string(), "All device slots are in use");
        assert_eq!(reg.runtimes().len(), MAX_DEVICES, "no runtime leaked past the ceiling");
    }

    #[tokio::test]
    async fn a_picked_open_of_a_unit_open_on_another_slot_is_rejected_not_stolen() {
        // Adversarial review MUST-FIX #2: `connect_device { deviceId }` is
        // the fourth open path — picking a unit that is open on ANOTHER slot
        // must reject (AlreadyOpen), never steal its claim; and because the
        // steal would have cleared slot 0's bookkeeping BEFORE failing, the
        // guard must fire before open_locked ever runs: slot 0's session
        // survives byte-identically.
        let reg = registry(vec![Arc::new(FakeSource::new("usb", true, &["A", "B"]))]);
        let a = reg.enumerate().await[0].id.clone();
        let b = reg.enumerate().await[1].id.clone();
        reg.open(&a).await.expect("A on slot 0");
        reg.open_additional(&b, None).await.expect("B on slot 1");

        let err = reg.open(&b).await.expect_err("picking B while it is open on slot 1");
        assert_eq!(err.to_string(), "Device already open: usb/B");
        assert_eq!(reg.current().expect("slot 0 untouched").id, a);
        assert_eq!(reg.slot_of("usb/B"), Some(1), "B's claim survives");
    }

    #[tokio::test]
    async fn open_first_physical_skips_units_open_on_another_slot() {
        // Planner finding F2: with B open on slot 1 and B enumerating FIRST,
        // the auto-connect must not steal B's claim onto slot 0 — it opens
        // the next free unit instead.
        let reg = registry(vec![Arc::new(FakeSource::new("usb", true, &["B", "A"]))]);
        let b = reg.enumerate().await[0].id.clone();
        // Land B on slot 1: occupy slot 0 first, then free it.
        let a = reg.enumerate().await[1].id.clone();
        reg.open(&a).await.expect("occupy slot 0");
        reg.open_additional(&b, None).await.expect("B on slot 1");
        reg.close().await.expect("free slot 0");

        let d = reg.open_first_physical().await.expect("auto-connect");
        assert_eq!(d.id.as_str(), "usb/A", "the open unit B must be skipped");
        assert_eq!(reg.slot_of("usb/B"), Some(1), "B's claim survives the auto-connect");
        assert_eq!(reg.slot_of("usb/A"), Some(0));
    }

    #[tokio::test]
    async fn open_first_physical_with_only_an_already_open_unit_is_not_found() {
        // EVERY enumerable unit is open on a non-default slot: the
        // auto-connect must fail with NotFound (never steal), leaving the
        // open unit's claim alone.
        let src = Arc::new(FakeSource::new("usb", true, &["X", "B"]));
        let reg = registry(vec![src.clone()]);
        let x = reg.enumerate().await[0].id.clone();
        let b = reg.enumerate().await[1].id.clone();
        reg.open(&x).await.expect("occupy slot 0");
        reg.open_additional(&b, None).await.expect("B on slot 1");
        reg.close().await.expect("free slot 0");
        src.vanish("X");

        let err = reg.open_first_physical().await.expect_err("only an already-open unit remains");
        assert!(matches!(err, DeviceError::NotFound));
        assert_eq!(reg.slot_of("usb/B"), Some(1), "B must survive the failed auto-connect");
    }

    #[tokio::test]
    async fn open_virtual_skips_a_virtual_unit_open_on_another_slot_and_takes_the_next() {
        // The demo button with virtual unit V1 already ADDED on another
        // slot: it must not steal V1 — it opens V2.
        let reg = registry(vec![
            Arc::new(FakeSource::new("usb", true, &["A"])),
            Arc::new(FakeSource::new("virtual", false, &["V1", "V2"])),
        ]);
        let a = reg.enumerate().await[0].id.clone();
        let v1 = reg.enumerate().await[1].id.clone();
        reg.open(&a).await.expect("occupy slot 0");
        reg.open_additional(&v1, None).await.expect("V1 added on slot 1");

        let d = reg.open_virtual().await.expect("demo hand-over");
        assert_eq!(d.id.as_str(), "virtual/V2", "V1 is taken — the demo must use V2");
        assert_eq!(reg.slot_of("virtual/V1"), Some(1), "V1's claim survives");
        assert_eq!(reg.slot_of("virtual/V2"), Some(0));
    }

    #[tokio::test]
    async fn runtime_for_routes_each_open_id_to_its_own_slot() {
        let reg = registry(vec![Arc::new(FakeSource::new("usb", true, &["A", "B"]))]);
        let a = reg.enumerate().await[0].id.clone();
        let b = reg.enumerate().await[1].id.clone();
        reg.open(&a).await.expect("open A");
        reg.open_additional(&b, None).await.expect("open B");

        let rt_a = reg.runtime_for(Some("usb/A")).expect("A routes");
        let rt_b = reg.runtime_for(Some("usb/B")).expect("B routes");
        assert!(rt_a.same_as(&reg.runtimes()[0]));
        assert!(rt_b.same_as(&reg.runtimes()[1]));
        assert!(!rt_a.same_as(&rt_b));
        // None still means the default device, whatever else is open.
        assert!(reg.runtime_for(None).expect("default").same_as(&rt_a));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn two_concurrent_additional_opens_never_collide_on_one_slot() {
        let src = Arc::new(FakeSource::slow(
            "usb",
            true,
            &["A", "B"],
            std::time::Duration::from_millis(50),
        ));
        let reg = registry(vec![src.clone()]);
        let a = reg.enumerate().await[0].id.clone();
        let b = reg.enumerate().await[1].id.clone();

        let (ra, rb) = tokio::join!(
            { let r = reg.clone(); let a = a.clone(); async move { r.open_additional(&a, None).await } },
            { let r = reg.clone(); let b = b.clone(); async move { r.open_additional(&b, None).await } },
        );
        ra.expect("open A");
        rb.expect("open B");
        let slots = [reg.slot_of("usb/A").expect("A open"), reg.slot_of("usb/B").expect("B open")];
        assert_ne!(slots[0], slots[1], "one slot per unit");
        assert!(!slots.contains(&0), "additional opens never take the default slot");
        assert_eq!(reg.runtimes().len(), 3);
    }

    #[tokio::test]
    async fn list_marks_every_open_unit_with_its_slot() {
        let reg = registry(vec![Arc::new(FakeSource::new("usb", true, &["A", "B", "C"]))]);
        let a = reg.enumerate().await[0].id.clone();
        let b = reg.enumerate().await[1].id.clone();
        reg.open(&a).await.expect("open A");
        reg.open_additional(&b, None).await.expect("open B");

        let list = reg.list().await;
        assert_eq!(list.open, vec!["usb/A".to_string(), "usb/B".to_string()], "slot order");
        let slot = |id: &str| list.devices.iter().find(|d| d.id == id).expect(id).slot;
        assert_eq!(slot("usb/A"), Some(0));
        assert_eq!(slot("usb/B"), Some(1));
        assert_eq!(slot("usb/C"), None, "not open ⇒ no slot");
    }

    #[tokio::test]
    async fn list_replaces_a_rekeyed_serial_twin_with_the_open_units_entry() {
        // Lot-D review #2, closed by lot E: unit S is open under id "usb/S";
        // a serial twin appears and the scan re-keys BOTH units to
        // path-suffixed ids, so "usb/S" no longer enumerates. The entry at
        // S's own BUS POSITION must fold into the open unit (stable id, no
        // ghost pair); the twin at the other port lists normally.
        use crate::device::testing::fake_descriptor_at;
        let src = Arc::new(FakeSource::new("usb", true, &[]));
        let source_id = crate::device::SourceId::new("usb");
        src.set_descriptors(vec![fake_descriptor_at(&source_id, "S", true, &[1])]);
        let reg = registry(vec![src.clone()]);
        let s = reg.enumerate().await[0].id.clone();
        reg.open(&s).await.expect("open S");

        // The twin plugs in: the scan now offers both units re-keyed.
        src.set_descriptors(vec![
            fake_descriptor_at(&source_id, "S@path-tb-1", true, &[1]),
            fake_descriptor_at(&source_id, "S@path-tb-2", true, &[2]),
        ]);

        let list = reg.list().await;
        let ids: Vec<&str> = list.devices.iter().map(|d| d.id.as_str()).collect();
        assert!(
            !ids.contains(&"usb/S@path-tb-1"),
            "the open unit's re-keyed twin entry must fold into it, got {ids:?}"
        );
        assert_eq!(list.devices.len(), 2, "no ghost pair: the open unit + the actual twin");
        let open_entry = list.devices.iter().find(|d| d.id == "usb/S").expect("open unit listed");
        assert!(open_entry.open);
        assert_eq!(open_entry.slot, Some(0));
        assert_eq!(open_entry.firmware_version, Some(42), "the enriched descriptor is kept");
        let twin = list
            .devices
            .iter()
            .find(|d| d.id == "usb/S@path-tb-2")
            .expect("the twin at the other port lists normally");
        assert!(!twin.open);
        assert_eq!(list.open, vec!["usb/S".to_string()]);
    }

    #[tokio::test]
    async fn list_never_hides_a_different_unit_swapped_onto_the_open_units_port() {
        // Adversarial review MUST-FIX #1: the everyday one-cable bench swap.
        // Unit S is open; the user unplugs it and plugs a DIFFERENT unit T
        // into the same physical port before the monitor tick lands. T
        // carries its own serial, so the port match alone must NOT fold it
        // into S's stale open descriptor — T lists as itself (selectable),
        // and S stays in the appended open tail exactly as before lot E.
        use crate::device::testing::fake_descriptor_at;
        let src = Arc::new(FakeSource::new("usb", true, &[]));
        let source_id = crate::device::SourceId::new("usb");
        src.set_descriptors(vec![fake_descriptor_at(&source_id, "S", true, &[1])]);
        let reg = registry(vec![src.clone()]);
        let s = reg.enumerate().await[0].id.clone();
        reg.open(&s).await.expect("open S");

        // The swap: T now sits at S's port.
        src.set_descriptors(vec![fake_descriptor_at(&source_id, "T", true, &[1])]);

        let list = reg.list().await;
        let t = list.devices.iter().find(|d| d.id == "usb/T").expect("T must be listed");
        assert!(!t.open, "T is a fresh unit, not the open one");
        assert_eq!(t.slot, None);
        let s_entry = list.devices.iter().find(|d| d.id == "usb/S").expect("S stays listed");
        assert!(s_entry.open, "the open-but-gone unit rides the appended tail");
        assert_eq!(list.open, vec!["usb/S".to_string()]);
    }

    #[tokio::test]
    async fn physical_present_ignores_units_already_open_on_a_slot() {
        // Adversarial review #8: the demo hand-over PREDICATE must agree
        // with the hand-over ACTION (open_first_physical skips open units) —
        // a bench whose only QA40x is added on another slot must not tear
        // the demo down for a unit the hand-over cannot open.
        let reg = registry(vec![
            Arc::new(FakeSource::new("usb", true, &["A"])),
            Arc::new(FakeSource::new("virtual", false, &["V"])),
        ]);
        assert!(reg.physical_present().await, "A is free");
        let a = reg.enumerate().await[0].id.clone();
        reg.open_additional(&a, None).await.expect("A added on slot 1");
        assert!(!reg.physical_present().await, "the only QA40x is open — nothing to hand over to");
    }

    #[tokio::test]
    async fn list_keeps_an_open_virtual_unit_that_stopped_enumerating_without_port_substitution() {
        // Lot E's port-substitution step (`usb_port(&desc.transport)`)
        // returns `None` for `Transport::Virtual` — a virtual open unit that
        // stopped enumerating must fall straight through to the OLD
        // append-tail path, never attempt (or crash on) a port match. This
        // pins the `let Some(open_port) = usb_port(&desc.transport) else {
        // continue }` branch actually firing for a transport with no bus
        // position, distinct from the USB "vanished" case which DOES have one.
        let src = Arc::new(FakeSource::new("virtual", false, &["V"]));
        let reg = registry(vec![src.clone()]);
        let v = reg.enumerate().await[0].id.clone();
        reg.open(&v).await.expect("open V");

        src.vanish("V");
        let list = reg.list().await;
        assert_eq!(list.open, vec!["virtual/V".to_string()]);
        let entry = list
            .devices
            .iter()
            .find(|d| d.id == "virtual/V")
            .expect("still listed via the append-tail path, not lost");
        assert!(entry.open);
        assert_eq!(entry.slot, Some(0));
        assert_eq!(entry.firmware_version, Some(42), "the enriched descriptor survives");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn shutdown_all_runs_the_slot_budgets_concurrently() {
        // BOTH devices wedged (mutex held by a stuck capture): serial
        // teardown would burn one full budget PER slot (~2×); the concurrent
        // one stays within ~1× (asserted with a wide margin). Wedging only
        // one slot would not discriminate — the healthy slot's teardown is
        // instantaneous, so serial ≈ concurrent (adversarial review #6).
        let reg = registry(vec![Arc::new(FakeSource::new("usb", true, &["A", "B"]))]);
        let a = reg.enumerate().await[0].id.clone();
        let b = reg.enumerate().await[1].id.clone();
        reg.open(&a).await.expect("open A");
        reg.open_additional(&b, None).await.expect("open B");

        let rts = reg.runtimes();
        let (h0, h1) = (rts[0].handle(), rts[1].handle());
        let wedge0 = h0.lock().await;
        let wedge1 = h1.lock().await;

        let budget = std::time::Duration::from_millis(400);
        let t0 = std::time::Instant::now();
        reg.shutdown_all(budget).await;
        let elapsed = t0.elapsed();
        drop(wedge0);
        drop(wedge1);

        assert!(
            elapsed < budget * 7 / 4,
            "teardown must be concurrent, not serial: took {elapsed:?} for a {budget:?} budget"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn shutdown_all_completes_the_healthy_slots_despite_a_wedged_sibling() {
        let reg = registry(vec![Arc::new(FakeSource::new("usb", true, &["A", "B"]))]);
        let a = reg.enumerate().await[0].id.clone();
        let b = reg.enumerate().await[1].id.clone();
        reg.open(&a).await.expect("open A");
        reg.open_additional(&b, None).await.expect("open B");

        // Wedge slot 0's device mutex only.
        let handle0 = reg.runtimes()[0].handle();
        let wedge = handle0.lock().await;

        reg.shutdown_all(std::time::Duration::from_millis(400)).await;
        drop(wedge);

        assert_eq!(reg.slot_of("usb/B"), None, "the healthy slot's teardown completed");
        assert_eq!(reg.slot_of("usb/A"), Some(0), "the wedged slot expired its budget, honestly");
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

//! The [`DeviceRuntime`]: everything that is RUNTIME state of ONE device —
//! the device object, the loops that drive it, the flags that stop them, and
//! the bookkeeping of what is open on it (issue #25 lot C).
//!
//! Created once per device slot and NEVER replaced (the lot-B handle
//! invariant, extended to the whole runtime): REST, scripting, the stream
//! loop and the measurement sessions all hold `Arc`s out of it, so a runtime
//! that was ever swapped would silently detach them from the device the
//! connection commands drive.
//!
//! Lot C: the registry owns exactly one. Lot E: a map keyed by device —
//! routing, not refactor.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use tokio::sync::Mutex as TokioMutex;

use tokio::sync::Mutex as LifecycleGate;

use crate::mixer::Mixer;
use crate::qa40x::{QA40xDevice, Telemetry};
use crate::stream::StreamControl;

use super::error::DeviceError;
use super::id::{DeviceDescriptor, DeviceId};
use super::registry::OpenDevice;
use super::source::DeviceHandle;

/// The continuous-generator loop's flags, as ONE unit — they are only ever
/// meaningful together (`running` reports the loop, `stop` requests its
/// exit). Replaces the pair of loose `Arc<AtomicBool>`s that AppState,
/// `StreamControl`, `ScriptControl` and `measurement::Session` used to pass
/// around individually.
#[derive(Clone, Default)]
pub struct GeneratorFlags {
    running: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
}

impl GeneratorFlags {
    /// Wrap a pre-existing flag pair — the bridge for the frozen
    /// constructors (`ScriptControl::new`, `Session::new`) whose signatures
    /// keep taking the loose Arcs for the examples' sake.
    pub fn from_parts(running: Arc<AtomicBool>, stop: Arc<AtomicBool>) -> Self {
        Self { running, stop }
    }

    /// The shared "loop is running" flag (same `Arc` on every call).
    pub fn running_flag(&self) -> &Arc<AtomicBool> {
        &self.running
    }

    /// The shared "please stop" flag (same `Arc` on every call).
    pub fn stop_flag(&self) -> &Arc<AtomicBool> {
        &self.stop
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// Stop the continuous generator (if running) and wait until its loop
    /// exits, so a caller can take exclusive control of the device. The body
    /// of the legacy `crate::ensure_generator_stopped`, verbatim.
    pub async fn ensure_stopped(&self) {
        if !self.is_running() {
            return;
        }
        self.stop.store(true, Ordering::SeqCst);
        for _ in 0..200 {
            if !self.is_running() {
                break;
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(25)).await;
        }
    }
}

/// The unit currently open on this runtime, readable WITHOUT the device
/// mutex (the `last_telemetry` rule: no cache reader ever queues behind a
/// 22 s capture). The stream loop stamps it into every frame; the liveness
/// monitor keys its bookkeeping on it. `None` = nothing open, or a device
/// opened outside the registry (the examples' legacy
/// `QA40xDevice::connect()` path).
#[derive(Clone, Default)]
pub struct OpenUnitCell(Arc<StdMutex<Option<DeviceId>>>);

impl OpenUnitCell {
    pub fn get(&self) -> Option<DeviceId> {
        self.0.lock().expect("open unit lock").clone()
    }

    pub(crate) fn set(&self, id: Option<DeviceId>) {
        *self.0.lock().expect("open unit lock") = id;
    }
}

/// Monotonic counter of opens on one runtime. Bookkeeping writers that
/// observed the device at generation N (the liveness monitor, the bootloader
/// detach) present it back to [`DeviceRuntime::note_closed_at`], which
/// ignores them once a newer open has superseded N — a stale monitor tick
/// can never wipe a completing open's bookkeeping (lot-B review finding).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct OpenGeneration(pub(crate) u64);

/// Open/close bookkeeping of one runtime, generation-keyed.
#[derive(Default)]
struct LifecycleState {
    /// Bumped by every successful open.
    generation: u64,
    /// The unit currently open, per the bookkeeping (the device's own state
    /// remains the truth — see the registry module doc).
    current: Option<OpenDevice>,
    /// The open generation a liveness monitor is watching, if any. Replaces
    /// the old process-wide `usb_monitor_active` AtomicBool: claims are
    /// per-generation, so a reconnect HANDS OVER to a fresh monitor (the
    /// superseded one exits quietly on its next tick) instead of relying on
    /// the old monitor surviving the swap — and only the current-generation
    /// monitor can ever report the loss.
    monitor_generation: Option<u64>,
}

struct RuntimeInner {
    handle: DeviceHandle,
    /// The device's telemetry cache cell, grabbed BEFORE the device went
    /// behind its mutex so pure cache readers never queue on the exclusive
    /// device lock (the quit-hang rule).
    telemetry: Arc<TokioMutex<Option<Telemetry>>>,
    /// The signal mixer: stateful (slot declarations persist across frames),
    /// so it is per-device state, never shared between units.
    mixer: Arc<StdMutex<Mixer>>,
    generator: GeneratorFlags,
    /// Cooperative cancel for the batched sweeps (one long stream
    /// transaction): `sweep_stop` sets it, a fresh program clears it on
    /// entry and hands it to the capture pump, which aborts between USB
    /// blocks through the clean STREAM_STOP + drain exit.
    sweep_cancel: Arc<AtomicBool>,
    stream: StreamControl,
    open_unit: OpenUnitCell,
    /// Serializes open/close on this runtime: an open holds it for its WHOLE
    /// duration, so `close()` waits an in-flight open out instead of
    /// interleaving with it (lot-B review finding: two concurrent connects
    /// could interleave enumerate/open). tokio Mutex — it IS held across
    /// awaits, that is its purpose. Lock order: gate → device mutex, never
    /// the reverse.
    lifecycle_gate: LifecycleGate<()>,
    /// std Mutex held only for a read/replace, never across an await (the
    /// `StreamControl::config` rule) — `current()`/`generation()` must never
    /// queue behind a long capture.
    lifecycle: StdMutex<LifecycleState>,
    /// Test seam: a fault the next [`DeviceRuntime::teardown`] returns
    /// instead of touching the device — pins the "bookkeeping cleared even
    /// on failed teardown" branch, which is otherwise unreachable
    /// (`QA40xDevice::disconnect` is best-effort and never errors).
    #[cfg(test)]
    teardown_fault: StdMutex<Option<DeviceError>>,
}

/// The per-device runtime handle. Cheap to clone (all state behind one
/// `Arc`); every accessor returns the SAME shared object on every call.
#[derive(Clone)]
pub struct DeviceRuntime {
    inner: Arc<RuntimeInner>,
}

impl DeviceRuntime {
    /// Build the runtime around a fresh device object. Allocation-only: no
    /// task is spawned, no simulator instantiated (the `virt.rs` laziness
    /// invariant is untouched).
    pub fn new() -> Self {
        let device = QA40xDevice::new();
        // Telemetry cell BEFORE the device goes behind the mutex — see the
        // field doc.
        let telemetry = device.telemetry_cell();
        let handle: DeviceHandle = Arc::new(TokioMutex::new(device));
        let mixer = Arc::new(StdMutex::new(Mixer::default()));
        let generator = GeneratorFlags::default();
        let open_unit = OpenUnitCell::default();
        let stream = StreamControl::new(
            handle.clone(),
            generator.clone(),
            mixer.clone(),
            open_unit.clone(),
        );
        Self {
            inner: Arc::new(RuntimeInner {
                handle,
                telemetry,
                mixer,
                generator,
                sweep_cancel: Arc::new(AtomicBool::new(false)),
                stream,
                open_unit,
                lifecycle_gate: LifecycleGate::new(()),
                lifecycle: StdMutex::new(LifecycleState::default()),
                #[cfg(test)]
                teardown_fault: StdMutex::new(None),
            }),
        }
    }

    /// The one device object of this runtime — the same `Arc` on every call.
    pub fn handle(&self) -> DeviceHandle {
        self.inner.handle.clone()
    }

    /// The device's telemetry cache cell (readable without the device mutex).
    pub fn telemetry_cell(&self) -> Arc<TokioMutex<Option<Telemetry>>> {
        self.inner.telemetry.clone()
    }

    /// This device's signal mixer.
    pub fn mixer(&self) -> Arc<StdMutex<Mixer>> {
        self.inner.mixer.clone()
    }

    /// This device's continuous-generator flags.
    pub fn generator(&self) -> &GeneratorFlags {
        &self.inner.generator
    }

    /// This device's cooperative sweep-cancel flag (shared between the THD
    /// batch and wow & flutter — sound because only one exclusive program
    /// runs per device at a time).
    pub fn sweep_cancel(&self) -> &Arc<AtomicBool> {
        &self.inner.sweep_cancel
    }

    /// Trip the sweep cancel (the `sweep_stop` command / shutdown path).
    pub fn cancel_sweep(&self) {
        self.inner.sweep_cancel.store(true, Ordering::SeqCst);
    }

    /// This device's stream loop control.
    pub fn stream(&self) -> StreamControl {
        self.inner.stream.clone()
    }

    /// The unit-open cell (stamped by the registry's open/close bookkeeping).
    pub fn open_unit(&self) -> OpenUnitCell {
        self.inner.open_unit.clone()
    }

    /* ---- lifecycle bookkeeping (generation-keyed) ---------------------- */

    /// The open/close serialization gate. An open holds it for its WHOLE
    /// duration; `close()` acquires it too, so a close landing during an
    /// in-flight open waits the open out instead of interleaving.
    pub(crate) fn lifecycle_gate(&self) -> &LifecycleGate<()> {
        &self.inner.lifecycle_gate
    }

    /// The unit currently open on this runtime, per the bookkeeping.
    pub fn current(&self) -> Option<OpenDevice> {
        self.inner.lifecycle.lock().expect("lifecycle lock").current.clone()
    }

    /// The open unit's id (cheap std-lock read, never behind the device
    /// mutex).
    pub fn device_id(&self) -> Option<DeviceId> {
        self.inner.lifecycle.lock().expect("lifecycle lock").current.as_ref().map(|c| c.id.clone())
    }

    /// The current open generation (advances on every successful open).
    pub fn generation(&self) -> OpenGeneration {
        OpenGeneration(self.inner.lifecycle.lock().expect("lifecycle lock").generation)
    }

    /// Record a successful open: bumps the generation, replaces `current`,
    /// stamps the open-unit cell. Returns the new generation — the token a
    /// bookkeeping writer (liveness monitor, bootloader detach) must present
    /// back to [`Self::note_closed_at`].
    pub fn note_open(&self, id: DeviceId, descriptor: DeviceDescriptor) -> OpenGeneration {
        let gen = {
            let mut st = self.inner.lifecycle.lock().expect("lifecycle lock");
            st.generation += 1;
            st.current = Some(OpenDevice { id: id.clone(), descriptor });
            st.generation
        };
        self.inner.open_unit.set(Some(id));
        OpenGeneration(gen)
    }

    /// Record that the device closed, unconditionally — the `close()` path
    /// (the intent was to close, whatever the generation) and the failed
    /// open path (whatever was open is gone).
    pub fn note_closed(&self) {
        self.inner.lifecycle.lock().expect("lifecycle lock").current = None;
        self.inner.open_unit.set(None);
    }

    /// Record that the device closed OUTSIDE `close()` — unplug detected by
    /// the liveness monitor, bootloader detach during a flash — but ONLY if
    /// `gen` is still the current generation and something is actually open:
    /// a stale tick from before a reconnect must not wipe the newer open's
    /// bookkeeping. Returns whether it applied — the caller's "I am the one
    /// who observed the loss" token (one disconnect event, never two).
    pub fn note_closed_at(&self, gen: OpenGeneration) -> bool {
        let applied = {
            let mut st = self.inner.lifecycle.lock().expect("lifecycle lock");
            if st.generation == gen.0 && st.current.is_some() {
                st.current = None;
                true
            } else {
                false
            }
        };
        if applied {
            self.inner.open_unit.set(None);
        }
        applied
    }

    /// Tear the device down (safe-state + release). The registry's `close()`
    /// calls this under the lifecycle gate.
    pub(crate) async fn teardown(&self) -> Result<(), DeviceError> {
        #[cfg(test)]
        if let Some(e) = self.inner.teardown_fault.lock().expect("fault lock").take() {
            return Err(e);
        }
        let handle = self.handle();
        let dev = handle.lock().await;
        dev.disconnect().await.map(|_| ()).map_err(DeviceError::from)
    }

    /// Arm the teardown seam: the next [`Self::teardown`] returns `err`
    /// without touching the device.
    #[cfg(test)]
    pub fn inject_teardown_fault(&self, err: DeviceError) {
        *self.inner.teardown_fault.lock().expect("fault lock") = Some(err);
    }

    /* ---- quiesce / shutdown -------------------------------------------- */

    /// Hand the device back: nothing must be driving it after this returns.
    /// ORDER IS LOAD-BEARING (quit-hang post-mortem): a batched sweep holds
    /// the device for its WHOLE run (one long stream transaction), so its
    /// cooperative cancel is tripped BEFORE anything tries to take the
    /// device lock — otherwise the callers below wait the sweep out
    /// (minutes, felt as a hang). Then the stream loop, then the continuous
    /// generator, each waited out so the device mutex is genuinely free.
    pub async fn quiesce(&self) {
        self.cancel_sweep();
        self.stream().stop_and_wait().await;
        self.generator().ensure_stopped().await;
    }

    /// [`Self::quiesce`] + the device-side safe state (42 dBV max-headroom
    /// input range, STREAM_STOP, teardown) — the per-device half of the exit
    /// path. Best-effort: failures are logged, never propagated (the process
    /// is leaving).
    pub async fn shutdown(&self) {
        self.quiesce().await;
        log::info!("exit: loops stopped");
        // Lock order: lifecycle gate → device mutex. Short timeout and
        // proceed regardless — the safe state must never be hostage to a
        // wedged open (the outer per-device budget still bounds the whole).
        let _gate = tokio::time::timeout(
            tokio::time::Duration::from_secs(2),
            self.inner.lifecycle_gate.lock(),
        )
        .await
        .map_err(|_| log::warn!("exit: lifecycle gate busy after 2 s — tearing down anyway"))
        .ok();
        log::info!("exit: acquiring device lock");
        let handle = self.handle();
        let d = handle.lock().await;
        log::info!("exit: device lock acquired; checking connection");
        if d.is_connected().await {
            match d.disconnect().await {
                Ok(_) => log::info!("exit: device left safe (42 dBV, stream stopped)"),
                Err(e) => log::warn!("exit: safe teardown failed: {e}"),
            }
        } else {
            log::info!("exit: no device connected, nothing to do");
        }
        drop(d);
        self.note_closed();
    }

    /* ---- liveness monitor ---------------------------------------------- */

    /// Claim the liveness-monitor slot for `gen`. `false` when a monitor is
    /// already watching that same generation (the caller must not spawn a
    /// second one — the old duplicate-toast bug); a claim for a NEWER
    /// generation displaces the previous one, whose monitor exits quietly on
    /// its next tick.
    pub fn monitor_claim(&self, gen: OpenGeneration) -> bool {
        let mut st = self.inner.lifecycle.lock().expect("lifecycle lock");
        if st.monitor_generation == Some(gen.0) {
            return false;
        }
        st.monitor_generation = Some(gen.0);
        true
    }

    /// Release the monitor slot IF still owned by `gen` (a displaced
    /// monitor's release must not clear the newer claim).
    pub fn monitor_release(&self, gen: OpenGeneration) {
        let mut st = self.inner.lifecycle.lock().expect("lifecycle lock");
        if st.monitor_generation == Some(gen.0) {
            st.monitor_generation = None;
        }
    }

    /// Spawn the gap-free DAC loop: the buffer repeats until the stop flag
    /// is set. The caller has already stopped any previous loop and checked
    /// the connection; this flips the running/stop flags and detaches the
    /// task.
    pub fn spawn_generator_loop(&self, left: Vec<f32>, right: Vec<f32>) {
        let device = self.handle();
        let running = self.inner.generator.running_flag().clone();
        let stop = self.inner.generator.stop_flag().clone();
        stop.store(false, Ordering::SeqCst);
        running.store(true, Ordering::SeqCst);
        tokio::spawn(async move {
            while !stop.load(Ordering::SeqCst) {
                let dev = device.lock().await;
                let res = dev.generate_signal(&left, &right).await;
                drop(dev);
                if let Err(e) = res {
                    log::info!("Generator loop stopped on error: {}", e);
                    break;
                }
            }
            running.store(false, Ordering::SeqCst);
            log::info!("Generator loop exited");
        });
    }
}

impl Default for DeviceRuntime {
    fn default() -> Self {
        Self::new()
    }
}

/// `device-disconnected` event payload: which unit was lost. `device_id` is
/// `None` only for a device opened outside the registry; old frontends (and
/// the e2e fake, which emits the event payload-less) ignore it.
#[derive(Clone, Debug, serde::Serialize, ts_rs::TS)]
#[ts(export)]
pub struct DeviceLost {
    pub device_id: Option<String>,
}

/// Cadence of the liveness monitor's physical-presence poll.
const MONITOR_TICK: std::time::Duration = std::time::Duration::from_secs(2);

/// Watch the runtime's CURRENT open for physical disappearance (USB unplug):
/// every 2 s, take the device mutex and probe the bus; on loss, clear the
/// bookkeeping and call `on_lost` — but only if this monitor's generation is
/// still the live one, so exactly ONE report per loss, never a stale one.
///
/// Claims the monitor slot itself: a no-op when a monitor already watches
/// this generation. No Tauri dependency — the caller provides the event
/// emission as `on_lost` (testability).
pub fn spawn_liveness_monitor(rt: DeviceRuntime, on_lost: impl FnOnce(DeviceLost) + Send + 'static) {
    let gen = rt.generation();
    if !rt.monitor_claim(gen) {
        // A monitor is already watching this (re)connection.
        return;
    }
    let device_id = rt.device_id().map(|id| id.as_str().to_string());
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(MONITOR_TICK).await;

            if rt.generation() != gen {
                // Superseded by a newer open — its own monitor took over.
                break;
            }
            log::debug!("usb-monitor: tick — acquiring device lock");
            let handle = rt.handle();
            let guard = handle.lock().await;
            log::debug!("usb-monitor: lock acquired — checking physical presence");
            let still_connected = guard.check_physical_connection().await;
            drop(guard);
            log::debug!("usb-monitor: check done → {still_connected}");

            if !still_connected {
                // The device closed outside disconnect_device — keep the
                // bookkeeping honest before telling the frontend. A stale
                // race (disconnect_device or a newer open landed first)
                // reports nothing: whoever cleared the bookkeeping told
                // the user already.
                if rt.note_closed_at(gen) {
                    log::info!("Device disconnected - emitting event");
                    on_lost(DeviceLost { device_id });
                }
                break;
            }
        }
        rt.monitor_release(gen);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_runtime_hands_out_the_same_shared_objects_on_every_call() {
        // The never-replaced invariant, at the runtime level: every consumer
        // (REST, scripting, stream loop, sessions) captures Arcs out of the
        // runtime at construction — a runtime that handed out fresh objects
        // would silently split them apart.
        let rt = DeviceRuntime::new();
        assert!(Arc::ptr_eq(&rt.handle(), &rt.handle()));
        assert!(Arc::ptr_eq(&rt.telemetry_cell(), &rt.telemetry_cell()));
        assert!(Arc::ptr_eq(&rt.mixer(), &rt.mixer()));
        assert!(Arc::ptr_eq(rt.generator().running_flag(), rt.generator().running_flag()));
        assert!(Arc::ptr_eq(rt.sweep_cancel(), rt.sweep_cancel()));
        // And a clone shares the same inner state.
        let clone = rt.clone();
        assert!(Arc::ptr_eq(&clone.handle(), &rt.handle()));
        assert!(Arc::ptr_eq(&clone.mixer(), &rt.mixer()));
    }

    #[tokio::test]
    async fn generator_flags_ensure_stopped_matches_the_legacy_helper() {
        // Behavioural equivalence with the moved `ensure_generator_stopped`:
        // not running -> immediate no-op, stop flag untouched.
        let flags = GeneratorFlags::default();
        flags.ensure_stopped().await;
        assert!(!flags.stop_flag().load(Ordering::SeqCst));

        // Running -> stop is requested; a cooperative loop that clears
        // `running` lets the wait return.
        flags.running_flag().store(true, Ordering::SeqCst);
        let bg = {
            let f = flags.clone();
            tokio::spawn(async move {
                while !f.stop_flag().load(Ordering::SeqCst) {
                    tokio::time::sleep(tokio::time::Duration::from_millis(5)).await;
                }
                f.running_flag().store(false, Ordering::SeqCst);
            })
        };
        flags.ensure_stopped().await;
        assert!(!flags.is_running());
        bg.await.expect("loop task");
    }

    #[test]
    fn monitor_claim_admits_one_monitor_per_generation_and_hands_over_on_reopen() {
        let rt = DeviceRuntime::new();
        let gen1 = OpenGeneration(1);
        let gen2 = OpenGeneration(2);

        // First claim wins; a duplicate for the SAME generation is refused
        // (the duplicate-toast bug's guard, now per-generation).
        assert!(rt.monitor_claim(gen1));
        assert!(!rt.monitor_claim(gen1));

        // A newer open hands over: its claim displaces the old one…
        assert!(rt.monitor_claim(gen2));
        // …and the displaced monitor's release must NOT clear the new claim.
        rt.monitor_release(gen1);
        assert!(!rt.monitor_claim(gen2), "gen2's claim must have survived gen1's release");

        // The owning monitor's release frees the slot for a fresh claim.
        rt.monitor_release(gen2);
        assert!(rt.monitor_claim(gen2));
    }

    #[test]
    fn the_open_unit_cell_is_shared_and_clearable() {
        let rt = DeviceRuntime::new();
        let cell = rt.open_unit();
        assert!(cell.get().is_none());
        let id = DeviceId::new(&crate::device::SourceId::new("usb"), "AB12");
        cell.set(Some(id.clone()));
        assert_eq!(rt.open_unit().get(), Some(id));
        cell.set(None);
        assert!(rt.open_unit().get().is_none());
    }
}

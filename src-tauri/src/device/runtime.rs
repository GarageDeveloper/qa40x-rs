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

use crate::mixer::Mixer;
use crate::qa40x::{QA40xDevice, Telemetry};
use crate::stream::StreamControl;

use super::id::DeviceId;
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
        let stream = StreamControl::new(handle.clone(), generator.clone(), mixer.clone());
        Self {
            inner: Arc::new(RuntimeInner {
                handle,
                telemetry,
                mixer,
                generator,
                sweep_cancel: Arc::new(AtomicBool::new(false)),
                stream,
                open_unit: OpenUnitCell::default(),
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

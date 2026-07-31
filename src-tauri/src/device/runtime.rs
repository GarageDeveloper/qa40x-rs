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
use super::i2s::I2sEngine;
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
    /// constructor (`Session::new`) whose signature keeps taking the loose
    /// Arcs for the examples' sake.
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

/// Exclusive "a measurement program is running on this device" guard
/// (issue #25 lot F): a program command holds it from entry to completion,
/// release on drop. Owned so the guard can outlive the
/// [`DeviceRuntime::try_program_lock`] call and travel into the command's
/// async body.
pub type ProgramGuard = tokio::sync::OwnedMutexGuard<()>;

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
    /// The front-panel I2S output engine (issue #71). Per-device like
    /// everything else here; its endpoint cell was grabbed BEFORE the device
    /// went behind its mutex (the telemetry-cell pattern) so the paced
    /// writer never queues on the exclusive device lock.
    i2s: I2sEngine,
    generator: GeneratorFlags,
    /// Cooperative cancel for the batched sweeps (one long stream
    /// transaction): `sweep_stop` sets it, a fresh program clears it on
    /// entry and hands it to the capture pump, which aborts between USB
    /// blocks through the clean STREAM_STOP + drain exit.
    sweep_cancel: Arc<AtomicBool>,
    /// Exclusive measurement-program gate (issue #25 lot F): one program per
    /// device at a time, enforced HERE — the "only one exclusive program
    /// runs" premise `sweep_cancel` relies on used to be frontend convention
    /// only, so a wow & flutter invoke landing while a THD batch held the
    /// device could wipe a pending Stop (the lot-C soundness caveat). tokio
    /// Mutex behind an Arc: the guard is HELD ACROSS the whole program
    /// (that is its purpose) and owned so it can travel into the command
    /// body. Acquisition is `try_lock` only — never awaited (fail-fast).
    /// Lock order: program gate → device mutex, never the reverse; never
    /// nested with `lifecycle_gate`.
    program_gate: Arc<TokioMutex<()>>,
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
        // Telemetry + I2S endpoint cells BEFORE the device goes behind the
        // mutex — see the field docs.
        let telemetry = device.telemetry_cell();
        let i2s_cell = device.i2s_endpoint_cell();
        let handle: DeviceHandle = Arc::new(TokioMutex::new(device));
        let mixer = Arc::new(StdMutex::new(Mixer::default()));
        let i2s = I2sEngine::new(handle.clone(), i2s_cell);
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
                i2s,
                generator,
                sweep_cancel: Arc::new(AtomicBool::new(false)),
                program_gate: Arc::new(TokioMutex::new(())),
                stream,
                open_unit,
                lifecycle_gate: LifecycleGate::new(()),
                lifecycle: StdMutex::new(LifecycleState::default()),
                #[cfg(test)]
                teardown_fault: StdMutex::new(None),
            }),
        }
    }

    /// Whether `other` is the SAME runtime (shared inner state) — slot
    /// identity for the registry's slot vector (issue #25 lot E).
    pub fn same_as(&self, other: &DeviceRuntime) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
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

    /// This device's front-panel I2S output engine (issue #71) — the same
    /// engine on every call.
    pub fn i2s(&self) -> I2sEngine {
        self.inner.i2s.clone()
    }

    /// This device's continuous-generator flags.
    pub fn generator(&self) -> &GeneratorFlags {
        &self.inner.generator
    }

    /// This device's cooperative sweep-cancel flag (shared between the THD
    /// batch and wow & flutter — sound because [`Self::try_program_lock`]
    /// admits one gated program command per device at a time; before lot F
    /// this premise was frontend convention only, and none of the gate's
    /// exempt paths (see its doc) ever writes this flag).
    pub fn sweep_cancel(&self) -> &Arc<AtomicBool> {
        &self.inner.sweep_cancel
    }

    /// Claim this device's exclusive measurement-program gate (issue #25
    /// lot F). Fail-fast: [`DeviceError::ProgramBusy`] when a program
    /// already holds it — never queued, so a second invoke reads as a
    /// refusal, not a hang. The guard spans the whole program command: a
    /// `sweep_cancel.store(false)` performed while holding it can only ever
    /// consume a stale Stop, never another program's pending one. Lock
    /// order: program gate → device mutex.
    ///
    /// Honest scope (recorded lot-F limits, narrowed by lot F4): the gate
    /// covers the five `measure_*` commands AND a `script_run` with the
    /// Measurement role (the guard travels into the spawned run and drops
    /// with it — `ScriptControl::start`). Still exempt: REST acquisitions,
    /// which drive the device through their own `Session`s and can
    /// interleave with a gated program between its device locks
    /// (pre-existing; `sweep_cancel` itself stays sound — no exempt path
    /// writes it). And it is per-INVOKE for the measure commands: a
    /// frontend program made of several invokes (a "both channels" THD
    /// sweep is two) releases and re-claims between them — cross-invoke
    /// exclusivity is the frontend's per-session program lock (lot F4).
    /// The REST half of this note lives in `rest.rs`'s module doc ("Device
    /// scope", lot F6) — the two halves reference each other.
    pub fn try_program_lock(&self) -> Result<ProgramGuard, DeviceError> {
        self.inner
            .program_gate
            .clone()
            .try_lock_owned()
            .map_err(|_| DeviceError::ProgramBusy)
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

    /// ATOMIC snapshot of (current open unit, its generation) — one lock
    /// acquisition. The liveness monitor derives its probe, its generation
    /// token AND the id it will report from this single snapshot: reading
    /// them separately let a concurrent open interleave, pairing unit A's
    /// probe with unit B's generation and id — a false loss report against
    /// a healthy device (adversarial review, MUST-FIX #3).
    pub fn open_snapshot(&self) -> Option<(OpenDevice, OpenGeneration)> {
        let st = self.inner.lifecycle.lock().expect("lifecycle lock");
        st.current.clone().map(|cur| (cur, OpenGeneration(st.generation)))
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
        // I2S after the sweep cancel (its stop writes a register, which a
        // sweep holding the device would otherwise make wait minutes) and
        // before the stream teardown, so nothing restarts it.
        self.i2s().stop_and_wait().await;
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

    /// Claim the liveness-monitor slot for `gen`. `false` when a monitor
    /// already watches that same generation (the caller must not spawn a
    /// second one — the old duplicate-toast bug) or a NEWER one (a stale
    /// spawner that lost the race to a fresh open must not displace the
    /// live monitor — adversarial review, MUST-FIX #3); a claim for a newer
    /// generation displaces the previous one, whose monitor exits quietly
    /// on its next tick.
    pub fn monitor_claim(&self, gen: OpenGeneration) -> bool {
        let mut st = self.inner.lifecycle.lock().expect("lifecycle lock");
        match st.monitor_generation {
            Some(existing) if existing >= gen.0 => false,
            _ => {
                st.monitor_generation = Some(gen.0);
                true
            }
        }
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

/// How the liveness monitor decides its unit is still there (issue #25
/// lot E). Derived from the open unit's transport at spawn: a USB unit is
/// present iff a QA40x sits at ITS bus position — per-unit, so with N units
/// open, unplugging one is detected as that unit's loss and never masked by
/// a sibling still being on the bus (the pre-lot-E "any QA40x on the bus"
/// predicate was structurally blind to this). A pure OS enumeration — the
/// probe NEVER takes the device mutex, so a 22 s capture no longer delays
/// loss detection by its own length.
pub(crate) enum PresenceProbe {
    /// A QA40x at this exact bus position.
    Port { bus_id: String, port_chain: Vec<u8> },
    /// The in-process simulator never unplugs: always present. (Defensive —
    /// the connect commands don't spawn a monitor for virtual units.)
    Virtual,
    /// Test seam: presence pinned to a flag the test flips (the "unplug").
    #[cfg(test)]
    Pinned(Arc<AtomicBool>),
}

impl PresenceProbe {
    fn for_transport(t: &crate::device::Transport) -> Self {
        match t {
            crate::device::Transport::Usb { bus_id, port_chain, .. } => Self::Port {
                bus_id: bus_id.clone(),
                port_chain: port_chain.clone(),
            },
            crate::device::Transport::Virtual => Self::Virtual,
        }
    }

    async fn present(&self) -> bool {
        match self {
            Self::Port { bus_id, port_chain } => {
                super::usb::unit_present_at(bus_id, port_chain).await
            }
            Self::Virtual => true,
            #[cfg(test)]
            Self::Pinned(flag) => flag.load(Ordering::SeqCst),
        }
    }
}

/// Watch the runtime's CURRENT open for physical disappearance (USB unplug):
/// every 2 s, probe the unit's bus position (no device mutex — see
/// [`PresenceProbe`]); on loss, clear the bookkeeping and call `on_lost` —
/// but only if this monitor's generation is still the live one, so exactly
/// ONE report per loss, never a stale one.
///
/// Claims the monitor slot itself: a no-op when a monitor already watches
/// this generation. No Tauri dependency — the caller provides the event
/// emission as `on_lost` (testability).
pub fn spawn_liveness_monitor(rt: DeviceRuntime, on_lost: impl FnOnce(DeviceLost) + Send + 'static) {
    spawn_liveness_monitor_with_tick(rt, MONITOR_TICK, on_lost);
}

/// [`spawn_liveness_monitor`] with an explicit tick — the seam that lets the
/// generation→emit path be tested without multi-second sleeps.
pub(crate) fn spawn_liveness_monitor_with_tick(
    rt: DeviceRuntime,
    tick: std::time::Duration,
    on_lost: impl FnOnce(DeviceLost) + Send + 'static,
) {
    // ONE atomic snapshot: the probe, the generation token and the reported
    // id must all describe the SAME open (MUST-FIX #3 — reading them
    // separately let a concurrent open pair unit A's probe with unit B's
    // generation and id). Nothing open at spawn means nothing to monitor
    // (connect commands spawn the monitor right after a successful open;
    // anything else is a stale caller).
    let Some((cur, gen)) = rt.open_snapshot() else { return };
    let probe = PresenceProbe::for_transport(&cur.descriptor.transport);
    spawn_monitor_at(rt, gen, cur.id, tick, probe, on_lost);
}

/// The monitor body with an explicit [`PresenceProbe`] — the seam that lets
/// per-unit loss semantics (issue #25 lot E: one unit's unplug, its sibling
/// untouched) be tested without a USB bus.
#[cfg(test)]
pub(crate) fn spawn_liveness_monitor_with_probe(
    rt: DeviceRuntime,
    tick: std::time::Duration,
    probe: PresenceProbe,
    on_lost: impl FnOnce(DeviceLost) + Send + 'static,
) {
    let Some((cur, gen)) = rt.open_snapshot() else { return };
    spawn_monitor_at(rt, gen, cur.id, tick, probe, on_lost);
}

fn spawn_monitor_at(
    rt: DeviceRuntime,
    gen: OpenGeneration,
    id: DeviceId,
    tick: std::time::Duration,
    probe: PresenceProbe,
    on_lost: impl FnOnce(DeviceLost) + Send + 'static,
) {
    if !rt.monitor_claim(gen) {
        // A monitor is already watching this (re)connection — or a newer
        // one: a spawner whose snapshot was superseded before it could
        // claim must not displace the live monitor.
        return;
    }
    let device_id = Some(id.as_str().to_string());
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(tick).await;

            if rt.generation() != gen {
                // Superseded by a newer open — its own monitor took over.
                break;
            }
            if rt.current().is_none() {
                // Closed through disconnect_device / a failed open — whoever
                // cleared the bookkeeping owns the user notification (the
                // note_closed_at token contract).
                break;
            }
            if !probe.present().await {
                // The device closed outside disconnect_device — keep the
                // bookkeeping honest before telling the frontend. A stale
                // race (disconnect_device or a newer open landed first)
                // reports nothing: whoever cleared the bookkeeping told
                // the user already.
                if rt.note_closed_at(gen) {
                    // Flag-only I2S stop (issue #71): no register I/O to a
                    // unit that is gone; the writer exits when the claim
                    // release below clears its endpoint cell.
                    rt.i2s().stop_now();
                    log::info!("Device disconnected - emitting event");
                    on_lost(DeviceLost { device_id });
                    // Release the dead claim (interface/device handles) so
                    // the device object reads honestly disconnected. Only
                    // with the lifecycle gate free AND the generation still
                    // ours: an in-flight or later open resets the device
                    // state itself (release_claim first, teardown on close),
                    // so a busy gate means whoever holds it will leave the
                    // state consistent — skipping is safe, and never
                    // retrying is deliberate. Lock order: gate → device
                    // mutex, as everywhere; the device await is BOUNDED so a
                    // wedged capture can't pin the gate (and with it every
                    // open) for its whole length — same 2 s cap as
                    // `shutdown()`'s gate wait.
                    if let Ok(_gate) = rt.lifecycle_gate().try_lock() {
                        if rt.generation() == gen {
                            let handle = rt.handle();
                            match tokio::time::timeout(
                                std::time::Duration::from_secs(2),
                                handle.lock(),
                            )
                            .await
                            {
                                Ok(dev) => {
                                    dev.mark_disconnected().await;
                                    log::debug!("usb-monitor: dead claim released");
                                }
                                Err(_) => log::warn!(
                                    "usb-monitor: device busy after 2 s — leaving the dead claim to the next open"
                                ),
                            };
                        }
                    }
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
        assert!(rt.i2s().same_as(&rt.i2s()));
        // And a clone shares the same inner state.
        let clone = rt.clone();
        assert!(Arc::ptr_eq(&clone.handle(), &rt.handle()));
        assert!(Arc::ptr_eq(&clone.mixer(), &rt.mixer()));
        assert!(clone.i2s().same_as(&rt.i2s()));
        // Sibling runtimes have INDEPENDENT engines — device A's I2S must
        // never drive device B's port.
        assert!(!DeviceRuntime::new().i2s().same_as(&rt.i2s()));
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

        // A claim for an OLDER generation than the live one is refused
        // (adversarial review MUST-FIX #3): a spawner whose snapshot was
        // superseded before it could claim must not displace the live
        // monitor — the newer open already has (or will spawn) its own.
        assert!(!rt.monitor_claim(gen1), "a stale spawner must not displace the live monitor");
    }

    fn opened_fake(rt: &DeviceRuntime, unit: &str) -> (DeviceId, OpenGeneration) {
        let src = crate::device::SourceId::new("usb");
        let id = DeviceId::new(&src, unit);
        let gen = rt.note_open(id.clone(), crate::device::testing::fake_descriptor(&src, unit, true));
        (id, gen)
    }

    /// The monitor's generation→emit composition (review F4): a physical
    /// loss is reported EXACTLY once, with the lost unit's id, and the
    /// bookkeeping is cleared. The runtime's device object was never
    /// connected, so `check_physical_connection` reports the loss on the
    /// first (fast, test-only) tick.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_monitor_reports_a_loss_exactly_once_with_the_units_id() {
        let rt = DeviceRuntime::new();
        opened_fake(&rt, "AB12");

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<DeviceLost>();
        spawn_liveness_monitor_with_tick(
            rt.clone(),
            std::time::Duration::from_millis(10),
            move |lost| {
                let _ = tx.send(lost);
            },
        );

        let lost = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
            .await
            .expect("the loss must be reported within budget")
            .expect("channel open");
        assert_eq!(lost.device_id.as_deref(), Some("usb/AB12"));
        assert!(rt.current().is_none(), "the monitor cleared the bookkeeping");
        // Exactly once: the monitor task ended (its FnOnce sender dropped),
        // so the channel closes with no second report.
        let end = tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv())
            .await
            .expect("the monitor task must have exited");
        assert!(end.is_none(), "no second loss report");
    }

    /// The token contract's other half (review F1's regression class): when
    /// someone ELSE already consumed the note_closed_at token for this
    /// generation (the flash path's bootloader detach), the monitor observes
    /// the dead device, finds nothing left to close, and exits WITHOUT
    /// reporting — whoever cleared the bookkeeping owns the notification.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_monitor_stays_silent_when_the_loss_was_already_bookkept() {
        let rt = DeviceRuntime::new();
        let (_, gen) = opened_fake(&rt, "AB12");
        // The flash path consumed the token before the monitor could.
        assert!(rt.note_closed_at(gen));

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<DeviceLost>();
        spawn_liveness_monitor_with_tick(
            rt.clone(),
            std::time::Duration::from_millis(10),
            move |lost| {
                let _ = tx.send(lost);
            },
        );

        let end = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
            .await
            .expect("the monitor must exit, not keep polling a dead device");
        assert!(end.is_none(), "an already-bookkept loss must not be re-reported");
    }

    /// A user disconnect (`close()` → `note_closed`) while the monitor is
    /// between ticks: the monitor must exit QUIETLY — whoever cleared the
    /// bookkeeping owns the user notification (the token contract), and the
    /// probe result must not even be consulted for a runtime that is closed.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_monitor_exits_quietly_when_the_runtime_was_closed_under_it() {
        let rt = DeviceRuntime::new();
        opened_fake(&rt, "AB12");

        let present = Arc::new(AtomicBool::new(true));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<DeviceLost>();
        spawn_liveness_monitor_with_probe(
            rt.clone(),
            std::time::Duration::from_millis(10),
            PresenceProbe::Pinned(present.clone()),
            move |lost| {
                let _ = tx.send(lost);
            },
        );
        // The close lands while the unit is still "present" on the bus — the
        // normal disconnect_device case.
        rt.note_closed();

        let end = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
            .await
            .expect("the monitor must exit once the runtime is closed");
        assert!(end.is_none(), "a user close must never be re-reported as a loss");
    }

    /// The lot-E acceptance property at the runtime level (planner F1): with
    /// TWO runtimes watched by their own monitors, unplugging unit A is
    /// reported as A's loss exactly once, while B's monitor stays silent and
    /// B's bookkeeping survives untouched. (The pre-lot-E "any QA40x on the
    /// bus" predicate was structurally blind to this — B's presence masked
    /// A's loss.)
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn one_units_unplug_is_reported_for_that_unit_only() {
        let rt_a = DeviceRuntime::new();
        let rt_b = DeviceRuntime::new();
        let (id_b, _) = {
            opened_fake(&rt_a, "AAAA");
            opened_fake(&rt_b, "BBBB")
        };

        let present_a = Arc::new(AtomicBool::new(true));
        let present_b = Arc::new(AtomicBool::new(true));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<DeviceLost>();
        for (rt, present) in [(rt_a.clone(), present_a.clone()), (rt_b.clone(), present_b.clone())] {
            let tx = tx.clone();
            spawn_liveness_monitor_with_probe(
                rt,
                std::time::Duration::from_millis(10),
                PresenceProbe::Pinned(present),
                move |lost| {
                    let _ = tx.send(lost);
                },
            );
        }
        drop(tx);

        // Unplug A only.
        present_a.store(false, Ordering::SeqCst);

        let lost = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
            .await
            .expect("A's loss must be reported within budget")
            .expect("channel open — B's monitor still holds a sender");
        assert_eq!(lost.device_id.as_deref(), Some("usb/AAAA"));
        assert!(rt_a.current().is_none(), "A's bookkeeping is cleared");
        assert_eq!(
            rt_b.current().expect("B must survive A's unplug untouched").id,
            id_b
        );
        // No second report while B stays present.
        let quiet = tokio::time::timeout(std::time::Duration::from_millis(200), rx.recv()).await;
        assert!(quiet.is_err(), "B's monitor must stay silent");
    }

    /// On a real loss the monitor also releases the dead claim: the device
    /// object must read disconnected afterwards (and a virtual import must be
    /// released), so nothing keeps driving a unit that is gone. The cleanup
    /// runs AFTER the event — poll for it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_loss_releases_the_dead_claim_after_reporting() {
        use crate::qa40x::transport::demo_sim_options;
        use vqa40x_core::Simulator;

        let rt = DeviceRuntime::new();
        // Attach a real (virtual) session so there is a claim to release.
        let sim = Simulator::new(demo_sim_options());
        {
            let handle = rt.handle();
            let dev = handle.lock().await;
            dev.connect_virtual_sim(sim.clone(), crate::qa40x::Model::Qa403)
                .await
                .expect("attach the virtual session");
        }
        opened_fake(&rt, "AB12");

        let present = Arc::new(AtomicBool::new(false));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<DeviceLost>();
        spawn_liveness_monitor_with_probe(
            rt.clone(),
            std::time::Duration::from_millis(10),
            PresenceProbe::Pinned(present),
            move |lost| {
                let _ = tx.send(lost);
            },
        );
        rx.recv().await.expect("the loss is reported first");

        // The claim release follows; poll within a budget.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            let connected = { rt.handle().lock().await.is_connected().await };
            if !connected {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the dead claim must be released after the loss report"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(
            sim.try_import(),
            "the virtual import must have been released by the cleanup"
        );
        sim.release_import();
    }

    /// Issue #25 lot F: the program gate admits ONE exclusive program per
    /// device — a second claim fails fast (`ProgramBusy`, never queued), the
    /// gate frees on guard drop, a clone shares the same gate, and sibling
    /// runtimes have INDEPENDENT gates (a sweep on device A must never
    /// refuse a program on device B).
    #[test]
    fn the_program_gate_is_exclusive_per_runtime_and_frees_on_drop() {
        let rt = DeviceRuntime::new();
        let guard = rt.try_program_lock().expect("a free gate must be claimable");
        assert!(
            matches!(rt.try_program_lock(), Err(DeviceError::ProgramBusy)),
            "a second program on the same device must be refused"
        );
        // A clone shares the inner state — same gate, same refusal.
        assert!(matches!(rt.clone().try_program_lock(), Err(DeviceError::ProgramBusy)));

        // A sibling runtime's gate is its own.
        let rt2 = DeviceRuntime::new();
        let _other = rt2
            .try_program_lock()
            .expect("device B's gate must be independent of device A's");

        drop(guard);
        let _again = rt
            .try_program_lock()
            .expect("the gate must free when the program's guard drops");
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

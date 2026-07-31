//! The per-device front-panel I2S output engine (issue #71).
//!
//! One engine per [`super::DeviceRuntime`], owning:
//!
//! - its OWN [`Mixer`] instance (the I2S routing differs from the DAC
//!   routing, and `Mixer` is stateful — sharing the runtime's DAC mixer
//!   would cross-contaminate slot declarations);
//! - a 1 s loop buffer rendered at the port's pinned 48 kHz
//!   ([`I2S_RATE_HZ`]) and pre-encoded to wire bytes;
//! - the paced EP 0x03 writer task: a two-buffer ping-pong, flow-controlled
//!   by the device (~42.7 ms per 2048-frame block), streaming silence when
//!   no source routes to the port.
//!
//! # No endpoint serialization (device notes §10)
//!
//! The writer reaches its endpoint through the device's dedicated I2S cell
//! ([`crate::qa40x::QA40xDevice::i2s_endpoint_cell`]) — never the exclusive
//! device mutex and never the `eps` mutex `stream_pump` holds for a whole
//! capture. Register writes (0x0A/0x0B) do take the device mutex, but only
//! at start/stop, between captures. So an acquisition, the ~1 Hz keepalive
//! and the I2S stream all run concurrently, which is what the hardware
//! expects. The endpoint cell is locked per writer iteration (one
//! completion + one refill), so teardown paths that clear the cell wait at
//! most one paced block.
//!
//! # Level convention
//!
//! The port is purely digital, so its "full scale" needs a reference: a
//! source at `reference_dbv` level-volts lands at digital full scale (a
//! sine at the reference plays 0 dBFS peak — the same peak/RMS convention
//! as the analog path). Scaling follows the `scale_mix_to_range` contract
//! (clamp ±1 and report, never rescale) with NO factory DAC trims — those
//! compensate an analog gain error a digital port does not have.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use tokio::sync::Mutex as TokioMutex;

use crate::mixer::{Mixer, MixerSlotDesc, SlotError};
use crate::qa40x::device::{cancel_and_drain, complete_or_cancel};
use crate::qa40x::i2s::{encode_i2s_frames, I2sWidth, I2S_RATE_HZ};
use crate::qa40x::transport::BulkOut;

use super::error::DeviceError;
use super::source::DeviceHandle;

/// The vendor app's pause between the `I2S_WIDTH` write and `I2S_CTRL = 1`.
const I2S_WIDTH_SETTLE: Duration = Duration::from_millis(100);

/// Per-block completion timeout. The device paces one completion every
/// ~42.7 ms; 2 s means a dead endpoint is detected well within a status
/// poll, while a busy bus never false-trips.
const WRITER_COMPLETION_TIMEOUT: Duration = Duration::from_secs(2);

/// One `i2s_apply` invocation: the idempotent full-state declaration
/// (enable/rebuild/disable in one shape, mirroring `output_only_start`).
#[derive(Clone, Debug)]
pub struct I2sRequest {
    pub enabled: bool,
    pub slots: Vec<MixerSlotDesc>,
    /// Source level (dBV, level-volts) that lands at digital full scale.
    pub reference_dbv: f32,
    pub width: I2sWidth,
}

/// The engine's observable state, returned by `i2s_apply` and served by the
/// `i2s_status` cache read.
#[derive(Clone, Debug, serde::Serialize, ts_rs::TS)]
#[ts(export)]
pub struct I2sStatus {
    /// The EP 0x03 claim exists on the current connection.
    pub supported: bool,
    /// The port was enabled by the last apply (user intent).
    pub enabled: bool,
    /// The writer task is alive (false + enabled = it died; see
    /// `last_error`).
    pub running: bool,
    pub width_bits: u8,
    pub reference_dbv: f32,
    /// Peak of the summed I2S mix in dBV; `None` when silent.
    pub sigma_peak_dbv: Option<f32>,
    /// The loop clips the reference (clamped + reported, never rescaled).
    pub clipped: bool,
    pub errors: Vec<SlotError>,
    /// Blocks accepted by the device since the writer started — the "is it
    /// actually flowing" readout (~23.4 blocks/s at 48 kHz).
    #[ts(type = "number")]
    pub blocks_written: u64,
    pub last_error: Option<String>,
}

/// The pre-encoded 1 s loop the writer slices blocks from.
struct I2sLoopBuf {
    bytes: Vec<u8>,
    block_bytes: usize,
}

impl I2sLoopBuf {
    /// The block starting at byte `cursor`, wrapping over the loop, and the
    /// next cursor. The loop length is a multiple of the frame size, so a
    /// wrapped cursor is always frame-aligned.
    fn block_at(&self, cursor: usize) -> (Vec<u8>, usize) {
        let n = self.bytes.len();
        let mut out = Vec::with_capacity(self.block_bytes);
        let mut c = cursor % n;
        while out.len() < self.block_bytes {
            let take = (self.block_bytes - out.len()).min(n - c);
            out.extend_from_slice(&self.bytes[c..c + take]);
            c = (c + take) % n;
        }
        (out, c)
    }
}

/// The swappable loop slot: a generation bump tells the writer to restart
/// from the new buffer (cursor reset — a re-mix is a deliberate
/// discontinuity, the same contract as the output-only rebuild).
struct LoopSlot {
    generation: u64,
    buf: Arc<I2sLoopBuf>,
}

struct StatusState {
    enabled: bool,
    width: I2sWidth,
    reference_dbv: f32,
    sigma_peak_dbv: Option<f32>,
    clipped: bool,
    errors: Vec<SlotError>,
    last_error: Option<String>,
}

struct I2sInner {
    /// Registers only (0x0A/0x0B at start/stop) — the writer never touches
    /// this.
    device: DeviceHandle,
    /// The device's dedicated EP 0x03 cell (see the module doc).
    ep_cell: Arc<TokioMutex<Option<BulkOut>>>,
    /// The engine's own mixer — NEVER the runtime's DAC mixer.
    mixer: Arc<StdMutex<Mixer>>,
    /// Serializes apply/stop. Lock order: apply gate → device mutex; the
    /// std mutexes below are never held across an await.
    apply_gate: TokioMutex<()>,
    loop_buf: StdMutex<LoopSlot>,
    stop: AtomicBool,
    running: AtomicBool,
    blocks_written: AtomicU64,
    status: StdMutex<StatusState>,
    task: StdMutex<Option<tokio::task::JoinHandle<()>>>,
}

/// The per-device I2S engine handle. Cheap to clone (all state behind one
/// `Arc`), like [`super::DeviceRuntime`].
#[derive(Clone)]
pub struct I2sEngine {
    inner: Arc<I2sInner>,
}

impl I2sEngine {
    pub fn new(device: DeviceHandle, ep_cell: Arc<TokioMutex<Option<BulkOut>>>) -> Self {
        Self {
            inner: Arc::new(I2sInner {
                device,
                ep_cell,
                mixer: Arc::new(StdMutex::new(Mixer::default())),
                apply_gate: TokioMutex::new(()),
                loop_buf: StdMutex::new(LoopSlot {
                    generation: 0,
                    buf: Arc::new(I2sLoopBuf {
                        bytes: vec![0u8; I2sWidth::Bits32.block_bytes()],
                        block_bytes: I2sWidth::Bits32.block_bytes(),
                    }),
                }),
                stop: AtomicBool::new(false),
                running: AtomicBool::new(false),
                blocks_written: AtomicU64::new(0),
                status: StdMutex::new(StatusState {
                    enabled: false,
                    width: I2sWidth::Bits32,
                    reference_dbv: 0.0,
                    sigma_peak_dbv: None,
                    clipped: false,
                    errors: Vec::new(),
                    last_error: None,
                }),
                task: StdMutex::new(None),
            }),
        }
    }

    /// Whether `other` is the SAME engine (shared inner state).
    pub fn same_as(&self, other: &I2sEngine) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }

    /// Apply a full port declaration: enable/rebuild/disable in one
    /// idempotent entry point. While the port is running, a re-declaration
    /// with the same width swaps the loop buffer WITHOUT touching registers
    /// — the downstream receiver's clock never glitches on a re-mix.
    pub async fn apply(&self, req: I2sRequest) -> Result<I2sStatus, DeviceError> {
        let _gate = self.inner.apply_gate.lock().await;

        if !req.enabled {
            self.stop_locked().await;
            {
                let mut st = self.inner.status.lock().expect("i2s status lock");
                st.enabled = false;
                st.sigma_peak_dbv = None;
                st.clipped = false;
                st.errors.clear();
            }
            return Ok(self.snapshot().await);
        }

        if !self.ep_present().await {
            return Err(DeviceError::Source(
                "I2S output is not available on this device".into(),
            ));
        }

        // Render the 1 s loop at the port rate and scale it to the
        // reference, off the async runtime (scripts may take a while to
        // compile). The port rate is pinned: sources are re-rendered at
        // 48 kHz, never resampled from an acquisition-rate buffer.
        let mixer = self.inner.mixer.clone();
        let slots = req.slots;
        let reference_dbv = req.reference_dbv;
        let width = req.width;
        let (bytes, sigma_peak_dbv, clipped, errors) = tokio::task::spawn_blocking(move || {
            let mut m = mixer.lock().map_err(|_| "I2S mixer lock poisoned".to_string())?;
            let mut errors = m.set_slots(slots);
            let mut frame = m.render(I2S_RATE_HZ, I2S_RATE_HZ as usize);
            errors.append(&mut frame.errors);
            let sigma_peak_dbv = (frame.peak > 0.0).then(|| 20.0 * frame.peak.log10());
            let clipped = scale_to_reference(&mut frame.left, &mut frame.right, reference_dbv);
            let bytes = encode_i2s_frames(&frame.left, &frame.right, width);
            Ok::<_, String>((bytes, sigma_peak_dbv, clipped, errors))
        })
        .await
        .map_err(|e| DeviceError::Source(format!("I2S mixer task failed: {e}")))?
        .map_err(DeviceError::Source)?;

        // A width change needs a register cycle — restart the port for it.
        // (No UI path changes the width today; this keeps the type honest.)
        let width_changed = self.inner.status.lock().expect("i2s status lock").width != width;
        if self.inner.running.load(Ordering::SeqCst) && width_changed {
            self.stop_locked().await;
        }

        {
            let mut slot = self.inner.loop_buf.lock().expect("i2s loop lock");
            slot.generation += 1;
            slot.buf = Arc::new(I2sLoopBuf { bytes, block_bytes: width.block_bytes() });
        }
        {
            let mut st = self.inner.status.lock().expect("i2s status lock");
            st.enabled = true;
            st.width = width;
            st.reference_dbv = reference_dbv;
            st.sigma_peak_dbv = sigma_peak_dbv;
            st.clipped = clipped;
            st.errors = errors;
            st.last_error = None;
        }

        if !self.inner.running.load(Ordering::SeqCst) {
            if let Err(e) = self.start_port(width).await {
                let mut st = self.inner.status.lock().expect("i2s status lock");
                st.enabled = false;
                st.last_error = Some(e.to_string());
                return Err(e);
            }
            self.spawn_writer();
        }

        Ok(self.snapshot().await)
    }

    /// The engine's observable state. A pure cache read on the engine's own
    /// state — never takes the device mutex (the `last_telemetry` rule).
    pub async fn status(&self) -> I2sStatus {
        self.snapshot().await
    }

    /// Stop the port and wait the writer out (bounded), then write
    /// `I2S_CTRL = 0` best-effort. Safe on a never-started engine.
    pub async fn stop_and_wait(&self) {
        let _gate = self.inner.apply_gate.lock().await;
        self.stop_locked().await;
        self.inner.status.lock().expect("i2s status lock").enabled = false;
    }

    /// Flag-only stop for the unplug path: no register I/O to a unit that is
    /// gone, no awaits. The writer exits on its next iteration (the endpoint
    /// cell is cleared by `mark_disconnected` anyway).
    pub fn stop_now(&self) {
        self.inner.stop.store(true, Ordering::SeqCst);
    }

    /* ---- internals ------------------------------------------------------ */

    async fn ep_present(&self) -> bool {
        match self.inner.ep_cell.try_lock() {
            Ok(g) => g.is_some(),
            // The writer holds the cell per-iteration — it only runs against
            // an existing endpoint.
            Err(_) => true,
        }
    }

    /// Register bring-up: width, the vendor's ~100 ms pause, then start.
    /// The device mutex is held across each register write only — never the
    /// pause.
    async fn start_port(&self, width: I2sWidth) -> Result<(), DeviceError> {
        {
            let dev = self.inner.device.lock().await;
            dev.set_i2s_width(width).await.map_err(DeviceError::from)?;
        }
        tokio::time::sleep(I2S_WIDTH_SETTLE).await;
        let dev = self.inner.device.lock().await;
        dev.set_i2s_running(true).await.map_err(DeviceError::from)
    }

    fn spawn_writer(&self) {
        self.inner.stop.store(false, Ordering::SeqCst);
        self.inner.running.store(true, Ordering::SeqCst);
        self.inner.blocks_written.store(0, Ordering::SeqCst);
        let inner = self.inner.clone();
        let handle = tokio::spawn(writer_task(inner));
        *self.inner.task.lock().expect("i2s task lock") = Some(handle);
    }

    /// Stop half shared by `apply(enabled: false)` and `stop_and_wait` —
    /// caller holds the apply gate.
    async fn stop_locked(&self) {
        self.inner.stop.store(true, Ordering::SeqCst);
        let task = self.inner.task.lock().expect("i2s task lock").take();
        if let Some(t) = task {
            if tokio::time::timeout(Duration::from_secs(5), t).await.is_err() {
                log::warn!("I2S writer did not exit within 5 s");
            }
        }
        // Port off. The device mutex is acquired with a bound: a program
        // holding the device for minutes must not hang a stop — the write
        // is then skipped, and the next connect's I2S_CTRL = 0 recovers.
        match tokio::time::timeout(Duration::from_secs(3), self.inner.device.lock()).await {
            Ok(dev) => {
                if let Err(e) = dev.set_i2s_running(false).await {
                    log::debug!("I2S stop register write skipped: {e}");
                }
            }
            Err(_) => log::warn!(
                "I2S stop: device busy after 3 s — leaving the register to the next connect"
            ),
        }
    }

    async fn snapshot(&self) -> I2sStatus {
        let supported = self.ep_present().await;
        let st = self.inner.status.lock().expect("i2s status lock");
        I2sStatus {
            supported,
            enabled: st.enabled,
            running: self.inner.running.load(Ordering::SeqCst),
            width_bits: st.width.bits(),
            reference_dbv: st.reference_dbv,
            sigma_peak_dbv: st.sigma_peak_dbv,
            clipped: st.clipped,
            errors: st.errors.clone(),
            blocks_written: self.inner.blocks_written.load(Ordering::SeqCst),
            last_error: st.last_error.clone(),
        }
    }
}

/// The paced writer: two blocks in flight, one completed / one refilled per
/// iteration, device-paced (~42.7 ms per block). Locks ONLY the endpoint
/// cell — never `eps`, never the device mutex — so captures and the
/// keepalive run beside it (the whole point of issue #71's design).
async fn writer_task(inner: Arc<I2sInner>) {
    let record = |inner: &I2sInner, msg: String| {
        log::warn!("I2S writer: {msg}");
        inner.status.lock().expect("i2s status lock").last_error = Some(msg);
    };

    let (mut generation, mut buf) = {
        let slot = inner.loop_buf.lock().expect("i2s loop lock");
        (slot.generation, slot.buf.clone())
    };
    let mut cursor = 0usize;

    // Prime the two-buffer ping-pong.
    {
        let mut g = inner.ep_cell.lock().await;
        match g.as_mut() {
            Some(ep) => {
                for _ in 0..2 {
                    let (block, next) = buf.block_at(cursor);
                    cursor = next;
                    ep.submit(block.into());
                }
            }
            None => {
                record(&inner, "endpoint released before the first block".into());
                inner.running.store(false, Ordering::SeqCst);
                return;
            }
        }
    }

    loop {
        if inner.stop.load(Ordering::SeqCst) {
            break;
        }
        // Endpoint cell locked per iteration only: teardown paths that
        // clear the cell wait at most one paced block.
        let mut g = inner.ep_cell.lock().await;
        let Some(ep) = g.as_mut() else {
            record(&inner, "endpoint released".into());
            break;
        };
        match complete_or_cancel(ep, WRITER_COMPLETION_TIMEOUT).await {
            Ok(c) => match c.status {
                Ok(()) => {
                    inner.blocks_written.fetch_add(1, Ordering::SeqCst);
                }
                Err(e) => {
                    record(&inner, format!("block write failed: {e}"));
                    break;
                }
            },
            Err(e) => {
                record(&inner, format!("block write stalled: {e}"));
                break;
            }
        }
        if inner.stop.load(Ordering::SeqCst) {
            break;
        }
        {
            let slot = inner.loop_buf.lock().expect("i2s loop lock");
            if slot.generation != generation {
                generation = slot.generation;
                buf = slot.buf.clone();
                // A re-mix restarts the loop — a deliberate discontinuity,
                // identical to the output-only rebuild contract.
                cursor = 0;
            }
        }
        let (block, next) = buf.block_at(cursor);
        cursor = next;
        ep.submit(block.into());
    }

    // Leave the endpoint queue empty for the next start (the drain rule:
    // a stale completion left queued would fail the next writer's first
    // collection).
    {
        let mut g = inner.ep_cell.lock().await;
        if let Some(ep) = g.as_mut() {
            cancel_and_drain(ep).await;
        }
    }
    inner.running.store(false, Ordering::SeqCst);
}

/// Scale the mixed loop (level-volts) so a source at `reference_dbv` lands
/// at digital full scale — `scale_mix_to_range`'s contract (clamp ±1 and
/// report, never rescale) with an f32 reference and NO DAC trims (nothing
/// analog to pre-compensate on a digital port). Pinned against the mixer's
/// scaler in the tests below.
fn scale_to_reference(left: &mut [f32], right: &mut [f32], reference_dbv: f32) -> bool {
    let scale = 10.0f32.powf(-reference_dbv / 20.0);
    let mut clipped = false;
    for chan in [left, right] {
        for v in chan.iter_mut() {
            let scaled = *v * scale;
            *v = scaled.clamp(-1.0, 1.0);
            if scaled > 1.0 || scaled < -1.0 {
                clipped = true;
            }
        }
    }
    clipped
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::qa40x::QA40xDevice;

    fn test_engine() -> I2sEngine {
        let device = QA40xDevice::new();
        let cell = device.i2s_endpoint_cell();
        let handle: DeviceHandle = Arc::new(TokioMutex::new(device));
        I2sEngine::new(handle, cell)
    }

    #[test]
    fn block_at_wraps_the_loop_without_dropping_bytes() {
        // A loop whose length is NOT a multiple of the block size (the real
        // 48 kHz × 8-byte loop is 384000 bytes, 23.4375 blocks): the wrap
        // must splice tail + head seamlessly.
        let bytes: Vec<u8> = (0..=255u8).collect(); // 256-byte loop
        let buf = I2sLoopBuf { bytes: bytes.clone(), block_bytes: 100 };
        let (b0, c1) = buf.block_at(0);
        assert_eq!(b0, bytes[0..100]);
        assert_eq!(c1, 100);
        let (b1, c2) = buf.block_at(c1);
        assert_eq!(b1, bytes[100..200]);
        let (b2, c3) = buf.block_at(c2);
        // Wraps: 56 tail bytes then 44 head bytes.
        assert_eq!(&b2[..56], &bytes[200..256]);
        assert_eq!(&b2[56..], &bytes[0..44]);
        assert_eq!(c3, 44);
    }

    #[test]
    fn the_real_loop_geometry_wraps_frame_aligned() {
        // 1 s at 48 kHz in 32-bit: 384000 bytes, block 16384. Every cursor
        // the writer can see must be frame-aligned (multiple of 8) — the
        // wire is interleaved stereo frames, so a misaligned wrap would
        // swap channels mid-stream.
        let buf = I2sLoopBuf {
            bytes: vec![0u8; I2S_RATE_HZ as usize * 8],
            block_bytes: I2sWidth::Bits32.block_bytes(),
        };
        let mut cursor = 0usize;
        for _ in 0..100 {
            let (block, next) = buf.block_at(cursor);
            assert_eq!(block.len(), 16384);
            assert_eq!(next % 8, 0, "cursor must stay frame-aligned");
            cursor = next;
        }
    }

    #[test]
    fn scale_to_reference_matches_the_mixer_scaler_for_integer_references() {
        // The pin that keeps the I2S level convention identical to the DAC
        // path's: same input, integer reference, trims (1,1) — same output,
        // same clip verdict.
        for reference in [-12i32, 0, 8] {
            let src_l = vec![1.0f32, -0.5, 3.5];
            let src_r = vec![0.25f32, -1.0, 0.0];
            let (mut l1, mut r1) = (src_l.clone(), src_r.clone());
            let (mut l2, mut r2) = (src_l, src_r);
            let c1 = scale_to_reference(&mut l1, &mut r1, reference as f32);
            let c2 = crate::mixer::scale_mix_to_range(&mut l2, &mut r2, reference, (1.0, 1.0));
            assert_eq!(c1, c2, "clip verdict at reference {reference}");
            assert_eq!(l1, l2, "left at reference {reference}");
            assert_eq!(r1, r2, "right at reference {reference}");
        }
    }

    #[test]
    fn a_sine_at_the_reference_lands_at_digital_full_scale() {
        // The convention: a source at the reference level plays 0 dBFS peak.
        let mut l = vec![10.0f32.powf(-6.0 / 20.0)]; // a −6 dBV peak
        let mut r = vec![0.0f32];
        let clipped = scale_to_reference(&mut l, &mut r, -6.0);
        assert!(!clipped);
        assert!((l[0] - 1.0).abs() < 1e-6, "reference peak must hit full scale");
    }

    #[tokio::test]
    async fn stop_and_wait_on_a_never_started_engine_returns_immediately() {
        let engine = test_engine();
        // No writer, no endpoint, device not connected: must not hang, must
        // not error.
        engine.stop_and_wait().await;
        let st = engine.status().await;
        assert!(!st.running);
        assert!(!st.enabled);
        assert!(!st.supported, "no endpoint claimed on an unconnected device");
    }

    #[tokio::test]
    async fn apply_disabled_on_an_idle_engine_is_a_clean_no_op() {
        let engine = test_engine();
        let st = engine
            .apply(I2sRequest {
                enabled: false,
                slots: vec![],
                reference_dbv: 0.0,
                width: I2sWidth::Bits32,
            })
            .await
            .expect("disable on idle must succeed");
        assert!(!st.enabled);
        assert!(!st.running);
        assert_eq!(st.blocks_written, 0);
    }

    #[tokio::test]
    async fn apply_enabled_without_an_endpoint_is_refused() {
        let engine = test_engine();
        let err = engine
            .apply(I2sRequest {
                enabled: true,
                slots: vec![],
                reference_dbv: 0.0,
                width: I2sWidth::Bits32,
            })
            .await
            .expect_err("no EP 0x03 claim — the port must refuse, not pretend");
        assert!(err.to_string().contains("not available"), "got: {err}");
    }

    #[tokio::test]
    async fn engine_clones_share_state_and_new_engines_do_not() {
        let engine = test_engine();
        assert!(engine.same_as(&engine.clone()));
        assert!(!engine.same_as(&test_engine()));
    }
}

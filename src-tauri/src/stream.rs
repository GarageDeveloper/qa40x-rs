//! The backend run loop: a tokio task owns render → range-fit → capture →
//! analyze and pushes every frame to the frontend over a Tauri `Channel`. The
//! frontend triggers, caches and formats — it never computes.
//!
//! Per frame the task:
//!
//! 1. renders the declared sources through the [`crate::mixer::Mixer`] (empty
//!    slot set = monitor mode: silence out, capture only);
//! 2. fits the output range to the **peak of the sum** with hysteresis
//!    ([`crate::mixer::fit_range_with_hysteresis`]), writes reg 6 only on a
//!    real change, strictly *between* captures;
//! 3. scales the mix to DAC full scale ([`crate::mixer::scale_mix_to_range`]
//!    — clamp + report, never rescale) and latches output clip ~100 ms;
//! 4. captures through the device Mutex (`generate_and_capture` — the same
//!    exclusive path as every other capture; no register I/O can interleave);
//! 5. computes the requested spectra — one [`SpectrumAnalyzer`] **per
//!    channel**, so averaging L never contaminates R (the "one value where
//!    there must be N" class, applied to the averager);
//! 6. evaluates each requested endpoint's scope TRIGGER against the
//!    already-emitted buffer (`evaluate_trigger`, `crate::audio::trigger`) —
//!    ALIGNMENT ONLY: it picks/shifts the slice the scope DISPLAYS, it never
//!    reorders or gates step 5 — `analyze_frame` always sees the unchanged
//!    mid-slice, whether the endpoint triggered, is waiting or is stopped;
//! 7. emits [`StreamMsg::Frame`] carrying the frame's own per-converter
//!    [`LevelOffsetsDb`] — computed from the register state of THIS frame, so
//!    a chart can never pair a trace with the wrong converter's reference
//!    (structural close of #48/#50/#51/#58/#60).
//!
//! The discrete `generate_and_capture` path on the device handle is separate:
//! it serves the measurement programs (sweeps, frequency response), while this
//! module owns the continuous live-view streaming.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel as IpcChannel;
use tokio::sync::Mutex;

use crate::audio::{AnalysisResult, AudioAnalyzer, SpectrumAnalyzer, SpectrumConfig, WindowFunction};
use crate::mixer::{
    auto_output_range, fit_range_with_hysteresis, scale_mix_to_range, ClipLatch, MixerSlotDesc,
    Mixer, SlotError, RANGE_DOWN_HYSTERESIS_DB,
};
use crate::qa40x::{AudioData, Channel, OutputGain, QA40xDevice};

/// Silence guard prepended/appended around a tone frame; the middle slice is
/// analyzed so the silence→tone edge transient never lands in the FFT (same
/// value and rationale as the v1 live loop).
const CAPTURE_GUARD: usize = 4096;

/// Floor on the frame cadence: don't hammer USB with tiny FFTs.
const MIN_FRAME_GAP_MS: f64 = 40.0;

/// Input peak (dBFS) at/above which the capture is treated as clipping
/// (mirrors the v1 annunciator threshold).
const INPUT_CLIP_DBFS: f32 = -0.1;

/// Input peak (dBFS) at/above which the capture is NEAR full scale (the
/// warning band below [`INPUT_CLIP_DBFS`]) — same −1 dBFS as the v1 hero
/// annunciator. The judgment lives here, not in the frontend: the UI only
/// renders the [`ClipState`] it is told.
const INPUT_NEAR_CLIP_DBFS: f32 = -1.0;

/* -------------------------------------------------------------------------- */
/* Wire types (ts-rs generated — the single shared shape)                      */
/* -------------------------------------------------------------------------- */

/// Per-converter, per-channel dBFS→dBV display offsets — B-3. Four values,
/// never one: each converter's dBFS reference moves with its OWN range
/// register (ADC ↔ reg 5, DAC ↔ reg 6), with per-channel factory calibration
/// on top. Carried by every frame, computed for the register state of that
/// frame (the #48/#50/#51/#58/#60 bug class, closed structurally).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct LevelOffsetsDb {
    pub input_l: f32,
    pub input_r: f32,
    pub output_l: f32,
    pub output_r: f32,
    /// False until factory calibration has been read from the device.
    pub calibrated: bool,
}

/// Analysis window for the streamed spectra.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum StreamWindow {
    Hann,
    Rect,
    Flattop,
}

impl StreamWindow {
    fn to_window_function(self) -> WindowFunction {
        match self {
            StreamWindow::Hann => WindowFunction::Hann,
            StreamWindow::Rect => WindowFunction::Rectangular,
            StreamWindow::Flattop => WindowFunction::FlatTop,
        }
    }
}

/// Spectrum averaging for the captured input channels. `count` ≤ 1 = off.
/// Coherent = complex averaging with per-frame phase alignment; otherwise
/// power averaging (rolling window of `count`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct StreamAveraging {
    pub coherent: bool,
    pub count: u32,
}

/// Which spectra to compute and push each frame — the display budget. The
/// time-domain capture is always carried; FFTs cost CPU per channel, so the
/// frontend asks only for what a tile actually shows (#52/#58).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct SpectraRequest {
    pub input_l: bool,
    pub input_r: bool,
    pub output_l: bool,
    pub output_r: bool,
}

/// Trigger run mode. `Auto` reports a fallback alignment (at `pre_samples`)
/// when nothing crosses; `Normal` holds the last triggered picture; `Single` is a
/// latch — the loop stops reporting new alignments for that endpoint after
/// one shot, until re-armed (`arm_epoch` bumped).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum TriggerMode {
    Auto,
    Normal,
    Single,
}

/// Edge polarity to trigger on (mirrors [`crate::audio::trigger::Edge`],
/// mapped in `evaluate_trigger` the way `StreamWindow::to_window_function()`
/// maps windows).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum TriggerEdge {
    Rising,
    Falling,
}

/// Per-endpoint trigger settings. Level/hysteresis are in level-VOLTS of the
/// endpoint's own converter (signed); the loop converts them to that frame's
/// FS domain via the frame's own [`LevelOffsetsDb`] entry, the same B-3
/// per-frame-converter discipline as everything else on this wire.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct TriggerConfig {
    pub mode: TriggerMode,
    pub edge: TriggerEdge,
    /// Level in level-volts of the endpoint's OWN converter (signed).
    pub level_v: f32,
    /// `None` = auto: 2 % of this frame's own peak, floored at 1e-4 FS.
    pub hysteresis_v: Option<f32>,
    /// Pre-trigger depth the display needs; the search starts there.
    pub pre_samples: u32,
    /// Bumped (or otherwise changed) by the UI to re-arm a `Single` shot.
    /// The loop re-arms on ANY change from the last value it saw, not only
    /// an increase: a workspace load resets this to 0 in the frontend while
    /// the loop's own latch may already sit at a higher value from earlier
    /// Arm clicks, and that reset must still re-arm (issue #26 review #2) —
    /// a `>` comparison would leave the latch dead until the value happened
    /// to climb back past its old high-water mark.
    pub arm_epoch: u32,
}

/// Which endpoints are triggered this frame, and how — the `SpectraRequest`
/// pattern. `None` = that endpoint isn't triggered (the loop skips the scan
/// entirely, same "only pay for what's requested" rule as spectra).
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct TriggerRequest {
    pub input_l: Option<TriggerConfig>,
    pub input_r: Option<TriggerConfig>,
    pub output_l: Option<TriggerConfig>,
    pub output_r: Option<TriggerConfig>,
}

/// The stream loop's configuration. `stream_update` swaps it atomically; the
/// loop reads a fresh snapshot every frame.
#[derive(Clone, Debug, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct StreamConfig {
    /// Samples per analyzed frame (the FFT size). Power of two, 4096..=1M.
    pub buffer_size: u32,
    /// Signal sources to mix into the DAC buffer. Empty = monitor mode
    /// (silence out, capture only, output range untouched).
    pub slots: Vec<MixerSlotDesc>,
    pub window: StreamWindow,
    pub averaging: StreamAveraging,
    pub spectra: SpectraRequest,
    /// Fixed output range in dBV, or `None` = auto-fit to the summed peak.
    pub output_range_dbv: Option<i32>,
    /// Per-endpoint scope trigger. Absent from an older/minimal client's
    /// JSON = no triggers (byte-identical old behavior). `#[ts(as/optional)]`
    /// exports this as `triggers?: TriggerRequest` — the Rust side stays a
    /// plain (non-`Option`) `TriggerRequest` with `#[serde(default)]`, so
    /// `config.triggers.*` field access below never needs an `Option` layer;
    /// only the wire TYPE needs to tell the frontend the key is optional.
    #[serde(default)]
    #[ts(as = "Option<_>", optional)]
    pub triggers: TriggerRequest,
}

/// One stereo digital-full-scale buffer (the summed stimulus actually sent).
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct StereoFrame {
    pub left: Vec<f32>,
    pub right: Vec<f32>,
}

/// The requested magnitude spectra (dBFS of each converter's own full scale),
/// on shared frequency bins. A channel the config didn't request is `None`.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct SpectraMsg {
    pub frequencies: Vec<f32>,
    pub input_l: Option<Vec<f32>>,
    pub input_r: Option<Vec<f32>>,
    pub output_l: Option<Vec<f32>>,
    pub output_r: Option<Vec<f32>>,
}

/// One harmonic located on a channel's displayed spectrum (n=1 = the
/// fundamental). Positions/levels are backend truth — the spectrum-tile
/// markers draw these verbatim, they never search the curve themselves.
#[derive(Clone, Copy, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct HarmonicMark {
    pub n: u32,
    /// Hz, refined to the actual spectral peak near n×f0.
    pub frequency: f32,
    /// dBFS of the channel's own converter (same reference as the spectrum).
    pub magnitude_db: f32,
    /// dB relative to the fundamental (0 for n=1).
    pub magnitude_dbc: f32,
}

/// Harmonic analysis (THD / THD+N / SNR / SINAD) of the captured input
/// channels, computed from each channel's own (possibly averaged) spectrum —
/// the fundamental is auto-detected as the loudest bin ≥ 20 Hz. `None` when
/// that channel's spectrum wasn't requested or carries no tone. Per channel,
/// never one shared result (the "one value where there must be N" class).
/// `harmonics_*` are the located series (n=1..10) of the SAME analysis, for
/// the spectrum-tile harmonic markers.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct StreamMetrics {
    pub input_l: Option<AnalysisResult>,
    pub input_r: Option<AnalysisResult>,
    pub harmonics_l: Option<Vec<HarmonicMark>>,
    pub harmonics_r: Option<Vec<HarmonicMark>>,
}

/// Result state of one endpoint's trigger evaluation this frame.
/// `Triggered` = a qualified edge was found (see `index`/`frac`); `Auto` =
/// none found but `TriggerMode::Auto` reports a fallback picture anyway;
/// `Waiting` = `Normal`/`Single` found nothing — the frontend holds its last
/// picture; `Stopped` = a `Single` shot already fired and hasn't been
/// re-armed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum TriggerState {
    Triggered,
    Auto,
    Waiting,
    Stopped,
}

/// One endpoint's trigger alignment for this frame — metadata only, never
/// gates or reorders `captured`/`spectra`/`metrics` (see the module doc).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct TriggerAlign {
    pub state: TriggerState,
    /// Trigger point: first sample at/after the crossing, in THIS frame's
    /// emitted (mid-sliced) buffer.
    pub index: u32,
    /// Sub-sample residual in [0,1]: the crossing is at `index - 1 + frac`
    /// (closed at both ends — see `audio::trigger::refine_linear`).
    pub frac: f32,
    /// The threshold actually compared, in this frame's FS domain.
    pub level_fs: f32,
    pub hysteresis_fs: f32,
}

/// Per-endpoint trigger alignment for the frame — the `SpectraMsg` pattern.
/// An endpoint the config didn't request is `None`.
#[derive(Clone, Copy, Debug, Default, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct TriggerMsg {
    pub input_l: Option<TriggerAlign>,
    pub input_r: Option<TriggerAlign>,
    pub output_l: Option<TriggerAlign>,
    pub output_r: Option<TriggerAlign>,
}

/// Captured-input level state, judged backend-side from the frame's peak
/// (latched ~100 ms like the clip dots so transients stay visible):
/// `Near` = within 1 dB of full scale (measurements start degrading),
/// `Clip` = at full scale (≥ −0.1 dBFS).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum ClipState {
    None,
    Near,
    Clip,
}

/// Mix/run status of the frame: Σ-peak of the summed sources, the clip
/// latches (backend truth, ~100 ms hold), and the output range in effect.
#[derive(Clone, Copy, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct MixStatus {
    /// Peak of the summed source mix in dBV; `None` in monitor mode or when
    /// the mix is silent.
    pub sigma_peak_dbv: Option<f32>,
    pub clip_input: ClipState,
    pub clip_output: bool,
    pub fitted_output_range_dbv: i32,
}

/// Loop cadence stats (frontend displays them verbatim).
#[derive(Clone, Copy, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct StreamStats {
    /// (Serialized as a JSON number — no frame count reaches 2^53.)
    #[ts(type = "number")]
    pub frames: u64,
    pub fps: f32,
    pub frame_ms: f32,
}

/// One pushed frame. `captured` and `stimulus` are digital full-scale buffers
/// of their own converter; `offsets` maps each to absolute dBV.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct StreamFrame {
    /// (Serialized as a JSON number — no frame count reaches 2^53.)
    #[ts(type = "number")]
    pub seq: u64,
    pub captured: AudioData,
    /// The summed stimulus actually sent this frame (`None` in monitor mode).
    pub stimulus: Option<StereoFrame>,
    pub spectra: SpectraMsg,
    pub metrics: StreamMetrics,
    /// Alignment-only scope trigger result (module doc: never gates
    /// `captured`/`spectra`/`metrics` above).
    pub trigger: TriggerMsg,
    pub mix: MixStatus,
    pub offsets: LevelOffsetsDb,
    pub stats: StreamStats,
    /// Per-slot source errors (bad script, unknown waveform…) — named, never
    /// wholesale: the rest of the mix keeps playing.
    pub errors: Vec<SlotError>,
}

/// Messages pushed over the `stream_start` channel.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export)]
pub enum StreamMsg {
    Frame(Box<StreamFrame>),
    /// The loop died on a device error (disconnect, wedged stream…).
    Error { message: String },
    /// The loop exited (stop request, channel gone, or after `Error`).
    Stopped,
}

/* -------------------------------------------------------------------------- */
/* Control                                                                     */
/* -------------------------------------------------------------------------- */

/// One endpoint's trigger config, checked against the frame size it will
/// scan. Same error-string style as [`validate_config`].
fn validate_trigger_config(cfg: &TriggerConfig, buffer_size: u32) -> Result<(), String> {
    let half = buffer_size / 2;
    if cfg.pre_samples > half {
        return Err(format!(
            "stream: trigger pre_samples {} exceeds buffer_size/2 ({half})",
            cfg.pre_samples
        ));
    }
    if !cfg.level_v.is_finite() {
        return Err(format!("stream: trigger level_v not finite ({})", cfg.level_v));
    }
    if let Some(h) = cfg.hysteresis_v {
        if !h.is_finite() || h < 0.0 {
            return Err(format!(
                "stream: trigger hysteresis_v must be finite and >= 0, got {h}"
            ));
        }
    }
    Ok(())
}

fn validate_config(config: &StreamConfig) -> Result<(), String> {
    let n = config.buffer_size;
    if !(4096..=1_048_576).contains(&n) || !n.is_power_of_two() {
        return Err(format!(
            "stream: bad buffer_size {n} (power of two, 4096..=1048576)"
        ));
    }
    if let Some(r) = config.output_range_dbv {
        if OutputGain::from_dbv(r).is_none() {
            return Err(format!("stream: invalid output range {r} dBV"));
        }
    }
    for cfg in [
        config.triggers.input_l,
        config.triggers.input_r,
        config.triggers.output_l,
        config.triggers.output_r,
    ]
    .into_iter()
    .flatten()
    {
        validate_trigger_config(&cfg, n)?;
    }
    Ok(())
}

/// Owns the stream task (the ScriptControl pattern: cloneable, all state in
/// Arcs, one running task at a time).
#[derive(Clone)]
pub struct StreamControl {
    device: Arc<Mutex<QA40xDevice>>,
    generator_running: Arc<AtomicBool>,
    generator_stop: Arc<AtomicBool>,
    mixer: Arc<std::sync::Mutex<Mixer>>,
    running: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    /// Serializes start/stop transitions. Tauri commands run CONCURRENTLY:
    /// without this lock a stop landing between a start's `running` swap and
    /// its `stop = false` reset kills the new loop on its first iteration,
    /// and a start racing a draining stop errors spuriously — the "Stop then
    /// play does nothing until app restart" bug (M3 review).
    control: Arc<Mutex<()>>,
    /// The live config; `stream_update` swaps it, the loop snapshots it each
    /// frame. std Mutex: held only for a clone, never across an await.
    config: Arc<std::sync::Mutex<StreamConfig>>,
    /// One-shot request to empty the averaging accumulators (both input
    /// channels). Set by `stream_reset_averaging`, consumed by the loop at
    /// the top of the next frame — commands never touch the analyzers
    /// directly (they live in the loop task).
    avg_reset: Arc<AtomicBool>,
}

impl StreamControl {
    pub fn new(
        device: Arc<Mutex<QA40xDevice>>,
        generator_running: Arc<AtomicBool>,
        generator_stop: Arc<AtomicBool>,
        mixer: Arc<std::sync::Mutex<Mixer>>,
    ) -> Self {
        Self {
            device,
            generator_running,
            generator_stop,
            mixer,
            running: Arc::new(AtomicBool::new(false)),
            stop: Arc::new(AtomicBool::new(false)),
            control: Arc::new(Mutex::new(())),
            config: Arc::new(std::sync::Mutex::new(StreamConfig {
                buffer_size: 32768,
                slots: Vec::new(),
                window: StreamWindow::Hann,
                averaging: StreamAveraging { coherent: false, count: 1 },
                spectra: SpectraRequest {
                    input_l: false,
                    input_r: false,
                    output_l: false,
                    output_r: false,
                },
                output_range_dbv: None,
                triggers: TriggerRequest::default(),
            })),
            avg_reset: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Ask the loop to empty the averaging accumulators (both channels) at
    /// the next frame. A no-op when nothing streams — the analyzers start
    /// fresh with each loop anyway.
    pub fn reset_averaging(&self) {
        self.avg_reset.store(true, Ordering::SeqCst);
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// Swap the loop's config (takes effect at the next frame).
    pub fn update(&self, config: StreamConfig) -> Result<(), String> {
        validate_config(&config)?;
        *self.config.lock().map_err(|_| "stream config lock poisoned")? = config;
        Ok(())
    }

    /// Request the loop to stop and wait until it has exited, so a caller can
    /// restart (or hand the device to a program) deterministically.
    pub async fn stop_and_wait(&self) {
        let _guard = self.control.lock().await;
        self.stop_and_wait_locked().await;
    }

    /// The stop half, under the control lock. The flag doubles as the
    /// capture's cooperative cancel (checked between USB blocks), so even a
    /// 1M-FFT frame (~22 s) stops within a block. The 15 s window is a
    /// backstop for the failure ladder (~12 s of timeout + drain + retry),
    /// not the expected path.
    async fn stop_and_wait_locked(&self) {
        if !self.is_running() {
            return;
        }
        self.stop.store(true, Ordering::SeqCst);
        for _ in 0..600 {
            if !self.is_running() {
                break;
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(25)).await;
        }
    }

    /// Start the stream loop, TAKING OVER from a previous one: a loop still
    /// draining its last frame is stopped and waited out first, so "play
    /// right after stop" always starts instead of racing into an error. One
    /// loop at a time; the continuous generator is stopped too (same
    /// exclusivity as every capturing command).
    pub async fn start(
        &self,
        config: StreamConfig,
        on_frame: IpcChannel<StreamMsg>,
    ) -> Result<(), String> {
        validate_config(&config)?;
        let _guard = self.control.lock().await;
        self.stop_and_wait_locked().await;
        if self.running.swap(true, Ordering::SeqCst) {
            // Only reachable if the old loop out-lived the whole stop window
            // (a truly wedged capture) — starting over it would corrupt the
            // device stream.
            return Err("stream busy: the previous loop has not exited yet".into());
        }
        self.stop.store(false, Ordering::SeqCst);
        *self.config.lock().map_err(|_| "stream config lock poisoned")? = config;

        crate::ensure_generator_stopped(&self.generator_running, &self.generator_stop).await;
        if !self.device.lock().await.is_connected().await {
            self.running.store(false, Ordering::SeqCst);
            return Err("Device not connected".into());
        }

        let ctl = self.clone();
        tokio::spawn(async move {
            let res = run_stream_loop(&ctl, &on_frame).await;
            ctl.running.store(false, Ordering::SeqCst);
            if let Err(e) = res {
                let _ = on_frame.send(StreamMsg::Error { message: e });
            }
            let _ = on_frame.send(StreamMsg::Stopped);
        });
        Ok(())
    }
}

/* -------------------------------------------------------------------------- */
/* The loop                                                                    */
/* -------------------------------------------------------------------------- */

/// Per-channel spectrum analyzers — one averager per channel, so channels
/// never cross-average (v1 had a single shared averager and had to route
/// around it). Output (stimulus) spectra never accumulate: the stimulus is an
/// ideal reference, not a measurement to denoise.
struct Analyzers {
    input_l: SpectrumAnalyzer,
    input_r: SpectrumAnalyzer,
    /// Non-accumulating scratch for the stimulus FFTs.
    output: SpectrumAnalyzer,
}

impl Analyzers {
    fn new() -> Self {
        // Full-range bins: the display decides its own X window (the wire
        // carries 0..Nyquist; v1's fixed 20 Hz–20 kHz cap was an analyzer
        // config detail, not a display choice).
        let config = SpectrumConfig {
            fft_size: 32768,
            num_averages: 1,
            freq_min: 0.0,
            freq_max: f32::MAX,
            log_scale: true,
        };
        Self {
            input_l: SpectrumAnalyzer::new(config.clone()),
            input_r: SpectrumAnalyzer::new(config.clone()),
            output: SpectrumAnalyzer::new(config),
        }
    }

    fn apply_averaging(&mut self, avg: StreamAveraging) {
        for a in [&mut self.input_l, &mut self.input_r] {
            a.set_coherent(avg.coherent);
            a.set_num_averages(avg.count.max(1) as usize);
        }
    }

    /// Empty both channels' accumulators (the user's "Reset avg" — start the
    /// rolling window from scratch without touching the averaging config).
    fn reset_accumulation(&mut self) {
        self.input_l.reset();
        self.input_r.reset();
    }
}

/// One endpoint's loop-owned trigger latch — mirrors [`Analyzers`]'s
/// per-channel-not-per-device shape (issue #25: keyed per endpoint, never
/// "the device"). `armed_epoch` tracks the last `arm_epoch` seen so a UI
/// re-arm (ANY change — not only an increase, see `TriggerConfig::arm_epoch`'s
/// doc) can be told apart from a config no-op; `fired` is the `Single`-mode
/// latch.
#[derive(Default)]
struct EndpointTrigger {
    armed_epoch: u32,
    fired: bool,
}

/// The four endpoints' trigger latches — one per endpoint, like
/// [`Analyzers`], never a single shared latch (multi-device / multi-endpoint
/// discipline, issue #25).
#[derive(Default)]
struct TriggerStates {
    input_l: EndpointTrigger,
    input_r: EndpointTrigger,
    output_l: EndpointTrigger,
    output_r: EndpointTrigger,
}

/// Evaluate one endpoint's trigger against its already-emitted buffer.
/// READS `samples` only — never mutates or reorders it, never influences
/// what `analyze_frame` sees (module doc). `offset_db` is that endpoint's
/// OWN [`LevelOffsetsDb`] entry for THIS frame (B-3: never a stale or wrong
/// converter's reference).
fn evaluate_trigger(
    cfg: &TriggerConfig,
    st: &mut EndpointTrigger,
    samples: &[f32],
    offset_db: f32,
) -> TriggerAlign {
    // Volts (the wire unit) -> this frame's FS domain, via the SAME
    // per-converter offset the frame's own trace uses to go the other way.
    let to_fs = 10f32.powf(-offset_db / 20.0);
    let level_fs = cfg.level_v * to_fs;
    let hysteresis_fs = cfg
        .hysteresis_v
        .map(|v| v * to_fs)
        .unwrap_or_else(|| crate::audio::auto_hysteresis(samples, 0.02, 1e-4));

    // ANY change in arm_epoch re-arms a Single latch — not only an increase.
    // A workspace load resets arm_epoch to 0 in the frontend while this
    // loop's own `armed_epoch` may already sit higher (past Arm clicks in
    // the same session); with a `>` comparison that reset would never
    // re-arm, leaving Single clicks silently dead until arm_epoch happened
    // to climb back past the old high-water mark (issue #26 review #2). The
    // same value is still a no-op, so a replayed/duplicate config update
    // never re-fires a shot.
    if cfg.arm_epoch != st.armed_epoch {
        st.armed_epoch = cfg.arm_epoch;
        st.fired = false;
    }

    if cfg.mode == TriggerMode::Single && st.fired {
        return TriggerAlign {
            state: TriggerState::Stopped,
            index: 0,
            frac: 0.0,
            level_fs,
            hysteresis_fs,
        };
    }

    let edge = match cfg.edge {
        TriggerEdge::Rising => crate::audio::Edge::Rising,
        TriggerEdge::Falling => crate::audio::Edge::Falling,
    };
    let pre = cfg.pre_samples as usize;
    match crate::audio::find_edge(samples, level_fs, hysteresis_fs, edge, pre) {
        Some(hit) => {
            if cfg.mode == TriggerMode::Single {
                st.fired = true;
            }
            TriggerAlign {
                state: TriggerState::Triggered,
                index: hit.index as u32,
                frac: hit.frac,
                level_fs,
                hysteresis_fs,
            }
        }
        None => {
            let state = match cfg.mode {
                TriggerMode::Auto => TriggerState::Auto,
                TriggerMode::Normal | TriggerMode::Single => TriggerState::Waiting,
            };
            TriggerAlign {
                state,
                index: cfg.pre_samples,
                frac: 0.0,
                level_fs,
                hysteresis_fs,
            }
        }
    }
}

/// Everything the per-frame blocking analysis step produces.
struct AnalysisOut {
    spectra: SpectraMsg,
    metrics: StreamMetrics,
    input_peak: f32,
}

/// Harmonic metrics for one captured channel from its own dB spectrum. The
/// fundamental is the loudest bin at/above 20 Hz (below that it's DC/hum
/// leakage, not a tone); a silent or empty spectrum yields `None`.
fn channel_metrics(
    signal: &[f32],
    frequencies: &[f32],
    magnitudes_db: &[f32],
) -> Option<(AnalysisResult, Vec<HarmonicMark>)> {
    // `AudioAnalyzer::analyze` wants LINEAR magnitudes (it integrates power);
    // the wire spectrum is dB of the same values, so 10^(dB/20) is exact.
    let magnitudes: Vec<f32> = magnitudes_db.iter().map(|db| 10.0f32.powf(db / 20.0)).collect();
    let fundamental = frequencies
        .iter()
        .zip(&magnitudes)
        .filter(|(f, _)| **f >= 20.0)
        .max_by(|a, b| a.1.total_cmp(b.1))
        .map(|(f, _)| *f)?;
    let analysis = AudioAnalyzer::analyze(signal, &magnitudes, frequencies, fundamental);
    // Harmonic series located on the SAME (possibly averaged) spectrum the
    // frame displays, so the markers sit exactly on the drawn curve. 10
    // harmonics = the THD computation's own span.
    let marks = AudioAnalyzer::harmonics_from_spectrum(frequencies, &magnitudes, fundamental, 10)
        .into_iter()
        .map(|h| HarmonicMark {
            n: h.n as u32,
            frequency: h.frequency,
            magnitude_db: h.magnitude_db,
            magnitude_dbc: h.magnitude_dbc,
        })
        .collect();
    Some((analysis, marks))
}

#[allow(clippy::too_many_arguments)]
fn analyze_frame(
    analyzers: &mut Analyzers,
    config: &StreamConfig,
    captured: &AudioData,
    stimulus: Option<&StereoFrame>,
    sample_rate: u32,
) -> AnalysisOut {
    let window = config.window.to_window_function();
    let mut spectra = SpectraMsg {
        frequencies: Vec::new(),
        input_l: None,
        input_r: None,
        output_l: None,
        output_r: None,
    };

    let take = |result: crate::audio::SpectrumResult, freqs: &mut Vec<f32>| {
        if freqs.is_empty() {
            *freqs = result.frequencies;
        }
        result.magnitudes_db
    };

    if config.spectra.input_l {
        let r = analyzers
            .input_l
            .process_windowed_ex(&captured.left_channel, sample_rate, window, true);
        spectra.input_l = Some(take(r, &mut spectra.frequencies));
    }
    if config.spectra.input_r {
        let r = analyzers
            .input_r
            .process_windowed_ex(&captured.right_channel, sample_rate, window, true);
        spectra.input_r = Some(take(r, &mut spectra.frequencies));
    }
    if let Some(stim) = stimulus {
        if config.spectra.output_l {
            let r = analyzers
                .output
                .process_windowed_ex(&stim.left, sample_rate, window, false);
            spectra.output_l = Some(take(r, &mut spectra.frequencies));
        }
        if config.spectra.output_r {
            let r = analyzers
                .output
                .process_windowed_ex(&stim.right, sample_rate, window, false);
            spectra.output_r = Some(take(r, &mut spectra.frequencies));
        }
    }

    let (input_l, harmonics_l) = spectra
        .input_l
        .as_deref()
        .and_then(|mags| channel_metrics(&captured.left_channel, &spectra.frequencies, mags))
        .map(|(a, h)| (Some(a), Some(h)))
        .unwrap_or((None, None));
    let (input_r, harmonics_r) = spectra
        .input_r
        .as_deref()
        .and_then(|mags| channel_metrics(&captured.right_channel, &spectra.frequencies, mags))
        .map(|(a, h)| (Some(a), Some(h)))
        .unwrap_or((None, None));
    let metrics = StreamMetrics { input_l, input_r, harmonics_l, harmonics_r };

    let input_peak = captured
        .left_channel
        .iter()
        .chain(captured.right_channel.iter())
        .fold(0.0f32, |p, &v| p.max(v.abs()));

    AnalysisOut { spectra, metrics, input_peak }
}

async fn run_stream_loop(
    ctl: &StreamControl,
    on_frame: &IpcChannel<StreamMsg>,
) -> Result<(), String> {
    let t0 = Instant::now();
    let now_ms = || t0.elapsed().as_secs_f64() * 1000.0;

    // Loop-owned state: analyzers, clip latches, slot sync key, stats.
    let analyzers = Arc::new(std::sync::Mutex::new(Analyzers::new()));
    let mut clip_in = ClipLatch::default();
    let mut near_in = ClipLatch::default();
    let mut clip_out = ClipLatch::default();
    let mut trigger_states = TriggerStates::default();
    let mut last_slots_key = String::new();
    let mut last_averaging: Option<StreamAveraging> = None;
    let mut seq: u64 = 0;
    let mut fps = 0.0f32;

    let input_clip_threshold = 10.0f32.powf(INPUT_CLIP_DBFS / 20.0);
    let input_near_threshold = 10.0f32.powf(INPUT_NEAR_CLIP_DBFS / 20.0);

    loop {
        if ctl.stop.load(Ordering::SeqCst) {
            return Ok(());
        }
        let frame_started = now_ms();

        let config = ctl
            .config
            .lock()
            .map_err(|_| "stream config lock poisoned")?
            .clone();
        let n = config.buffer_size as usize;

        // ---- Slot + averaging sync (only when they actually changed) ----
        let slots_key = serde_json::to_string(&config.slots).unwrap_or_default();
        let mut slot_errors: Vec<SlotError> = Vec::new();
        if slots_key != last_slots_key {
            let mx = ctl.mixer.clone();
            let slots = config.slots.clone();
            slot_errors = tokio::task::spawn_blocking(move || {
                mx.lock()
                    .map_err(|_| "mixer lock poisoned".to_string())
                    .map(|mut m| m.set_slots(slots))
            })
            .await
            .map_err(|e| format!("mixer task failed: {e}"))??;
            last_slots_key = slots_key;
        }
        if last_averaging != Some(config.averaging) {
            analyzers
                .lock()
                .map_err(|_| "analyzer lock poisoned")?
                .apply_averaging(config.averaging);
            last_averaging = Some(config.averaging);
        }
        if ctl.avg_reset.swap(false, Ordering::SeqCst) {
            analyzers
                .lock()
                .map_err(|_| "analyzer lock poisoned")?
                .reset_accumulation();
        }

        // ---- Device state of THIS frame ----
        let dev_config = ctl.device.lock().await.get_config().await;
        let sample_rate = dev_config.sample_rate.as_hz();
        let current_range = dev_config.output_gain.as_dbv();

        // ---- Render the mix (tone mode) or prepare silence (monitor) ----
        let tone = !config.slots.is_empty();
        let guard = if tone { CAPTURE_GUARD } else { 0 };
        let render_len = n + 2 * guard;

        let (mut left, mut right, mix_peak, mut render_errors) = if tone {
            let mx = ctl.mixer.clone();
            let frame = tokio::task::spawn_blocking(move || {
                mx.lock()
                    .map_err(|_| "mixer lock poisoned".to_string())
                    .map(|mut m| m.render_frame(sample_rate, render_len, false))
            })
            .await
            .map_err(|e| format!("mixer task failed: {e}"))??;
            (frame.left, frame.right, Some(frame.peak), frame.errors)
        } else {
            (vec![0.0f32; render_len], vec![0.0f32; render_len], None, Vec::new())
        };
        slot_errors.append(&mut render_errors);

        // ---- Output range fit (auto: peak of the sum + hysteresis) ----
        let sigma_peak_dbv = mix_peak.and_then(|p| {
            if p > 0.0 {
                Some(20.0 * p.log10())
            } else {
                None
            }
        });
        let desired_range = match config.output_range_dbv {
            Some(fixed) => fixed,
            None => match sigma_peak_dbv {
                // Auto-fit only drives the range while sources play (v1
                // behavior: a monitor frame never touches reg 6).
                Some(peak_dbv) if tone => fit_range_with_hysteresis(
                    peak_dbv,
                    Some(current_range),
                    auto_output_range,
                    RANGE_DOWN_HYSTERESIS_DB,
                ),
                _ => current_range,
            },
        };
        if desired_range != current_range {
            let device = ctl.device.lock().await;
            let gain = OutputGain::from_dbv(desired_range)
                .ok_or_else(|| format!("stream: invalid output range {desired_range}"))?;
            device
                .set_output_gain(gain)
                .await
                .map_err(|e| format!("stream: set output range: {e}"))?;
        }

        // ---- Scale to DAC full scale + output clip latch ----
        let clipped_out = if tone {
            // Per-unit DAC trims (issue #8) — read AFTER the range write
            // above: the trim record follows the active output range. The
            // stimulus trace stays consistent: `output_dbv_offset` divides
            // the same trim back out, so the dBV axis shows the commanded
            // (= actual) level.
            let (dac_trims, _) = ctl.device.lock().await.dac_trims().await;
            scale_mix_to_range(&mut left, &mut right, desired_range, dac_trims)
        } else {
            false
        };
        clip_out.report(clipped_out, now_ms());

        // ---- Capture (the one exclusive device transaction) ----
        // The loop's stop flag rides into the capture as a cooperative cancel,
        // checked between USB blocks: at 1M FFT a frame is ~22 s of capture,
        // and without this a stop (or an app quit — safe_shutdown) could only
        // take effect at the NEXT frame boundary. Same mechanism as the
        // batched sweeps (the sweep got it first; this is its stream twin).
        let captured_raw = {
            let device = ctl.device.lock().await;
            match device
                .generate_and_capture_cancellable(&left, &right, Some(&ctl.stop))
                .await
            {
                Ok(c) => c,
                Err(crate::qa40x::QA40xError::Cancelled) => {
                    log::info!("stream: stop observed mid-capture — cancelled cooperatively");
                    return Ok(());
                }
                Err(e) => {
                    // A device that vanished mid-run (USB unplug, manual
                    // disconnect) is a LIFECYCLE event, not a stream error:
                    // end the loop cleanly (Stopped, no Error message) — the
                    // USB monitor / disconnect path already tell the user.
                    if !device.is_connected().await {
                        log::info!("stream: device gone mid-capture — stopping cleanly");
                        return Ok(());
                    }
                    return Err(format!("stream: capture failed: {e}"));
                }
            }
        };

        // ---- Mid-slice the guard off capture and stimulus ----
        let mid = |v: &[f32]| -> Vec<f32> {
            if guard > 0 && v.len() >= guard + n {
                v[guard..guard + n].to_vec()
            } else {
                v.to_vec()
            }
        };
        let captured = AudioData {
            left_channel: mid(&captured_raw.left_channel),
            right_channel: mid(&captured_raw.right_channel),
            sample_rate: captured_raw.sample_rate,
        };
        let stimulus = tone.then(|| StereoFrame { left: mid(&left), right: mid(&right) });

        // ---- Offsets for the register state of THIS frame (B-3) ----
        let offsets = {
            let device = ctl.device.lock().await;
            let (input_l, cal_in) = device.input_dbv_offset(Channel::Left).await;
            let (input_r, _) = device.input_dbv_offset(Channel::Right).await;
            let (output_l, cal_out) = device.output_dbv_offset(Channel::Left).await;
            let (output_r, _) = device.output_dbv_offset(Channel::Right).await;
            LevelOffsetsDb {
                input_l,
                input_r,
                output_l,
                output_r,
                calibrated: cal_in && cal_out,
            }
        };

        // ---- Trigger alignment (reads the emitted buffers only — never
        // feeds analyze_frame below; see the module doc) ----
        // One linear scan per REQUESTED endpoint (≤4), cheap relative to the
        // FFTs, so it runs inline rather than adding another spawn_blocking
        // round trip.
        let trigger = TriggerMsg {
            input_l: config.triggers.input_l.as_ref().map(|cfg| {
                evaluate_trigger(cfg, &mut trigger_states.input_l, &captured.left_channel, offsets.input_l)
            }),
            input_r: config.triggers.input_r.as_ref().map(|cfg| {
                evaluate_trigger(cfg, &mut trigger_states.input_r, &captured.right_channel, offsets.input_r)
            }),
            output_l: config.triggers.output_l.as_ref().and_then(|cfg| {
                stimulus
                    .as_ref()
                    .map(|s| evaluate_trigger(cfg, &mut trigger_states.output_l, &s.left, offsets.output_l))
            }),
            output_r: config.triggers.output_r.as_ref().and_then(|cfg| {
                stimulus
                    .as_ref()
                    .map(|s| evaluate_trigger(cfg, &mut trigger_states.output_r, &s.right, offsets.output_r))
            }),
        };

        // ---- Spectra + input peak (CPU-heavy → blocking thread) ----
        // Consume a reset that landed DURING this frame's capture, so the
        // analysis below already starts a fresh averaging window — the frame
        // being emitted reflects the click (~one frame period sooner than
        // waiting for the next top-of-loop check).
        let reset_now = ctl.avg_reset.swap(false, Ordering::SeqCst);
        let analysis = {
            let analyzers = analyzers.clone();
            let config = config.clone();
            let captured = captured.clone();
            let stimulus = stimulus.clone();
            tokio::task::spawn_blocking(move || {
                analyzers
                    .lock()
                    .map_err(|_| "analyzer lock poisoned".to_string())
                    .map(|mut a| {
                        if reset_now {
                            a.reset_accumulation();
                        }
                        analyze_frame(&mut a, &config, &captured, stimulus.as_ref(), sample_rate)
                    })
            })
            .await
            .map_err(|e| format!("analysis task failed: {e}"))??
        };
        clip_in.report(analysis.input_peak >= input_clip_threshold, now_ms());
        near_in.report(analysis.input_peak >= input_near_threshold, now_ms());

        // ---- Stats + emit ----
        seq += 1;
        let frame_ms = (now_ms() - frame_started) as f32;
        let inst_fps = if frame_ms > 0.0 { 1000.0 / frame_ms } else { 0.0 };
        fps = if fps == 0.0 { inst_fps } else { fps * 0.7 + inst_fps * 0.3 };

        let msg = StreamMsg::Frame(Box::new(StreamFrame {
            seq,
            captured,
            stimulus,
            spectra: analysis.spectra,
            metrics: analysis.metrics,
            trigger,
            mix: MixStatus {
                sigma_peak_dbv,
                clip_input: if clip_in.is_lit(now_ms()) {
                    ClipState::Clip
                } else if near_in.is_lit(now_ms()) {
                    ClipState::Near
                } else {
                    ClipState::None
                },
                clip_output: clip_out.is_lit(now_ms()),
                fitted_output_range_dbv: desired_range,
            },
            offsets,
            stats: StreamStats { frames: seq, fps, frame_ms },
            errors: slot_errors,
        }));
        if on_frame.send(msg).is_err() {
            // Frontend gone (page reloaded / channel dropped): stop cleanly.
            return Ok(());
        }

        // ---- Cadence floor ----
        let elapsed = now_ms() - frame_started;
        if elapsed < MIN_FRAME_GAP_MS {
            tokio::time::sleep(tokio::time::Duration::from_millis(
                (MIN_FRAME_GAP_MS - elapsed) as u64,
            ))
            .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_trigger_cfg() -> TriggerConfig {
        TriggerConfig {
            mode: TriggerMode::Auto,
            edge: TriggerEdge::Rising,
            level_v: 0.0,
            hysteresis_v: Some(0.1),
            pre_samples: 10,
            arm_epoch: 0,
        }
    }

    /// A signal with no rising crossing of level 0 at all (constant negative).
    fn no_edge_samples() -> Vec<f32> {
        vec![-1.0f32; 200]
    }

    /// A signal with one clean, well-qualified rising edge through level 0.
    fn one_edge_samples() -> Vec<f32> {
        let mut s = vec![-1.0f32; 50];
        s.extend((0..50).map(|i| -1.0 + 2.0 * i as f32 / 49.0));
        s.extend(vec![1.0f32; 50]);
        s
    }

    /// 9a. AUTO, no edge -> Auto with index == pre_samples.
    #[test]
    fn evaluate_trigger_auto_no_edge_reports_auto_at_pre_samples() {
        let cfg = TriggerConfig { mode: TriggerMode::Auto, pre_samples: 10, ..default_trigger_cfg() };
        let mut st = EndpointTrigger::default();
        let align = evaluate_trigger(&cfg, &mut st, &no_edge_samples(), 0.0);
        assert_eq!(align.state, TriggerState::Auto);
        assert_eq!(align.index, 10);
    }

    /// 9b. NORMAL, no edge -> Waiting.
    #[test]
    fn evaluate_trigger_normal_no_edge_waits() {
        let cfg = TriggerConfig { mode: TriggerMode::Normal, ..default_trigger_cfg() };
        let mut st = EndpointTrigger::default();
        let align = evaluate_trigger(&cfg, &mut st, &no_edge_samples(), 0.0);
        assert_eq!(align.state, TriggerState::Waiting);
    }

    /// 9c. SINGLE: fires once, then Stopped without re-arming, then
    /// Triggered again once arm_epoch is bumped.
    #[test]
    fn evaluate_trigger_single_latches_then_rearms() {
        let mut cfg = TriggerConfig {
            mode: TriggerMode::Single,
            pre_samples: 0,
            arm_epoch: 1,
            ..default_trigger_cfg()
        };
        let mut st = EndpointTrigger::default();
        let samples = one_edge_samples();

        let first = evaluate_trigger(&cfg, &mut st, &samples, 0.0);
        assert_eq!(first.state, TriggerState::Triggered);

        let second = evaluate_trigger(&cfg, &mut st, &samples, 0.0);
        assert_eq!(second.state, TriggerState::Stopped);

        cfg.arm_epoch += 1;
        let third = evaluate_trigger(&cfg, &mut st, &samples, 0.0);
        assert_eq!(third.state, TriggerState::Triggered);
    }

    /// 9d (review #2) — a workspace load resets `arm_epoch` to 0 in the
    /// frontend while the loop's own `armed_epoch` may already be higher
    /// (past Arm clicks in the same session): the DECREASE must still
    /// re-arm a fired Single latch, not just an increase.
    #[test]
    fn evaluate_trigger_rearms_on_any_epoch_change_not_just_increase() {
        let cfg = TriggerConfig {
            mode: TriggerMode::Single,
            pre_samples: 0,
            arm_epoch: 0,
            ..default_trigger_cfg()
        };
        // Simulates the loop having already armed+fired at a higher epoch
        // from earlier in the session, then the frontend's arm_epoch
        // dropping back to 0 on a workspace load.
        let mut st = EndpointTrigger { armed_epoch: 5, fired: true };
        let align = evaluate_trigger(&cfg, &mut st, &one_edge_samples(), 0.0);
        assert_eq!(align.state, TriggerState::Triggered);
    }

    /// Test 10 — Volts -> FS conversion uses the frame's own offset; hysteresis
    /// `None` falls back to the pinned auto value (2 % of frame peak).
    #[test]
    fn evaluate_trigger_converts_volts_to_fs() {
        // 10^(-offset/20) == 0.5 exactly for offset = 20*log10(2).
        let offset_db = 20.0 * 2f32.log10();
        let cfg = TriggerConfig {
            level_v: 0.5,
            hysteresis_v: None,
            ..default_trigger_cfg()
        };
        let mut st = EndpointTrigger::default();
        let samples = vec![1.0f32; 100]; // peak exactly 1.0
        let align = evaluate_trigger(&cfg, &mut st, &samples, offset_db);
        assert!((align.level_fs - 0.25).abs() < 1e-5, "level_fs {}", align.level_fs);
        // auto_hysteresis(peak=1.0, frac=0.02, floor=1e-4) == 0.02, unaffected
        // by the level's offset conversion (it reads the FS-domain samples).
        assert!((align.hysteresis_fs - 0.02).abs() < 1e-6, "hysteresis_fs {}", align.hysteresis_fs);
    }

    fn base_stream_config() -> StreamConfig {
        StreamConfig {
            buffer_size: 8192,
            slots: Vec::new(),
            window: StreamWindow::Hann,
            averaging: StreamAveraging { coherent: false, count: 1 },
            spectra: SpectraRequest { input_l: false, input_r: false, output_l: false, output_r: false },
            output_range_dbv: None,
            triggers: TriggerRequest::default(),
        }
    }

    /// 11. `validate_config` rejects each bad trigger field.
    #[test]
    fn validate_config_rejects_bad_trigger_fields() {
        let half = base_stream_config().buffer_size / 2;

        let mut too_deep = base_stream_config();
        too_deep.triggers.input_l = Some(TriggerConfig { pre_samples: half + 1, ..default_trigger_cfg() });
        assert!(validate_config(&too_deep).is_err());

        let mut neg_hyst = base_stream_config();
        neg_hyst.triggers.input_l = Some(TriggerConfig { hysteresis_v: Some(-0.1), ..default_trigger_cfg() });
        assert!(validate_config(&neg_hyst).is_err());

        let mut bad_level = base_stream_config();
        bad_level.triggers.input_l = Some(TriggerConfig { level_v: f32::NAN, ..default_trigger_cfg() });
        assert!(validate_config(&bad_level).is_err());

        // A well-formed trigger config must still pass.
        let mut ok = base_stream_config();
        ok.triggers.input_l = Some(default_trigger_cfg());
        assert!(validate_config(&ok).is_ok());
    }

    /// Test 12 — non-interference pin: `analyze_frame` (the function feeding
    /// spectra/metrics) produces byte-identical output whether or not
    /// `triggers` is set on the config — the trigger reads captured/stimulus
    /// independently and never touches this path (module doc's central
    /// invariant, and the reason the A/B bench numbers can't move).
    #[test]
    fn analyze_frame_ignores_triggers_field() {
        let captured = AudioData {
            left_channel: one_edge_samples(),
            right_channel: one_edge_samples(),
            sample_rate: 48_000,
        };
        let stimulus = StereoFrame { left: one_edge_samples(), right: one_edge_samples() };

        let mut config_no_trigger = base_stream_config();
        config_no_trigger.spectra = SpectraRequest { input_l: true, input_r: true, output_l: true, output_r: true };

        let mut config_with_trigger = config_no_trigger.clone();
        config_with_trigger.triggers.input_l = Some(default_trigger_cfg());
        config_with_trigger.triggers.output_r =
            Some(TriggerConfig { mode: TriggerMode::Single, ..default_trigger_cfg() });

        let mut analyzers_a = Analyzers::new();
        let out_a = analyze_frame(&mut analyzers_a, &config_no_trigger, &captured, Some(&stimulus), 48_000);
        let mut analyzers_b = Analyzers::new();
        let out_b = analyze_frame(&mut analyzers_b, &config_with_trigger, &captured, Some(&stimulus), 48_000);

        assert_eq!(format!("{:?}", out_a.spectra), format!("{:?}", out_b.spectra));
        assert_eq!(format!("{:?}", out_a.metrics), format!("{:?}", out_b.metrics));
        assert_eq!(out_a.input_peak, out_b.input_peak);
    }
}

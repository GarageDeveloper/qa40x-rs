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
//! 6. emits [`StreamMsg::Frame`] carrying the frame's own per-converter
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
            scale_mix_to_range(&mut left, &mut right, desired_range)
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

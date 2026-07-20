//! Measurement programs (Traces V2 Phase E).
//!
//! A **measurement program** *drives the instrument*: it configures it,
//! acquires, measures, steps, repeats. It owns the device for its duration —
//! exclusivity is a real hardware constraint (one USB stream at a time), and
//! it is made legible by an explicit session bracket:
//!
//! ```text
//! session.begin(autorange) … apply_config / acquire / measure_* … session.end()
//! ```
//!
//! This is the counterpart of the **signal source** family
//! (`crate::sources`): a source renders samples and never touches the device;
//! a program has the device and nothing renders through it but the program's
//! own stimulus. `acquire()` and the `measure_*` verbs live here and only
//! here.
//!
//! Implementations: [`FrSweepProgram`] (the frequency-response sweep) and
//! `MeasurementScript` (`crate::script`) — a user script that measures.
//!
//! # The bracket, precisely
//!
//! `begin()` stops the continuous generator loop and marks the session
//! active; `end()` closes it. [`Session::acquire`] *auto-begins* — it ensures
//! generator exclusivity itself on every call, which is the historical
//! behaviour of script acquisitions (a script that never acquires never
//! disturbs a running generator). The composite verbs that take the stream
//! for a long time (e.g. [`Session::frequency_response`]) require an explicit
//! `begin()` first. Phase F narrows this further when the mixer takes over
//! the DAC buffer and `activeTask` becomes a program-only lock.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use async_trait::async_trait;
use tokio::sync::Mutex;

use crate::audio::{AnalysisResult, AudioAnalyzer};
use crate::qa40x::{
    AudioData, Capabilities, Channel, FrequencyResponseTrace, InputGain, OutputGain, QA40xDevice,
    SampleRate,
};
use crate::rest;
use crate::sources::{route_stimulus, Route, Waveform};

/* -------------------------------------------------------------------------- */
/* Cancellation                                                                */
/* -------------------------------------------------------------------------- */

/// A shared cancel flag: cooperative cancellation for measurement programs.
/// Cloneable; `from_flag` wraps an existing `Arc<AtomicBool>` (the script
/// engine's stop flag) so both sides observe the same signal.
#[derive(Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_flag(flag: Arc<AtomicBool>) -> Self {
        Self(flag)
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    /// The underlying flag (for code that polls an `Arc<AtomicBool>` directly,
    /// like the Rhai engine's progress hook).
    pub fn flag(&self) -> &Arc<AtomicBool> {
        &self.0
    }
}

/* -------------------------------------------------------------------------- */
/* Requests / results                                                          */
/* -------------------------------------------------------------------------- */

/// A frequency band request (peak search, band RMS…).
#[derive(Clone, Copy, Debug)]
pub struct Band {
    pub lo_hz: f32,
    pub hi_hz: f32,
}

/// A fundamental-frequency request (THD, THD+N, SNR).
#[derive(Clone, Copy, Debug)]
pub struct Fundamental {
    pub hz: f32,
}

/// A per-channel measurement result.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LeftRight {
    pub left: f64,
    pub right: f64,
}

/// The generator settings a session plays on `acquire()` — same model as the
/// REST `GenConfig`, plus the output routing.
#[derive(Clone, Debug)]
pub struct GenConfig {
    pub on: bool,
    pub wave: Waveform,
    pub freq: f32,
    pub amp_dbfs: f32,
    /// Which DAC channel(s) the tone is routed to (default Left — the
    /// historical script-acquisition convention).
    pub route: Route,
}

impl Default for GenConfig {
    fn default() -> Self {
        Self { on: true, wave: Waveform::Sine, freq: 1000.0, amp_dbfs: -6.0, route: Route::Left }
    }
}

/// A config delta for [`Session::apply_config`]: every `Some` field is
/// applied, every `None` left as is. Range/rate values are typed, so an
/// invalid setting is unrepresentable (callers validate/parse first).
#[derive(Clone, Debug, Default)]
pub struct SessionConfig {
    pub sample_rate: Option<SampleRate>,
    pub input_range: Option<InputGain>,
    pub output_range: Option<OutputGain>,
    pub buffer_size: Option<usize>,
    pub gen_enabled: Option<bool>,
    pub gen_waveform: Option<Waveform>,
    pub gen_frequency_hz: Option<f32>,
    pub gen_amplitude_dbfs: Option<f32>,
    pub gen_route: Option<Route>,
}

impl SessionConfig {
    /// The session defaults (what `default_settings()` restores): generator
    /// on, 1 kHz sine at −6 dBFS routed Left, 32768-sample buffer.
    pub fn default_settings() -> Self {
        let gen = GenConfig::default();
        Self {
            buffer_size: Some(DEFAULT_BUFFER_SIZE),
            gen_enabled: Some(gen.on),
            gen_waveform: Some(gen.wave),
            gen_frequency_hz: Some(gen.freq),
            gen_amplitude_dbfs: Some(gen.amp_dbfs),
            gen_route: Some(gen.route),
            ..Self::default()
        }
    }
}

/// The stimulus tone one acquisition played.
#[derive(Clone, Debug)]
pub struct PlayedTone {
    pub samples: Vec<f32>,
    pub freq: f32,
    pub route: Route,
}

/// What [`Session::acquire`] returns: the raw stereo capture plus the tone
/// played (None = generator off, a monitor capture of whatever comes in).
#[derive(Clone, Debug)]
pub struct Capture {
    pub audio: AudioData,
    pub tone: Option<PlayedTone>,
}

const DEFAULT_BUFFER_SIZE: usize = 32_768;

/* -------------------------------------------------------------------------- */
/* Session                                                                     */
/* -------------------------------------------------------------------------- */

struct SessionState {
    active: bool,
    /// Accepted by `begin()` for the coming auto-range work (Phase G); the
    /// session records the request but does not act on it yet.
    autorange: bool,
    gen: GenConfig,
    buffer_size: usize,
    last: Option<AudioData>,
}

impl Default for SessionState {
    fn default() -> Self {
        Self {
            active: false,
            autorange: false,
            gen: GenConfig::default(),
            buffer_size: DEFAULT_BUFFER_SIZE,
            last: None,
        }
    }
}

/// The exclusive device session a [`MeasurementProgram`] runs against.
///
/// Cheap to clone: all state is shared behind `Arc`s, so a program can hand a
/// clone to a blocking thread (the Rhai engine) while the async side keeps
/// the original — both observe the same session.
#[derive(Clone)]
pub struct Session {
    device: Arc<Mutex<QA40xDevice>>,
    generator_running: Arc<AtomicBool>,
    generator_stop: Arc<AtomicBool>,
    state: Arc<StdMutex<SessionState>>,
}

impl Session {
    pub fn new(
        device: Arc<Mutex<QA40xDevice>>,
        generator_running: Arc<AtomicBool>,
        generator_stop: Arc<AtomicBool>,
    ) -> Self {
        Self {
            device,
            generator_running,
            generator_stop,
            state: Arc::new(StdMutex::new(SessionState::default())),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, SessionState> {
        self.state.lock().expect("session state lock poisoned")
    }

    /// Open the exclusive bracket: stop the continuous generator loop (and
    /// wait for it to exit) so the stream is ours. Idempotent.
    pub async fn begin(&self, autorange: bool) -> Result<(), String> {
        crate::ensure_generator_stopped(&self.generator_running, &self.generator_stop).await;
        let mut st = self.state();
        st.active = true;
        st.autorange = autorange;
        Ok(())
    }

    /// Close the bracket. (Nothing is restored: a finished measurement leaves
    /// the instrument quiet, exactly as before this refactor.)
    pub async fn end(&self) {
        self.state().active = false;
    }

    pub fn is_active(&self) -> bool {
        self.state().active
    }

    /// Apply a config delta. Register writes (rates/ranges) go to the device
    /// — the driver skips writes that match the current value, so this never
    /// chatters the relays; generator/buffer settings are session state.
    pub async fn apply_config(&self, cfg: SessionConfig) -> Result<(), String> {
        if cfg.sample_rate.is_some() || cfg.input_range.is_some() || cfg.output_range.is_some() {
            let dev = self.device.lock().await;
            if let Some(sr) = cfg.sample_rate {
                dev.set_sample_rate(sr)
                    .await
                    .map_err(|e| format!("set_sample_rate failed: {e}"))?;
            }
            if let Some(g) = cfg.input_range {
                dev.set_input_gain(g).await.map_err(|e| format!("set_input_range failed: {e}"))?;
            }
            if let Some(g) = cfg.output_range {
                dev.set_output_gain(g)
                    .await
                    .map_err(|e| format!("set_output_range failed: {e}"))?;
            }
        }
        let mut st = self.state();
        if let Some(n) = cfg.buffer_size {
            st.buffer_size = n;
        }
        if let Some(on) = cfg.gen_enabled {
            st.gen.on = on;
        }
        if let Some(w) = cfg.gen_waveform {
            st.gen.wave = w;
        }
        if let Some(f) = cfg.gen_frequency_hz {
            st.gen.freq = f;
        }
        if let Some(a) = cfg.gen_amplitude_dbfs {
            st.gen.amp_dbfs = a.clamp(-120.0, 0.0);
        }
        if let Some(r) = cfg.gen_route {
            st.gen.route = r;
        }
        Ok(())
    }

    /// Play the configured generator tone (routed to the declared output
    /// channel(s)) and capture the loopback. Auto-begins (see the module
    /// docs): the continuous generator is stopped first so the stream is
    /// exclusively ours — interleaving register I/O with a capture wedges the
    /// device. The capture is retained for the `measure_*` verbs.
    pub async fn acquire(&self) -> Result<Capture, String> {
        let (gen, n) = {
            let st = self.state();
            (st.gen.clone(), st.buffer_size.max(1024))
        };
        crate::ensure_generator_stopped(&self.generator_running, &self.generator_stop).await;
        let dev = self.device.lock().await;
        if !dev.is_connected().await {
            return Err("device not connected — connect the QA40x first".to_string());
        }
        let sr = dev.get_config().await.sample_rate.as_hz();
        // An Off-routed generator drives nothing: same as gen off, so the
        // "Off" tag never reaches the frontend's stimulus pipeline.
        let driving = gen.on && gen.route != Route::Off;
        let tone = if driving {
            let amp = 10f32.powf(gen.amp_dbfs.clamp(-120.0, 0.0) / 20.0);
            gen.wave.generate(gen.freq, amp, sr, n)
        } else {
            vec![0.0f32; n]
        };
        let (left, right) = if driving {
            route_stimulus(&tone, gen.route)
        } else {
            (vec![0.0f32; n], vec![0.0f32; n])
        };
        let audio = dev
            .generate_and_capture(&left, &right)
            .await
            .map_err(|e| format!("acquisition failed: {e}"))?;
        drop(dev);
        let mut st = self.state();
        st.active = true; // the bracket is open now, if it wasn't already
        st.last = Some(audio.clone());
        Ok(Capture {
            audio,
            tone: driving.then(|| PlayedTone { samples: tone, freq: gen.freq, route: gen.route }),
        })
    }

    /// The last `acquire()` capture, if any.
    pub fn last_capture(&self) -> Option<AudioData> {
        self.state().last.clone()
    }

    /// Current generator settings (what the next `acquire()` will play).
    pub fn gen_config(&self) -> GenConfig {
        self.state().gen.clone()
    }

    /// Current acquisition buffer size (samples).
    pub fn buffer_size(&self) -> usize {
        self.state().buffer_size
    }

    #[cfg(test)]
    pub(crate) fn inject_last(&self, cap: AudioData) {
        self.state().last = Some(cap);
    }

    /* ---- status / config readback (cached values, no register I/O) ------- */

    pub async fn connected(&self) -> bool {
        self.device.lock().await.is_connected().await
    }

    pub async fn firmware_version(&self) -> String {
        self.device
            .lock()
            .await
            .device_meta()
            .await
            .map(|m| m.firmware_version.to_string())
            .unwrap_or_else(|| "0".into())
    }

    pub async fn model_name(&self) -> String {
        self.device
            .lock()
            .await
            .model()
            .await
            .map(|m| m.name().to_string())
            .unwrap_or_default()
    }

    pub async fn sample_rate_hz(&self) -> u32 {
        self.device.lock().await.get_config().await.sample_rate.as_hz()
    }

    pub async fn input_range_dbv(&self) -> i32 {
        self.device.lock().await.get_config().await.input_gain.as_dbv()
    }

    pub async fn output_range_dbv(&self) -> i32 {
        self.device.lock().await.get_config().await.output_gain.as_dbv()
    }

    /* ---- measurements over the last capture ------------------------------ */

    fn last_or_err(&self) -> Result<AudioData, String> {
        self.last_capture().ok_or_else(|| "no acquisition yet — call acquire() first".to_string())
    }

    /// Strongest-bin frequency per channel within a band (Hz).
    pub fn find_peak(&self, req: Band) -> Result<LeftRight, String> {
        let cap = self.last_or_err()?;
        Ok(LeftRight {
            left: rest::peak_freq(&cap.left_channel, cap.sample_rate, req.lo_hz, req.hi_hz) as f64,
            right: rest::peak_freq(&cap.right_channel, cap.sample_rate, req.lo_hz, req.hi_hz)
                as f64,
        })
    }

    /// The full harmonic analysis (THD, THD+N, SNR, …) of each channel at a
    /// fundamental — the same analysis code the REST server uses.
    pub fn analyze(&self, req: Fundamental) -> Result<(AnalysisResult, AnalysisResult), String> {
        let cap = self.last_or_err()?;
        Ok((
            rest::analyze_channel(&cap.left_channel, cap.sample_rate, req.hz),
            rest::analyze_channel(&cap.right_channel, cap.sample_rate, req.hz),
        ))
    }

    /// THD per channel at a fundamental, in percent.
    pub fn measure_thd(&self, req: Fundamental) -> Result<LeftRight, String> {
        let (l, r) = self.analyze(req)?;
        Ok(LeftRight { left: l.thd as f64, right: r.thd as f64 })
    }

    /// THD+N per channel at a fundamental, in percent.
    pub fn measure_thdn(&self, req: Fundamental) -> Result<LeftRight, String> {
        let (l, r) = self.analyze(req)?;
        Ok(LeftRight { left: l.thd_n as f64, right: r.thd_n as f64 })
    }

    /// Band RMS level per channel in dBV (dBFS + input-range calibration).
    pub async fn measure_rms(&self, req: Band) -> Result<LeftRight, String> {
        self.level_dbv(req, false).await
    }

    /// Band peak level per channel in dBV.
    pub async fn measure_peak_level(&self, req: Band) -> Result<LeftRight, String> {
        self.level_dbv(req, true).await
    }

    async fn level_dbv(&self, req: Band, use_peak: bool) -> Result<LeftRight, String> {
        let cap = self.last_or_err()?;
        let fund = rest::peak_freq(&cap.left_channel, cap.sample_rate, req.lo_hz, req.hi_hz);
        let (off_l, off_r) = {
            let dev = self.device.lock().await;
            (
                dev.input_dbv_offset(Channel::Left).await.0,
                dev.input_dbv_offset(Channel::Right).await.0,
            )
        };
        let pick = |a: &AnalysisResult| if use_peak { a.peak } else { a.rms };
        let l = rest::db(pick(&rest::analyze_channel(&cap.left_channel, cap.sample_rate, fund))
            as f64)
            + off_l as f64;
        let r = rest::db(pick(&rest::analyze_channel(&cap.right_channel, cap.sample_rate, fund))
            as f64)
            + off_r as f64;
        Ok(LeftRight { left: l, right: r })
    }

    /* ---- composite verbs -------------------------------------------------- */

    /// Run a chirp-deconvolution frequency response (the device's synchronized
    /// stream + Farina deconvolution). Requires an explicit `begin()` — this
    /// verb holds the stream for the whole chirp.
    pub async fn frequency_response(
        &self,
        req: &FrequencyResponseRequest,
    ) -> Result<Vec<FrequencyResponseTrace>, String> {
        if !self.is_active() {
            return Err("no active session — call begin() first".to_string());
        }
        let dev = self.device.lock().await;
        if !dev.is_connected().await {
            return Err("device not connected — connect the QA40x first".to_string());
        }
        dev.measure_frequency_response_multi(
            req.start_freq,
            req.end_freq,
            req.duration_secs,
            req.amplitude_dbfs,
            req.drive_left,
            req.drive_right,
            req.want_left,
            req.want_right,
        )
        .await
        .map_err(|e| e.to_string())
    }
}

/* -------------------------------------------------------------------------- */
/* Auto-level by probing (Traces V2 Phase G2 — design doc §3, levels doc §5)   */
/* -------------------------------------------------------------------------- */

/// Outcome of the probe-based auto-level: what was driven, what came back,
/// the DUT gain it implies, and the drive that will hit the target.
#[derive(Clone, Copy, Debug)]
pub struct AutoLevel {
    /// The probe level actually driven (Vrms at the analyzer output).
    pub probe_vrms: f64,
    /// Band RMS measured around the found peak, louder channel (Vrms).
    pub measured_vrms: f64,
    /// `measured / probe` (linear) …
    pub gain: f64,
    /// … and in dB, for messages.
    pub gain_db: f64,
    /// `target / gain`: the drive that puts the DUT's output at the target.
    pub required_drive_vrms: f64,
}

/// Step 1: the probe level — `target × 10⁻²` (−40 dB), clamped into the
/// model's output span. −40 dB balances two risks: a DUT with 40 dB more
/// gain than anticipated only *reaches* the target during the probe, while
/// the probe still sits tens of mV above the noise floor for a trustworthy
/// band-RMS estimate around a known tone.
pub fn probe_level_vrms(target_vrms: f64, caps: &Capabilities) -> Result<f64, String> {
    if !target_vrms.is_finite() || target_vrms <= 0.0 {
        return Err(format!(
            "auto-level target must be a positive, finite voltage (got {target_vrms} Vrms)"
        ));
    }
    Ok((target_vrms * 1e-2).clamp(caps.min_output_vrms, caps.max_output_vrms))
}

/// Steps 3–5: gain from the probe measurement, then the required drive —
/// refusing, never clamping. Every division is guarded: a zero or non-finite
/// measured level means "DUT gain could not be determined" (unpowered, muted,
/// disconnected, or a failed capture) — an error, NOT a 0 dB gain. And when
/// the required drive exceeds the model's output limit the measurement fails
/// with the measured gain in dB; clamping would silently measure something
/// other than what the test names.
pub fn drive_from_probe(
    target_vrms: f64,
    probe_vrms: f64,
    measured_vrms: f64,
    caps: &Capabilities,
) -> Result<AutoLevel, String> {
    if !target_vrms.is_finite() || target_vrms <= 0.0 {
        return Err(format!(
            "auto-level target must be a positive, finite voltage (got {target_vrms} Vrms)"
        ));
    }
    if !probe_vrms.is_finite() || probe_vrms <= 0.0 {
        return Err(format!("auto-level probe was not a positive voltage ({probe_vrms} Vrms)"));
    }
    if !measured_vrms.is_finite() || measured_vrms <= 0.0 {
        return Err(
            "DUT gain could not be determined: the probe measured no signal (DUT unpowered, \
             muted, disconnected, or the capture failed)"
                .to_string(),
        );
    }
    let gain = measured_vrms / probe_vrms;
    let gain_db = 20.0 * gain.log10();
    let required_drive_vrms = target_vrms / gain;
    if !required_drive_vrms.is_finite() || required_drive_vrms <= 0.0 {
        return Err(format!(
            "DUT gain could not be determined: measured gain {gain_db:.1} dB gives no usable \
             drive level"
        ));
    }
    if required_drive_vrms > caps.max_output_vrms {
        return Err(format!(
            "measured DUT gain {gain_db:.1} dB; reaching {target_vrms:.3} Vrms would require \
             {required_drive_vrms:.3} Vrms drive, above this model's {:.3} Vrms ({:.0} dBV) \
             output limit",
            caps.max_output_vrms,
            20.0 * caps.max_output_vrms.log10(),
        ));
    }
    Ok(AutoLevel { probe_vrms, measured_vrms, gain, gain_db, required_drive_vrms })
}

impl Session {
    /// The connected model's capabilities (output span, band, rates).
    pub async fn capabilities(&self) -> Result<Capabilities, String> {
        self.device
            .lock()
            .await
            .model()
            .await
            .map(|m| m.capabilities())
            .ok_or_else(|| "device not connected — capabilities unknown".to_string())
    }

    /// Band RMS around the strongest bin near `hz`, per channel, in **Vrms**
    /// (calibrated), over the last capture. The peak is *found* within
    /// [hz/2, 2·hz] rather than assumed at the requested bin, and the tone's
    /// whole spectral lobe is integrated (`band_rms_fraction`) instead of
    /// reading one bin — a windowed or slightly off-bin tone would otherwise
    /// be quietly underestimated.
    pub async fn probe_measured_vrms(&self, hz: f64) -> Result<LeftRight, String> {
        let cap = self.last_or_err()?;
        let nyq = cap.sample_rate as f32 / 2.0;
        let lo = (hz as f32 / 2.0).max(1.0);
        let hi = (hz as f32 * 2.0).min(nyq * 0.99);
        let (off_l, off_r) = {
            let dev = self.device.lock().await;
            (
                dev.input_dbv_offset(Channel::Left).await.0,
                dev.input_dbv_offset(Channel::Right).await.0,
            )
        };
        let band_vrms = |sig: &[f32], off_db: f32| -> f64 {
            let fund = rest::peak_freq(sig, cap.sample_rate, lo, hi);
            let (mags, freqs) = rest::spectrum(sig, cap.sample_rate);
            let frac = AudioAnalyzer::band_rms_fraction(&mags, &freqs, fund) as f64;
            let full = AudioAnalyzer::calculate_rms(sig) as f64;
            // dBFS → Vrms via the input-range calibration offset. Linear all
            // the way: a dead channel must come out 0.0 (→ "gain could not be
            // determined"), not a dB floor masquerading as a level.
            full * frac * 10f64.powf(off_db as f64 / 20.0)
        };
        Ok(LeftRight {
            left: band_vrms(&cap.left_channel, off_l),
            right: band_vrms(&cap.right_channel, off_r),
        })
    }

    /// Probe-based auto-level: measure the DUT's gain at −40 dB below the
    /// target, then compute the drive that puts the DUT's output at
    /// `target_vrms` — refusing (with the gain in dB) when that drive exceeds
    /// the model's output limit. The generator is left at the probe settings;
    /// the caller applies the returned drive (or reports the refusal).
    /// Routing follows the session's current generator route.
    pub async fn auto_level(
        &self,
        target_vrms: f64,
        frequency_hz: f64,
    ) -> Result<AutoLevel, String> {
        let caps = self.capabilities().await?;
        if !frequency_hz.is_finite()
            || frequency_hz < caps.min_measurement_hz
            || frequency_hz > caps.max_measurement_hz
        {
            return Err(format!(
                "auto-level frequency {frequency_hz} Hz outside this model's {}–{} Hz band",
                caps.min_measurement_hz, caps.max_measurement_hz
            ));
        }
        let probe = probe_level_vrms(target_vrms, &caps)?;
        // Probe on a fixed mid range: the probe is at most max_output×10⁻²
        // (≈ −16 dBV on the working values), which the +8 dBV range contains
        // with ≥ 20 dB to spare. Range auto-fit deliberately stays within the
        // {+8, +18} dBV ranges (the lower ones await relay-noise
        // characterisation — same policy as the frontend's autoOutputRange).
        let probe_dbv = 20.0 * probe.log10();
        let range = if probe_dbv <= 8.0 { OutputGain::Gain8dBV } else { OutputGain::Gain18dBV };
        // dBFS is sine-referenced RMS (task #48: a 0 dBFS sine measures the
        // range's dBV). apply_config clamps to −120 dBFS, so recompute the
        // *effective* probe from the clamped value — the gain division must
        // use what was actually driven.
        let range_dbv = f64::from(range.as_dbv());
        let amp_dbfs = ((probe_dbv - range_dbv) as f32).clamp(-120.0, 0.0);
        let effective_probe = 10f64.powf((f64::from(amp_dbfs) + range_dbv) / 20.0);
        self.apply_config(SessionConfig {
            output_range: Some(range),
            gen_enabled: Some(true),
            gen_waveform: Some(Waveform::Sine),
            gen_frequency_hz: Some(frequency_hz as f32),
            gen_amplitude_dbfs: Some(amp_dbfs),
            ..SessionConfig::default()
        })
        .await?;
        // The range write above stamps the relay-settle deadline; the driver
        // makes this acquisition wait it out (Phase G1).
        self.acquire().await?;
        let m = self.probe_measured_vrms(frequency_hz).await?;
        let measured = m.left.max(m.right); // the louder channel
        drive_from_probe(target_vrms, effective_probe, measured, &caps)
    }
}

/* -------------------------------------------------------------------------- */
/* Programs                                                                    */
/* -------------------------------------------------------------------------- */

/// An imperative measurement run against an exclusive device session.
#[async_trait]
pub trait MeasurementProgram: Send {
    async fn run(&mut self, session: &mut Session, cancel: &CancelToken) -> Result<(), String>;
}

/// Parameters of one frequency-response sweep (mirrors the UI form 1:1).
#[derive(Clone, Copy, Debug)]
pub struct FrequencyResponseRequest {
    pub start_freq: f32,
    pub end_freq: f32,
    pub duration_secs: f32,
    pub amplitude_dbfs: f32,
    pub drive_left: bool,
    pub drive_right: bool,
    pub want_left: bool,
    pub want_right: bool,
}

/// The FR sweep as a measurement program: begin → chirp + deconvolve → end.
/// The result (one trace per selected input channel) lands in `result`.
pub struct FrSweepProgram {
    pub request: FrequencyResponseRequest,
    pub result: Option<Vec<FrequencyResponseTrace>>,
}

impl FrSweepProgram {
    pub fn new(request: FrequencyResponseRequest) -> Self {
        Self { request, result: None }
    }
}

#[async_trait]
impl MeasurementProgram for FrSweepProgram {
    async fn run(&mut self, session: &mut Session, cancel: &CancelToken) -> Result<(), String> {
        session.begin(false).await?;
        let res = if cancel.is_cancelled() {
            Err("frequency-response sweep cancelled".to_string())
        } else {
            session.frequency_response(&self.request).await
        };
        session.end().await;
        self.result = Some(res?);
        Ok(())
    }
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    fn test_session() -> Session {
        Session::new(
            Arc::new(Mutex::new(QA40xDevice::new())),
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicBool::new(false)),
        )
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
    }

    /// A 1 kHz / −6 dBFS synthetic capture.
    fn tone_capture() -> AudioData {
        let sr = 48_000u32;
        let n = 32_768usize;
        let tone: Vec<f32> = (0..n)
            .map(|i| 0.5 * (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / sr as f32).sin())
            .collect();
        AudioData { left_channel: tone.clone(), right_channel: tone, sample_rate: sr }
    }

    #[test]
    fn the_bracket_is_explicit_and_idempotent() {
        let rt = rt();
        let s = test_session();
        assert!(!s.is_active());
        rt.block_on(s.begin(false)).unwrap();
        assert!(s.is_active());
        rt.block_on(s.begin(true)).unwrap(); // idempotent
        assert!(s.is_active());
        rt.block_on(s.end());
        assert!(!s.is_active());
    }

    #[test]
    fn acquire_requires_a_connection() {
        let rt = rt();
        let s = test_session();
        let err = rt.block_on(s.acquire()).unwrap_err();
        assert!(err.contains("not connected"), "got: {err}");
    }

    #[test]
    fn measurements_require_an_acquisition() {
        let s = test_session();
        let err = s.find_peak(Band { lo_hz: 20.0, hi_hz: 20_000.0 }).unwrap_err();
        assert!(err.contains("no acquisition yet"), "got: {err}");
        let err = s.measure_thd(Fundamental { hz: 1000.0 }).unwrap_err();
        assert!(err.contains("no acquisition yet"), "got: {err}");
    }

    #[test]
    fn measurement_verbs_analyse_the_last_capture() {
        let rt = rt();
        let s = test_session();
        s.inject_last(tone_capture());

        let peak = s.find_peak(Band { lo_hz: 20.0, hi_hz: 20_000.0 }).unwrap();
        assert!((peak.left - 1000.0).abs() < 5.0, "peak at {} Hz", peak.left);
        assert_eq!(peak.left, peak.right);

        let thd = s.measure_thd(Fundamental { hz: peak.left as f32 }).unwrap();
        assert!(thd.left < 0.01, "clean sine THD {}%", thd.left);
        let thdn = s.measure_thdn(Fundamental { hz: peak.left as f32 }).unwrap();
        assert!(thdn.left < 1.0, "clean sine THD+N {}%", thdn.left);

        // −6 dBFS RMS ≈ −9 dBFS + the input-range offset (≈ 0 dBV at 6 dBV
        // range on the disconnected default config) — just assert the ballpark
        // the script tests use.
        let rms = rt.block_on(s.measure_rms(Band { lo_hz: 20.0, hi_hz: 20_000.0 })).unwrap();
        assert!(rms.left > -9.4 && rms.left < -8.7, "rms {} dBV", rms.left);
        let pk = rt
            .block_on(s.measure_peak_level(Band { lo_hz: 20.0, hi_hz: 20_000.0 }))
            .unwrap();
        assert!(pk.left > rms.left, "peak {} above rms {}", pk.left, rms.left);
    }

    #[test]
    fn apply_config_updates_generator_state_without_the_device() {
        let rt = rt();
        let s = test_session();
        rt.block_on(s.apply_config(SessionConfig {
            gen_enabled: Some(true),
            gen_waveform: Some(Waveform::Square),
            gen_frequency_hz: Some(100.0),
            gen_amplitude_dbfs: Some(-200.0), // clamped
            gen_route: Some(Route::Both),
            buffer_size: Some(4096),
            ..SessionConfig::default()
        }))
        .unwrap();
        let g = s.gen_config();
        assert_eq!(g.wave, Waveform::Square);
        assert_eq!(g.freq, 100.0);
        assert_eq!(g.amp_dbfs, -120.0);
        assert_eq!(g.route, Route::Both);
        assert_eq!(s.buffer_size(), 4096);

        rt.block_on(s.apply_config(SessionConfig::default_settings())).unwrap();
        let g = s.gen_config();
        assert_eq!(g.wave, Waveform::Sine);
        assert_eq!(g.route, Route::Left);
        assert_eq!(s.buffer_size(), 32_768);
    }

    #[test]
    fn the_fr_program_needs_a_device_and_ends_its_session() {
        let rt = rt();
        let mut s = test_session();
        let mut prog = FrSweepProgram::new(FrequencyResponseRequest {
            start_freq: 20.0,
            end_freq: 20_000.0,
            duration_secs: 1.0,
            amplitude_dbfs: -6.0,
            drive_left: true,
            drive_right: false,
            want_left: true,
            want_right: false,
        });
        let cancel = CancelToken::new();
        let err = rt.block_on(prog.run(&mut s, &cancel)).unwrap_err();
        assert!(err.contains("not connected"), "got: {err}");
        assert!(!s.is_active(), "the bracket must close even on failure");
        assert!(prog.result.is_none());
    }

    #[test]
    fn a_cancelled_fr_program_never_touches_the_stream() {
        let rt = rt();
        let mut s = test_session();
        let mut prog = FrSweepProgram::new(FrequencyResponseRequest {
            start_freq: 20.0,
            end_freq: 20_000.0,
            duration_secs: 1.0,
            amplitude_dbfs: -6.0,
            drive_left: true,
            drive_right: false,
            want_left: true,
            want_right: false,
        });
        let cancel = CancelToken::new();
        cancel.cancel();
        let err = rt.block_on(prog.run(&mut s, &cancel)).unwrap_err();
        assert!(err.contains("cancelled"), "got: {err}");
    }

    /* ---- auto-level ------------------------------------------------------- */

    fn caps() -> Capabilities {
        crate::qa40x::Model::Qa402.capabilities()
    }

    #[test]
    fn the_probe_sits_40_db_below_the_target_clamped_to_the_output_span() {
        let c = caps();
        // Worked example (levels doc §5): 1 W into 8 Ω → 2.83 Vrms target.
        let p = probe_level_vrms(2.83, &c).unwrap();
        assert!((p - 0.0283).abs() < 1e-9, "probe {p}");
        // A tiny target clamps up to the smallest producible level…
        let p = probe_level_vrms(2e-6, &c).unwrap();
        assert_eq!(p, c.min_output_vrms);
        // …and bad targets are refused outright.
        for bad in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(probe_level_vrms(bad, &c).is_err(), "target {bad} must be refused");
        }
    }

    #[test]
    fn the_worked_example_computes_gain_and_drive() {
        // levels doc §5: probe 28.3 mV, measured 1.42 V → +34 dB, drive 56.4 mV.
        let r = drive_from_probe(2.83, 0.0283, 1.42, &caps()).unwrap();
        assert!((r.gain - 50.176).abs() < 0.01, "gain {}", r.gain);
        assert!((r.gain_db - 34.0).abs() < 0.05, "gain {} dB", r.gain_db);
        assert!((r.required_drive_vrms - 0.0564).abs() < 0.0001, "drive {}", r.required_drive_vrms);
    }

    #[test]
    fn an_impossible_drive_is_refused_with_the_gain_named_never_clamped() {
        // A −20 dB attenuator "DUT": reaching 2.83 Vrms needs 28.3 Vrms drive.
        let err = drive_from_probe(2.83, 0.0283, 0.00283, &caps()).unwrap_err();
        assert!(err.contains("-20.0 dB"), "the measured gain must be named: {err}");
        assert!(err.contains("28.3"), "the required drive must be named: {err}");
        assert!(err.contains("output limit"), "got: {err}");
    }

    #[test]
    fn an_unmeasurable_probe_is_an_error_not_a_0_db_gain() {
        for bad in [0.0, -0.1, f64::NAN, f64::INFINITY] {
            let err = drive_from_probe(2.83, 0.0283, bad, &caps()).unwrap_err();
            assert!(
                err.contains("could not be determined"),
                "measured {bad} must not become a gain: {err}"
            );
        }
        // A broken probe value is likewise guarded (division by zero).
        assert!(drive_from_probe(2.83, 0.0, 1.0, &caps()).is_err());
        assert!(drive_from_probe(2.83, f64::NAN, 1.0, &caps()).is_err());
    }

    #[test]
    fn probe_measurement_reads_the_band_rms_around_the_found_peak() {
        let rt = rt();
        let s = test_session();
        s.inject_last(tone_capture()); // 1 kHz sine, −6 dBFS peak → RMS ≈ 0.354
        // Ask near — not at — the tone: the peak must be *found*.
        let m = rt.block_on(s.probe_measured_vrms(1100.0)).unwrap();
        assert!(m.left > 0.33 && m.left < 0.37, "band Vrms {}", m.left);
        assert_eq!(m.left, m.right);
        // A silent capture measures 0.0 — the "gain undetermined" trigger —
        // not some dB-floor voltage.
        s.inject_last(AudioData {
            left_channel: vec![0.0; 32_768],
            right_channel: vec![0.0; 32_768],
            sample_rate: 48_000,
        });
        let m = rt.block_on(s.probe_measured_vrms(1000.0)).unwrap();
        assert_eq!(m.left, 0.0);
    }

    #[test]
    fn auto_level_needs_a_connected_device() {
        let rt = rt();
        let s = test_session();
        let err = rt.block_on(s.auto_level(2.83, 1000.0)).unwrap_err();
        assert!(err.contains("not connected"), "got: {err}");
    }

    #[test]
    fn frequency_response_requires_the_bracket() {
        let rt = rt();
        let s = test_session();
        let req = FrequencyResponseRequest {
            start_freq: 20.0,
            end_freq: 20_000.0,
            duration_secs: 1.0,
            amplitude_dbfs: -6.0,
            drive_left: true,
            drive_right: false,
            want_left: true,
            want_right: false,
        };
        let err = rt.block_on(s.frequency_response(&req)).unwrap_err();
        assert!(err.contains("begin()"), "got: {err}");
    }
}

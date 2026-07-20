//! Signal sources (Traces V2 Phase E).
//!
//! A **signal source** renders samples on demand: it is asked for one frame of
//! `ctx.buffer_size` samples at `ctx.sample_rate` and fills the buffers. It
//! never touches the device. Because sources are pull-based and additive,
//! several can run at once — the mixer (`crate::mixer`, Phase F) asks every
//! enabled source to render into a scratch buffer and sums the contributions
//! per channel according to each source's [`Route`].
//!
//! This is one of the two families of code that drive audio here; the other is
//! the **measurement program** (`crate::measurement`), which owns the device
//! exclusively for its duration. A source *produces* a signal; a program
//! *drives the instrument*. Keeping them apart is what lets N sources coexist
//! while measurements stay exclusive.
//!
//! Implementations:
//! - [`WaveformSource`] — the periodic tones (sine / square / triangle /
//!   sawtooth), delegating to [`SignalGenerator`] so the samples are exactly
//!   the ones the acquisition path has always played;
//! - [`ToneListSource`] — a generator holding a *list* of [`Tone`]s (each
//!   with its own phase) summed per sample;
//! - [`MultitoneSource`] — the bin-aligned, Schroeder-phased, RMS-normalized
//!   multitone (formerly mirrored by the frontend’s `makeMultitone`; the unit tests
//!   pin both against the same reference vector);
//! - [`NoiseSource`] — white noise at a level;
//! - [`ChirpSource`] — the log (exponential) sweep with raised-cosine end
//!   fades (formerly mirrored by the frontend’s `makeChirp`, same pinned vector);
//! - [`RhaiSignalSource`] — a user script whose `fn render(ctx)` produces the
//!   samples (see the render contract below).
//!
//! TODO(traces-v2): a WAV/file `SignalSource`. No production WAV reader exists
//! in the app yet — the only RIFF parser is test-only (`audio/validation.rs`),
//! so the file source stays unimplemented rather than inventing a half reader
//! here. Add it when the File trace source lands.
//!
//! # Level semantics: `amplitude` is a sine-referenced RMS target (task #48)
//!
//! Measured on hardware in loopback: the value fed to the generator is a
//! **peak**, and an output range's dBV is the RMS of a full-scale **sine**
//! (full-scale peak = `10^(R/20)·√2`). So an amplitude `a` in this module is
//! sine-referenced: it is the peak of the sine whose RMS is the requested
//! level, and the level's RMS target *in buffer units* is `a/√2` — the same
//! for every waveform. Before Phase G2 every waveform rendered at peak `a`,
//! which made a square (crest factor 1) land 3.01 dB hot and a triangle or
//! sawtooth (crest factor √3) 1.76 dB low, exactly as measured. Each source
//! below therefore normalizes its own frame to RMS `a/√2`:
//!
//! - periodic waveforms scale their peak by the analytic `CF/√2`
//!   ([`Waveform::crest_factor`]) — a sine's factor is exactly 1.0, so sines
//!   are bit-identical to what always played (pinned by test);
//! - multitone and chirp measure the rendered frame's actual RMS (their crest
//!   factor is not a constant) and scale it to the target;
//! - noise normalizes analytically from its distribution (measuring one frame
//!   would make the level jitter frame to frame).
//!
//! # The Rhai render contract
//!
//! A *source script* defines a function the host calls once per frame:
//!
//! ```rhai
//! fn render(ctx) {
//!     // ctx.sample_rate (int), ctx.buffer_size (int), plus one float per
//!     // entry of RenderContext::params.
//!     let out = [];
//!     ...
//!     out            // exactly ctx.buffer_size samples
//! }
//! ```
//!
//! The function returns either an **array** of `ctx.buffer_size` numbers (a
//! mono contribution, applied to both channels) or a **map**
//! `#{ left: [...], right: [...] }` with one array per channel. Anything else
//! — including a wrong length — is a hard error naming what to fix. Samples
//! are not clamped here; headroom belongs to the mixer.
//!
//! The engine is the same sandbox as every script here (operation / depth /
//! size caps, no filesystem, no `eval`, no modules) and exposes *no* device
//! functions at all: a signal source has no device access by construction.

use std::collections::BTreeMap;

use rhai::{Array, Dynamic, Engine, Map, AST};
use serde::Deserialize;

use crate::utils::SignalGenerator;

/* -------------------------------------------------------------------------- */
/* The contract                                                                */
/* -------------------------------------------------------------------------- */

/// Upper bound on how many samples a source may be asked to render in one
/// frame — the single source of truth shared by the mixer command's `buffer_size`
/// guard and the Rhai sandbox's array cap, so the two cannot drift apart.
///
/// It must cover every buffer the app legitimately requests of `render`:
/// the largest analysis FFT (1_048_576) plus the live loop's capture-guard
/// padding (2·4096 on the frontend), and the 1-second gap-free loop buffer at
/// the fastest sample rate (384_000 on the QA403). 2^21 clears both with room.
/// A Rhai `render` that builds an array of `ctx.buffer_size` samples used to
/// throw "Size of array/BLOB too large" whenever the FFT was ≥ 65536, because
/// the array cap was fixed at 65536 while these buffers routinely exceed it.
pub const MAX_RENDER_SAMPLES: usize = 1 << 21;

/// Everything a source needs to render one frame.
pub struct RenderContext {
    pub sample_rate: u32,
    pub buffer_size: usize,
    /// Per-frame parameters (frequency ramps, amplitude fades, script knobs…).
    /// Native sources take their configuration as struct fields; this is the
    /// channel for parametrized/scripted sources.
    pub params: BTreeMap<String, f64>,
}

pub trait SignalSource {
    /// Fill `left` / `right` (already sized `ctx.buffer_size`) with this
    /// source's contribution. Additive: the mixer sums all sources.
    fn render(&self, left: &mut [f32], right: &mut [f32], ctx: &RenderContext);
}

/// Which DAC output channel(s) a source *drives* (Traces V2: output routing is
/// declared by the source and decoupled from capture — the inputs are always
/// captured while streaming, whatever is driven). The mixer applies it when
/// summing; a source's `render` fills its contribution on both channels.
///
/// This is the design's `Routing` (design doc §2): `Off` keeps a source
/// defined and rendering but contributes nothing to the sum — distinct from
/// disabling it (which skips the render entirely).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Route {
    Left,
    Right,
    Both,
    Off,
}

impl Route {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "left" | "l" => Some(Self::Left),
            "right" | "r" => Some(Self::Right),
            "both" | "lr" | "l+r" => Some(Self::Both),
            "off" | "none" => Some(Self::Off),
            _ => None,
        }
    }

    pub fn drives_left(self) -> bool {
        matches!(self, Self::Left | Self::Both)
    }

    pub fn drives_right(self) -> bool {
        matches!(self, Self::Right | Self::Both)
    }

    /// The channel tag the frontend's stimulus pipeline understands. `Off`
    /// never reaches the frontend: an Off-routed generator plays no tone at
    /// all (see `Session::acquire`), so no stimulus carries this tag.
    pub fn tag(self) -> &'static str {
        match self {
            Self::Left => "Left",
            Self::Right => "Right",
            Self::Both => "Both",
            Self::Off => "Off",
        }
    }
}

/// Route a mono tone to the stereo DAC buffers per the declared output
/// routing: the driven channel(s) get the tone, the others silence.
pub fn route_stimulus(tone: &[f32], route: Route) -> (Vec<f32>, Vec<f32>) {
    let silence = vec![0.0f32; tone.len()];
    (
        if route.drives_left() { tone.to_vec() } else { silence.clone() },
        if route.drives_right() { tone.to_vec() } else { silence },
    )
}

/* -------------------------------------------------------------------------- */
/* Periodic waveforms                                                          */
/* -------------------------------------------------------------------------- */

/// A periodic waveform (also what a measurement script picks via
/// `set_waveform`); generation delegates to [`SignalGenerator`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Waveform {
    Sine,
    Square,
    Triangle,
    Sawtooth,
}

impl Waveform {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "sine" | "sin" => Some(Self::Sine),
            "square" | "sqr" => Some(Self::Square),
            "triangle" | "tri" => Some(Self::Triangle),
            "sawtooth" | "saw" => Some(Self::Sawtooth),
            _ => None,
        }
    }

    /// Crest factor (peak / RMS) of the ideal waveform, derived analytically:
    /// - sine: RMS of `a·sin` is `a/√2` ⇒ CF = √2;
    /// - square: `|x| = a` everywhere ⇒ RMS = a ⇒ CF = 1;
    /// - triangle and sawtooth: both sweep linearly through `[−a, a]`, so the
    ///   mean square is `∫(a·u)² du / 2` over `u ∈ [−1, 1]` = `a²/3` ⇒ CF = √3.
    pub fn crest_factor(self) -> f64 {
        match self {
            Self::Sine => std::f64::consts::SQRT_2,
            Self::Square => 1.0,
            Self::Triangle | Self::Sawtooth => 3f64.sqrt(),
        }
    }

    /// Render one frame at the sine-referenced amplitude `amp` (module docs):
    /// the RMS target is `amp/√2`, so the waveform is generated at peak
    /// `amp·CF/√2` — every waveform then lands the same RMS. This is THE
    /// boundary that turns a level into a rendered amplitude; both the mixer
    /// path ([`WaveformSource`]) and the measurement-session generator
    /// (`Session::acquire`, scripts' `set_waveform`) go through it. A sine's
    /// factor is `√2/√2` — exactly 1.0 in IEEE arithmetic — so sine output is
    /// bit-identical to the raw generator (pinned by test).
    pub fn generate(self, freq: f32, amp: f32, sr: u32, n: usize) -> Vec<f32> {
        let peak = (amp as f64 * (self.crest_factor() / std::f64::consts::SQRT_2)) as f32;
        match self {
            Self::Sine => SignalGenerator::sine(freq, peak, sr, n),
            Self::Square => SignalGenerator::square(freq, peak, sr, n),
            Self::Triangle => SignalGenerator::triangle(freq, peak, sr, n),
            Self::Sawtooth => SignalGenerator::sawtooth(freq, peak, sr, n),
        }
    }
}

/// Write a mono contribution to both channels (routing is the mixer's job).
fn fill_mono(tone: &[f32], left: &mut [f32], right: &mut [f32]) {
    left.copy_from_slice(tone);
    right.copy_from_slice(tone);
}

/// A periodic tone source (sine / square / triangle / sawtooth). `amplitude`
/// is the sine-referenced level amplitude (module docs): the rendered frame's
/// RMS is `amplitude/√2` whatever the waveform; a sine still peaks at exactly
/// `amplitude`, exactly what the generation code has always taken.
pub struct WaveformSource {
    pub waveform: Waveform,
    pub frequency_hz: f32,
    pub amplitude: f32,
}

impl SignalSource for WaveformSource {
    fn render(&self, left: &mut [f32], right: &mut [f32], ctx: &RenderContext) {
        let tone = self
            .waveform
            .generate(self.frequency_hz, self.amplitude, ctx.sample_rate, ctx.buffer_size);
        fill_mono(&tone, left, right);
    }
}

/* -------------------------------------------------------------------------- */
/* Tone lists (Traces V2 Phase G — design doc §3)                              */
/* -------------------------------------------------------------------------- */

/// One tone of a generator's tone list. `amplitude_vrms` is the tone's output
/// RMS in volts — numerically equal to its sine-referenced peak in buffer
/// units (a sine of buffer peak `p` measures `p` Vrms at the output; module
/// docs / task #48), so no conversion is needed at the mixer boundary.
///
/// `phase_degrees` is the tone's phase at sample 0. It is not cosmetic: the
/// *relative* phases across a list set the crest factor of the sum, hence the
/// headroom the mix needs — N equal tones at zero phase peak `10·log10(N)` dB
/// above well-spread phases (see doc/device-notes.md §8).
#[derive(Clone, Copy, Debug, serde::Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct Tone {
    pub enabled: bool,
    pub frequency_hz: f64,
    pub amplitude_vrms: f64,
    pub phase_degrees: f64,
}

/// A generator holding a **list** of tones, summed per sample (all math in
/// f64, one cast at the end). Each tone's RMS lands at its own
/// `amplitude_vrms`; orthogonal frequencies then sum in power. A single
/// enabled tone at phase 0 renders bit-identical to `SignalGenerator::sine`
/// (pinned by test), so the one-tone list *is* the classic sine generator.
pub struct ToneListSource {
    pub tones: Vec<Tone>,
}

impl SignalSource for ToneListSource {
    fn render(&self, left: &mut [f32], right: &mut [f32], ctx: &RenderContext) {
        let two_pi = 2.0 * std::f64::consts::PI;
        let mut out = vec![0.0f64; ctx.buffer_size];
        for t in self.tones.iter().filter(|t| t.enabled) {
            let w = two_pi * t.frequency_hz / ctx.sample_rate as f64;
            let phi = t.phase_degrees.to_radians();
            for (i, o) in out.iter_mut().enumerate() {
                // Same wrapped-phase accumulation as SignalGenerator::sine
                // (an unwrapped f64 argument loses precision at high
                // frequency × large sample index and shows up as phase noise).
                *o += t.amplitude_vrms * ((w * i as f64) % two_pi + phi).sin();
            }
        }
        let samples: Vec<f32> = out.into_iter().map(|v| v as f32).collect();
        fill_mono(&samples, left, right);
    }
}

/* -------------------------------------------------------------------------- */
/* Multitone / noise / chirp (the single implementation; TS mirror deleted)   */
/* -------------------------------------------------------------------------- */

/// Bin-aligned frequencies (Hz) for the multitone stimulus.
pub const MULTITONE_FREQS: [f64; 9] =
    [50.0, 100.0, 250.0, 500.0, 1000.0, 2500.0, 5000.0, 10000.0, 15000.0];

/// A sum of FFT-bin-aligned tones, Schroeder-phased and RMS-normalized so the
/// whole signal's RMS is the level (`amplitude/√2` in buffer units — module
/// docs). All math in f64, like
/// the original; do not "improve" it, the outputs are pinned by tests on both
/// sides.
pub struct MultitoneSource {
    pub amplitude: f32,
}

impl MultitoneSource {
    fn generate(&self, sr: u32, n: usize) -> Vec<f32> {
        let sr = sr as f64;
        let nyq = sr / 2.0;
        let cycles_list: Vec<f64> = MULTITONE_FREQS
            .iter()
            .filter(|&&f| f < nyq * 0.95)
            .map(|&f| ((f * n as f64) / sr).round().max(1.0))
            .collect();
        let mut out = vec![0.0f64; n];
        let count = if cycles_list.is_empty() { 1.0 } else { cycles_list.len() as f64 };
        for (k, &cycles) in cycles_list.iter().enumerate() {
            // Schroeder phase (φ_k = π·k·(k+1)/N) spreads the tones' energy in
            // time, keeping the crest factor of the sum well below the
            // zero-phase worst case (√N·√2 — see doc/device-notes.md §8).
            let phase = std::f64::consts::PI * k as f64 * (k as f64 + 1.0) / count;
            let winc = 2.0 * std::f64::consts::PI * cycles / n as f64;
            for (i, o) in out.iter_mut().enumerate() {
                *o += (winc * i as f64 + phase).sin();
            }
        }
        let peak = out.iter().fold(0.0f64, |p, &v| p.max(v.abs()));
        let g = if peak > 0.0 { self.amplitude as f64 / peak } else { 0.0 };
        for o in out.iter_mut() {
            *o *= g;
        }
        // Peak-normalizing (above, the historical behaviour) and RMS-targeting
        // are in tension — you cannot have both. Deliberate resolution (Phase
        // G2): `level` is an RMS target for EVERY waveform, so the frame is
        // RMS-normalized to `amplitude/√2` (the RMS a sine at that level has)
        // and the peak lands where the Schroeder phasing puts it. For this
        // 9-tone set the summed crest factor is ≈ 3.4 at real buffer sizes
        // (≈ +7.6 dB over a sine; zero phases would cost √9·√2 = +9.5 dB), so
        // the peak is ≈ 2.4·amplitude. The mixer fits the output range to the
        // actual summed peak per frame, so that headroom is accounted for —
        // whereas the old peak-normalization quietly played the multitone
        // ≈ 7.6 dB *below* its level setting.
        let rms = (out.iter().map(|v| v * v).sum::<f64>() / n as f64).sqrt();
        let k2 = if rms > 0.0 {
            (self.amplitude as f64 * std::f64::consts::FRAC_1_SQRT_2) / rms
        } else {
            0.0
        };
        out.into_iter().map(|v| (v * k2) as f32).collect()
    }
}

impl SignalSource for MultitoneSource {
    fn render(&self, left: &mut [f32], right: &mut [f32], ctx: &RenderContext) {
        fill_mono(&self.generate(ctx.sample_rate, ctx.buffer_size), left, right);
    }
}

/// White noise at a level (port of `makeNoise`, kept in sync).
///
/// Normalized **analytically**, not by measuring the frame: uniform noise on
/// `±A` has mean square `E[x²] = A²/3`, i.e. RMS `A/√3`, so a bound of
/// `A = amplitude·√(3/2)` puts the RMS at the `amplitude/√2` target exactly in
/// expectation. Rescaling each frame to its own measured RMS would instead
/// chase the statistical estimate and make the level jitter frame to frame.
pub struct NoiseSource {
    pub amplitude: f32,
}

impl SignalSource for NoiseSource {
    fn render(&self, left: &mut [f32], right: &mut [f32], ctx: &RenderContext) {
        let bound = (self.amplitude as f64 * 1.5f64.sqrt()) as f32;
        fill_mono(&SignalGenerator::white_noise(bound, ctx.buffer_size), left, right);
    }
}

/// A log (exponential) sweep across the audio band with short raised-cosine
/// end fades — f64 math, 20 Hz to
/// min(20 kHz, 0.45·sr), ~2 ms fades. Pinned by tests on both sides.
pub struct ChirpSource {
    pub amplitude: f32,
}

impl ChirpSource {
    fn generate(&self, sr: u32, n: usize) -> Vec<f32> {
        let sr = sr as f64;
        let amplitude = self.amplitude as f64;
        let f0 = 20.0f64;
        let f1 = 20000.0f64.min(sr * 0.45);
        let total = n as f64 / sr;
        let k = (f1 / f0).ln();
        let mut out = vec![0.0f64; n];
        for (i, o) in out.iter_mut().enumerate() {
            let t = i as f64 / sr;
            let phase =
                (2.0 * std::f64::consts::PI * f0 * total / k) * (((t / total) * k).exp() - 1.0);
            *o = amplitude * phase.sin();
        }
        // Raised-cosine fades (~2 ms) so the loop seam and band edges don't click.
        let fade = ((n as f64 * 0.02).floor() as usize).min((sr * 0.002).floor() as usize);
        for i in 0..fade {
            let w = 0.5 - 0.5 * (std::f64::consts::PI * i as f64 / fade as f64).cos();
            out[i] *= w;
            out[n - 1 - i] *= w;
        }
        // RMS-normalize the frame to the `amplitude/√2` target (module docs):
        // a chirp is nearly sine-like (RMS ≈ peak/√2) but the end fades shave
        // a little energy, so its exact crest factor depends on (sr, n). The
        // frame is deterministic per (sr, n), so this scale is a constant —
        // no frame-to-frame level jitter.
        let rms = (out.iter().map(|v| v * v).sum::<f64>() / n as f64).sqrt();
        let k = if rms > 0.0 { (amplitude * std::f64::consts::FRAC_1_SQRT_2) / rms } else { 0.0 };
        out.into_iter().map(|v| (v * k) as f32).collect()
    }
}

impl SignalSource for ChirpSource {
    fn render(&self, left: &mut [f32], right: &mut [f32], ctx: &RenderContext) {
        fill_mono(&self.generate(ctx.sample_rate, ctx.buffer_size), left, right);
    }
}

/* -------------------------------------------------------------------------- */
/* Rhai source scripts                                                         */
/* -------------------------------------------------------------------------- */

/// Does the AST define the source entry point `fn render(ctx)`?
pub(crate) fn has_render_fn(ast: &AST) -> bool {
    ast.iter_functions().any(|f| f.name == "render" && f.params.len() == 1)
}

/// Build the `ctx` map handed to a script's `render`: sample_rate +
/// buffer_size as ints, every `params` entry as a float.
pub(crate) fn render_ctx_map(ctx: &RenderContext) -> Map {
    let mut m = Map::new();
    m.insert("sample_rate".into(), Dynamic::from_int(ctx.sample_rate as i64));
    m.insert("buffer_size".into(), Dynamic::from_int(ctx.buffer_size as i64));
    for (k, v) in &ctx.params {
        m.insert(k.as_str().into(), Dynamic::from_float(*v));
    }
    m
}

/// Convert a Rhai array of numbers into exactly-`n` f32 samples.
fn samples_from_array(arr: Array, what: &str, n: usize) -> Result<Vec<f32>, String> {
    if arr.len() != n {
        return Err(format!(
            "render() returned {} {what} samples — it must return exactly ctx.buffer_size ({n})",
            arr.len()
        ));
    }
    arr.into_iter()
        .map(|v| {
            if let Ok(i) = v.as_int() {
                Ok(i as f32)
            } else {
                v.as_float()
                    .map(|f| f as f32)
                    .map_err(|t| format!("render() {what} samples must be numbers, got a {t}"))
            }
        })
        .collect()
}

/// Interpret a `render()` return value per the contract: an array (mono, both
/// channels) or `#{ left: [...], right: [...] }`.
pub(crate) fn stereo_from_render_value(
    value: Dynamic,
    n: usize,
) -> Result<(Vec<f32>, Vec<f32>), String> {
    if value.is::<Array>() {
        let mono = samples_from_array(value.cast::<Array>(), "mono", n)?;
        return Ok((mono.clone(), mono));
    }
    if value.is::<Map>() {
        let mut map = value.cast::<Map>();
        let mut chan = |key: &str| -> Result<Vec<f32>, String> {
            let v = map
                .remove(key)
                .ok_or_else(|| format!("render() returned a map without a `{key}` array"))?;
            if !v.is::<Array>() {
                return Err(format!("render(): `{key}` must be an array of samples"));
            }
            samples_from_array(v.cast::<Array>(), key, n)
        };
        let left = chan("left")?;
        let right = chan("right")?;
        return Ok((left, right));
    }
    Err(
        "render() must return an array of samples (mono) or #{ left: [...], right: [...] }"
            .to_string(),
    )
}

/// Call the script's `render(ctx)` (without re-running the top-level
/// statements), returning the raw value or the raw engine error — callers
/// apply their own error formatting (the trace runner keeps its "stopped by
/// user" / operation-limit rewrites this way).
pub(crate) fn call_render_raw(
    engine: &Engine,
    ast: &AST,
    ctx: &RenderContext,
) -> Result<Dynamic, Box<rhai::EvalAltResult>> {
    let mut scope = rhai::Scope::new();
    let options = rhai::CallFnOptions::new().eval_ast(false).rewind_scope(true);
    engine.call_fn_with_options(options, &mut scope, ast, "render", (render_ctx_map(ctx),))
}

/// A signal source written in Rhai: the script defines `fn render(ctx)` (see
/// the module docs for the contract) and the host calls it per frame. The
/// engine is fully sandboxed and exposes no device access at all.
pub struct RhaiSignalSource {
    engine: Engine,
    ast: AST,
}

impl RhaiSignalSource {
    /// Compile a source script. Fails when the script doesn't parse or doesn't
    /// define `fn render(ctx)`.
    pub fn compile(source: &str) -> Result<Self, String> {
        let mut engine = Engine::new();
        crate::script::apply_sandbox(&mut engine);
        let ast = engine.compile(source).map_err(|e| e.to_string())?;
        if !has_render_fn(&ast) {
            return Err(
                "a signal-source script must define `fn render(ctx)` (returning \
                 ctx.buffer_size samples)"
                    .to_string(),
            );
        }
        Ok(Self { engine, ast })
    }

    /// Render one frame, surfacing script errors (the trait's `render`
    /// swallows them into silence — use this when the caller wants the error).
    pub fn try_render(
        &self,
        left: &mut [f32],
        right: &mut [f32],
        ctx: &RenderContext,
    ) -> Result<(), String> {
        let out = call_render_raw(&self.engine, &self.ast, ctx)
            .map_err(|e| format!("render() failed: {e}"))?;
        let (l, r) = stereo_from_render_value(out, ctx.buffer_size)?;
        left.copy_from_slice(&l);
        right.copy_from_slice(&r);
        Ok(())
    }
}

impl SignalSource for RhaiSignalSource {
    fn render(&self, left: &mut [f32], right: &mut [f32], ctx: &RenderContext) {
        if self.try_render(left, right, ctx).is_err() {
            left.fill(0.0);
            right.fill(0.0);
        }
    }
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(sample_rate: u32, buffer_size: usize) -> RenderContext {
        RenderContext { sample_rate, buffer_size, params: BTreeMap::new() }
    }

    fn rendered(src: &dyn SignalSource, c: &RenderContext) -> (Vec<f32>, Vec<f32>) {
        let mut l = vec![0.0f32; c.buffer_size];
        let mut r = vec![0.0f32; c.buffer_size];
        src.render(&mut l, &mut r, c);
        (l, r)
    }

    fn rms(sig: &[f32]) -> f64 {
        (sig.iter().map(|&v| (v as f64) * (v as f64)).sum::<f64>() / sig.len() as f64).sqrt()
    }

    #[test]
    fn waveform_sources_render_the_exact_generator_samples() {
        // Phase E is a refactor: the ported render must produce the same
        // samples as the generation code the acquisition path plays.
        let c = ctx(48_000, 512);
        for wave in [Waveform::Sine, Waveform::Square, Waveform::Triangle, Waveform::Sawtooth] {
            let src = WaveformSource { waveform: wave, frequency_hz: 997.0, amplitude: 0.5 };
            let (l, r) = rendered(&src, &c);
            let expected = wave.generate(997.0, 0.5, 48_000, 512);
            assert_eq!(l, expected, "{wave:?} left");
            assert_eq!(r, expected, "{wave:?} right (mono contribution on both)");
        }
    }

    /// THE regression guard for Phase G2: the sine chain was measured CORRECT
    /// on hardware (task #48 — a sine requested at −12 dBV measured −11.68,
    /// a pure loopback/cal offset). Any change that moves a sine's samples is
    /// a regression, so the normalized path must be bit-identical to the raw
    /// generator for sines.
    #[test]
    fn sine_output_is_bit_identical_to_the_raw_generator() {
        for (freq, amp, sr, n) in
            [(1000.0, 0.5, 48_000, 4800), (996.094f32, 0.25118864, 48_000, 16384), (19999.0, 1.0, 96_000, 512)]
        {
            let normalized = Waveform::Sine.generate(freq, amp, sr, n);
            let raw = SignalGenerator::sine(freq, amp, sr, n);
            assert_eq!(normalized, raw, "sine {freq} Hz / {amp} must not move by a single bit");
        }
    }

    /// The measured crest-factor table (task #48): at equal *peak*, the raw
    /// waveforms land at `20·log10(√2/CF)` relative to a sine — square +3.01,
    /// triangle/sawtooth −1.76 dB, matching the hardware loopback to ±0.01 dB
    /// once the constant cal offset is removed.
    #[test]
    fn raw_generators_reproduce_the_measured_crest_factor_offsets() {
        // 100 Hz → 480 samples/cycle, 10 whole cycles: dense enough that the
        // sampling grid's bias on the ramp waveforms' RMS is ≪ 0.01 dB.
        let (sr, n) = (48_000, 4800);
        let sine_rms = rms(&SignalGenerator::sine(100.0, 0.5, sr, n));
        let case = |sig: Vec<f32>, want_db: f64, what: &str| {
            let got_db = 20.0 * (rms(&sig) / sine_rms).log10();
            assert!((got_db - want_db).abs() < 0.01, "{what}: {got_db:.3} dB vs {want_db:.3}");
        };
        case(SignalGenerator::square(100.0, 0.5, sr, n), 3.0103, "square");
        case(SignalGenerator::triangle(100.0, 0.5, sr, n), -1.7609, "triangle");
        case(SignalGenerator::sawtooth(100.0, 0.5, sr, n), -1.7609, "sawtooth");
    }

    /// The Phase G2 contract: `amplitude` is an RMS target — every waveform
    /// rendered through the normalizing boundary lands at RMS `amplitude/√2`.
    #[test]
    fn every_waveform_lands_the_level_in_rms() {
        let target = 0.5f64 * std::f64::consts::FRAC_1_SQRT_2;
        for wave in [Waveform::Sine, Waveform::Square, Waveform::Triangle, Waveform::Sawtooth] {
            let sig = wave.generate(100.0, 0.5, 48_000, 4800); // 10 whole cycles
            let err_db = 20.0 * (rms(&sig) / target).log10();
            assert!(err_db.abs() < 0.01, "{wave:?}: {err_db:.3} dB off the RMS target");
        }
    }

    /// Reference vector (pinned when the TS mirror still existed): multitone at
    /// sr=48000, n=480, amplitude=0.5, sampled at a few indices (Phase G2:
    /// RMS-normalized — frame RMS = amplitude/√2). Both ports must stay on
    /// these values (f64 math, f32 at the very end).
    const MULTITONE_PIN: [(usize, f64); 6] = [
        (0, 0.29709921065567846),
        (1, 0.39812234745638947),
        (7, 0.39744976946725602),
        (100, 0.082897028750176752),
        (240, 0.36588685934453241),
        (479, 0.0069448423828723776),
    ];

    #[test]
    fn multitone_matches_the_pinned_reference_vector() {
        let c = ctx(48_000, 480);
        let (l, r) = rendered(&MultitoneSource { amplitude: 0.5 }, &c);
        for &(i, v) in &MULTITONE_PIN {
            assert!((l[i] as f64 - v).abs() < 1e-6, "sample {i}: {} vs {v}", l[i]);
        }
        assert_eq!(l, r);
    }

    #[test]
    fn multitone_is_rms_normalized_to_the_level() {
        // The deliberate Phase G2 resolution of peak-vs-RMS: the whole frame's
        // RMS is the level (amplitude/√2); the peak floats with the Schroeder
        // crest factor (≈ 3.2 at this n — well below the zero-phase √9·√2).
        let c = ctx(48_000, 480);
        let (l, _r) = rendered(&MultitoneSource { amplitude: 0.5 }, &c);
        let target = 0.5f64 * std::f64::consts::FRAC_1_SQRT_2;
        assert!((rms(&l) - target).abs() < 1e-6, "rms {} vs {target}", rms(&l));
        let peak = l.iter().fold(0.0f64, |p, &v| p.max(v.abs() as f64));
        let cf = peak / rms(&l);
        assert!(cf > std::f64::consts::SQRT_2 && cf < 3.0 * std::f64::consts::SQRT_2,
            "crest factor {cf} out of the Schroeder ballpark");
    }

    /// Reference vector (pinned when the TS mirror still existed): chirp at
    /// sr=48000, n=480, amplitude=0.5 (Phase G2: RMS-normalized).
    const CHIRP_PIN: [(usize, f64); 6] = [
        (0, 0.0),
        (1, 0.000042853159729629450),
        (7, 0.0091751998219446722),
        (100, 0.29770473618953558),
        (240, -0.35227775173386155),
        (479, 0.0),
    ];

    #[test]
    fn chirp_matches_the_pinned_reference_vector() {
        let c = ctx(48_000, 480);
        let (l, _r) = rendered(&ChirpSource { amplitude: 0.5 }, &c);
        for &(i, v) in &CHIRP_PIN {
            assert!((l[i] as f64 - v).abs() < 1e-6, "sample {i}: {} vs {v}", l[i]);
        }
        // RMS-normalized: the frame's RMS is the level.
        let target = 0.5f64 * std::f64::consts::FRAC_1_SQRT_2;
        assert!((rms(&l) - target).abs() < 1e-6, "rms {} vs {target}", rms(&l));
    }

    #[test]
    fn noise_is_rms_normalized_analytically() {
        // Uniform ±A noise has RMS A/√3; the source sets A = amplitude·√(3/2)
        // so the RMS lands on amplitude/√2 in expectation — the bound (peak)
        // is amplitude·√(3/2), deliberately above `amplitude`.
        let bound = 0.25f64 * 1.5f64.sqrt();
        let c = ctx(48_000, 65_536);
        let (l, _r) = rendered(&NoiseSource { amplitude: 0.25 }, &c);
        assert!(l.iter().all(|v| (v.abs() as f64) <= bound + 1e-7), "noise exceeded its bound");
        assert!(l.iter().any(|v| v.abs() > 0.0), "noise is all zeros");
        let target = 0.25f64 * std::f64::consts::FRAC_1_SQRT_2;
        let err = rms(&l) / target;
        assert!((0.99..1.01).contains(&err), "rms {} vs target {target}", rms(&l));
    }

    /* ---- Tone lists ----------------------------------------------------- */

    #[test]
    fn a_one_tone_list_at_phase_zero_is_the_classic_sine_bit_for_bit() {
        let c = ctx(48_000, 4096);
        let src = ToneListSource {
            tones: vec![Tone {
                enabled: true,
                frequency_hz: 997.0,
                amplitude_vrms: 0.5,
                phase_degrees: 0.0,
            }],
        };
        let (l, _r) = rendered(&src, &c);
        assert_eq!(l, SignalGenerator::sine(997.0, 0.5, 48_000, 4096));
    }

    #[test]
    fn tones_sum_and_disabled_tones_are_skipped() {
        let c = ctx(48_000, 256);
        let t = |f: f64, v: f64, on: bool| Tone {
            enabled: on,
            frequency_hz: f,
            amplitude_vrms: v,
            phase_degrees: 0.0,
        };
        let src = ToneListSource {
            tones: vec![t(1000.0, 0.5, true), t(2500.0, 0.25, true), t(5000.0, 0.9, false)],
        };
        let (l, _r) = rendered(&src, &c);
        let a = SignalGenerator::sine(1000.0, 0.5, 48_000, 256);
        let b = SignalGenerator::sine(2500.0, 0.25, 48_000, 256);
        for i in 0..256 {
            let want = a[i] as f64 + b[i] as f64;
            assert!((l[i] as f64 - want).abs() < 1e-6, "sample {i}");
        }
    }

    #[test]
    fn relative_phase_sets_the_crest_factor_of_the_sum() {
        // Two equal tones, same frequency: in phase the peaks add (peak 2a);
        // in antiphase they cancel. Phase is a level parameter, not cosmetics.
        let c = ctx(48_000, 4800);
        let t = |phase: f64| Tone {
            enabled: true,
            frequency_hz: 1000.0,
            amplitude_vrms: 0.5,
            phase_degrees: phase,
        };
        let peak_of = |tones: Vec<Tone>| {
            let (l, _r) = rendered(&ToneListSource { tones }, &c);
            l.iter().fold(0.0f32, |p, &v| p.max(v.abs()))
        };
        let coherent = peak_of(vec![t(0.0), t(0.0)]);
        let cancelled = peak_of(vec![t(0.0), t(180.0)]);
        assert!((coherent - 1.0).abs() < 1e-3, "in-phase peak {coherent} (expected ~1.0)");
        assert!(cancelled < 1e-6, "antiphase peak {cancelled} (expected ~0)");
    }

    #[test]
    fn a_tone_lands_its_amplitude_vrms_in_rms() {
        // amplitude_vrms is the tone's output RMS: a sine of buffer peak p
        // measures p Vrms at the output (task #48), so buffer RMS = p/√2.
        let c = ctx(48_000, 4800);
        let src = ToneListSource {
            tones: vec![Tone {
                enabled: true,
                frequency_hz: 1000.0,
                amplitude_vrms: 0.5,
                phase_degrees: 90.0,
            }],
        };
        let (l, _r) = rendered(&src, &c);
        let target = 0.5f64 * std::f64::consts::FRAC_1_SQRT_2;
        let err_db = 20.0 * (rms(&l) / target).log10();
        assert!(err_db.abs() < 0.01, "tone RMS off by {err_db:.3} dB");
    }

    #[test]
    fn route_stimulus_drives_the_declared_channels() {
        let tone = vec![1.0f32, -1.0];
        let silence = vec![0.0f32, 0.0];
        let (l, r) = route_stimulus(&tone, Route::Left);
        assert_eq!((l, r), (tone.clone(), silence.clone()));
        let (l, r) = route_stimulus(&tone, Route::Right);
        assert_eq!((l, r), (silence.clone(), tone.clone()));
        let (l, r) = route_stimulus(&tone, Route::Both);
        assert_eq!((l, r), (tone.clone(), tone.clone()));
    }

    /* ---- Rhai render sources ------------------------------------------- */

    #[test]
    fn a_rhai_source_renders_a_mono_array_to_both_channels() {
        let src = RhaiSignalSource::compile(
            r#"
            fn render(ctx) {
                let out = [];
                for i in 0..ctx.buffer_size { out.push(if i % 2 == 0 { 0.5 } else { -0.5 }); }
                out
            }
            "#,
        )
        .unwrap();
        let c = ctx(48_000, 8);
        let mut l = vec![0.0f32; 8];
        let mut r = vec![0.0f32; 8];
        src.try_render(&mut l, &mut r, &c).unwrap();
        assert_eq!(l, vec![0.5, -0.5, 0.5, -0.5, 0.5, -0.5, 0.5, -0.5]);
        assert_eq!(l, r);
    }

    #[test]
    fn a_rhai_source_can_return_a_stereo_map() {
        let src = RhaiSignalSource::compile(
            r#"
            fn render(ctx) {
                let l = [];
                let r = [];
                for i in 0..ctx.buffer_size { l.push(1.0); r.push(-1.0); }
                #{ left: l, right: r }
            }
            "#,
        )
        .unwrap();
        let c = ctx(48_000, 4);
        let mut l = vec![0.0f32; 4];
        let mut r = vec![0.0f32; 4];
        src.try_render(&mut l, &mut r, &c).unwrap();
        assert_eq!(l, vec![1.0; 4]);
        assert_eq!(r, vec![-1.0; 4]);
    }

    #[test]
    fn a_rhai_source_sees_sample_rate_and_params() {
        let src = RhaiSignalSource::compile(
            r#"
            fn render(ctx) {
                let out = [];
                for i in 0..ctx.buffer_size { out.push(ctx.gain * (ctx.sample_rate / 48000)); }
                out
            }
            "#,
        )
        .unwrap();
        let mut c = ctx(48_000, 2);
        c.params.insert("gain".into(), 0.25);
        let mut l = vec![0.0f32; 2];
        let mut r = vec![0.0f32; 2];
        src.try_render(&mut l, &mut r, &c).unwrap();
        assert_eq!(l, vec![0.25, 0.25]);
    }

    #[test]
    fn render_length_and_shape_errors_are_legible() {
        let short = RhaiSignalSource::compile("fn render(ctx) { [0.0, 1.0] }").unwrap();
        let c = ctx(48_000, 4);
        let mut l = vec![0.0f32; 4];
        let mut r = vec![0.0f32; 4];
        let err = short.try_render(&mut l, &mut r, &c).unwrap_err();
        assert!(err.contains("buffer_size"), "got: {err}");

        let wrong = RhaiSignalSource::compile(r#"fn render(ctx) { "nope" }"#).unwrap();
        let err = wrong.try_render(&mut l, &mut r, &c).unwrap_err();
        assert!(err.contains("must return an array"), "got: {err}");

        let half = RhaiSignalSource::compile("fn render(ctx) { #{ left: [0.0, 0.0, 0.0, 0.0] } }")
            .unwrap();
        let err = half.try_render(&mut l, &mut r, &c).unwrap_err();
        assert!(err.contains("`right`"), "got: {err}");

        // The trait's infallible render degrades to silence instead.
        l.fill(9.0);
        r.fill(9.0);
        short.render(&mut l, &mut r, &c);
        assert_eq!(l, vec![0.0; 4]);
        assert_eq!(r, vec![0.0; 4]);
    }

    #[test]
    fn render_array_cap_covers_the_buffers_the_app_requests() {
        // Bug #59: the sandbox array cap (was 65_536) was smaller than the
        // buffers the app asks render() for — the largest FFT (1_048_576) plus
        // the live loop's 2·4096 capture padding, and the 1-second loop buffer at
        // 384_000 — so a render building a ctx.buffer_size array threw "Size of
        // array/BLOB too large". Exercise the CAP with pad (native, O(N)) rather
        // than an interpreted push loop, which is slow at these sizes and is an
        // orthogonal concern (see the shape test below).
        let src = RhaiSignalSource::compile(
            "fn render(ctx) { let out = []; out.pad(ctx.buffer_size, 0.1); out }",
        )
        .unwrap();
        // The realistic maxima (65536 FFT + pad, 131072 FFT + pad, 384 kHz loop)
        // and the ceiling itself must all render; each is ≤ MAX_RENDER_SAMPLES.
        for n in [65_536usize + 8_192, 131_072 + 8_192, 384_000, MAX_RENDER_SAMPLES] {
            let c = ctx(48_000, n);
            let mut l = vec![0.0f32; n];
            let mut r = vec![0.0f32; n];
            src.try_render(&mut l, &mut r, &c)
                .unwrap_or_else(|e| panic!("render at buffer_size {n} failed: {e}"));
        }
        // The cap still exists — one past the ceiling is rejected (a runaway
        // guard, and proof the cap == MAX_RENDER_SAMPLES, matching the mixer
        // command's buffer_size guard which uses the same constant).
        let n = MAX_RENDER_SAMPLES + 1;
        let c = ctx(48_000, n);
        let mut l = vec![0.0f32; n];
        let mut r = vec![0.0f32; n];
        assert!(src.try_render(&mut l, &mut r, &c).is_err());
    }

    #[test]
    fn the_default_square_source_shape_renders() {
        // The actual default "Square-wave source" shape (a push loop) renders at
        // a normal buffer — the array-cap fix is what unblocks it at large FFTs.
        let src = RhaiSignalSource::compile(
            "fn render(ctx) { let out = []; for i in 0..ctx.buffer_size \
             { out.push(if (i % 2) == 0 { 0.1 } else { -0.1 }); } out }",
        )
        .unwrap();
        let n = 4096;
        let c = ctx(48_000, n);
        let mut l = vec![0.0f32; n];
        let mut r = vec![0.0f32; n];
        src.try_render(&mut l, &mut r, &c).unwrap();
        assert_eq!(l.len(), n);
        assert_ne!(l[0], l[1], "a square wave alternates between adjacent samples");
    }

    #[test]
    fn a_source_script_without_render_is_rejected_at_compile() {
        let err = match RhaiSignalSource::compile("print(1);") {
            Err(e) => e,
            Ok(_) => panic!("a script without render must not compile as a source"),
        };
        assert!(err.contains("fn render(ctx)"), "got: {err}");
    }

    #[test]
    fn rhai_sources_stay_sandboxed() {
        // `import` inside render dies at run time: the resolver is a
        // DummyModuleResolver and max_modules is 0, so nothing can load.
        let importing =
            RhaiSignalSource::compile(r#"fn render(ctx) { import "os" as os; [] }"#).unwrap();
        let c = ctx(48_000, 1);
        let mut l = vec![0.0f32; 1];
        let mut r = vec![0.0f32; 1];
        assert!(importing.try_render(&mut l, &mut r, &c).is_err());

        // A top-level import is inert: render calls never evaluate the top
        // level, so nothing is resolved and render still works.
        let inert = RhaiSignalSource::compile(
            r#"import "os" as os; fn render(ctx) { [0.5] }"#,
        )
        .unwrap();
        inert.try_render(&mut l, &mut r, &c).unwrap();
        assert_eq!(l, vec![0.5]);

        // The operation cap terminates a runaway render.
        let looping = RhaiSignalSource::compile("fn render(ctx) { while true {} }").unwrap();
        let err = looping.try_render(&mut l, &mut r, &c).unwrap_err();
        assert!(err.contains("operations"), "got: {err}");
    }
}

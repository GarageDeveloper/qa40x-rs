//! The signal mixer (Traces V2 Phase F).
//!
//! N enabled signal sources → one DAC buffer. Per frame the mixer:
//!
//! 1. asks every **enabled** [`SignalSource`] to `render` into a scratch
//!    buffer;
//! 2. sums the contributions per channel according to each source's
//!    [`Route`] (`Left` / `Right` / `Both` / `Off`);
//! 3. computes the **peak of the summed buffer** and hands the summed pair
//!    back to the caller, which fits the output range (reg 6) from that peak
//!    and streams it via `generate_and_capture`.
//!
//! The mixer — not any individual source — owns the DAC buffer. It never
//! touches the device: the streaming loop (the frontend live loop, reusing
//! the existing plumbing) renders a frame here, fits the range, then plays
//! it. That ordering keeps register I/O strictly *between* captures.
//!
//! # Units
//!
//! The mixer is unit-agnostic — it sums whatever the sources render and
//! reports the peak in the same unit. By convention the frontend feeds
//! amplitudes in **level-volts** (sine-referenced: a sine with peak 1.0
//! measures 0 dBV RMS at the output, so full scale at an output range of
//! R dBV is `10^(R/20)`), picks the range from the summed peak, and only then
//! scales to DAC full-scale. Since Phase G2 every native source renders so
//! its *RMS* matches its level whatever its crest factor (see
//! `crate::sources` — task #48). A clipping sum is *reported* (the peak
//! exceeds the selected range), never silently rescaled — the user decides.
//!
//! # Errors
//!
//! Per-slot, never wholesale: a script that fails to compile is dropped from
//! the mix and named in the result; a script whose `render` fails contributes
//! silence for that frame and is named. The other sources keep playing.

use serde::{Deserialize, Serialize};

use crate::sources::{
    ChirpSource, MultitoneSource, NoiseSource, RenderContext, RhaiSignalSource, Route,
    SignalSource, Tone, ToneListSource, Waveform, WaveformSource,
};

/* -------------------------------------------------------------------------- */
/* Slot descriptors (what the frontend declares)                               */
/* -------------------------------------------------------------------------- */

/// What a mixer slot renders. Amplitudes are linear, in the caller's level
/// unit (see the module docs); a script renders its own samples in that same
/// unit.
#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum SlotSource {
    Waveform { waveform: String, frequency_hz: f32, amplitude: f32 },
    /// A phased tone list (Traces V2 Phase G2, design doc §3): each tone's
    /// `amplitude_vrms` doubles as its level-volt peak (see `crate::sources`).
    Tones { tones: Vec<Tone> },
    Multitone { amplitude: f32 },
    Noise { amplitude: f32 },
    Chirp { amplitude: f32 },
    Script { source: String },
}

/// One declared mixer slot: a signal source plus its routing and enablement.
/// The `id` is the frontend's trace id, echoed back in per-slot errors.
#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct MixerSlotDesc {
    pub id: String,
    pub source: SlotSource,
    pub route: String,
    pub enabled: bool,
}

/// A per-slot problem (compile or render), named so the UI can point at the
/// offending trace instead of failing the whole mix.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct SlotError {
    pub id: String,
    pub error: String,
}

/// One slot's own routed contribution to a mix frame (Traces V2 Phase H:
/// per-source trace previews). Captured during the SAME render pass as the
/// sum — a second render would draw different noise / script samples and lie
/// about what actually played. Channels are post-routing: an undriven channel
/// is silence, exactly what the slot added to the sum there.
#[derive(Clone, Debug, Serialize)]
pub struct SlotFrame {
    pub id: String,
    pub left: Vec<f32>,
    pub right: Vec<f32>,
}

/// Result of starting the gap-free output-only generator (rewrite-v2 M2):
/// what the declared mix summed to, the output range fitted to that peak, and
/// any per-slot errors — the same readouts a stream frame's [`MixStatus`]
/// carries, for the path that has no frames.
///
/// [`MixStatus`]: crate::stream::MixStatus
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct OutputOnlyStatus {
    /// Peak of the summed mix in dBV; `None` when the mix is silent.
    pub sigma_peak_dbv: Option<f32>,
    /// The loop buffer clips the fitted range (clamped + reported, never
    /// rescaled — the same contract as the stream loop).
    pub clipped: bool,
    pub fitted_output_range_dbv: i32,
    pub errors: Vec<SlotError>,
}

/// One rendered mix frame: the summed stereo pair plus the peak of the sum
/// (max |sample| over both channels, in the sources' level unit). `slots`
/// carries each source's own contribution when the caller asked for it
/// (omitted from the wire otherwise — it multiplies the payload by N).
#[derive(Clone, Debug, Serialize)]
pub struct MixFrame {
    pub left: Vec<f32>,
    pub right: Vec<f32>,
    pub peak: f32,
    pub errors: Vec<SlotError>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub slots: Vec<SlotFrame>,
}

/* -------------------------------------------------------------------------- */
/* The mixer                                                                   */
/* -------------------------------------------------------------------------- */

enum Built {
    Native(Box<dyn SignalSource + Send + Sync>),
    /// Keeps the source text so an unchanged script isn't recompiled on the
    /// next `set_slots` (slots are re-declared whenever anything changes).
    Script { src: String, compiled: RhaiSignalSource },
}

struct Slot {
    id: String,
    route: Route,
    enabled: bool,
    built: Built,
}

/// The mixer state: the declared slots plus reusable render buffers (this
/// runs per streamed frame — allocate once, reuse).
#[derive(Default)]
pub struct Mixer {
    slots: Vec<Slot>,
    scratch_l: Vec<f32>,
    scratch_r: Vec<f32>,
}

impl Mixer {
    /// Replace the slot set. Bad slots (unparseable waveform/route, script
    /// compile failure) are dropped from the mix and returned as named
    /// errors; the good ones play. Compiled scripts are reused when the same
    /// slot id declares the same source text.
    pub fn set_slots(&mut self, descs: Vec<MixerSlotDesc>) -> Vec<SlotError> {
        let mut errors = Vec::new();
        let mut old: Vec<Slot> = std::mem::take(&mut self.slots);
        for d in descs {
            let Some(route) = Route::parse(&d.route) else {
                errors.push(SlotError {
                    id: d.id,
                    error: format!("unknown route {:?} (left, right, both, off)", d.route),
                });
                continue;
            };
            let built = match d.source {
                SlotSource::Waveform { waveform, frequency_hz, amplitude } => {
                    match Waveform::parse(&waveform) {
                        Some(w) => Built::Native(Box::new(WaveformSource {
                            waveform: w,
                            frequency_hz,
                            amplitude,
                        })),
                        None => {
                            errors.push(SlotError {
                                id: d.id,
                                error: format!(
                                    "unknown waveform {waveform:?} (sine, square, triangle, \
                                     sawtooth)"
                                ),
                            });
                            continue;
                        }
                    }
                }
                SlotSource::Tones { tones } => {
                    Built::Native(Box::new(ToneListSource { tones }))
                }
                SlotSource::Multitone { amplitude } => {
                    Built::Native(Box::new(MultitoneSource { amplitude }))
                }
                SlotSource::Noise { amplitude } => {
                    Built::Native(Box::new(NoiseSource { amplitude }))
                }
                SlotSource::Chirp { amplitude } => {
                    Built::Native(Box::new(ChirpSource { amplitude }))
                }
                SlotSource::Script { source } => {
                    // Reuse the previous compilation when this slot's text is
                    // unchanged (the common case: something else changed).
                    let reused = old
                        .iter()
                        .position(|s| {
                            s.id == d.id
                                && matches!(&s.built, Built::Script { src, .. } if *src == source)
                        })
                        .map(|i| old.swap_remove(i).built);
                    match reused {
                        Some(built) => built,
                        None => match RhaiSignalSource::compile(&source) {
                            Ok(compiled) => Built::Script { src: source, compiled },
                            Err(e) => {
                                errors.push(SlotError { id: d.id, error: e });
                                continue;
                            }
                        },
                    }
                }
            };
            self.slots.push(Slot { id: d.id, route, enabled: d.enabled, built });
        }
        errors
    }

    /// Render one frame: sum every enabled slot per its routing and report
    /// the peak of the sum. A failing script contributes silence and is named
    /// in `errors` — the mix is never torn down by one bad source.
    pub fn render(&mut self, sample_rate: u32, buffer_size: usize) -> MixFrame {
        self.render_frame(sample_rate, buffer_size, false)
    }

    /// [`render`](Self::render), optionally also capturing each slot's own
    /// routed contribution (`with_slots`) so the UI can show what every
    /// source adds to the mix (Phase H) — from the same render pass, never a
    /// re-render (noise / scripts would differ). Off-routed and disabled
    /// slots contribute nothing and get no slot frame.
    pub fn render_frame(
        &mut self,
        sample_rate: u32,
        buffer_size: usize,
        with_slots: bool,
    ) -> MixFrame {
        let ctx = RenderContext {
            sample_rate,
            buffer_size,
            params: std::collections::BTreeMap::new(),
        };
        let mut left = vec![0.0f32; buffer_size];
        let mut right = vec![0.0f32; buffer_size];
        self.scratch_l.resize(buffer_size, 0.0);
        self.scratch_r.resize(buffer_size, 0.0);
        let mut errors = Vec::new();
        let mut slot_frames = Vec::new();

        for slot in &self.slots {
            if !slot.enabled || slot.route == Route::Off {
                continue;
            }
            match &slot.built {
                Built::Native(src) => src.render(&mut self.scratch_l, &mut self.scratch_r, &ctx),
                Built::Script { compiled, .. } => {
                    if let Err(e) = compiled.try_render(&mut self.scratch_l, &mut self.scratch_r, &ctx)
                    {
                        errors.push(SlotError { id: slot.id.clone(), error: e });
                        continue;
                    }
                }
            }
            if slot.route.drives_left() {
                for (o, s) in left.iter_mut().zip(&self.scratch_l) {
                    *o += *s;
                }
            }
            if slot.route.drives_right() {
                for (o, s) in right.iter_mut().zip(&self.scratch_r) {
                    *o += *s;
                }
            }
            if with_slots {
                slot_frames.push(SlotFrame {
                    id: slot.id.clone(),
                    left: if slot.route.drives_left() {
                        self.scratch_l.clone()
                    } else {
                        vec![0.0; buffer_size]
                    },
                    right: if slot.route.drives_right() {
                        self.scratch_r.clone()
                    } else {
                        vec![0.0; buffer_size]
                    },
                });
            }
        }

        let peak = left
            .iter()
            .chain(right.iter())
            .fold(0.0f32, |p, &v| p.max(v.abs()));
        MixFrame { left, right, peak, errors, slots: slot_frames }
    }

    /// Number of declared slots (diagnostics).
    pub fn len(&self) -> usize {
        self.slots.len()
    }

    pub fn is_empty(&self) -> bool {
        self.slots.is_empty()
    }
}

/* -------------------------------------------------------------------------- */
/* Output-range fit + scale-to-range + clip latch (rewrite-v2 B-2)             */
/*                                                                             */
/* Ports of the frontend mixer.ts range logic, moved here so the backend      */
/* stream loop owns the whole render → fit → scale → play path. The vitest    */
/* invariants for these functions are ported in the test module below —       */
/* mixer.ts must not be deleted before its tests exist here (plan §4.2 B-2).  */
/* -------------------------------------------------------------------------- */

/// Hysteresis width (dB) for range-down moves. Going *up* is a correctness
/// matter (staying low clips the DAC) and happens at the boundary; going
/// *down* is only an optimisation, so it waits until the peak is clearly
/// below the boundary — a level sitting on it can then never oscillate.
pub const RANGE_DOWN_HYSTERESIS_DB: f32 = 1.0;

/// Safety margin (dB) added to the peak when auto-picking the output range:
/// pick the smallest range that contains peak + margin. A range that exactly
/// equals the peak leaves nothing for overshoot — one hot frame (a bin-snap
/// nudging a tone, a source edited mid-run, tones drifting into phase) lands
/// in clipping before the autorange can react. Working value.
pub const OUTPUT_RANGE_MARGIN_DB: f32 = 1.0;

/// How long the clip indicator stays lit after the last clipping frame (ms).
pub const CLIP_HOLD_MS: f64 = 100.0;

/// Smallest of `ranges` (ascending, dBV ceilings) that contains
/// `level_dbv + margin_db`; the largest range when nothing does (the mix is
/// then reported as clipping by the scaler, never silently rescaled).
pub fn pick_smallest_range(level_dbv: f32, ranges: &[i32], margin_db: f32) -> i32 {
    for &r in ranges {
        if level_dbv + margin_db <= r as f32 {
            return r;
        }
    }
    *ranges.last().expect("pick_smallest_range: empty range list")
}

/// Pick the output range for a target level. Restricted to {+8, +18}: these
/// are the ranges proven click-free (the +8 experiment showed no low-DAC
/// relay from peak 0.014 up to 0.4 — only the legitimate input overload at
/// output 0 dBV). The -12 dBV range has an output-path relay that chatters
/// above DAC peak ~0.13 (clicks from ~-30 dBV out); -2 is uncharacterised.
/// Extend downward only after measuring their relay thresholds.
pub fn auto_output_range(level_dbv: f32) -> i32 {
    pick_smallest_range(level_dbv, &[8, 18], OUTPUT_RANGE_MARGIN_DB)
}

/// Pick the output range for the summed peak, with hysteresis around the base
/// policy `pick` (in production that is [`auto_output_range`] — the {+8, +18}
/// restriction and its rationale live there, untouched):
/// - upward moves apply immediately (the current range would clip);
/// - downward moves apply only once the peak sits `hysteresis_db` below the
///   level that would re-select the current range.
/// `current` is the range in effect (`None` = none known → take the base pick).
pub fn fit_range_with_hysteresis(
    peak_dbv: f32,
    current: Option<i32>,
    pick: impl Fn(f32) -> i32,
    hysteresis_db: f32,
) -> i32 {
    let target = pick(peak_dbv);
    let Some(current) = current else { return target };
    if target >= current {
        return target;
    }
    // Downward move: only when even peak+hysteresis still picks the lower range.
    if pick(peak_dbv + hysteresis_db) < current {
        target
    } else {
        current
    }
}

/// Scale a summed mix (level-volts) to DAC full scale for the selected output
/// range, in place. Samples beyond full scale are clamped to ±1 — the DAC
/// would clip there anyway — and reported: the mix is NEVER silently rescaled
/// (relative source levels are the user's choice; report the clip and let
/// them decide). Returns whether any sample clipped.
pub fn scale_mix_to_range(left: &mut [f32], right: &mut [f32], range_dbv: i32) -> bool {
    let scale = 10.0f32.powf(-(range_dbv as f32) / 20.0);
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

/// Holds the UI clip indicator lit for `hold_ms` after the last clip, so a
/// brief clip (a few samples ≈ tens of µs) is visible between screen
/// refreshes. Time is injected (milliseconds on any monotonic clock) so the
/// latch is testable.
pub struct ClipLatch {
    hold_ms: f64,
    last_clip_at: f64,
}

impl Default for ClipLatch {
    fn default() -> Self {
        Self::new(CLIP_HOLD_MS)
    }
}

impl ClipLatch {
    pub fn new(hold_ms: f64) -> Self {
        Self { hold_ms, last_clip_at: f64::NEG_INFINITY }
    }

    /// Record one frame's clip state at time `now` (ms).
    pub fn report(&mut self, clipped: bool, now: f64) {
        if clipped {
            self.last_clip_at = now;
        }
    }

    /// Should the indicator be lit at time `now` (ms)?
    pub fn is_lit(&self, now: f64) -> bool {
        now - self.last_clip_at < self.hold_ms
    }
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    fn sine_slot(id: &str, freq: f32, amp: f32, route: &str) -> MixerSlotDesc {
        MixerSlotDesc {
            id: id.into(),
            source: SlotSource::Waveform {
                waveform: "sine".into(),
                frequency_hz: freq,
                amplitude: amp,
            },
            route: route.into(),
            enabled: true,
        }
    }

    fn sine(freq: f32, amp: f32, sr: u32, n: usize) -> Vec<f32> {
        Waveform::Sine.generate(freq, amp, sr, n)
    }

    #[test]
    fn two_sources_sum_sample_wise() {
        let mut m = Mixer::default();
        assert!(m.set_slots(vec![
            sine_slot("a", 1000.0, 0.5, "both"),
            sine_slot("b", 2500.0, 0.25, "both"),
        ])
        .is_empty());
        let f = m.render(48_000, 256);
        assert!(f.errors.is_empty());
        let a = sine(1000.0, 0.5, 48_000, 256);
        let b = sine(2500.0, 0.25, 48_000, 256);
        for i in 0..256 {
            let want = a[i] + b[i];
            assert!((f.left[i] - want).abs() < 1e-6, "left[{i}]: {} vs {want}", f.left[i]);
            assert_eq!(f.left[i], f.right[i], "both-routed mix must be identical L/R");
        }
    }

    #[test]
    fn routing_places_each_source_on_its_channels() {
        let mut m = Mixer::default();
        assert!(m.set_slots(vec![
            sine_slot("l", 1000.0, 0.5, "left"),
            sine_slot("r", 2000.0, 0.25, "right"),
            sine_slot("mute", 3000.0, 0.9, "off"),
        ])
        .is_empty());
        let f = m.render(48_000, 128);
        let l = sine(1000.0, 0.5, 48_000, 128);
        let r = sine(2000.0, 0.25, 48_000, 128);
        // Left carries only the left-routed source; right only the right-routed
        // one; the Off-routed source contributes nowhere.
        assert_eq!(f.left, l);
        assert_eq!(f.right, r);
    }

    #[test]
    fn a_disabled_slot_is_not_rendered() {
        let mut m = Mixer::default();
        let mut slots = vec![sine_slot("a", 1000.0, 0.5, "both")];
        slots[0].enabled = false;
        assert!(m.set_slots(slots).is_empty());
        let f = m.render(48_000, 64);
        assert!(f.left.iter().all(|&v| v == 0.0));
        assert_eq!(f.peak, 0.0);
    }

    #[test]
    fn the_peak_is_of_the_summed_buffer_not_any_single_source() {
        let mut m = Mixer::default();
        // Two in-phase sines at the same frequency: the sum's peak is the sum
        // of the peaks — larger than either source alone.
        assert!(m.set_slots(vec![
            sine_slot("a", 1000.0, 0.4, "left"),
            sine_slot("b", 1000.0, 0.3, "left"),
        ])
        .is_empty());
        let f = m.render(48_000, 4800); // an exact-cycle window catches the crest
        assert!((f.peak - 0.7).abs() < 1e-3, "sum peak {} (expected ~0.7)", f.peak);
    }

    #[test]
    fn a_tone_list_slot_plays_its_phased_tones() {
        let mut m = Mixer::default();
        let t = |f: f64, v: f64, ph: f64| Tone {
            enabled: true,
            frequency_hz: f,
            amplitude_vrms: v,
            phase_degrees: ph,
        };
        assert!(m
            .set_slots(vec![MixerSlotDesc {
                id: "tones".into(),
                source: SlotSource::Tones { tones: vec![t(1000.0, 0.5, 0.0), t(1000.0, 0.5, 180.0)] },
                route: "left".into(),
                enabled: true,
            }])
            .is_empty());
        // Two equal antiphase tones cancel: the routed channel is silent —
        // per-tone phase reached the render, and routing still applies.
        let f = m.render(48_000, 4800);
        assert!(f.errors.is_empty());
        assert!(f.peak < 1e-6, "antiphase tones must cancel (peak {})", f.peak);
        assert!(f.right.iter().all(|&v| v == 0.0));
    }

    #[test]
    fn a_script_source_mixes_with_native_sources() {
        let mut m = Mixer::default();
        let script = r#"
            fn render(ctx) {
                let out = [];
                for i in 0..ctx.buffer_size { out.push(0.25); }
                out
            }
        "#;
        assert!(m.set_slots(vec![
            sine_slot("gen", 1000.0, 0.5, "left"),
            MixerSlotDesc {
                id: "sq".into(),
                source: SlotSource::Script { source: script.into() },
                route: "both".into(),
                enabled: true,
            },
        ])
        .is_empty());
        let f = m.render(48_000, 32);
        let s = sine(1000.0, 0.5, 48_000, 32);
        for i in 0..32 {
            assert!((f.left[i] - (s[i] + 0.25)).abs() < 1e-6);
            assert!((f.right[i] - 0.25).abs() < 1e-6);
        }
    }

    #[test]
    fn a_bad_slot_is_dropped_and_named_the_rest_play() {
        let mut m = Mixer::default();
        let errs = m.set_slots(vec![
            sine_slot("good", 1000.0, 0.5, "both"),
            MixerSlotDesc {
                id: "broken".into(),
                source: SlotSource::Script { source: "print(1);".into() },
                route: "both".into(),
                enabled: true,
            },
        ]);
        assert_eq!(errs.len(), 1);
        assert_eq!(errs[0].id, "broken");
        assert!(errs[0].error.contains("fn render(ctx)"), "got: {}", errs[0].error);
        assert_eq!(m.len(), 1, "the good slot must survive");
        let f = m.render(48_000, 16);
        assert!(f.errors.is_empty());
        assert_eq!(f.left, sine(1000.0, 0.5, 48_000, 16));
    }

    #[test]
    fn a_failing_render_contributes_silence_and_is_named() {
        let mut m = Mixer::default();
        // Compiles fine, fails at render (wrong length).
        assert!(m.set_slots(vec![
            sine_slot("gen", 1000.0, 0.5, "both"),
            MixerSlotDesc {
                id: "short".into(),
                source: SlotSource::Script { source: "fn render(ctx) { [0.0] }".into() },
                route: "both".into(),
                enabled: true,
            },
        ])
        .is_empty());
        let f = m.render(48_000, 8);
        assert_eq!(f.errors.len(), 1);
        assert_eq!(f.errors[0].id, "short");
        assert_eq!(f.left, sine(1000.0, 0.5, 48_000, 8), "the good source still plays");
    }

    #[test]
    fn the_square_source_example_renders() {
        // Pins the "Square-wave source (plays into the mix)" example from
        // src/script-examples.ts — keep the two in sync.
        let script = r#"
fn render(ctx) {
    let FREQ = 440.0;                     // Hz — change me
    let AMP = 0.1;                        // level-volts (0.1 = -20 dBV)
    let period = ctx.sample_rate / FREQ;  // samples per cycle
    let out = [];
    for i in 0..ctx.buffer_size {
        let phase = (i.to_float() / period) % 1.0;
        out.push(if phase < 0.5 { AMP } else { -AMP });
    }
    out
}
"#;
        let mut m = Mixer::default();
        assert!(m
            .set_slots(vec![MixerSlotDesc {
                id: "sq".into(),
                source: SlotSource::Script { source: script.into() },
                route: "both".into(),
                enabled: true,
            }])
            .is_empty());
        // 48 kHz / 440 Hz ≈ 109.09 samples per cycle: first half-cycle high.
        let f = m.render(48_000, 120);
        assert!(f.errors.is_empty(), "errors: {:?}", f.errors);
        assert!((f.left[0] - 0.1).abs() < 1e-6);
        assert!((f.left[50] - 0.1).abs() < 1e-6, "still high mid-half-cycle");
        assert!((f.left[60] + 0.1).abs() < 1e-6, "low in the second half-cycle");
        assert!((f.peak - 0.1).abs() < 1e-6);
    }

    #[test]
    fn with_slots_reports_each_sources_routed_contribution() {
        let mut m = Mixer::default();
        assert!(m.set_slots(vec![
            sine_slot("a", 1000.0, 0.5, "left"),
            sine_slot("b", 2500.0, 0.25, "both"),
        ])
        .is_empty());
        let f = m.render_frame(48_000, 128, true);
        assert_eq!(f.slots.len(), 2);
        let a = &f.slots[0];
        let b = &f.slots[1];
        assert_eq!(a.id, "a");
        assert_eq!(a.left, sine(1000.0, 0.5, 48_000, 128));
        assert!(a.right.iter().all(|&v| v == 0.0), "undriven channel is silence");
        assert_eq!(b.left, sine(2500.0, 0.25, 48_000, 128));
        assert_eq!(b.left, b.right, "both-routed contribution is identical L/R");
        // The sum equals the sum of the reported contributions, sample-wise —
        // the slot frames come from the same render pass as the mix.
        for i in 0..128 {
            assert!((f.left[i] - (a.left[i] + b.left[i])).abs() < 1e-6);
            assert!((f.right[i] - b.right[i]).abs() < 1e-6);
        }
    }

    #[test]
    fn with_slots_skips_off_and_disabled_slots_and_is_off_by_default() {
        let mut m = Mixer::default();
        let mut slots = vec![
            sine_slot("plays", 1000.0, 0.5, "both"),
            sine_slot("muted", 2000.0, 0.5, "off"),
            sine_slot("disabled", 3000.0, 0.5, "both"),
        ];
        slots[2].enabled = false;
        assert!(m.set_slots(slots).is_empty());
        let f = m.render_frame(48_000, 64, true);
        assert_eq!(f.slots.len(), 1, "only the playing slot gets a frame");
        assert_eq!(f.slots[0].id, "plays");
        // The plain render (and thus the default wire format) carries none.
        assert!(m.render(48_000, 64).slots.is_empty());
    }

    #[test]
    fn an_unknown_route_or_waveform_is_a_named_error() {
        let mut m = Mixer::default();
        let errs = m.set_slots(vec![
            MixerSlotDesc {
                id: "w".into(),
                source: SlotSource::Waveform {
                    waveform: "warble".into(),
                    frequency_hz: 1000.0,
                    amplitude: 0.5,
                },
                route: "both".into(),
                enabled: true,
            },
            {
                let mut s = sine_slot("r", 1000.0, 0.5, "sideways");
                s.enabled = true;
                s
            },
        ]);
        assert_eq!(errs.len(), 2);
        assert!(errs.iter().any(|e| e.id == "w" && e.error.contains("waveform")));
        assert!(errs.iter().any(|e| e.id == "r" && e.error.contains("route")));
        assert!(m.is_empty());
    }
}

/// Ports of the (now-removed) `src/mixer.ts` vitest invariants for the
/// range-fit / scale / clip-latch logic. They guard that the felt behavior of
/// the output range (hysteresis, margin, never-rescale) did not drift when the
/// logic moved to this backend module.
#[cfg(test)]
mod range_tests {
    use super::*;

    /// levelToAmplitude: dBV → linear level-volts (0 dBV ≙ 1.0).
    fn level_to_amplitude(dbv: f32) -> f32 {
        10.0f32.powf(dbv / 20.0)
    }

    /// mixPeakDbv: linear peak → dBV.
    fn mix_peak_dbv(peak: f32) -> f32 {
        20.0 * peak.log10()
    }

    /// A margin-less {+8, +18} base policy, so the hysteresis is exercised in
    /// isolation. The production auto_output_range adds the +1 dB margin via
    /// pick_smallest_range, tested separately below.
    fn pick(dbv: f32) -> i32 {
        if dbv > 8.0 { 18 } else { 8 }
    }

    #[test]
    fn fits_the_peak_of_the_sum_not_one_sources_level() {
        // Two −12 dBV sources in phase sum to ~−6 dBV: still the +8 range…
        let two_low = mix_peak_dbv(2.0 * level_to_amplitude(-12.0));
        assert_eq!(fit_range_with_hysteresis(two_low, Some(8), pick, RANGE_DOWN_HYSTERESIS_DB), 8);
        // …but two +6 dBV sources sum to ~+12 dBV: the +18 range, even though
        // each source alone fits +8.
        let two_high = mix_peak_dbv(2.0 * level_to_amplitude(6.0));
        assert_eq!(fit_range_with_hysteresis(two_high, Some(8), pick, RANGE_DOWN_HYSTERESIS_DB), 18);
    }

    #[test]
    fn moves_up_immediately_staying_low_would_clip() {
        assert_eq!(fit_range_with_hysteresis(8.05, Some(8), pick, RANGE_DOWN_HYSTERESIS_DB), 18);
    }

    #[test]
    fn moves_down_only_once_clearly_below_the_boundary() {
        // Just under the boundary: stay high (only 0.05 dB of headroom on +8).
        assert_eq!(fit_range_with_hysteresis(7.95, Some(18), pick, RANGE_DOWN_HYSTERESIS_DB), 18);
        // Clearly below (more than the hysteresis): drop.
        assert_eq!(fit_range_with_hysteresis(6.9, Some(18), pick, RANGE_DOWN_HYSTERESIS_DB), 8);
    }

    #[test]
    fn a_level_sitting_exactly_on_the_boundary_never_oscillates() {
        // Dither ±0.2 dB around the boundary, from either starting range: the
        // range moves up at most once and then stays put.
        let seq = [8.2f32, 7.8, 8.2, 7.8, 8.0, 8.2];
        let mut range = 8;
        let mut seen = Vec::new();
        for &peak in &seq {
            range = fit_range_with_hysteresis(peak, Some(range), pick, RANGE_DOWN_HYSTERESIS_DB);
            seen.push(range);
        }
        assert_eq!(seen, vec![18, 18, 18, 18, 18, 18]);
        // From the high range, the same dither never drops.
        let mut range = 18;
        for &peak in &seq {
            range = fit_range_with_hysteresis(peak, Some(range), pick, RANGE_DOWN_HYSTERESIS_DB);
        }
        assert_eq!(range, 18);
    }

    #[test]
    fn with_no_known_current_range_takes_the_base_pick() {
        assert_eq!(fit_range_with_hysteresis(-12.0, None, pick, RANGE_DOWN_HYSTERESIS_DB), 8);
        assert_eq!(fit_range_with_hysteresis(10.0, None, pick, RANGE_DOWN_HYSTERESIS_DB), 18);
    }

    #[test]
    fn picks_the_smallest_range_that_contains_level_plus_margin() {
        assert_eq!(OUTPUT_RANGE_MARGIN_DB, 1.0);
        assert_eq!(pick_smallest_range(-12.0, &[8, 18], OUTPUT_RANGE_MARGIN_DB), 8);
        // 7 + 1 dB just fits +8.
        assert_eq!(pick_smallest_range(7.0, &[8, 18], OUTPUT_RANGE_MARGIN_DB), 8);
    }

    #[test]
    fn a_level_within_the_margin_of_a_ranges_ceiling_moves_up_a_range() {
        // 7.5 dBV fits +8 on paper, but 7.5 + 1 does not: no headroom for
        // overshoot on the +8 range → take +18.
        assert_eq!(pick_smallest_range(7.5, &[8, 18], OUTPUT_RANGE_MARGIN_DB), 18);
        // A level exactly at the ceiling especially: nothing left for overshoot.
        assert_eq!(pick_smallest_range(8.0, &[8, 18], OUTPUT_RANGE_MARGIN_DB), 18);
    }

    #[test]
    fn clamps_to_the_largest_range_when_nothing_fits() {
        assert_eq!(pick_smallest_range(17.5, &[8, 18], OUTPUT_RANGE_MARGIN_DB), 18);
        assert_eq!(pick_smallest_range(30.0, &[8, 18], OUTPUT_RANGE_MARGIN_DB), 18);
    }

    #[test]
    fn auto_output_range_is_the_margined_8_18_policy() {
        assert_eq!(auto_output_range(-12.0), 8);
        assert_eq!(auto_output_range(7.0), 8);
        assert_eq!(auto_output_range(7.5), 18);
        assert_eq!(auto_output_range(30.0), 18);
    }

    #[test]
    fn scales_level_volts_to_dbfs_of_the_selected_range() {
        // A 0 dBV peak on the +8 dBV range is −8 dBFS.
        let mut left = vec![1.0f32, -1.0];
        let mut right = vec![0.0f32, 0.5];
        let clipped = scale_mix_to_range(&mut left, &mut right, 8);
        assert!(!clipped);
        let fs = 10.0f32.powf(-8.0 / 20.0);
        assert!((left[0] - fs).abs() < 1e-7);
        assert!((left[1] + fs).abs() < 1e-7);
        assert!((right[1] - 0.5 * fs).abs() < 1e-7);
    }

    #[test]
    fn clamps_and_reports_a_clipping_sum_never_rescales_the_mix() {
        // A +10 dBV peak does not fit the +8 dBV range.
        let over = level_to_amplitude(10.0);
        let mut left = vec![over, over / 2.0, -over];
        let mut right = vec![0.0f32, 0.0, 0.0];
        let clipped = scale_mix_to_range(&mut left, &mut right, 8);
        assert!(clipped);
        assert_eq!(left[0], 1.0); // clamped, not rescaled
        assert_eq!(left[2], -1.0);
        // The in-range sample keeps its true value: no silent global rescale.
        assert!((left[1] - (over / 2.0) * 10.0f32.powf(-8.0 / 20.0)).abs() < 1e-7);
    }

    #[test]
    fn clip_latch_stays_lit_for_the_hold_window_then_clears() {
        let mut latch = ClipLatch::new(100.0);
        assert!(!latch.is_lit(0.0));
        latch.report(true, 1000.0);
        assert!(latch.is_lit(1050.0)); // mid-hold
        assert!(latch.is_lit(1099.0)); // just inside
        assert!(!latch.is_lit(1150.0)); // cleared after ~100 ms
    }

    #[test]
    fn a_reclip_extends_the_hold_clean_frames_never_clear_it_early() {
        let mut latch = ClipLatch::new(100.0);
        latch.report(true, 1000.0);
        latch.report(false, 1050.0); // a clean frame does not reset the latch
        assert!(latch.is_lit(1099.0));
        latch.report(true, 1090.0); // clip again → extended
        assert!(latch.is_lit(1150.0));
        assert!(!latch.is_lit(1200.0));
    }
}

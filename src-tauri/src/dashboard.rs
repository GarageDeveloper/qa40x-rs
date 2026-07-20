//! Dashboard data plane.
//!
//! The backend is the single source of truth for *numbers*: it produces
//! **Traces**. A `Trace` is one logical signal carrying up to two domain frames
//! (time + frequency), produced by a `Source`. The frontend (view plane) only
//! *references* traces by id + domain when arranging graphs; it never owns the
//! samples. These types are the schema both sides agree on — keep them in sync
//! with `src/dashboard/model.ts`.

use serde::{Deserialize, Serialize};

/// Stable identifier for a trace, e.g. "hw-in-left", "ref:1", a uuid.
pub type TraceId = String;

/// A canonical unit. Internally everything is Vrms (or raw samples); other units
/// are pure formatting applied at the view edge. (Conversion helper lands with
/// the canonical-units task; this is the schema only.)
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Unit {
    Vrms,
    Vpk,
    Dbv,
    Dbu,
    Dbfs,
    /// dB relative to a reference in volts.
    Dbr,
    /// Watts into a load (ohms carried alongside where needed).
    Watt,
    Percent,
    /// Dimensionless / already-in-dB spectrum magnitude.
    Db,
}

/// Which input channel an `Source::HwInput` reads.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Chan {
    Left,
    Right,
}

/// Which family a script trace runs as (Traces V2 Phase E — the split):
/// a **source** script produces a signal (plots / `fn render(ctx)`) and has
/// no device access; a **measurement** script drives the instrument through
/// an exclusive session (`acquire()` and the `measure_*` verbs live there,
/// and only there). Mirrors `ScriptRole` in `src/dashboard/model.ts`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum ScriptRole {
    Source,
    /// The permissive default when an old save carries no role (the frontend
    /// migration classifies by content; this is only the parse fallback).
    #[default]
    Measurement,
}

/// Parameters of a runnable script trace: the inline Rhai source the trace
/// runs, plus its name (mirrors `ScriptParams` in `src/dashboard/model.ts`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ScriptParams {
    pub name: String,
    pub source: String,
    #[serde(default)]
    pub role: ScriptRole,
}

/// Where a trace's data comes from. Sources feed the trace pool uniformly.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Source {
    /// Live ADC capture on a channel.
    HwInput { channel: Chan },
    /// The generated DAC output, captured for display.
    Dac { channel: Chan },
    /// A runnable Rhai script trace carrying its inline source (task #39).
    Script { params: ScriptParams },
    /// An imported file (WAV/CSV).
    File { path: String },
    /// A frozen snapshot kept for comparison (a "memory"/reference trace).
    Memory,
}

/// One curve of a swept measurement (e.g. THD of the Left channel vs freq).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct SweepCurve {
    pub label: String,
    pub values: Vec<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase_deg: Option<Vec<f32>>,
}

/// One frame of data, in exactly one domain. Flat + typed-array friendly so it
/// serializes cheaply to the webview.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(tag = "domain", rename_all = "snake_case")]
pub enum Frame {
    /// Time domain: raw samples at `sample_rate`, starting at `t0` seconds.
    /// A "both"-channel trace carries L in `samples` and R in `samples_r`.
    Td {
        sample_rate: f64,
        t0: f64,
        samples: Vec<f32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        samples_r: Option<Vec<f32>>,
    },
    /// Frequency domain: already-binned magnitude (in dB) vs frequency, with
    /// optional phase. Whether the axis is drawn log/linear is the view's job.
    Fd {
        freqs: Vec<f32>,
        mag_db: Vec<f32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        phase_deg: Option<Vec<f32>>,
    },
    /// Swept measurement: one or more labelled curves over shared frequencies
    /// (what a sweep run — or a script's `plot_sweep` — produces).
    Sweep {
        freqs: Vec<f32>,
        curves: Vec<SweepCurve>,
    },
}

impl Frame {
    /// Build a frequency-domain frame from parallel (freqs, mag_db) slices.
    pub fn fd(freqs: Vec<f32>, mag_db: Vec<f32>) -> Frame {
        Frame::Fd {
            freqs,
            mag_db,
            phase_deg: None,
        }
    }

    /// Build a time-domain frame from samples at a sample rate (t0 = 0).
    pub fn td(sample_rate: f64, samples: Vec<f32>) -> Frame {
        Frame::Td {
            sample_rate,
            t0: 0.0,
            samples,
            samples_r: None,
        }
    }

    /// Build a swept-measurement frame from shared freqs + labelled curves.
    pub fn sweep(freqs: Vec<f32>, curves: Vec<SweepCurve>) -> Frame {
        Frame::Sweep { freqs, curves }
    }
}

/// The unit of data on the dashboard: one logical signal with up to two domain
/// frames, produced by a source. The frontend renders `td`/`fd` into graph slots.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Trace {
    pub id: TraceId,
    pub label: String,
    pub source: Source,
    /// Time-domain frame, present iff this trace exposes a scope view.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub td: Option<Frame>,
    /// Frequency-domain frame, present iff this trace exposes a spectrum view.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fd: Option<Frame>,
    /// Canonical unit of the samples / magnitudes.
    pub unit: Unit,
    /// Bumped on every new capture so the frontend can dedup/animate.
    pub seq: u64,
}

impl Trace {
    /// A live hardware-input trace carrying a scope (td) + spectrum (fd) view.
    pub fn hw_input(id: impl Into<TraceId>, channel: Chan, seq: u64) -> Trace {
        Trace {
            id: id.into(),
            label: match channel {
                Chan::Left => "HW Input L".into(),
                Chan::Right => "HW Input R".into(),
            },
            source: Source::HwInput { channel },
            td: None,
            fd: None,
            unit: Unit::Dbfs,
            seq,
        }
    }
}

/* -------------------------------------------------------------------------- */
/* Per-frame measurements (dashboard measure chips — moved from measure.ts)    */
/* -------------------------------------------------------------------------- */

/// The loudest spectrum bin of an fd frame.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct FdPeak {
    pub index: usize,
    pub freq: f32,
    pub mag_db: f32,
}

/// What the measure chips read for one trace: linear td metrics + the fd
/// peak bin, computed once per frame (the frontend caches by trace seq and
/// only formats).
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct FrameMeasures {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub td: Option<crate::measurements::levels::BufferMetrics>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fd: Option<FdPeak>,
}

/// Measure a trace's frames for the per-graph readout strip. The td metrics
/// cover the primary channel (`samples`), matching the old frontend chips.
pub fn measure_frames(td: &Option<Frame>, fd: &Option<Frame>) -> FrameMeasures {
    let td_metrics = match td {
        Some(Frame::Td { samples, .. }) => {
            let f64s: Vec<f64> = samples.iter().map(|&v| v as f64).collect();
            Some(crate::measurements::levels::analyze_buffer(&f64s))
        }
        _ => None,
    };
    let fd_peak = match fd {
        Some(Frame::Fd { freqs, mag_db, .. }) => {
            let f64s: Vec<f64> = mag_db.iter().map(|&v| v as f64).collect();
            crate::measurements::spectral::peak_bin(&f64s).map(|i| FdPeak {
                index: i,
                freq: freqs.get(i).copied().unwrap_or(0.0),
                mag_db: mag_db[i],
            })
        }
        _ => None,
    };
    FrameMeasures { td: td_metrics, fd: fd_peak }
}

/* -------------------------------------------------------------------------- */
/* Transform chain (Traces V2 Phase C — moved from src/dashboard/transform.ts) */
/* -------------------------------------------------------------------------- */

/// The frequency weighting a `TransformStep::Weighting` applies (the chain
/// only offers the fixed curves; the USER curve is a display-side feature).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum WeightingStepMode {
    A,
    C,
    Riaa,
}

impl From<WeightingStepMode> for crate::measurements::weighting::WeightingMode {
    fn from(m: WeightingStepMode) -> Self {
        use crate::measurements::weighting::WeightingMode as W;
        match m {
            WeightingStepMode::A => W::A,
            WeightingStepMode::C => W::C,
            WeightingStepMode::Riaa => W::Riaa,
        }
    }
}

/// One step of a transform chain (mirrors `TransformStep` in model.ts).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum TransformStep {
    /// A / C / RIAA per-bin dB gain on the spectrum.
    Weighting { mode: WeightingStepMode },
    /// RBJ biquad notch — filters the scope samples (td) and shapes the
    /// spectrum (fd) by the filter's response.
    Notch {
        freq: f64,
        #[serde(default)]
        q: Option<f64>,
    },
    /// Subtract a reference trace's spectrum (dB division), interpolated onto
    /// the input's bins. The frontend resolves `ref` to a spectrum and passes
    /// it in the chain call's `refs` map.
    Deconvolve { r#ref: TraceId },
    /// A Rhai transformer, run in the script sandbox on both frames.
    Script { source: String },
}

/// What a transform chain returns: the endpoint's frames, plus the first
/// script error if one fired (the frames then carry the chain WITHOUT any
/// script step applied — same as the old frontend overlay, which dropped all
/// script effects on error).
#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct TransformChainResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub td: Option<Frame>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fd: Option<Frame>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub script_error: Option<String>,
}

/// The sample rate a spectrum-only transform can assume: the input's td rate
/// when present, else twice the top bin (Nyquist), else 48 kHz.
fn infer_sample_rate(td: &Option<Frame>, fd: &Option<Frame>) -> f64 {
    if let Some(Frame::Td { sample_rate, .. }) = td {
        return *sample_rate;
    }
    if let Some(Frame::Fd { freqs, .. }) = fd {
        if let Some(top) = freqs.last() {
            return *top as f64 * 2.0;
        }
    }
    48000.0
}

/// Run a biquad over an f32 sample block (math in f64, like the JS original).
fn filter_f32(samples: &[f32], c: &crate::measurements::filters::BiquadCoeffs) -> Vec<f32> {
    let f64s: Vec<f64> = samples.iter().map(|&v| v as f64).collect();
    crate::measurements::filters::biquad_filter(&f64s, c)
        .into_iter()
        .map(|v| v as f32)
        .collect()
}

/// Apply a transform chain to an input trace's frames, in order — the single
/// authoritative implementation of what used to be split between the pure TS
/// chain (`applyTransformSteps`) and the async script overlay in main.ts.
///
/// Steps act on whichever frames exist; a deconvolve step whose reference is
/// missing from `refs` (or has no spectrum) leaves the spectrum unchanged.
/// Script steps run fd first then td (the overlay's order); the first script
/// error reverts BOTH frames to their pre-script state, skips the remaining
/// script steps, and is reported in `script_error` — pure steps still apply.
/// Sweep frames never enter the chain (the frontend passes them through).
pub fn apply_transform_chain(
    mut td: Option<Frame>,
    mut fd: Option<Frame>,
    steps: &[TransformStep],
    refs: &std::collections::HashMap<TraceId, Frame>,
) -> TransformChainResult {
    use crate::measurements::filters::{biquad_gain_db, notch_coeffs, DEFAULT_NOTCH_Q};
    use crate::measurements::spectral::transfer_gain_db;
    use crate::measurements::weighting::weighting_gain_db;

    let mut script_error: Option<String> = None;
    let mut pre_script: Option<(Option<Frame>, Option<Frame>)> = None;

    for step in steps {
        match step {
            TransformStep::Weighting { mode } => {
                if let Some(Frame::Fd { freqs, mag_db, .. }) = fd.as_mut() {
                    for (m, &f) in mag_db.iter_mut().zip(freqs.iter()) {
                        *m += weighting_gain_db((*mode).into(), f as f64, None) as f32;
                    }
                }
            }
            TransformStep::Notch { freq, q } => {
                let q = q.unwrap_or(DEFAULT_NOTCH_Q);
                if let Some(Frame::Td { sample_rate, samples, samples_r, .. }) = td.as_mut() {
                    let c = notch_coeffs(*freq, q, *sample_rate);
                    *samples = filter_f32(samples, &c);
                    if let Some(r) = samples_r.as_mut() {
                        *r = filter_f32(r, &c);
                    }
                }
                if fd.is_some() {
                    let fs = infer_sample_rate(&td, &fd);
                    let c = notch_coeffs(*freq, q, fs);
                    if let Some(Frame::Fd { freqs, mag_db, .. }) = fd.as_mut() {
                        for (m, &f) in mag_db.iter_mut().zip(freqs.iter()) {
                            *m += biquad_gain_db(&c, f as f64, fs) as f32;
                        }
                    }
                }
            }
            TransformStep::Deconvolve { r#ref } => {
                let reference = match refs.get(r#ref) {
                    Some(Frame::Fd { freqs, mag_db, .. }) if !freqs.is_empty() => {
                        Some((freqs, mag_db))
                    }
                    _ => None,
                };
                if let (Some((rf, rm)), Some(Frame::Fd { freqs, mag_db, .. })) =
                    (reference, fd.as_mut())
                {
                    let f64s = |v: &[f32]| v.iter().map(|&x| x as f64).collect::<Vec<f64>>();
                    *mag_db =
                        transfer_gain_db(&f64s(freqs), &f64s(mag_db), &f64s(rf), &f64s(rm))
                            .into_iter()
                            .map(|v| v as f32)
                            .collect();
                }
            }
            TransformStep::Script { source } => {
                if source.trim().is_empty() || script_error.is_some() {
                    continue;
                }
                if pre_script.is_none() {
                    pre_script = Some((td.clone(), fd.clone()));
                }
                // fd first, then td — the old overlay's order.
                for frame in [&mut fd, &mut td] {
                    let Some(f) = frame.as_ref() else { continue };
                    match crate::script::run_transform(source, f) {
                        Ok(out) => *frame = Some(out),
                        Err(e) => {
                            script_error = Some(e);
                            break;
                        }
                    }
                }
                if script_error.is_some() {
                    let (t, f) = pre_script.take().expect("snapshot taken above");
                    td = t;
                    fd = f;
                }
            }
        }
    }

    TransformChainResult { td, fd, script_error }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trace_round_trips_through_json() {
        let t = Trace {
            id: "hw-in-left".into(),
            label: "HW Input L".into(),
            source: Source::HwInput { channel: Chan::Left },
            td: Some(Frame::td(48000.0, vec![0.0, 0.5, -0.5])),
            fd: Some(Frame::fd(vec![100.0, 1000.0], vec![-20.0, -3.0])),
            unit: Unit::Dbfs,
            seq: 7,
        };
        let json = serde_json::to_string(&t).unwrap();
        let back: Trace = serde_json::from_str(&json).unwrap();
        assert_eq!(t, back);
    }

    #[test]
    fn frame_tag_is_the_domain() {
        let fd = Frame::fd(vec![1.0], vec![-1.0]);
        let json = serde_json::to_string(&fd).unwrap();
        assert!(json.contains("\"domain\":\"fd\""), "got {json}");
        // phase omitted when None
        assert!(!json.contains("phase_deg"), "got {json}");

        let td = Frame::td(48000.0, vec![0.0]);
        let json = serde_json::to_string(&td).unwrap();
        assert!(json.contains("\"domain\":\"td\""), "got {json}");

        let sw = Frame::sweep(
            vec![20.0, 1000.0],
            vec![SweepCurve { label: "L".into(), values: vec![-90.0, -100.0], phase_deg: None }],
        );
        let json = serde_json::to_string(&sw).unwrap();
        assert!(json.contains("\"domain\":\"sweep\""), "got {json}");
        assert!(json.contains("\"label\":\"L\""), "got {json}");
        assert!(!json.contains("phase_deg"), "got {json}");
    }

    #[test]
    fn source_is_externally_tagged_by_kind() {
        let s = Source::HwInput { channel: Chan::Right };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"kind\":\"hw_input\""), "got {json}");
        assert!(json.contains("\"channel\":\"right\""), "got {json}");
    }

    /* ---------------- transform chain (ported from transform.test.ts) ---- */

    use std::collections::HashMap;

    fn sine(f: f64, fs: f64, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| (2.0 * std::f64::consts::PI * f * i as f64 / fs).sin() as f32)
            .collect()
    }

    fn rms(s: &[f32]) -> f64 {
        (s.iter().map(|&x| (x as f64) * (x as f64)).sum::<f64>() / s.len() as f64).sqrt()
    }

    fn input_frames() -> (Option<Frame>, Option<Frame>) {
        (
            Some(Frame::td(48000.0, sine(60.0, 48000.0, 4800))),
            Some(Frame::fd(vec![60.0, 1000.0, 10000.0], vec![-20.0, -3.0, -40.0])),
        )
    }

    #[test]
    fn step_serde_matches_the_frontend() {
        let steps: Vec<TransformStep> = serde_json::from_str(
            r#"[
                {"type":"weighting","mode":"a"},
                {"type":"notch","freq":60},
                {"type":"deconvolve","ref":"hw-out-left"},
                {"type":"script","source":"mag_db[0] += 1.0;"}
            ]"#,
        )
        .unwrap();
        assert_eq!(steps[0], TransformStep::Weighting { mode: WeightingStepMode::A });
        assert_eq!(steps[1], TransformStep::Notch { freq: 60.0, q: None });
        assert_eq!(steps[2], TransformStep::Deconvolve { r#ref: "hw-out-left".into() });
        assert!(matches!(&steps[3], TransformStep::Script { source } if source.contains("mag_db")));
        // riaa mode round-trips lowercase.
        let json = serde_json::to_string(&TransformStep::Weighting {
            mode: WeightingStepMode::Riaa,
        })
        .unwrap();
        assert!(json.contains("\"riaa\""), "got {json}");
    }

    #[test]
    fn weighting_shifts_the_spectrum_only() {
        use crate::measurements::weighting::{weighting_gain_db, WeightingMode};
        let (td, fd) = input_frames();
        let out = apply_transform_chain(
            td.clone(),
            fd,
            &[TransformStep::Weighting { mode: WeightingStepMode::A }],
            &HashMap::new(),
        );
        let Some(Frame::Fd { freqs, mag_db, .. }) = out.fd else { panic!("fd missing") };
        let expect = [-20.0, -3.0, -40.0];
        for i in 0..mag_db.len() {
            let gain = weighting_gain_db(WeightingMode::A, freqs[i] as f64, None);
            assert!((mag_db[i] as f64 - (expect[i] + gain)).abs() < 1e-4, "bin {i}");
        }
        assert_eq!(out.td, td); // scope untouched
        assert!(out.script_error.is_none());
    }

    #[test]
    fn notch_filters_the_scope_and_shapes_the_spectrum() {
        let (td, fd) = input_frames();
        let out = apply_transform_chain(
            td,
            fd,
            &[TransformStep::Notch { freq: 60.0, q: None }],
            &HashMap::new(),
        );
        let Some(Frame::Td { samples, .. }) = &out.td else { panic!("td missing") };
        assert!(rms(&samples[2400..]) < rms(&samples[..2400]), "60 Hz must decay");
        let Some(Frame::Fd { mag_db, .. }) = &out.fd else { panic!("fd missing") };
        assert!(mag_db[0] < -60.0, "60 Hz bin crushed, got {}", mag_db[0]);
        assert!((mag_db[1] - -3.0).abs() < 0.1, "1 kHz intact, got {}", mag_db[1]);
    }

    #[test]
    fn notch_filters_the_right_channel_too() {
        // A 60 Hz Q=8 notch settles slowly (τ ≈ Q/(π·f0) ≈ 42 ms) — use a
        // full second and judge the second half, like the TS original.
        let td = Some(Frame::Td {
            sample_rate: 48000.0,
            t0: 0.0,
            samples: sine(1000.0, 48000.0, 48000),
            samples_r: Some(sine(60.0, 48000.0, 48000)),
        });
        let out = apply_transform_chain(
            td,
            None,
            &[TransformStep::Notch { freq: 60.0, q: None }],
            &HashMap::new(),
        );
        let Some(Frame::Td { samples, samples_r, .. }) = &out.td else { panic!() };
        assert!(rms(&samples[24000..]) > 0.69, "1 kHz L passes");
        let r = samples_r.as_ref().expect("R kept");
        assert!(rms(&r[24000..]) < 0.02, "60 Hz R notched, rms {}", rms(&r[24000..]));
    }

    #[test]
    fn deconvolve_is_flat_against_itself_and_inert_without_a_reference() {
        let (td, fd) = input_frames();
        let mut refs = HashMap::new();
        refs.insert("ref-x".to_string(), fd.clone().unwrap());
        let out = apply_transform_chain(
            td.clone(),
            fd.clone(),
            &[TransformStep::Deconvolve { r#ref: "ref-x".into() }],
            &refs,
        );
        let Some(Frame::Fd { mag_db, .. }) = &out.fd else { panic!() };
        assert!(mag_db.iter().all(|v| v.abs() < 1e-6), "flat vs itself: {mag_db:?}");

        let out = apply_transform_chain(
            td,
            fd.clone(),
            &[TransformStep::Deconvolve { r#ref: "nope".into() }],
            &HashMap::new(),
        );
        assert_eq!(out.fd, fd, "missing reference leaves the spectrum unchanged");
    }

    #[test]
    fn script_step_edits_frames_and_an_error_reverts_them() {
        let (_, fd) = input_frames();
        // A working spectrum script shifts the first bin (fd-only trace: a
        // script that references mag_db errors on a td frame — see below).
        let out = apply_transform_chain(
            None,
            fd.clone(),
            &[TransformStep::Script { source: "mag_db[0] += 1.0;".into() }],
            &HashMap::new(),
        );
        assert!(out.script_error.is_none(), "err: {:?}", out.script_error);
        let Some(Frame::Fd { mag_db, .. }) = &out.fd else { panic!() };
        assert!((mag_db[0] - -19.0).abs() < 1e-4, "got {}", mag_db[0]);

        // A broken script reports the error and reverts the frames to the
        // pre-script state — pure steps before it still apply.
        let out = apply_transform_chain(
            None,
            fd.clone(),
            &[
                TransformStep::Weighting { mode: WeightingStepMode::A },
                TransformStep::Script { source: "mag_db.push(-1.0);".into() },
            ],
            &HashMap::new(),
        );
        assert!(out.script_error.is_some());
        let Some(Frame::Fd { mag_db, .. }) = &out.fd else { panic!() };
        // Weighted (pure step) but not script-shifted; A(1 kHz) = 0 dB.
        assert!((mag_db[1] - -3.0).abs() < 1e-4, "got {}", mag_db[1]);

        // Both-domain quirk (same as the old overlay): a script that only
        // knows the spectrum errors on the td pass, so NOTHING lands.
        let (td, fd) = input_frames();
        let out = apply_transform_chain(
            td,
            fd.clone(),
            &[TransformStep::Script { source: "mag_db[0] += 1.0;".into() }],
            &HashMap::new(),
        );
        assert!(out.script_error.is_some());
        assert_eq!(out.fd, fd, "fd effect reverted with the td failure");

        // Blank scripts are skipped outright.
        let out = apply_transform_chain(
            None,
            fd.clone(),
            &[TransformStep::Script { source: "   ".into() }],
            &HashMap::new(),
        );
        assert!(out.script_error.is_none());
        assert_eq!(out.fd, fd);
    }

    #[test]
    fn measure_frames_covers_td_metrics_and_the_fd_peak() {
        // The dashboard.test.ts reference frame: td [0,1,-1,0.5], fd [-40,-3].
        let td = Some(Frame::td(48000.0, vec![0.0, 1.0, -1.0, 0.5]));
        let fd = Some(Frame::fd(vec![100.0, 1000.0], vec![-40.0, -3.0]));
        let m = measure_frames(&td, &fd);
        let t = m.td.expect("td metrics");
        assert!((t.peak - 1.0).abs() < 1e-12); // -> "0.0 dBFS"
        assert!((t.rms - 0.75).abs() < 1e-12); // sqrt(2.25/4)
        assert!((t.dc_offset - 0.125).abs() < 1e-12);
        let p = m.fd.expect("fd peak");
        assert_eq!((p.index, p.freq, p.mag_db), (1, 1000.0, -3.0));

        // Missing frames measure to nothing; an empty spectrum has no peak.
        let none = measure_frames(&None, &Some(Frame::fd(vec![], vec![])));
        assert!(none.td.is_none() && none.fd.is_none());
    }

    #[test]
    fn td_frame_with_samples_r_round_trips_and_defaults() {
        // Old payloads without samples_r still parse (serde default).
        let f: Frame =
            serde_json::from_str(r#"{"domain":"td","sample_rate":48000,"t0":0,"samples":[0.5]}"#)
                .unwrap();
        assert!(matches!(f, Frame::Td { samples_r: None, .. }));
        // And the field is omitted when absent.
        assert!(!serde_json::to_string(&Frame::td(48000.0, vec![0.0])).unwrap().contains("samples_r"));
    }
}

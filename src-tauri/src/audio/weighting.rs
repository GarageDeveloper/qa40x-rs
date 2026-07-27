//! Frequency weighting (A / C) and level metrics.
//!
//! A-weighting (IEC 61672) approximates the ear's sensitivity for noise
//! measurements: it strongly attenuates lows and referenced to 0 dB at 1 kHz.
//! C-weighting is nearly flat in the mid-band. Weighted RMS is computed in the
//! frequency domain via Parseval (rectangular window is exact for total power;
//! for broadband noise or a tone the weighted integral is accurate), so it is
//! sample-rate agnostic and needs no per-rate filter design.

use realfft::RealFftPlanner;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Weighting {
    /// Unweighted (flat / "Z").
    Z,
    A,
    C,
}

/// Linear weighting gain at frequency `f`, normalized to 0 dB at 1 kHz.
/// The curves themselves live in `measurements::weighting` (single
/// implementation, shared with the dashboard transform chain).
pub fn weight_gain(w: Weighting, f: f32) -> f32 {
    use crate::measurements::weighting::{weighting_gain_linear, WeightingMode};
    let mode = match w {
        Weighting::Z => WeightingMode::Z,
        Weighting::A => WeightingMode::A,
        Weighting::C => WeightingMode::C,
    };
    weighting_gain_linear(mode, f as f64, None) as f32
}

/// Weighted RMS of a full-scale-referenced signal (result in the same units as
/// the samples, i.e. 0 dBFS = 1.0). Uses Parseval over the one-sided spectrum.
pub fn weighted_rms(signal: &[f32], sample_rate: u32, w: Weighting) -> f32 {
    let n = signal.len();
    if n < 4 {
        return 0.0;
    }
    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(n);
    let mut buf = signal.to_vec();
    let mut spec = fft.make_output_vec();
    fft.process(&mut buf, &mut spec).unwrap();

    let bin_hz = sample_rate as f32 / n as f32;
    let n_bins = spec.len(); // n/2 + 1
    let mut power = 0.0f64;
    for (k, c) in spec.iter().enumerate() {
        // Skip DC (k=0): no meaningful weighted level, and it holds any offset.
        if k == 0 {
            continue;
        }
        let f = k as f32 * bin_hz;
        let g = weight_gain(w, f);
        // One-sided: interior bins count twice; Nyquist (even n) once.
        let two = if k == n_bins - 1 && n % 2 == 0 { 1.0 } else { 2.0 };
        let mag2 = (c.norm() as f64) * (c.norm() as f64);
        power += two * mag2 * (g as f64) * (g as f64);
    }
    // Parseval: sum|X|^2 over full spectrum = N * sum(x^2); RMS^2 = power/N^2.
    ((power / (n as f64 * n as f64)).sqrt()) as f32
}

/// A captured sample this close to full scale (1.0) is presumed clipped —
/// the ADC rail, not genuine signal content (issue #29 review finding #4:
/// an unflagged saturated capture reads as a normal, if loud, measurement —
/// e.g. a 0 dBV input range fed a 4 Vrms DUT output shows `peak_dbfs` ≈ 0
/// and a plausible-looking Vrms that is actually the clipped rail, not the
/// true level).
pub const CLIP_THRESHOLD: f32 = 0.999;

/// Digital (full-scale-referenced) level metrics for a captured block.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LevelMetrics {
    pub rms_dbfs: f32,
    pub peak_dbfs: f32,
    pub rms_a_dbfs: f32,
    pub rms_c_dbfs: f32,
    /// True when any sample sits at/above `CLIP_THRESHOLD` — the reading is
    /// the ADC rail, not the DUT's actual level.
    pub clipped: bool,
}

fn to_dbfs(x: f32) -> f32 {
    if x > 0.0 {
        (20.0 * x.log10()).max(-200.0)
    } else {
        -200.0
    }
}

/// Compute unweighted / A / C RMS and peak of a full-scale signal, in dBFS.
pub fn analyze_levels(signal: &[f32], sample_rate: u32) -> LevelMetrics {
    let rms = {
        let s: f64 = signal.iter().map(|v| (*v as f64) * (*v as f64)).sum();
        (s / signal.len().max(1) as f64).sqrt() as f32
    };
    let peak = signal.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    LevelMetrics {
        rms_dbfs: to_dbfs(rms),
        peak_dbfs: to_dbfs(peak),
        rms_a_dbfs: to_dbfs(weighted_rms(signal, sample_rate, Weighting::A)),
        rms_c_dbfs: to_dbfs(weighted_rms(signal, sample_rate, Weighting::C)),
        clipped: signal.iter().any(|v| v.abs() >= CLIP_THRESHOLD),
    }
}

/// Full level measurement including absolute voltage (filled by the device
/// layer from calibration; volts fields are 0 / `calibrated=false` otherwise).
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct LevelResult {
    pub rms_dbfs: f32,
    pub peak_dbfs: f32,
    pub rms_a_dbfs: f32,
    pub rms_c_dbfs: f32,
    /// Absolute level of the (unweighted) RMS, via calibration.
    pub rms_vrms: f32,
    pub rms_dbv: f32,
    pub rms_dbu: f32,
    /// A-weighted absolute noise level.
    pub rms_a_dbv: f32,
    pub calibrated: bool,
    /// The capture saturated the ADC (issue #29 review finding #4) — every
    /// other field in this result is the clipped rail, not the true level.
    pub clipped: bool,
    /// The stimulus frequency ACTUALLY played, after the Nyquist-alias
    /// clamp (issue #29 review finding #1) — 0 when `generate` was false.
    pub stimulus_freq_hz: f32,
}

/// Project digital level metrics onto absolute voltage via the input's
/// linear volts-per-digital-RMS factor. Pulled out of
/// `QA40xDevice::measure_levels` (issue #29 review finding #3b) so the
/// dBFS→Vrms/dBV/dBu arithmetic is unit-testable without a device/USB
/// transaction. `stimulus_freq_hz` is threaded through unchanged — this
/// function does no clamping, the caller (device.rs) already did.
pub fn project_levels(
    m: &LevelMetrics,
    factor: f32,
    calibrated: bool,
    stimulus_freq_hz: f32,
) -> LevelResult {
    let lin = |dbfs: f32| 10.0f32.powf(dbfs / 20.0);
    let v_rms = lin(m.rms_dbfs) * factor;
    let v_a = lin(m.rms_a_dbfs) * factor;
    let v_to_dbv = |v: f32| if v > 0.0 { 20.0 * v.log10() } else { -200.0 };
    LevelResult {
        rms_dbfs: m.rms_dbfs,
        peak_dbfs: m.peak_dbfs,
        rms_a_dbfs: m.rms_a_dbfs,
        rms_c_dbfs: m.rms_c_dbfs,
        rms_vrms: v_rms,
        rms_dbv: v_to_dbv(v_rms),
        rms_dbu: v_to_dbv(v_rms / 0.775),
        rms_a_dbv: v_to_dbv(v_a),
        calibrated,
        clipped: m.clipped,
        stimulus_freq_hz,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_weight_reference_points() {
        // 0 dB at 1 kHz by definition.
        assert!((20.0 * weight_gain(Weighting::A, 1000.0).log10()).abs() < 0.01);
        // ~-19.1 dB at 100 Hz, ~-10.9 dB at 10 kHz (IEC 61672 table).
        let a100 = 20.0 * weight_gain(Weighting::A, 100.0).log10();
        assert!((a100 + 19.1).abs() < 0.5, "A(100) = {}", a100);
        let a10k = 20.0 * weight_gain(Weighting::A, 10000.0).log10();
        assert!((a10k + 2.5).abs() < 0.6, "A(10k) = {}", a10k);
    }

    #[test]
    fn unweighted_rms_matches_time_domain() {
        let fs = 48000u32;
        let n = 48000;
        let sig: Vec<f32> = (0..n)
            .map(|i| 0.5 * (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / fs as f32).sin())
            .collect();
        // A 0.5-amplitude sine has RMS 0.3536 → -9.03 dBFS.
        let m = analyze_levels(&sig, fs);
        assert!((m.rms_dbfs + 9.03).abs() < 0.1, "rms {}", m.rms_dbfs);
        // At 1 kHz A-weighting is ~0 dB, so A ≈ unweighted.
        assert!((m.rms_a_dbfs - m.rms_dbfs).abs() < 0.2, "A {} vs {}", m.rms_a_dbfs, m.rms_dbfs);
    }

    #[test]
    fn a_weight_attenuates_low_tone() {
        let fs = 48000u32;
        let n = 48000;
        // 100 Hz tone: A-weighted level ~19 dB below unweighted.
        let sig: Vec<f32> = (0..n)
            .map(|i| 0.5 * (2.0 * std::f32::consts::PI * 100.0 * i as f32 / fs as f32).sin())
            .collect();
        let m = analyze_levels(&sig, fs);
        let diff = m.rms_dbfs - m.rms_a_dbfs;
        assert!((diff - 19.1).abs() < 0.6, "attenuation {} dB", diff);
    }

    #[test]
    fn a_normal_capture_is_never_flagged_clipped() {
        let fs = 48000u32;
        let sig: Vec<f32> = (0..fs)
            .map(|i| 0.5 * (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / fs as f32).sin())
            .collect();
        assert!(!analyze_levels(&sig, fs).clipped);
    }

    #[test]
    fn a_saturated_capture_is_flagged_clipped() {
        let fs = 48000u32;
        // A 4 Vrms DUT into a 0 dBV (1 Vrms full-scale) range rails the ADC:
        // the digital signal pins at ±1.0 — exactly the failure mode issue
        // #29 review finding #4 calls out (peak_dbfs reads a plausible 0 dB,
        // not an obvious fault, without this flag).
        let sig: Vec<f32> = (0..fs)
            .map(|i| {
                let s = (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / fs as f32).sin();
                (4.0 * s).clamp(-1.0, 1.0)
            })
            .collect();
        let m = analyze_levels(&sig, fs);
        assert!(m.clipped);
        // A single rail sample is enough to flag it.
        let mut quiet = vec![0.0f32; 1000];
        assert!(!analyze_levels(&quiet, fs).clipped);
        quiet[500] = 1.0;
        assert!(analyze_levels(&quiet, fs).clipped);
    }

    #[test]
    fn project_levels_pins_known_dbfs_to_absolute_volts() {
        // factor=1.0 (an "ideal range", uncalibrated): -20 dBFS RMS is
        // 0.1 Vrms => 20*log10(0.1) = -20 dBV exactly, and dBu divides by
        // 0.775 V first (0.1/0.775 = 0.12903 => -17.789 dBu).
        let m = LevelMetrics {
            rms_dbfs: -20.0,
            peak_dbfs: -15.0,
            rms_a_dbfs: -22.0,
            rms_c_dbfs: -20.5,
            clipped: false,
        };
        let r = project_levels(&m, 1.0, false, 1000.0);
        assert!((r.rms_vrms - 0.1).abs() < 1e-6, "vrms {}", r.rms_vrms);
        assert!((r.rms_dbv - -20.0).abs() < 1e-3, "dbv {}", r.rms_dbv);
        assert!((r.rms_dbu - -17.789).abs() < 0.01, "dbu {}", r.rms_dbu);
        assert!(!r.calibrated);
        assert!(!r.clipped);
        assert_eq!(r.stimulus_freq_hz, 1000.0);

        // A factor of 2.0 (e.g. a calibration trim) doubles every voltage:
        // 0 dBFS RMS (digital 1.0) * 2.0 = 2.0 Vrms => +6.02 dBV.
        let m0 = LevelMetrics { rms_dbfs: 0.0, ..m };
        let r2 = project_levels(&m0, 2.0, true, 0.0);
        assert!((r2.rms_vrms - 2.0).abs() < 1e-6, "vrms {}", r2.rms_vrms);
        assert!((r2.rms_dbv - 6.0206).abs() < 0.01, "dbv {}", r2.rms_dbv);
        assert!(r2.calibrated);
    }

    #[test]
    fn project_levels_of_a_floored_silent_signal_stays_deeply_negative() {
        // `to_dbfs` floors a truly-silent `analyze_levels` reading at exactly
        // -200 dBFS, but that's `lin(-200) = 1e-10`, not literally 0 — so the
        // dBV/dBu projection computes a real (if absurdly quiet) value, not
        // its OWN -200 floor (that branch only fires for factor <= 0).
        let m = LevelMetrics {
            rms_dbfs: -200.0,
            peak_dbfs: -200.0,
            rms_a_dbfs: -200.0,
            rms_c_dbfs: -200.0,
            clipped: false,
        };
        let r = project_levels(&m, 1.0, true, 0.0);
        assert!((r.rms_dbv - -200.0).abs() < 1e-3, "dbv {}", r.rms_dbv);
        // dBu divides by 0.775 first: 20*log10(1/0.775) ≈ +2.214 dB shift.
        assert!((r.rms_dbu - -197.786).abs() < 0.01, "dbu {}", r.rms_dbu);
    }

    #[test]
    fn project_levels_floors_at_minus_200_only_when_the_factor_is_zero() {
        // The projection's OWN floor branch (`v <= 0.0`) only fires when the
        // calibration factor collapses the voltage to zero/negative (e.g. an
        // unresolved converter factor) — never from a merely-quiet signal.
        let m = LevelMetrics {
            rms_dbfs: -20.0,
            peak_dbfs: -15.0,
            rms_a_dbfs: -22.0,
            rms_c_dbfs: -20.5,
            clipped: false,
        };
        let r = project_levels(&m, 0.0, false, 0.0);
        assert_eq!(r.rms_vrms, 0.0);
        assert_eq!(r.rms_dbv, -200.0);
        assert_eq!(r.rms_dbu, -200.0);
    }

    #[test]
    fn analyze_levels_of_total_silence_floors_every_field_and_never_clips() {
        // A true-zero capture (e.g. a disconnected input) must floor every
        // dBFS field at exactly -200 (the `to_dbfs` floor: `x > 0.0` is
        // false for 0.0) and never mistake "nothing" for a rail (issue #29
        // review finding #4's `clipped` flag needs a specific test for
        // this boundary — 0.0 is as far from `CLIP_THRESHOLD` as it gets,
        // but it's also the one signal where every OTHER field pins to its
        // own floor, so it's worth confirming they don't accidentally
        // collide with the clip condition).
        let fs = 48000u32;
        let sig = vec![0.0f32; 4096];
        let m = analyze_levels(&sig, fs);
        assert_eq!(m.rms_dbfs, -200.0);
        assert_eq!(m.peak_dbfs, -200.0);
        assert_eq!(m.rms_a_dbfs, -200.0);
        assert_eq!(m.rms_c_dbfs, -200.0);
        assert!(!m.clipped);

        // Projected through a real calibration factor, a silent capture
        // reads a real (if absurd) voltage, not its own separate floor —
        // see `project_levels_of_a_floored_silent_signal_stays_deeply_negative`
        // for why `lin(-200) = 1e-10`, not literally 0.
        let r = project_levels(&m, 1.0, true, 0.0);
        assert!((r.rms_dbv - -200.0).abs() < 1e-3, "dbv {}", r.rms_dbv);
    }

    #[test]
    fn analyze_levels_of_pure_dc_reads_full_on_unweighted_but_silent_on_ac_weighted() {
        // A pure-DC capture (e.g. an unbalanced input picking up an offset,
        // or a synthetic test buffer) has ALL of its energy at 0 Hz.
        // `weighted_rms` explicitly skips the DC bin (k=0 — "no meaningful
        // weighted level, and it holds any offset", weighting.rs:51-54), so
        // the unweighted rms/peak read the DC level exactly, while the A/C
        // weighted levels read the OTHER extreme: floored at -200, as if
        // silent. This is the exact behavior a naive "is my DUT working"
        // glance at rms_a_dbfs alone would misread as "no signal" — pinning
        // it here so a future change to the DC handling doesn't silently
        // start leaking DC energy into the weighted sums (or vice versa,
        // stop skipping it and NaN on a weight curve that's 0 at f=0).
        let fs = 48000u32;
        let sig = vec![0.3f32; 4096]; // constant, well under CLIP_THRESHOLD
        let m = analyze_levels(&sig, fs);
        // 20*log10(0.3) = -10.4576 dBFS exactly, for both rms and peak
        // (a constant signal's RMS and peak are both |0.3|).
        assert!((m.rms_dbfs - -10.4576).abs() < 0.01, "rms {}", m.rms_dbfs);
        assert!((m.peak_dbfs - -10.4576).abs() < 0.01, "peak {}", m.peak_dbfs);
        assert_eq!(m.rms_a_dbfs, -200.0, "A-weighted DC must read as silence");
        assert_eq!(m.rms_c_dbfs, -200.0, "C-weighted DC must read as silence");
        assert!(!m.clipped);
    }
}


//! Frequency weighting curves — the Rust twin of `src/weighting.ts`, which
//! served both the chart renderers and the dashboard transformer chain.
//!
//! Adds RIAA and user-curve modes on top of the A/C pair that already existed
//! in `audio/weighting.rs` (which keeps its own f32 linear-gain form for the
//! Parseval RMS path; the phase C migration will make it delegate here).
//!
//! The USER curve is a **parameter**, not state: the old TS module kept the
//! loaded curve in a module-global, which made the math impure. Here the
//! caller owns the curve (it is display configuration, like a notch's Q) and
//! passes it per call.

use serde::{Deserialize, Serialize};

/// Frequency weighting applied to a displayed/derived spectrum.
/// Serialized names match the frontend's `Weighting` string union.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WeightingMode {
    /// Unweighted (flat).
    Z,
    A,
    C,
    #[serde(rename = "RIAA")]
    Riaa,
    /// A user-loaded curve, supplied via the `user` parameter.
    #[serde(rename = "USER")]
    User,
}

/// A user-loaded weighting curve: ascending `freqs` (Hz) with matching
/// `gains` (dB to ADD at that frequency). Interpolated log-frequency /
/// linear-dB, held flat beyond the endpoints.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UserWeightingCurve {
    pub freqs: Vec<f64>,
    pub gains: Vec<f64>,
}

/// Raw (unnormalized) A-weighting transfer magnitude at frequency f.
fn raw_a_weight(f: f64) -> f64 {
    let f2 = f * f;
    (12194.0 * 12194.0 * f2 * f2)
        / ((f2 + 20.6 * 20.6)
            * ((f2 + 107.7 * 107.7) * (f2 + 737.9 * 737.9)).sqrt()
            * (f2 + 12194.0 * 12194.0))
}

/// Raw (unnormalized) C-weighting transfer magnitude at frequency f.
fn raw_c_weight(f: f64) -> f64 {
    let f2 = f * f;
    (12194.0 * 12194.0 * f2) / ((f2 + 20.6 * 20.6) * (f2 + 12194.0 * 12194.0))
}

/// RIAA playback (de-emphasis) magnitude at f — the boost a phono preamp
/// applies (pole 50 Hz, zero 500 Hz, pole 2122 Hz; time constants
/// 3180/318/75 µs).
fn raw_riaa_deemphasis(f: f64) -> f64 {
    let w = 2.0 * std::f64::consts::PI * f;
    let t1 = 3180e-6;
    let t2 = 318e-6;
    let t3 = 75e-6;
    1.0f64.hypot(w * t2) / (1.0f64.hypot(w * t1) * 1.0f64.hypot(w * t3))
}

/// Interpolate a user curve at frequency f (log-f, linear-dB; flat ends;
/// 0 dB for an empty curve or non-positive frequency).
pub fn user_weight_gain_db(curve: &UserWeightingCurve, f: f64) -> f64 {
    let freqs = &curve.freqs;
    let gains = &curve.gains;
    if freqs.is_empty() || gains.len() != freqs.len() || !(f > 0.0) {
        return 0.0;
    }
    if f <= freqs[0] {
        return gains[0];
    }
    if f >= freqs[freqs.len() - 1] {
        return gains[gains.len() - 1];
    }
    // Binary search for the bracketing points.
    let (mut lo, mut hi) = (0usize, freqs.len() - 1);
    while hi - lo > 1 {
        let mid = (lo + hi) >> 1;
        if freqs[mid] <= f {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let t = (f.ln() - freqs[lo].ln()) / (freqs[hi].ln() - freqs[lo].ln());
    gains[lo] + t * (gains[hi] - gains[lo])
}

/// dB gain to ADD to a spectrum bin at frequency `f` for the given weighting,
/// normalized to 0 dB at 1 kHz. Z (none) returns 0; `User` without a curve
/// returns 0. RIAA subtracts the de-emphasis curve (like the QA40x "RIAA
/// weighting"): drive the phono stage with a flat signal and a correct RIAA
/// response reads flat, so deviations are the error from the curve.
pub fn weighting_gain_db(mode: WeightingMode, f: f64, user: Option<&UserWeightingCurve>) -> f64 {
    if !(f > 0.0) {
        return 0.0;
    }
    match mode {
        WeightingMode::Z => 0.0,
        WeightingMode::A => {
            20.0 * raw_a_weight(f).log10() - 20.0 * raw_a_weight(1000.0).log10()
        }
        WeightingMode::C => {
            20.0 * raw_c_weight(f).log10() - 20.0 * raw_c_weight(1000.0).log10()
        }
        WeightingMode::Riaa => {
            20.0 * raw_riaa_deemphasis(1000.0).log10() - 20.0 * raw_riaa_deemphasis(f).log10()
        }
        WeightingMode::User => user.map_or(0.0, |c| user_weight_gain_db(c, f)),
    }
}

/// Linear weighting gain (a plain ratio, 1.0 at 1 kHz) — the multiplicative
/// form the Parseval weighted-RMS loop wants (`audio/weighting.rs` delegates
/// here). Computed from the raw transfer ratios directly, no dB round trip.
pub fn weighting_gain_linear(
    mode: WeightingMode,
    f: f64,
    user: Option<&UserWeightingCurve>,
) -> f64 {
    if !(f > 0.0) {
        return 1.0;
    }
    match mode {
        WeightingMode::Z => 1.0,
        WeightingMode::A => raw_a_weight(f) / raw_a_weight(1000.0),
        WeightingMode::C => raw_c_weight(f) / raw_c_weight(1000.0),
        WeightingMode::Riaa => raw_riaa_deemphasis(1000.0) / raw_riaa_deemphasis(f),
        WeightingMode::User => {
            user.map_or(1.0, |c| 10f64.powf(user_weight_gain_db(c, f) / 20.0))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_modes_are_zero_at_1khz_and_for_bad_frequencies() {
        for mode in [
            WeightingMode::Z,
            WeightingMode::A,
            WeightingMode::C,
            WeightingMode::Riaa,
        ] {
            assert!(weighting_gain_db(mode, 1000.0, None).abs() < 1e-9, "{mode:?}");
            assert_eq!(weighting_gain_db(mode, 0.0, None), 0.0);
            assert_eq!(weighting_gain_db(mode, -5.0, None), 0.0);
        }
        assert_eq!(weighting_gain_db(WeightingMode::User, 440.0, None), 0.0);
    }

    #[test]
    fn a_weight_reference_points() {
        // IEC 61672 table: ~-19.1 dB at 100 Hz, ~-2.5 dB at 10 kHz.
        let a100 = weighting_gain_db(WeightingMode::A, 100.0, None);
        assert!((a100 + 19.1).abs() < 0.5, "A(100) = {a100}");
        let a10k = weighting_gain_db(WeightingMode::A, 10000.0, None);
        assert!((a10k + 2.5).abs() < 0.6, "A(10k) = {a10k}");
    }

    #[test]
    fn c_weight_reference_points() {
        // IEC 61672 table: ~-3.0 dB at 31.5 Hz, ~-8.5 dB at 16 kHz.
        let c31 = weighting_gain_db(WeightingMode::C, 31.5, None);
        assert!((c31 + 3.0).abs() < 0.3, "C(31.5) = {c31}");
        let c16k = weighting_gain_db(WeightingMode::C, 16000.0, None);
        assert!((c16k + 8.5).abs() < 0.5, "C(16k) = {c16k}");
    }

    #[test]
    fn riaa_error_weighting_signs() {
        // The playback curve boosts lows/cuts highs; the weighting is its
        // inverse: strongly negative at 20 Hz, strongly positive at 20 kHz.
        let lo = weighting_gain_db(WeightingMode::Riaa, 20.0, None);
        assert!((lo + 19.3).abs() < 0.5, "RIAA(20) = {lo}");
        let hi = weighting_gain_db(WeightingMode::Riaa, 20000.0, None);
        assert!((hi - 19.6).abs() < 0.5, "RIAA(20k) = {hi}");
    }

    #[test]
    fn user_curve_interpolates_log_f_linear_db() {
        let curve = UserWeightingCurve { freqs: vec![100.0, 1000.0], gains: vec![0.0, 12.0] };
        let g = |f: f64| weighting_gain_db(WeightingMode::User, f, Some(&curve));
        assert_eq!(g(100.0), 0.0);
        assert_eq!(g(1000.0), 12.0);
        // Geometric mean of the endpoints sits at the linear-dB midpoint.
        assert!((g((100.0f64 * 1000.0).sqrt()) - 6.0).abs() < 1e-9);
        // Held flat beyond the ends.
        assert_eq!(g(10.0), 0.0);
        assert_eq!(g(20000.0), 12.0);
    }

    #[test]
    fn degenerate_user_curves_are_flat() {
        let empty = UserWeightingCurve { freqs: vec![], gains: vec![] };
        assert_eq!(user_weight_gain_db(&empty, 1000.0), 0.0);
        let mismatched = UserWeightingCurve { freqs: vec![100.0, 1000.0], gains: vec![3.0] };
        assert_eq!(user_weight_gain_db(&mismatched, 500.0), 0.0);
    }

    #[test]
    fn serde_names_match_the_frontend() {
        assert_eq!(serde_json::to_string(&WeightingMode::Riaa).unwrap(), "\"RIAA\"");
        assert_eq!(serde_json::to_string(&WeightingMode::User).unwrap(), "\"USER\"");
        assert_eq!(serde_json::from_str::<WeightingMode>("\"A\"").unwrap(), WeightingMode::A);
    }
}

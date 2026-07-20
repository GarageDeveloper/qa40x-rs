//! Spectrum-level helpers: peak search, dB interpolation and transfer
//! functions, power-domain averaging, derived response figures.
//!
//! Rust twin of the spectrum half of `src/dashboard/transform.ts`
//! (`interpolateDb`/`transferGainDb`), of `main.ts`'s `SpectrumAverager`
//! (power averaging) and dB↔percent helpers, of `session.ts`'s −3 dB
//! bandwidth and ripple, and of `wowflutter.ts`'s pitch-offset conversions.
//!
//! Convention: `mags`/`gains` arrays are in dB (spectra live in absolute dBV
//! after ingest), `freqs` in Hz, ascending.

use serde::{Deserialize, Serialize};

use super::units::{db10, db20, undb10, undb20, DB_FLOOR};

/// Index of the largest finite magnitude, or `None` when the slice is empty
/// or contains no finite value.
pub fn peak_bin(mags: &[f64]) -> Option<usize> {
    let mut best: Option<usize> = None;
    for (i, &v) in mags.iter().enumerate() {
        if !v.is_finite() {
            continue;
        }
        if best.map_or(true, |b| v > mags[b]) {
            best = Some(i);
        }
    }
    best
}

/// [`peak_bin`] restricted to bins whose frequency is ≥ `min_freq` — e.g. the
/// wow & flutter dominant-modulation-rate search, which must skip the
/// DC/static-offset bin.
pub fn peak_bin_at_or_above(freqs: &[f64], mags: &[f64], min_freq: f64) -> Option<usize> {
    let mut best: Option<usize> = None;
    for (i, &v) in mags.iter().enumerate() {
        if freqs.get(i).map_or(true, |&f| f < min_freq) || !v.is_finite() {
            continue;
        }
        if best.map_or(true, |b| v > mags[b]) {
            best = Some(i);
        }
    }
    best
}

/// Mean of dB values in the POWER domain: `10·log10(mean(10^(v/10)))` over
/// the finite entries; `None` when there is none. This is how spectrum
/// frames average (the ÷10 form — not the ÷20 amplitude form).
pub fn power_mean_db(values: &[f64]) -> Option<f64> {
    let mut sum = 0.0f64;
    let mut cnt = 0usize;
    for &v in values {
        if v.is_finite() {
            sum += undb10(v);
            cnt += 1;
        }
    }
    if cnt > 0 {
        Some(db10(sum / cnt as f64))
    } else {
        None
    }
}

/// Power-average N spectrum frames per bin. Frames shorter than the newest
/// one contribute nothing to the missing bins; a bin with no finite value in
/// any frame falls back to the NEWEST frame's value (mirrors the live
/// averager). The newest frame is `frames.last()`; returns it unchanged when
/// it is the only one, and an empty vec when `frames` is empty.
pub fn power_average_spectra_db(frames: &[&[f64]]) -> Vec<f64> {
    let Some(&newest) = frames.last() else {
        return Vec::new();
    };
    if frames.len() == 1 {
        return newest.to_vec();
    }
    (0..newest.len())
        .map(|i| {
            let column: Vec<f64> = frames.iter().filter_map(|f| f.get(i).copied()).collect();
            power_mean_db(&column).unwrap_or(newest[i])
        })
        .collect()
}

/// Sum two dB quantities in the power domain:
/// `10·log10(10^(a/10) + 10^(b/10))` — e.g. combining THD and noise powers
/// into THD+N.
pub fn power_sum_db(a_db: f64, b_db: f64) -> f64 {
    db10(undb10(a_db) + undb10(b_db))
}

/// A distortion ratio in percent → dB (`20·log10(pct/100)`), floored at
/// [`DB_FLOOR`] for zero/negative/non-finite input.
pub fn percent_to_db(percent: f64) -> f64 {
    if percent.is_finite() && percent > 0.0 {
        db20(percent / 100.0)
    } else {
        DB_FLOOR
    }
}

/// A dB ratio → percent (`100·10^(db/20)`), the inverse of [`percent_to_db`].
pub fn db_to_percent(db: f64) -> f64 {
    100.0 * undb20(db)
}

/// Sample a reference spectrum (`ref_freqs` → `ref_mags`, dB) at each of
/// `freqs` by linear interpolation, clamped to the reference's ends. Both
/// frequency arrays must be ascending. Returns zeros when the reference is
/// empty (mirrors the TS deconvolve behaviour).
pub fn interpolate_db(freqs: &[f64], ref_freqs: &[f64], ref_mags: &[f64]) -> Vec<f64> {
    let mut out = Vec::with_capacity(freqs.len());
    let mut j = 0usize;
    for &f in freqs {
        if ref_freqs.is_empty() {
            out.push(0.0);
            continue;
        }
        while j < ref_freqs.len() - 1 && ref_freqs[j + 1] < f {
            j += 1;
        }
        if f <= ref_freqs[0] {
            out.push(ref_mags[0]);
        } else if f >= ref_freqs[ref_freqs.len() - 1] {
            out.push(ref_mags[ref_mags.len() - 1]);
        } else {
            let f0 = ref_freqs[j];
            let f1 = ref_freqs[j + 1];
            let t = if f1 > f0 { (f - f0) / (f1 - f0) } else { 0.0 };
            out.push(ref_mags[j] + t * (ref_mags[j + 1] - ref_mags[j]));
        }
    }
    out
}

/// Transfer function (gain) of a spectrum vs a reference: `mags − ref` in dB,
/// with the reference interpolated onto the input's bins. Backs both the
/// deconvolve transform step and the graphs' transfer-function mode.
pub fn transfer_gain_db(
    freqs: &[f64],
    mags: &[f64],
    ref_freqs: &[f64],
    ref_mags: &[f64],
) -> Vec<f64> {
    let ref_at = interpolate_db(freqs, ref_freqs, ref_mags);
    mags.iter().zip(ref_at).map(|(m, r)| m - r).collect()
}

/// Min and max over the finite entries, or `None` when there is none.
pub fn finite_extremes(values: &[f64]) -> Option<(f64, f64)> {
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    for &v in values {
        if !v.is_finite() {
            continue;
        }
        min = min.min(v);
        max = max.max(v);
    }
    if min.is_finite() {
        Some((min, max))
    } else {
        None
    }
}

/// Peak-to-peak ripple (max − min, dB) over the finite magnitudes.
pub fn ripple_db(mags: &[f64]) -> Option<f64> {
    finite_extremes(mags).map(|(min, max)| max - min)
}

/// The −3 dB top end of a frequency response: reference the magnitude nearest
/// 1 kHz (log-distance, finite bins only), then walk up in frequency and keep
/// the highest bin still within 3 dB of it; stop at the first bin that falls
/// below. `None` for fewer than 2 points or when no bin qualifies.
pub fn minus_3db_cutoff(freqs: &[f64], mags: &[f64]) -> Option<f64> {
    if freqs.len() < 2 || freqs.len() != mags.len() {
        return None;
    }
    let mut ref_idx = 0usize;
    let mut best_dist = f64::INFINITY;
    for (i, &f) in freqs.iter().enumerate() {
        let dist = ((if f > 0.0 { f } else { 1.0 }).log10() - 3.0).abs();
        if mags[i].is_finite() && dist < best_dist {
            best_dist = dist;
            ref_idx = i;
        }
    }
    let reference = mags[ref_idx];
    if !reference.is_finite() {
        return None;
    }
    let mut hi: Option<f64> = None;
    for i in ref_idx..freqs.len() {
        if mags[i].is_finite() && mags[i] >= reference - 3.0 {
            hi = Some(freqs[i]);
        } else if mags[i] < reference - 3.0 {
            break;
        }
    }
    hi
}

/// The key figures of a frequency-response curve (session summary tables).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct FrSummary {
    /// Peak-to-peak ripple (dB) over the finite magnitudes.
    pub ripple_db: Option<f64>,
    /// The −3 dB top end referenced near 1 kHz ([`minus_3db_cutoff`]).
    pub minus_3db_hz: Option<f64>,
}

/// Summarize a frequency response for display (ripple + −3 dB cutoff).
pub fn summarize_response(freqs: &[f64], mags: &[f64]) -> FrSummary {
    FrSummary {
        ripple_db: ripple_db(mags),
        minus_3db_hz: minus_3db_cutoff(freqs, mags),
    }
}

/// A static pitch offset in Hz → musical cents:
/// `1200·log2((ref + offset)/ref)`.
pub fn hz_offset_to_cents(offset_hz: f64, ref_hz: f64) -> f64 {
    1200.0 * ((ref_hz + offset_hz) / ref_hz).log2()
}

/// A static pitch offset in Hz → percent of the reference frequency.
pub fn hz_offset_to_percent(offset_hz: f64, ref_hz: f64) -> f64 {
    offset_hz / ref_hz * 100.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peak_bin_skips_non_finite() {
        assert_eq!(peak_bin(&[-30.0, f64::NAN, -10.0, -20.0]), Some(2));
        assert_eq!(peak_bin(&[]), None);
        assert_eq!(peak_bin(&[f64::NAN]), None);
    }

    #[test]
    fn peak_bin_respects_the_min_frequency() {
        let freqs = [0.0, 0.5, 2.0, 8.0];
        let mags = [10.0, 3.0, 1.0, 2.0];
        // The DC/static bin (largest) is excluded below 0.25 Hz.
        assert_eq!(peak_bin_at_or_above(&freqs, &mags, 0.25), Some(1));
        assert_eq!(peak_bin_at_or_above(&freqs, &mags, 100.0), None);
    }

    #[test]
    fn power_mean_uses_the_div10_form() {
        // Equal frames average to themselves.
        assert!((power_mean_db(&[-10.0, -10.0]).unwrap() + 10.0).abs() < 1e-9);
        // 0 dB and -10 dB average to 10*log10(0.55) ≈ -2.596 (NOT -5).
        let m = power_mean_db(&[0.0, -10.0]).unwrap();
        assert!((m - 10.0 * 0.55f64.log10()).abs() < 1e-9, "{m}");
        assert_eq!(power_mean_db(&[f64::NAN]), None);
    }

    #[test]
    fn spectra_average_falls_back_to_the_newest_frame() {
        let a = [f64::NAN, -20.0];
        let b = [-10.0, -20.0];
        let out = power_average_spectra_db(&[&a, &b]);
        assert!((out[0] + 10.0).abs() < 1e-9); // only b's bin is finite
        assert!((out[1] + 20.0).abs() < 1e-9);
        assert!(power_average_spectra_db(&[]).is_empty());
        assert_eq!(power_average_spectra_db(&[&b]), b.to_vec());
    }

    #[test]
    fn power_sum_combines_thd_and_noise() {
        // Two equal powers sum to +3.01 dB.
        assert!((power_sum_db(-60.0, -60.0) + 56.9897).abs() < 1e-3);
    }

    #[test]
    fn percent_db_round_trip() {
        assert!(percent_to_db(100.0).abs() < 1e-9);
        assert!((percent_to_db(1.0) + 40.0).abs() < 1e-9);
        assert!((db_to_percent(-40.0) - 1.0).abs() < 1e-9);
        assert_eq!(percent_to_db(0.0), DB_FLOOR);
        assert_eq!(percent_to_db(f64::NAN), DB_FLOOR);
        for pct in [0.003, 0.1, 1.0, 25.0] {
            assert!((db_to_percent(percent_to_db(pct)) - pct).abs() < 1e-9);
        }
    }

    #[test]
    fn interpolation_is_exact_at_knots_and_clamped_at_ends() {
        let rf = [100.0, 1000.0, 10000.0];
        let rm = [0.0, -6.0, -12.0];
        let out = interpolate_db(&[50.0, 100.0, 550.0, 10000.0, 20000.0], &rf, &rm);
        assert_eq!(out[0], 0.0); // clamped low
        assert_eq!(out[1], 0.0); // knot
        assert!((out[2] - (0.0 + (550.0 - 100.0) / 900.0 * -6.0)).abs() < 1e-12);
        assert_eq!(out[3], -12.0); // top knot
        assert_eq!(out[4], -12.0); // clamped high
        assert_eq!(interpolate_db(&[1.0, 2.0], &[], &[]), vec![0.0, 0.0]);
    }

    #[test]
    fn transfer_of_a_spectrum_against_itself_is_flat_zero() {
        let f = [100.0, 1000.0, 10000.0];
        let m = [-3.0, -6.0, -9.0];
        for g in transfer_gain_db(&f, &m, &f, &m) {
            assert!(g.abs() < 1e-12);
        }
    }

    #[test]
    fn ripple_and_extremes_skip_non_finite() {
        assert_eq!(ripple_db(&[0.0, -2.0, f64::NAN, 1.0]), Some(3.0));
        assert_eq!(ripple_db(&[f64::NAN]), None);
        assert_eq!(finite_extremes(&[]), None);
    }

    #[test]
    fn minus_3db_cutoff_walks_up_from_1khz() {
        let freqs = [100.0, 1000.0, 10000.0, 20000.0, 30000.0];
        let mags = [0.0, 0.0, 0.0, -2.9, -3.5];
        assert_eq!(minus_3db_cutoff(&freqs, &mags), Some(20000.0));
        // A NaN bin neither extends nor breaks the walk (mirrors the TS scan).
        let mags = [0.0, 0.0, f64::NAN, -2.9, -3.5];
        assert_eq!(minus_3db_cutoff(&freqs, &mags), Some(20000.0));
        assert_eq!(minus_3db_cutoff(&[1000.0], &[0.0]), None);
    }

    #[test]
    fn pitch_offset_conversions() {
        // A full octave up is +1200 cents and +100 %.
        assert!((hz_offset_to_cents(3150.0, 3150.0) - 1200.0).abs() < 1e-9);
        assert!((hz_offset_to_percent(3150.0, 3150.0) - 100.0).abs() < 1e-9);
        assert_eq!(hz_offset_to_cents(0.0, 3150.0), 0.0);
        // A -1 % pitch error is about -17.4 cents.
        let cents = hz_offset_to_cents(-31.5, 3150.0);
        assert!((cents + 17.4).abs() < 0.1, "{cents}");
    }
}

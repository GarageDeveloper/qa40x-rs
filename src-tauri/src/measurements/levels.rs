//! Per-buffer level metrics and headroom classification.
//!
//! Rust twin of the frontend helpers in `src/dashboard/measure.ts` (RMS, peak,
//! DC, crest) and of the clip/headroom thresholds that lived — with two
//! different values — in `src/levels.ts` (`peakZone`) and
//! `src/annunciators.ts`. The samples' unit is whatever the caller works in
//! (full-scale-referenced or volts); the metrics carry the same unit.

use serde::{Deserialize, Serialize};

use super::units::db20;
use super::Ratio;

/// RMS (√(Σx²/N)) of a buffer; 0 for an empty buffer.
///
/// Non-finite samples propagate (as in the TS original) — captures are always
/// finite, and masking a NaN here would hide an upstream bug.
pub fn rms(samples: &[f64]) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    let acc: f64 = samples.iter().map(|x| x * x).sum();
    (acc / samples.len() as f64).sqrt()
}

/// Largest absolute sample; 0 for an empty buffer.
pub fn peak_abs(samples: &[f64]) -> f64 {
    samples.iter().fold(0.0f64, |m, x| m.max(x.abs()))
}

/// Arithmetic mean — the DC offset; 0 for an empty buffer.
pub fn mean(samples: &[f64]) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    samples.iter().sum::<f64>() / samples.len() as f64
}

/// Linear per-buffer metrics (same unit as the input samples). dB readings
/// are derived via [`BufferMetrics::rms_db`] etc., never stored.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct BufferMetrics {
    /// RMS amplitude (linear).
    pub rms: f64,
    /// Peak absolute amplitude (linear).
    pub peak: f64,
    /// DC offset (mean, linear).
    pub dc_offset: f64,
}

impl BufferMetrics {
    /// RMS relative to the samples' unit reference, in dB.
    pub fn rms_db(&self) -> f64 {
        db20(self.rms)
    }

    /// Peak relative to the samples' unit reference, in dB.
    pub fn peak_db(&self) -> f64 {
        db20(self.peak)
    }

    /// Crest factor (peak ÷ RMS) as a linear [`Ratio`]; `None` when the
    /// buffer is silent (RMS 0), where a crest factor is undefined.
    pub fn crest(&self) -> Option<Ratio> {
        if self.rms > 0.0 {
            Some(Ratio { linear: self.peak / self.rms })
        } else {
            None
        }
    }
}

/// Compute all [`BufferMetrics`] in one pass over the buffer.
pub fn analyze_buffer(samples: &[f64]) -> BufferMetrics {
    if samples.is_empty() {
        return BufferMetrics { rms: 0.0, peak: 0.0, dc_offset: 0.0 };
    }
    let mut sq = 0.0f64;
    let mut peak = 0.0f64;
    let mut sum = 0.0f64;
    for &x in samples {
        sq += x * x;
        peak = peak.max(x.abs());
        sum += x;
    }
    let n = samples.len() as f64;
    BufferMetrics { rms: (sq / n).sqrt(), peak, dc_offset: sum / n }
}

/// Headroom thresholds: a peak at or above `clip_dbfs` reads as clipping, at
/// or above `warn_dbfs` as "hot"/near-clip. The app deliberately carries TWO
/// sets ([`ANNUNCIATOR_THRESHOLDS`], [`METER_THRESHOLDS`]) — they are
/// different indicators, not an inconsistency to unify (checked against the
/// introducing commits, 2026-07-16).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct HeadroomThresholds {
    /// Peak ≥ this (dBFS) is clipping.
    pub clip_dbfs: f64,
    /// Peak in [this, clip) is near full scale.
    pub warn_dbfs: f64,
}

/// The CLIP "virtual LED" thresholds (QA40x-style annunciator behaviour):
/// red at −0.1 dBFS, soft amber warning above −1 dBFS.
pub const ANNUNCIATOR_THRESHOLDS: HeadroomThresholds =
    HeadroomThresholds { clip_dbfs: -0.1, warn_dbfs: -1.0 };

/// The Levels widget's bar-meter zoning (OK/HOT/CLIP pill): a more
/// conservative gain-staging guide than the clip LED.
pub const METER_THRESHOLDS: HeadroomThresholds =
    HeadroomThresholds { clip_dbfs: -1.0, warn_dbfs: -6.0 };

/// Headroom classification of a peak level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HeadroomZone {
    /// Peak ≥ `clip_dbfs` — treat as clipped.
    Clip,
    /// Peak in [`warn_dbfs`, `clip_dbfs`) — near full scale.
    Hot,
    /// Comfortable headroom.
    Ok,
}

/// Classify a peak level (dBFS) against a threshold set.
pub fn headroom_zone(peak_dbfs: f64, thresholds: HeadroomThresholds) -> HeadroomZone {
    if peak_dbfs >= thresholds.clip_dbfs {
        HeadroomZone::Clip
    } else if peak_dbfs >= thresholds.warn_dbfs {
        HeadroomZone::Hot
    } else {
        HeadroomZone::Ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f64, amp: f64, fs: f64, n: usize) -> Vec<f64> {
        (0..n)
            .map(|i| amp * (2.0 * std::f64::consts::PI * freq * i as f64 / fs).sin())
            .collect()
    }

    #[test]
    fn sine_rms_is_amplitude_over_sqrt2() {
        // Integer number of cycles so the analytic value is exact.
        let s = sine(1000.0, 0.5, 48000.0, 48000);
        let m = analyze_buffer(&s);
        assert!((m.rms - 0.5 / std::f64::consts::SQRT_2).abs() < 1e-6, "rms {}", m.rms);
        assert!((m.peak - 0.5).abs() < 1e-4);
        assert!(m.dc_offset.abs() < 1e-12);
    }

    #[test]
    fn sine_crest_is_3_01_db_and_square_is_0_db() {
        let s = sine(1000.0, 0.5, 48000.0, 48000);
        let crest = analyze_buffer(&s).crest().unwrap();
        assert!((crest.db() - 3.0103).abs() < 1e-2, "crest {}", crest.db());

        let sq: Vec<f64> = (0..48000).map(|i| if (i / 24) % 2 == 0 { 0.7 } else { -0.7 }).collect();
        let crest = analyze_buffer(&sq).crest().unwrap();
        assert!(crest.db().abs() < 1e-9, "square crest {}", crest.db());
    }

    #[test]
    fn dc_offset_is_the_mean() {
        let s: Vec<f64> = sine(1000.0, 0.2, 48000.0, 48000)
            .into_iter()
            .map(|x| x + 0.01)
            .collect();
        let m = analyze_buffer(&s);
        assert!((m.dc_offset - 0.01).abs() < 1e-9);
        assert!((mean(&s) - m.dc_offset).abs() < 1e-15);
    }

    #[test]
    fn one_pass_matches_the_individual_helpers() {
        let s = sine(997.0, 0.3, 48000.0, 8192);
        let m = analyze_buffer(&s);
        assert_eq!(m.rms, rms(&s));
        assert_eq!(m.peak, peak_abs(&s));
        assert_eq!(m.dc_offset, mean(&s));
    }

    #[test]
    fn empty_and_silent_buffers() {
        let m = analyze_buffer(&[]);
        assert_eq!((m.rms, m.peak, m.dc_offset), (0.0, 0.0, 0.0));
        assert!(m.crest().is_none());
        assert_eq!(m.rms_db(), super::super::units::DB_FLOOR);
        assert!(analyze_buffer(&[0.0; 64]).crest().is_none());
    }

    #[test]
    fn headroom_zone_boundaries() {
        // Annunciator LED thresholds (QA40x-style): -0.1 / -1.
        let a = ANNUNCIATOR_THRESHOLDS;
        assert_eq!(headroom_zone(0.0, a), HeadroomZone::Clip);
        assert_eq!(headroom_zone(-0.1, a), HeadroomZone::Clip);
        assert_eq!(headroom_zone(-0.5, a), HeadroomZone::Hot);
        assert_eq!(headroom_zone(-1.0, a), HeadroomZone::Hot);
        assert_eq!(headroom_zone(-1.1, a), HeadroomZone::Ok);
        // Bar-meter zoning: -1 / -6.
        let m = METER_THRESHOLDS;
        assert_eq!(headroom_zone(-0.5, m), HeadroomZone::Clip);
        assert_eq!(headroom_zone(-3.0, m), HeadroomZone::Hot);
        assert_eq!(headroom_zone(-6.0, m), HeadroomZone::Hot);
        assert_eq!(headroom_zone(-120.0, m), HeadroomZone::Ok);
    }
}

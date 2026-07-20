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

/// Digital (full-scale-referenced) level metrics for a captured block.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LevelMetrics {
    pub rms_dbfs: f32,
    pub peak_dbfs: f32,
    pub rms_a_dbfs: f32,
    pub rms_c_dbfs: f32,
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
    }
}

/// Full level measurement including absolute voltage (filled by the device
/// layer from calibration; volts fields are 0 / `calibrated=false` otherwise).
#[derive(Debug, Clone, Serialize, Deserialize)]
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
}

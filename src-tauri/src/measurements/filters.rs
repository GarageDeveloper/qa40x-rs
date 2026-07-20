//! Small pure filters — the Rust twin of the biquad half of
//! `src/dashboard/transform.ts` (RBJ notch used by the transformer chain).

use serde::{Deserialize, Serialize};

/// Normalised biquad coefficients (a0 = 1).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct BiquadCoeffs {
    pub b0: f64,
    pub b1: f64,
    pub b2: f64,
    pub a1: f64,
    pub a2: f64,
}

/// Default notch quality factor: narrow enough to spare programme material,
/// wide enough to swallow a wandering mains hum.
pub const DEFAULT_NOTCH_Q: f64 = 8.0;

/// Floor (dB) for a biquad's magnitude response. Deliberately deeper than the
/// measurement layer's −200 dB floor: a notch's null is genuinely bottomless
/// and the TS original reported it as −300.
pub const BIQUAD_GAIN_FLOOR_DB: f64 = -300.0;

/// RBJ cookbook notch at `f0` Hz with quality `q`, for sample rate `fs`.
pub fn notch_coeffs(f0: f64, q: f64, fs: f64) -> BiquadCoeffs {
    let w0 = 2.0 * std::f64::consts::PI * f0 / fs;
    let alpha = w0.sin() / (2.0 * q);
    let cw = w0.cos();
    let a0 = 1.0 + alpha;
    BiquadCoeffs {
        b0: 1.0 / a0,
        b1: -2.0 * cw / a0,
        b2: 1.0 / a0,
        a1: -2.0 * cw / a0,
        a2: (1.0 - alpha) / a0,
    }
}

/// Run samples through the biquad (direct form 1, zero initial state).
pub fn biquad_filter(samples: &[f64], c: &BiquadCoeffs) -> Vec<f64> {
    let mut out = Vec::with_capacity(samples.len());
    let (mut x1, mut x2, mut y1, mut y2) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    for &x in samples {
        let y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
        out.push(y);
        x2 = x1;
        x1 = x;
        y2 = y1;
        y1 = y;
    }
    out
}

/// The biquad's magnitude response (dB) at frequency `f` for sample rate `fs`,
/// floored at [`BIQUAD_GAIN_FLOOR_DB`].
pub fn biquad_gain_db(c: &BiquadCoeffs, f: f64, fs: f64) -> f64 {
    let w = 2.0 * std::f64::consts::PI * f / fs;
    // |H(e^jw)| = |b0 + b1 e^-jw + b2 e^-2jw| / |1 + a1 e^-jw + a2 e^-2jw|
    let num_re = c.b0 + c.b1 * w.cos() + c.b2 * (2.0 * w).cos();
    let num_im = -(c.b1 * w.sin() + c.b2 * (2.0 * w).sin());
    let den_re = 1.0 + c.a1 * w.cos() + c.a2 * (2.0 * w).cos();
    let den_im = -(c.a1 * w.sin() + c.a2 * (2.0 * w).sin());
    let num = num_re.hypot(num_im);
    let den = den_re.hypot(den_im);
    if den == 0.0 {
        return BIQUAD_GAIN_FLOOR_DB;
    }
    let ratio = num / den;
    if ratio > 0.0 {
        (20.0 * ratio.log10()).max(BIQUAD_GAIN_FLOOR_DB)
    } else {
        BIQUAD_GAIN_FLOOR_DB
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f64, fs: f64, n: usize) -> Vec<f64> {
        (0..n)
            .map(|i| (2.0 * std::f64::consts::PI * freq * i as f64 / fs).sin())
            .collect()
    }

    fn rms(s: &[f64]) -> f64 {
        (s.iter().map(|x| x * x).sum::<f64>() / s.len() as f64).sqrt()
    }

    #[test]
    fn notch_kills_the_tuned_tone() {
        let fs = 48000.0;
        let c = notch_coeffs(1000.0, DEFAULT_NOTCH_Q, fs);
        let filtered = biquad_filter(&sine(1000.0, fs, 48000), &c);
        // Skip the transient, then the tone must be strongly attenuated.
        let tail = &filtered[24000..];
        assert!(rms(tail) < 0.01, "residual rms {}", rms(tail));
    }

    #[test]
    fn notch_passes_distant_frequencies() {
        let fs = 48000.0;
        let c = notch_coeffs(1000.0, DEFAULT_NOTCH_Q, fs);
        let filtered = biquad_filter(&sine(100.0, fs, 48000), &c);
        let tail = &filtered[24000..];
        let expected = 1.0 / std::f64::consts::SQRT_2;
        assert!((rms(tail) - expected).abs() / expected < 0.02, "rms {}", rms(tail));
    }

    #[test]
    fn gain_response_matches_the_filter() {
        let fs = 48000.0;
        let c = notch_coeffs(1000.0, DEFAULT_NOTCH_Q, fs);
        // Deep null at f0, near-unity far away, -3 dB at the Q edges.
        assert!(biquad_gain_db(&c, 1000.0, fs) < -60.0);
        assert!(biquad_gain_db(&c, 100.0, fs).abs() < 0.1);
        assert!(biquad_gain_db(&c, 10000.0, fs).abs() < 0.1);
        let edge = biquad_gain_db(&c, 1000.0 * (1.0 + 1.0 / (2.0 * DEFAULT_NOTCH_Q)), fs);
        assert!((edge + 3.0).abs() < 0.5, "edge gain {edge}");
    }

    #[test]
    fn dc_and_zero_input() {
        let c = notch_coeffs(1000.0, DEFAULT_NOTCH_Q, 48000.0);
        // DC passes a notch (gain 1 at w=0).
        assert!(biquad_gain_db(&c, 0.0, 48000.0).abs() < 1e-9);
        assert!(biquad_filter(&[], &c).is_empty());
        let zeros = biquad_filter(&[0.0; 16], &c);
        assert!(zeros.iter().all(|&v| v == 0.0));
    }
}

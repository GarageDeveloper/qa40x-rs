//! Frequency-response estimation from a synchronized output/input sweep.
//!
//! The measurement plays a chirp `x[n]` through the DAC and records the DUT's
//! response `y[n]` on the ADC. Naively dividing the two magnitude spectra is
//! ill-conditioned wherever the excitation has little energy (band edges), and
//! throws away the phase relationship entirely. Instead we estimate the complex
//! transfer function with a regularized H1 estimator, remove the fixed
//! round-trip latency (which otherwise dominates the phase as a steep linear
//! slope), and smooth the result onto log-spaced points.

use realfft::RealFftPlanner;
use rustfft::num_complex::Complex;
use serde::{Deserialize, Serialize};

/// Frequency response measurement data returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct FrequencyResponseData {
    /// Frequency points in Hz (log-spaced).
    pub frequencies: Vec<f32>,
    /// Magnitude response in dB (20*log10 of the transfer function).
    pub magnitudes_db: Vec<f32>,
    /// Phase response in degrees, latency-compensated and unwrapped.
    pub phases: Vec<f32>,
    /// Coherence-like quality metric per point (0..1); high where the
    /// excitation had energy and the estimate is trustworthy.
    pub coherence: Vec<f32>,
    /// Estimated round-trip latency that was compensated, in samples.
    pub latency_samples: f32,
    /// Sample rate the measurement ran at (Hz), so the UI can convert latency
    /// to time exactly regardless of any later config change.
    pub sample_rate: u32,
}

/// One frequency-response trace tagged with the input channel it came from.
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct FrequencyResponseTrace {
    /// "Left" or "Right".
    pub channel: String,
    pub data: FrequencyResponseData,
}

/// Estimate the complex transfer function `H = Y/X` and post-process it.
///
/// - `output` is the reference signal sent to the DAC.
/// - `input` is the signal recorded from the ADC.
/// - Frequencies outside `[start_freq, end_freq]` are dropped.
pub fn analyze_sweep(
    output: &[f32],
    input: &[f32],
    sample_rate: u32,
    start_freq: f32,
    end_freq: f32,
) -> FrequencyResponseData {
    let n = output.len().min(input.len());
    if n < 16 {
        return FrequencyResponseData {
            frequencies: Vec::new(),
            magnitudes_db: Vec::new(),
            phases: Vec::new(),
            coherence: Vec::new(),
            latency_samples: 0.0,
            sample_rate,
        };
    }

    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(n);
    let ifft = planner.plan_fft_inverse(n);

    // Forward transforms of the (unwindowed) excitation and response.
    let mut x_time = output[..n].to_vec();
    let mut y_time = input[..n].to_vec();
    let mut x_spec = fft.make_output_vec();
    let mut y_spec = fft.make_output_vec();
    fft.process(&mut x_time, &mut x_spec).unwrap();
    fft.process(&mut y_time, &mut y_spec).unwrap();

    let n_bins = x_spec.len(); // n/2 + 1
    let freq_res = sample_rate as f32 / n as f32;

    // Regularized H1 estimator: H = (Y * conj(X)) / (|X|^2 + lambda).
    // lambda is a small fraction of the peak excitation power so that bins with
    // no excitation energy yield H -> 0 instead of exploding.
    let max_xx = x_spec
        .iter()
        .map(|c| c.norm_sqr())
        .fold(0.0_f32, f32::max)
        .max(1e-20);
    let lambda = max_xx * 1e-4;

    let mut h: Vec<Complex<f32>> = Vec::with_capacity(n_bins);
    // Coherence proxy per bin: excitation energy relative to its peak, so points
    // where the sweep barely excited the DUT are flagged as low confidence.
    let mut bin_conf: Vec<f32> = Vec::with_capacity(n_bins);
    for k in 0..n_bins {
        let xx = x_spec[k].norm_sqr();
        h.push(y_spec[k] * x_spec[k].conj() / (xx + lambda));
        bin_conf.push((xx / max_xx).sqrt());
    }

    // Estimate round-trip latency from the impulse response (IFFT of H).
    // The largest-magnitude tap corresponds to the bulk delay of the path.
    let mut h_for_ir = h.clone();
    // realfft's inverse requires the Nyquist/DC imaginary parts to be zero.
    h_for_ir[0].im = 0.0;
    if n % 2 == 0 {
        let last = n_bins - 1;
        h_for_ir[last].im = 0.0;
    }
    let mut ir = ifft.make_output_vec();
    ifft.process(&mut h_for_ir, &mut ir).unwrap();

    let mut peak_idx = 0usize;
    let mut peak_val = 0.0f32;
    for (i, &v) in ir.iter().enumerate() {
        let a = v.abs();
        if a > peak_val {
            peak_val = a;
            peak_idx = i;
        }
    }
    // A peak in the second half is a small negative (circular) delay.
    let latency_samples = if peak_idx > n / 2 {
        peak_idx as f32 - n as f32
    } else {
        peak_idx as f32
    };

    // Sub-sample refinement via parabolic interpolation around the peak.
    let latency_refined = {
        let im1 = ir[(peak_idx + n - 1) % n].abs();
        let ip1 = ir[(peak_idx + 1) % n].abs();
        let denom = im1 - 2.0 * peak_val + ip1;
        if denom.abs() > 1e-12 {
            latency_samples + 0.5 * (im1 - ip1) / denom
        } else {
            latency_samples
        }
    };

    // Remove the linear phase corresponding to the bulk delay:
    // H'(f) = H(f) * exp(+j*2*pi*f*tau).
    let two_pi = 2.0 * std::f32::consts::PI;
    for k in 0..n_bins {
        let angle = two_pi * (k as f32) * latency_refined / (n as f32);
        let rot = Complex::from_polar(1.0, angle);
        h[k] *= rot;
    }

    // Log-spaced target frequencies clamped to the analysed band and Nyquist.
    let nyquist = sample_rate as f32 / 2.0;
    let lo = start_freq.max(freq_res).max(1.0);
    let hi = end_freq.min(nyquist * 0.999).max(lo * 1.001);
    let points_per_octave = 48.0_f32;
    let octaves = (hi / lo).log2();
    let num_points = ((octaves * points_per_octave).ceil() as usize).clamp(16, 2048);

    let mut frequencies = Vec::with_capacity(num_points);
    let mut magnitudes_db = Vec::with_capacity(num_points);
    let mut phases = Vec::with_capacity(num_points);
    let mut coherence = Vec::with_capacity(num_points);

    // Half-width of the fractional-octave averaging band.
    let half_bw = 2.0_f32.powf(1.0 / (2.0 * points_per_octave / 2.0)); // ~1/24 octave

    let mut prev_phase_unwrapped = 0.0f32;
    let mut first = true;

    for p in 0..num_points {
        let fc = lo * (hi / lo).powf(p as f32 / (num_points - 1) as f32);
        let f_low = fc / half_bw;
        let f_high = fc * half_bw;

        let k_low = (f_low / freq_res).floor() as usize;
        let k_high = ((f_high / freq_res).ceil() as usize).min(n_bins - 1);

        // Accumulate power for magnitude, a confidence-weighted vector for
        // phase, and the cross/auto spectra for the magnitude-squared coherence.
        let mut power_sum = 0.0f32;
        let mut cos_sum = 0.0f32;
        let mut sin_sum = 0.0f32;
        let mut count = 0usize;
        // Coherence accumulators (delay-compensated cross spectrum).
        let mut sxy = Complex::new(0.0f32, 0.0f32);
        let mut sxx = 0.0f32;
        let mut syy = 0.0f32;

        for k in k_low..=k_high.max(k_low) {
            if k == 0 || k >= n_bins {
                continue;
            }
            let mag = h[k].norm();
            let ph = h[k].arg();
            let w = bin_conf[k].max(1e-6);
            power_sum += mag * mag;
            cos_sum += w * ph.cos();
            sin_sum += w * ph.sin();

            // Remove the bulk delay from the cross term so it sums coherently
            // across the band (otherwise a wide band at HF cancels itself).
            let angle = two_pi * (k as f32) * latency_refined / (n as f32);
            let rot = Complex::from_polar(1.0, angle);
            sxy += y_spec[k] * x_spec[k].conj() * rot;
            sxx += x_spec[k].norm_sqr();
            syy += y_spec[k].norm_sqr();
            count += 1;
        }

        if count == 0 {
            // Fall back to the nearest single bin.
            let k = ((fc / freq_res).round() as usize).clamp(1, n_bins - 1);
            let mag = h[k].norm();
            power_sum = mag * mag;
            cos_sum = h[k].arg().cos();
            sin_sum = h[k].arg().sin();
            let angle = two_pi * (k as f32) * latency_refined / (n as f32);
            let rot = Complex::from_polar(1.0, angle);
            sxy = y_spec[k] * x_spec[k].conj() * rot;
            sxx = x_spec[k].norm_sqr();
            syy = y_spec[k].norm_sqr();
            count = 1;
        }

        // Magnitude-squared coherence: |Sxy|^2 / (Sxx * Syy), in [0, 1]. This is
        // scale-invariant, so the log sweep's 1/f energy roll-off does NOT drag
        // it down; it only falls where the response is noisy or unexcited.
        let gamma2 = if sxx > 1e-30 && syy > 1e-30 {
            (sxy.norm_sqr() / (sxx * syy)).clamp(0.0, 1.0)
        } else {
            0.0
        };

        let mag = (power_sum / count as f32).sqrt().max(1e-12);
        let mut phase = sin_sum.atan2(cos_sum).to_degrees();

        // Unwrap against the previous point for a continuous phase trace.
        if first {
            first = false;
            prev_phase_unwrapped = phase;
        } else {
            let mut delta = phase - (prev_phase_unwrapped % 360.0);
            while delta > 180.0 {
                delta -= 360.0;
            }
            while delta < -180.0 {
                delta += 360.0;
            }
            prev_phase_unwrapped += delta;
            phase = prev_phase_unwrapped;
        }

        frequencies.push(fc);
        magnitudes_db.push(20.0 * mag.log10());
        phases.push(phase);
        coherence.push(gamma2);
    }

    FrequencyResponseData {
        frequencies,
        magnitudes_db,
        phases,
        coherence,
        latency_samples: latency_refined,
        sample_rate,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exp_chirp(f0: f32, f1: f32, fs: u32, n: usize) -> Vec<f32> {
        let t_end = n as f32 / fs as f32;
        let k = (f1 / f0).ln();
        (0..n)
            .map(|i| {
                let t = i as f32 / fs as f32;
                let phase =
                    2.0 * std::f32::consts::PI * f0 * t_end / k * ((k * t / t_end).exp() - 1.0);
                phase.sin()
            })
            .collect()
    }

    #[test]
    fn flat_loopback_is_flat_and_zero_phase() {
        let fs = 48000;
        let n = 48000;
        let x = exp_chirp(20.0, 20000.0, fs, n);
        // Perfect loopback with a known integer delay and 0.5 gain.
        let delay = 137usize;
        let mut y = vec![0.0f32; n];
        for i in 0..n {
            if i >= delay {
                y[i] = 0.5 * x[i - delay];
            }
        }
        let r = analyze_sweep(&x, &y, fs, 50.0, 18000.0);
        assert!(!r.frequencies.is_empty());
        // Latency should be recovered.
        assert!((r.latency_samples - delay as f32).abs() < 1.0, "latency {}", r.latency_samples);
        // Magnitude ~ 20*log10(0.5) = -6.02 dB, flat.
        let mean = r.magnitudes_db.iter().sum::<f32>() / r.magnitudes_db.len() as f32;
        assert!((mean + 6.02).abs() < 0.5, "mean mag {}", mean);
        for &m in &r.magnitudes_db {
            assert!((m - mean).abs() < 1.0, "ripple too high: {} vs {}", m, mean);
        }
        // Phase near zero after latency compensation.
        for &p in &r.phases {
            assert!(p.abs() < 15.0, "phase not flat: {}", p);
        }
    }

    #[test]
    fn single_pole_lowpass_rolls_off() {
        let fs = 48000;
        let n = 48000;
        let x = exp_chirp(20.0, 20000.0, fs, n);
        // One-pole RC low-pass, fc = 1000 Hz.
        let fc = 1000.0f32;
        let dt = 1.0 / fs as f32;
        let rc = 1.0 / (2.0 * std::f32::consts::PI * fc);
        let alpha = dt / (rc + dt);
        let mut y = vec![0.0f32; n];
        let mut prev = 0.0f32;
        for i in 0..n {
            prev += alpha * (x[i] - prev);
            y[i] = prev;
        }
        let r = analyze_sweep(&x, &y, fs, 100.0, 18000.0);
        // At fc, magnitude should be about -3 dB relative to the passband.
        let idx_lf = r.frequencies.iter().position(|&f| f >= 150.0).unwrap();
        let idx_fc = r
            .frequencies
            .iter()
            .position(|&f| f >= fc)
            .unwrap_or(r.frequencies.len() - 1);
        let passband = r.magnitudes_db[idx_lf];
        let at_fc = r.magnitudes_db[idx_fc];
        assert!(
            (passband - at_fc - 3.0).abs() < 1.5,
            "expected ~3 dB drop at fc, got {} dB",
            passband - at_fc
        );
    }
}

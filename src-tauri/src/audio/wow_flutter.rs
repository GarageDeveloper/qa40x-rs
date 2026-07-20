//! Wow & flutter measurement.
//!
//! A reference tone (typically 3150 Hz per DIN/IEC 386) played by a mechanical
//! transport is frequency-modulated by the transport's speed variations. We
//! demodulate the instantaneous frequency of the captured tone, express the
//! deviation as a fraction of the reference, apply the DIN/IEC weighting curve
//! (peaked at 4 Hz), and report weighted/unweighted RMS and a deviation
//! spectrum (wow = low rate, flutter = higher rate).
//!
//! Method: heterodyne the tone to baseband (`x·e^{-j2πf0 t}`), low-pass to
//! isolate it, decimate, take the unwrapped phase, differentiate to get the
//! instantaneous frequency deviation, remove the static offset, normalize by f0.

use rustfft::num_complex::Complex;
use serde::{Deserialize, Serialize};

/// Wow & flutter result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WowFlutterResult {
    pub reference_freq: f32,
    /// Weighted (DIN/IEC 386) RMS speed deviation, percent.
    pub weighted_rms_percent: f32,
    /// Unweighted RMS speed deviation, percent.
    pub unweighted_rms_percent: f32,
    /// Weighted 2-sigma peak, percent (a common "peak-weighted" readout).
    pub peak_weighted_percent: f32,
    /// Mean (static) frequency error of the captured tone, Hz — a constant
    /// pitch offset, removed before the W&F figures.
    pub static_offset_hz: f32,
    /// Sample rate of the decimated deviation series/spectrum, Hz.
    pub demod_rate: f32,
    /// Deviation vs time, percent (decimated) — for a time plot.
    pub deviation_series: Vec<f32>,
    /// Deviation spectrum: modulation rate (Hz).
    pub rate_hz: Vec<f32>,
    /// Deviation spectrum magnitude, percent (unweighted).
    pub spectrum_percent: Vec<f32>,
}

/// One-pole low-pass, applied in place.
fn one_pole_lp(data: &mut [Complex<f32>], cutoff_hz: f32, fs: f32) {
    let dt = 1.0 / fs;
    let rc = 1.0 / (2.0 * std::f32::consts::PI * cutoff_hz);
    let alpha = dt / (rc + dt);
    let mut y = Complex::new(0.0, 0.0);
    for s in data.iter_mut() {
        y += (*s - y) * alpha;
        *s = y;
    }
}

/// Second-order Butterworth-ish band-pass biquad approximating the DIN/IEC 386
/// weighting (peak at 4 Hz). Approximate — the unweighted figure is exact.
fn din_weight_rms(dev: &[f32], fs: f32) -> (f32, f32) {
    // Biquad band-pass centered at f0=4 Hz.
    let f0 = 4.0_f32;
    let q = 1.4_f32;
    let w0 = 2.0 * std::f32::consts::PI * f0 / fs;
    let (sw, cw) = w0.sin_cos();
    let alpha = sw / (2.0 * q);
    // RBJ band-pass (constant 0 dB peak gain).
    let b0 = alpha;
    let b1 = 0.0;
    let b2 = -alpha;
    let a0 = 1.0 + alpha;
    let a1 = -2.0 * cw;
    let a2 = 1.0 - alpha;
    let (b0, b1, b2, a1, a2) = (b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);

    let mut x1 = 0.0;
    let mut x2 = 0.0;
    let mut y1 = 0.0;
    let mut y2 = 0.0;
    let mut sumsq = 0.0f64;
    let mut peak = 0.0f32;
    for &x in dev {
        let y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1;
        x1 = x;
        y2 = y1;
        y1 = y;
        sumsq += (y as f64) * (y as f64);
        peak = peak.max(y.abs());
    }
    let rms = if dev.is_empty() {
        0.0
    } else {
        (sumsq / dev.len() as f64).sqrt() as f32
    };
    (rms, peak)
}

/// Analyse wow & flutter of a captured reference tone.
pub fn analyze_wow_flutter(signal: &[f32], sample_rate: u32, reference_freq: f32) -> WowFlutterResult {
    let fs = sample_rate as f32;
    let f0 = reference_freq.max(1.0);
    let n = signal.len();

    let empty = WowFlutterResult {
        reference_freq: f0,
        weighted_rms_percent: 0.0,
        unweighted_rms_percent: 0.0,
        peak_weighted_percent: 0.0,
        static_offset_hz: 0.0,
        demod_rate: 0.0,
        deviation_series: Vec::new(),
        rate_hz: Vec::new(),
        spectrum_percent: Vec::new(),
    };
    if n < 1024 {
        return empty;
    }

    // 1. Heterodyne the tone to baseband.
    let two_pi = 2.0 * std::f64::consts::PI;
    let w = two_pi * f0 as f64 / fs as f64;
    let mut z: Vec<Complex<f32>> = (0..n)
        .map(|i| {
            let ph = -(w * i as f64) % two_pi;
            Complex::new(ph.cos() as f32, ph.sin() as f32) * signal[i]
        })
        .collect();

    // 2. Low-pass to isolate the baseband (remove the image at -2*f0) — keep
    //    modulation rates up to a few hundred Hz. Cascade for a steeper skirt.
    let lp_cut = 300.0_f32.min(f0 * 0.8);
    one_pole_lp(&mut z, lp_cut, fs);
    one_pole_lp(&mut z, lp_cut, fs);
    one_pole_lp(&mut z, lp_cut, fs);

    // 3. Decimate to a manageable rate for the deviation signal.
    let target_rate = 1000.0_f32;
    let m = (fs / target_rate).floor().max(1.0) as usize;
    let demod_rate = fs / m as f32;
    // Skip a settling margin at the start (filter transient).
    let skip = (fs * 0.05) as usize; // 50 ms
    let dz: Vec<Complex<f32>> = z.iter().skip(skip).step_by(m).cloned().collect();
    if dz.len() < 64 {
        return empty;
    }

    // 4. Unwrapped phase → instantaneous frequency deviation (Hz).
    let mut dev_hz: Vec<f32> = Vec::with_capacity(dz.len());
    let mut prev = dz[0].arg();
    let scale = demod_rate / (2.0 * std::f32::consts::PI);
    for c in dz.iter().skip(1) {
        let a = c.arg();
        let mut d = a - prev;
        while d > std::f32::consts::PI {
            d -= 2.0 * std::f32::consts::PI;
        }
        while d < -std::f32::consts::PI {
            d += 2.0 * std::f32::consts::PI;
        }
        prev = a;
        dev_hz.push(d * scale);
    }

    // 5. Remove the static offset (constant pitch error).
    let mean: f32 = dev_hz.iter().sum::<f32>() / dev_hz.len() as f32;
    for v in dev_hz.iter_mut() {
        *v -= mean;
    }

    // 6. Fractional deviation, percent.
    let dev_pct: Vec<f32> = dev_hz.iter().map(|d| d / f0 * 100.0).collect();

    // Unweighted RMS.
    let unweighted_rms = {
        let s: f64 = dev_pct.iter().map(|v| (*v as f64) * (*v as f64)).sum();
        (s / dev_pct.len() as f64).sqrt() as f32
    };

    // Weighted (DIN/IEC 386 approx).
    let (weighted_rms, weighted_peak) = din_weight_rms(&dev_pct, demod_rate);

    // Deviation spectrum (magnitude in %) via a simple DFT-through-FFT.
    let (rate_hz, spectrum_percent) = deviation_spectrum(&dev_pct, demod_rate);

    WowFlutterResult {
        reference_freq: f0,
        weighted_rms_percent: weighted_rms,
        unweighted_rms_percent: unweighted_rms,
        peak_weighted_percent: weighted_peak,
        static_offset_hz: mean,
        demod_rate,
        deviation_series: dev_pct,
        rate_hz,
        spectrum_percent,
    }
}

/// One-sided magnitude spectrum of the deviation signal, up to ~200 Hz.
fn deviation_spectrum(dev_pct: &[f32], fs: f32) -> (Vec<f32>, Vec<f32>) {
    use realfft::RealFftPlanner;
    // Use a power-of-two window for the FFT.
    let mut len = 1usize;
    while len * 2 <= dev_pct.len() {
        len *= 2;
    }
    if len < 64 {
        return (Vec::new(), Vec::new());
    }
    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(len);
    // Hann window over the most recent `len` samples.
    let start = dev_pct.len() - len;
    let mut buf: Vec<f32> = (0..len)
        .map(|i| {
            let w = 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / len as f32).cos());
            dev_pct[start + i] * w
        })
        .collect();
    let mut spec = fft.make_output_vec();
    fft.process(&mut buf, &mut spec).unwrap();

    let bin_hz = fs / len as f32;
    // Hann coherent gain 0.5 → scale by 2/(len*0.5) for amplitude.
    let norm = 2.0 / (len as f32 * 0.5);
    let max_rate = 200.0_f32;
    let mut rate = Vec::new();
    let mut mag = Vec::new();
    for (k, c) in spec.iter().enumerate() {
        let f = k as f32 * bin_hz;
        if f > max_rate {
            break;
        }
        rate.push(f);
        mag.push(c.norm() * norm);
    }
    (rate, mag)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tone FM-modulated by a known wow depth must be recovered.
    #[test]
    fn recovers_known_wow() {
        let fs = 48000u32;
        let f0 = 3150.0f32;
        let dur = 4.0f32;
        let n = (fs as f32 * dur) as usize;

        // Instantaneous freq = f0 * (1 + depth*sin(2π f_w t)); peak fractional
        // deviation = depth, RMS = depth/√2.
        let f_w = 4.0f32; // 4 Hz wow
        let depth = 0.002f32; // 0.2% peak
        let two_pi = 2.0 * std::f32::consts::PI;
        // phase(t) = 2π f0 [ t - depth/(2π f_w) cos(2π f_w t) ]
        let sig: Vec<f32> = (0..n)
            .map(|i| {
                let t = i as f32 / fs as f32;
                let ph = two_pi * f0 * (t - depth / (two_pi * f_w) * (two_pi * f_w * t).cos());
                ph.sin()
            })
            .collect();

        let r = analyze_wow_flutter(&sig, fs, f0);
        let expected_rms = depth / 2.0f32.sqrt() * 100.0; // percent
        assert!(
            (r.unweighted_rms_percent - expected_rms).abs() < 0.03,
            "unweighted RMS {} vs expected {}",
            r.unweighted_rms_percent,
            expected_rms
        );
        // The deviation spectrum should peak near 4 Hz.
        let peak_i = r
            .spectrum_percent
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .map(|(i, _)| i)
            .unwrap();
        assert!(
            (r.rate_hz[peak_i] - f_w).abs() < 1.0,
            "spectrum peak at {} Hz, expected ~{}",
            r.rate_hz[peak_i],
            f_w
        );
    }

    /// A pure, unmodulated tone must read ~0 wow & flutter.
    #[test]
    fn clean_tone_reads_near_zero() {
        let fs = 48000u32;
        let f0 = 3150.0f32;
        let n = 48000 * 3;
        let two_pi = 2.0 * std::f32::consts::PI;
        let sig: Vec<f32> = (0..n)
            .map(|i| (two_pi * f0 * i as f32 / fs as f32).sin())
            .collect();
        let r = analyze_wow_flutter(&sig, fs, f0);
        assert!(
            r.unweighted_rms_percent < 0.01,
            "clean tone W&F {} should be ~0",
            r.unweighted_rms_percent
        );
    }
}

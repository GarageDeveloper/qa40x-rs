use num_complex::Complex;
use realfft::RealFftPlanner;
use rustfft::FftPlanner;
use serde::{Deserialize, Serialize};

/// FFT result containing frequency domain data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FftResult {
    /// Frequency bins (Hz)
    pub frequencies: Vec<f32>,
    /// Magnitude spectrum (linear scale)
    pub magnitudes: Vec<f32>,
    /// Phase spectrum (radians)
    pub phases: Vec<f32>,
    /// Power spectrum (magnitude squared)
    pub power: Vec<f32>,
    /// Sample rate used
    pub sample_rate: u32,
    /// Real part of the n-normalized complex spectrum (for coherent averaging).
    /// Internal only — skipped in serialization to keep the wire payload small.
    #[serde(skip)]
    pub re: Vec<f32>,
    /// Imag part of the n-normalized complex spectrum (for coherent averaging).
    #[serde(skip)]
    pub im: Vec<f32>,
    /// Equivalent noise bandwidth of the analysis window, in bins:
    /// `N·Σw² / (Σw)²` (1.0 rectangular, 1.5 Hann, ≈3.77 flat-top). Because
    /// `magnitudes` is amplitude-corrected, summing bin powers over a band
    /// counts broadband noise ENBW× too high (and a coherent tone's main lobe
    /// exactly ENBW× its RMS²) — divide an integrated band power by this to
    /// get the true band power for tones and noise alike.
    #[serde(default = "default_enbw")]
    pub enbw_bins: f32,
}

fn default_enbw() -> f32 {
    1.0
}

impl FftResult {
    /// Convert magnitudes to dB scale
    pub fn magnitudes_db(&self) -> Vec<f32> {
        self.magnitudes
            .iter()
            .map(|&m| 20.0 * (m.max(1e-10)).log10())
            .collect()
    }

    /// Convert power to dB scale. Floor at 1e-20 (→ -200 dBFS): for POWER,
    /// 10·log10(1e-10) is only -100 dB, which would clamp the real noise floor
    /// into a flat line and hide dynamic range (see SpectrumAnalyzer).
    pub fn power_db(&self) -> Vec<f32> {
        self.power
            .iter()
            .map(|&p| 10.0 * (p.max(1e-20)).log10())
            .collect()
    }
}

/// FFT processor for audio signals
pub struct FftProcessor {
    real_planner: RealFftPlanner<f32>,
    complex_planner: FftPlanner<f32>,
}

impl FftProcessor {
    /// Create a new FFT processor
    pub fn new() -> Self {
        Self {
            real_planner: RealFftPlanner::new(),
            complex_planner: FftPlanner::new(),
        }
    }

    /// Perform FFT on real-valued signal (Hann window, the default).
    pub fn process_real(&mut self, signal: &[f32], sample_rate: u32) -> FftResult {
        self.process_real_windowed(signal, sample_rate, WindowFunction::Hann)
    }

    /// Perform FFT on real-valued signal with a caller-chosen analysis window.
    pub fn process_real_windowed(
        &mut self,
        signal: &[f32],
        sample_rate: u32,
        window: WindowFunction,
    ) -> FftResult {
        let n = signal.len();
        let mut input = signal.to_vec();

        // Amplitude correction factor: 1 / the window's coherent gain
        // (its mean value), measured on the window itself so ANY window
        // formula is compensated exactly. Without it a windowed tone's
        // spectral line reads low by the window's gain (Hann −6.02 dB,
        // flat-top −13.3 dB…), and the absolute level would move when the
        // user switches analysis windows.
        let mut w = vec![1.0f32; n];
        window.apply(&mut w);
        let sum_w = w.iter().sum::<f32>();
        let sum_w2 = w.iter().map(|&x| x * x).sum::<f32>();
        let coherent_gain = sum_w / n as f32;
        let acf = 1.0 / coherent_gain.max(1e-12);
        let enbw_bins = n as f32 * sum_w2 / (sum_w * sum_w).max(1e-12);

        // Apply the chosen analysis window (Rectangular = none).
        window.apply(&mut input);

        // Prepare FFT
        let fft = self.real_planner.plan_fft_forward(n);
        let mut spectrum = fft.make_output_vec();

        // Perform FFT
        fft.process(&mut input, &mut spectrum)
            .expect("FFT processing failed");

        // Calculate frequencies
        let freq_resolution = sample_rate as f32 / n as f32;
        let n_bins = spectrum.len();
        let frequencies: Vec<f32> = (0..n_bins)
            .map(|i| i as f32 * freq_resolution)
            .collect();

        // One-sided amplitude spectrum in DIGITAL RMS units: |X(k)|·(2/N)
        // recovers a tone's peak amplitude (×1 for the unpaired DC/Nyquist
        // bins), the ACF undoes the window's gain, and /√2 references RMS —
        // so a full-scale sine's line reads −3.01 dBFS, which is exactly
        // what the per-converter dBV offsets expect (`dac_volts_per_digital
        // _rms`, the PyQa40x-modelled ADC factor): spectrum + offset = true
        // absolute dBV on either converter.
        let bin_scale = |i: usize| -> f32 {
            let one_sided = if i == 0 || (n % 2 == 0 && i == n_bins - 1) { 1.0 } else { 2.0 };
            one_sided / n as f32 * acf / std::f32::consts::SQRT_2
        };
        let magnitudes: Vec<f32> = spectrum
            .iter()
            .enumerate()
            .map(|(i, c)| c.norm() * bin_scale(i))
            .collect();
        let phases: Vec<f32> = spectrum.iter().map(|c| c.arg()).collect();
        let power: Vec<f32> = magnitudes.iter().map(|&m| m * m).collect();
        // re/im carry the SAME scaling so the coherent (complex) averager's
        // magnitudes stay consistent with the power path.
        let re: Vec<f32> = spectrum
            .iter()
            .enumerate()
            .map(|(i, c)| c.re * bin_scale(i))
            .collect();
        let im: Vec<f32> = spectrum
            .iter()
            .enumerate()
            .map(|(i, c)| c.im * bin_scale(i))
            .collect();

        FftResult {
            frequencies,
            magnitudes,
            phases,
            power,
            sample_rate,
            re,
            im,
            enbw_bins,
        }
    }

    /// Perform FFT on complex-valued signal
    pub fn process_complex(&mut self, signal: &[Complex<f32>], sample_rate: u32) -> FftResult {
        let n = signal.len();
        let mut buffer = signal.to_vec();

        // Apply window
        self.apply_complex_hann_window(&mut buffer);

        // Perform FFT
        let fft = self.complex_planner.plan_fft_forward(n);
        fft.process(&mut buffer);

        // Calculate frequencies (centered around 0)
        let freq_resolution = sample_rate as f32 / n as f32;
        let frequencies: Vec<f32> = (0..n)
            .map(|i| {
                if i <= n / 2 {
                    i as f32 * freq_resolution
                } else {
                    (i as i32 - n as i32) as f32 * freq_resolution
                }
            })
            .collect();

        // Calculate magnitudes, phases, and power
        let magnitudes: Vec<f32> = buffer.iter().map(|c| c.norm() / n as f32).collect();
        let phases: Vec<f32> = buffer.iter().map(|c| c.arg()).collect();
        let power: Vec<f32> = magnitudes.iter().map(|&m| m * m).collect();
        let re: Vec<f32> = buffer.iter().map(|c| c.re / n as f32).collect();
        let im: Vec<f32> = buffer.iter().map(|c| c.im / n as f32).collect();

        FftResult {
            frequencies,
            magnitudes,
            phases,
            power,
            sample_rate,
            re,
            im,
            // Periodic Hann: Σw = N/2, Σw² = 3N/8 → N·Σw²/(Σw)² = 3/2 exactly.
            enbw_bins: 1.5,
        }
    }

    /// Apply Hann window to real signal
    /// Apply Hann window to complex signal
    fn apply_complex_hann_window(&self, signal: &mut [Complex<f32>]) {
        let n = signal.len();
        for (i, sample) in signal.iter_mut().enumerate() {
            let window = 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / n as f32).cos());
            *sample *= window;
        }
    }

    /// Compute inverse FFT
    pub fn ifft_real(&mut self, spectrum: &[Complex<f32>]) -> Vec<f32> {
        let n = (spectrum.len() - 1) * 2;
        let ifft = self.real_planner.plan_fft_inverse(n);

        let mut spectrum_copy = spectrum.to_vec();
        let mut output = ifft.make_output_vec();

        ifft.process(&mut spectrum_copy, &mut output)
            .expect("IFFT processing failed");

        // Normalize
        output.iter_mut().for_each(|x| *x /= n as f32);
        output
    }
}

impl Default for FftProcessor {
    fn default() -> Self {
        Self::new()
    }
}

/// Window functions for signal processing
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowFunction {
    Hann,
    Hamming,
    Blackman,
    FlatTop,
    Rectangular,
}

impl WindowFunction {
    /// Apply window function to signal
    pub fn apply(&self, signal: &mut [f32]) {
        let n = signal.len();
        match self {
            WindowFunction::Hann => {
                for (i, sample) in signal.iter_mut().enumerate() {
                    let w = 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / n as f32).cos());
                    *sample *= w;
                }
            }
            WindowFunction::Hamming => {
                for (i, sample) in signal.iter_mut().enumerate() {
                    let w = 0.54 - 0.46 * (2.0 * std::f32::consts::PI * i as f32 / n as f32).cos();
                    *sample *= w;
                }
            }
            WindowFunction::Blackman => {
                for (i, sample) in signal.iter_mut().enumerate() {
                    let w = 0.42 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / n as f32).cos()
                        + 0.08 * (4.0 * std::f32::consts::PI * i as f32 / n as f32).cos();
                    *sample *= w;
                }
            }
            WindowFunction::FlatTop => {
                // 5-term flat-top: minimal amplitude error (~0.02 dB), for
                // accurate level readouts at the cost of frequency resolution.
                let (a0, a1, a2, a3, a4) = (
                    0.215_578_95_f32,
                    0.416_631_58,
                    0.277_263_16,
                    0.083_578_95,
                    0.006_947_37,
                );
                for (i, sample) in signal.iter_mut().enumerate() {
                    let t = 2.0 * std::f32::consts::PI * i as f32 / n as f32;
                    let w = a0 - a1 * t.cos() + a2 * (2.0 * t).cos()
                        - a3 * (3.0 * t).cos()
                        + a4 * (4.0 * t).cos();
                    *sample *= w;
                }
            }
            WindowFunction::Rectangular => {
                // No windowing
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fft_sine_wave() {
        let mut processor = FftProcessor::new();
        let sample_rate = 48000;
        let duration = 1.0;
        let frequency = 1000.0;

        // Generate 1kHz sine wave
        let n_samples = (sample_rate as f32 * duration) as usize;
        let signal: Vec<f32> = (0..n_samples)
            .map(|i| {
                let t = i as f32 / sample_rate as f32;
                (2.0 * std::f32::consts::PI * frequency * t).sin()
            })
            .collect();

        let result = processor.process_real(&signal, sample_rate);

        // Find peak frequency
        let peak_idx = result
            .magnitudes
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap())
            .unwrap()
            .0;

        let peak_freq = result.frequencies[peak_idx];

        // Peak should be at 1000 Hz (within tolerance)
        assert!((peak_freq - frequency).abs() < 10.0);
    }

    /// The ENBW the band-integration paths divide by must match the classic
    /// per-window values, or every broadband (noise) readout shifts by the
    /// difference — the A/B bench caught exactly this against the official app.
    #[test]
    fn enbw_matches_the_textbook_values() {
        let mut p = FftProcessor::new();
        let signal = vec![0.25f32; 4096];
        for (window, want, tol) in [
            (WindowFunction::Rectangular, 1.0, 1e-6),
            (WindowFunction::Hann, 1.5, 1e-3),
            (WindowFunction::Hamming, 1.363, 2e-3),
            (WindowFunction::FlatTop, 3.77, 0.01),
        ] {
            let enbw = p.process_real_windowed(&signal, 48000, window).enbw_bins;
            assert!(
                (enbw - want).abs() < tol,
                "{window:?}: ENBW {enbw} want ≈{want}"
            );
        }
    }

    /// THE absolute-amplitude convention pin: the one-sided
    /// spectrum is in DIGITAL RMS units, window-amplitude-corrected — a
    /// bin-centered full-scale sine's line reads 1/√2 (−3.01 dBFS) under
    /// EVERY analysis window. This is what makes `spectrum bin + converter
    /// dBV offset = true absolute dBV` (the offsets are digital-RMS
    /// referenced), and what keeps the absolute level from moving when the
    /// user switches windows. Hardware-checked 2026-07-17: a −12 dBV
    /// loopback ask displayed −20.7 dBV before this correction — the Hann
    /// coherent gain (−6.02) + one-sided/RMS bookkeeping (−3.01), exactly.
    #[test]
    fn full_scale_sine_reads_minus_3dbfs_under_every_window() {
        let mut processor = FftProcessor::new();
        let sample_rate = 48000;
        let n = 8192usize;
        // Bin-centered tone (bin 171) so no scalloping enters the pin.
        let bin = 171usize;
        let frequency = bin as f32 * sample_rate as f32 / n as f32;
        let signal: Vec<f32> = (0..n)
            .map(|i| {
                (2.0 * std::f32::consts::PI * frequency * i as f32 / sample_rate as f32).sin()
            })
            .collect();

        for window in [
            WindowFunction::Rectangular,
            WindowFunction::Hann,
            WindowFunction::Hamming,
            WindowFunction::Blackman,
            WindowFunction::FlatTop,
        ] {
            let result = processor.process_real_windowed(&signal, sample_rate, window);
            // The tone's energy sits in the mainlobe around `bin`; the
            // corrected PEAK bin carries the sine's digital RMS.
            let peak = result.magnitudes[bin - 2..=bin + 2]
                .iter()
                .fold(0.0f32, |m, &v| m.max(v));
            let rms_db = 20.0 * peak.log10();
            assert!(
                (rms_db - (-3.01)).abs() < 0.1,
                "{window:?}: full-scale sine line reads {rms_db:.2} dBFS, want −3.01"
            );
        }
    }
}

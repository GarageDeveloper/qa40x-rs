use serde::{Deserialize, Serialize};

/// Audio analysis results
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct AnalysisResult {
    pub thd: f32,           // Total Harmonic Distortion (%)
    pub thd_n: f32,         // THD+N (%)
    pub snr: f32,           // Signal-to-Noise Ratio (dB)
    pub sinad: f32,         // Signal-to-Noise and Distortion (dB)
    pub rms: f32,           // RMS level
    pub peak: f32,          // Peak level
    pub crest_factor: f32,  // Crest factor (dB)
    pub dc_offset: f32,     // DC offset
}

/// Level of a single harmonic component.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Harmonic {
    /// Harmonic number (1 = fundamental, 2 = 2nd harmonic, ...).
    pub n: usize,
    /// Frequency of this harmonic (Hz).
    pub frequency: f32,
    /// Linear magnitude.
    pub magnitude: f32,
    /// Magnitude in dB relative to full scale.
    pub magnitude_db: f32,
    /// Magnitude in dB relative to the fundamental (dBc); 0 for the fundamental.
    pub magnitude_dbc: f32,
}

/// Result of a harmonic analysis around a known fundamental.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HarmonicResult {
    pub fundamental_freq: f32,
    pub harmonics: Vec<Harmonic>,
    /// Total harmonic distortion (%) from harmonics 2..=N.
    pub thd_percent: f32,
    /// THD in dB (20*log10(thd_ratio)).
    pub thd_db: f32,
}

/// One point of a swept THD measurement.
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct ThdSweepPoint {
    /// Swept variable: frequency (Hz) for THD-vs-frequency, or level (dBFS) for
    /// THD-vs-level. Both are provided; the irrelevant one is left as the
    /// constant used.
    pub frequency: f32,
    pub level_dbfs: f32,
    /// THD (harmonics only), percent and dB.
    pub thd_percent: f32,
    pub thd_db: f32,
    /// THD+N (harmonics + noise in the measurement band), percent and dB.
    pub thd_n_percent: f32,
    pub thd_n_db: f32,
    /// Fundamental level of the captured signal, dBFS.
    pub fundamental_dbfs: f32,
}

/// Result of a swept THD measurement (vs frequency or vs level).
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct ThdSweepResult {
    pub points: Vec<ThdSweepPoint>,
    /// "frequency" or "level" — what was swept (for axis labelling).
    pub swept: String,
}

/// Audio signal analyzer for quality measurements
pub struct AudioAnalyzer;

impl AudioAnalyzer {
    /// Calculate RMS (Root Mean Square) level
    pub fn calculate_rms(signal: &[f32]) -> f32 {
        let sum_squares: f32 = signal.iter().map(|&x| x * x).sum();
        (sum_squares / signal.len() as f32).sqrt()
    }

    /// Calculate peak level
    pub fn calculate_peak(signal: &[f32]) -> f32 {
        signal
            .iter()
            .map(|&x| x.abs())
            .max_by(|a, b| a.total_cmp(b))
            .unwrap_or(0.0)
    }

    /// Calculate DC offset
    pub fn calculate_dc_offset(signal: &[f32]) -> f32 {
        signal.iter().sum::<f32>() / signal.len() as f32
    }

    /// Calculate crest factor in dB
    pub fn calculate_crest_factor(signal: &[f32]) -> f32 {
        let peak = Self::calculate_peak(signal);
        let rms = Self::calculate_rms(signal);
        if rms > 0.0 {
            20.0 * (peak / rms).log10()
        } else {
            0.0
        }
    }

    /// Calculate THD (Total Harmonic Distortion)
    /// Requires FFT result with fundamental frequency identified
    // Lobe half-width (bins) for integrating a tone's power, and the wider
    // exclusion half-width for removing the fundamental from a THD+N residual.
    // Sized for the Hann window used by the live FFT path (process_fft): its
    // main lobe is ~3 bins and the skirts fall as k^-6, negligible past ~24.
    // Integrating the lobe (instead of reading a single bin) is what makes the
    // measurement match theory when the tone sits between two FFT bins.
    const LOBE_HALF_BINS: usize = 6;
    const EXCL_HALF_BINS: usize = 24;

    /// Refine to the local peak near `target_freq`, then integrate `|X|²` over
    /// `±LOBE_HALF_BINS` around it. Returns `(power, peak_bin)`. Power is f64 to
    /// avoid losing small residuals next to a huge fundamental.
    fn integrate_lobe(magnitudes: &[f32], frequencies: &[f32], target_freq: f32) -> (f64, usize) {
        let n = magnitudes.len();
        if n < 2 || frequencies.len() < 2 {
            return (0.0, 0);
        }
        let bin_hz = (frequencies[1] - frequencies[0]).max(1e-9);
        let center = (target_freq / bin_hz).round().max(1.0) as usize;
        let lobe = Self::LOBE_HALF_BINS;
        // Refine to the strongest bin within ±lobe of the target.
        let lo = center.saturating_sub(lobe).max(1);
        let hi = (center + lobe).min(n - 1);
        let mut peak_bin = lo;
        let mut peak = 0.0f32;
        for i in lo..=hi {
            if magnitudes[i] > peak {
                peak = magnitudes[i];
                peak_bin = i;
            }
        }
        // Integrate the lobe around that peak.
        let plo = peak_bin.saturating_sub(lobe).max(1);
        let phi = (peak_bin + lobe).min(n - 1);
        let mut power = 0.0f64;
        for i in plo..=phi {
            power += (magnitudes[i] as f64).powi(2);
        }
        (power, peak_bin)
    }

    /// Fraction of the signal's RMS attributable to the tone near
    /// `target_freq`: `√(main-lobe power / total spectral power)`, both from
    /// the same windowed spectrum, so the window's scaling cancels and — by
    /// Parseval — the ratio applies directly to the time-domain RMS. Used by
    /// the auto-level probe (`crate::measurement`) to turn a calibrated
    /// full-band RMS into a band RMS around the found peak, instead of
    /// reading one bin (which quietly underestimates a windowed tone).
    pub fn band_rms_fraction(magnitudes: &[f32], frequencies: &[f32], target_freq: f32) -> f32 {
        let (lobe, _) = Self::integrate_lobe(magnitudes, frequencies, target_freq);
        let total: f64 = magnitudes.iter().map(|&m| (m as f64).powi(2)).sum();
        if total > 0.0 {
            (lobe / total).sqrt().min(1.0) as f32
        } else {
            0.0
        }
    }

    pub fn calculate_thd(
        magnitudes: &[f32],
        frequencies: &[f32],
        fundamental_freq: f32,
        num_harmonics: usize,
    ) -> f32 {
        let nyquist = frequencies.last().copied().unwrap_or(0.0);
        let (fund_power, fund_bin) =
            Self::integrate_lobe(magnitudes, frequencies, fundamental_freq);
        if fund_power <= 0.0 {
            return 0.0;
        }
        // Harmonics are multiples of the REFINED fundamental (so a between-bin
        // tone doesn't drift the harmonic targets off their peaks).
        let f0 = frequencies[fund_bin];
        let mut harmonic_power = 0.0f64;
        for n in 2..=num_harmonics {
            let harmonic_freq = f0 * n as f32;
            if harmonic_freq >= nyquist {
                break;
            }
            harmonic_power += Self::integrate_lobe(magnitudes, frequencies, harmonic_freq).0;
        }
        ((harmonic_power / fund_power).sqrt() as f32) * 100.0
    }

    /// Calculate THD+N (Total Harmonic Distortion plus Noise)
    pub fn calculate_thd_n(
        magnitudes: &[f32],
        frequencies: &[f32],
        fundamental_freq: f32,
        bandwidth_hz: f32,
    ) -> f32 {
        let (fund_power, fund_bin) =
            Self::integrate_lobe(magnitudes, frequencies, fundamental_freq);
        if fund_power <= 0.0 {
            return 0.0;
        }
        // Residual = every in-band bin EXCEPT a wide zone around the fundamental
        // (the window skirts spread well past the main lobe when the tone sits
        // between bins). Summed directly in f64 rather than total-minus-
        // fundamental to avoid catastrophic cancellation.
        let excl_lo = fund_bin.saturating_sub(Self::EXCL_HALF_BINS);
        let excl_hi = fund_bin + Self::EXCL_HALF_BINS;
        let mut residual = 0.0f64;
        for (i, &freq) in frequencies.iter().enumerate() {
            if freq >= 20.0 && freq <= bandwidth_hz && (i < excl_lo || i > excl_hi) {
                residual += (magnitudes[i] as f64).powi(2);
            }
        }
        ((residual / fund_power).sqrt() as f32) * 100.0
    }

    /// Calculate SNR (Signal-to-Noise Ratio)
    pub fn calculate_snr(
        signal_power: f32,
        noise_power: f32,
    ) -> f32 {
        // Cap at a finite value: non-finite floats serialize to JSON null and
        // crash the frontend tiles.
        if noise_power > 0.0 {
            (10.0 * (signal_power / noise_power).log10()).min(999.0)
        } else {
            999.0
        }
    }

    /// Calculate SINAD (Signal-to-Noise and Distortion)
    pub fn calculate_sinad(
        signal_power: f32,
        noise_and_distortion_power: f32,
    ) -> f32 {
        if noise_and_distortion_power > 0.0 {
            (10.0 * (signal_power / noise_and_distortion_power).log10()).min(999.0)
        } else {
            999.0
        }
    }

    /// Perform comprehensive audio analysis
    pub fn analyze(
        signal: &[f32],
        magnitudes: &[f32],
        frequencies: &[f32],
        fundamental_freq: f32,
    ) -> AnalysisResult {
        let rms = Self::calculate_rms(signal);
        let peak = Self::calculate_peak(signal);
        let dc_offset = Self::calculate_dc_offset(signal);
        let crest_factor = Self::calculate_crest_factor(signal);

        let thd = Self::calculate_thd(magnitudes, frequencies, fundamental_freq, 10);
        let thd_n = Self::calculate_thd_n(magnitudes, frequencies, fundamental_freq, 20000.0);

        // Signal power = the fundamental's whole main lobe, not a single bin: a
        // windowed tone spreads its energy across ±LOBE_HALF_BINS, so a one-bin
        // estimate massively undercounts it and dumps the rest into "noise"
        // (which used to collapse SNR to ~0 dB). Mirrors the THD/THD+N path.
        let (signal_power, fund_bin) =
            Self::integrate_lobe(magnitudes, frequencies, fundamental_freq);

        // In-band residual (20 Hz..20 kHz) excluding a wide zone around the
        // fundamental = noise + distortion → SINAD.
        let excl_lo = fund_bin.saturating_sub(Self::EXCL_HALF_BINS);
        let excl_hi = fund_bin + Self::EXCL_HALF_BINS;
        let mut nd_power = 0.0f64;
        for (i, &freq) in frequencies.iter().enumerate() {
            if freq >= 20.0 && freq <= 20000.0 && (i < excl_lo || i > excl_hi) {
                nd_power += (magnitudes[i] as f64).powi(2);
            }
        }

        // Noise only = residual minus the harmonic lobes → SNR.
        let nyquist = frequencies.last().copied().unwrap_or(0.0);
        let f0 = frequencies.get(fund_bin).copied().unwrap_or(fundamental_freq);
        let mut harmonic_power = 0.0f64;
        for h in 2..=10 {
            let hf = f0 * h as f32;
            if hf >= nyquist {
                break;
            }
            harmonic_power += Self::integrate_lobe(magnitudes, frequencies, hf).0;
        }
        let noise_power = (nd_power - harmonic_power).max(0.0);

        let ratio_db = |sig: f64, ref_: f64| -> f32 {
            if ref_ > 0.0 && sig > 0.0 {
                ((10.0 * (sig / ref_).log10()) as f32).clamp(-200.0, 999.0)
            } else {
                999.0
            }
        };
        let snr = ratio_db(signal_power, noise_power);
        let sinad = ratio_db(signal_power, nd_power);

        AnalysisResult {
            thd,
            thd_n,
            snr,
            sinad,
            rms,
            peak,
            crest_factor,
            dc_offset,
        }
    }

    /// Analyse the harmonic content of a captured tone: locate the fundamental
    /// Locate the harmonic series on an ALREADY-COMPUTED magnitude spectrum
    /// (linear magnitudes) — n=1 (the refined fundamental) first. The stream
    /// loop uses this on its displayed (possibly averaged) spectrum so the
    /// markers sit exactly on the curve the user sees; `analyze_harmonics`
    /// wraps it with its own FFT for the one-shot tone path.
    ///
    /// The fundamental is refined to the strongest bin near `fundamental_freq`,
    /// and each harmonic level is taken as the peak within a small window
    /// (±3 %, at least ±3 bins) around n×f0 so slight frequency error or
    /// leakage doesn't miss the peak. Frequencies above the spectrum's end
    /// (Nyquist) are skipped. Empty on a degenerate spectrum.
    pub fn harmonics_from_spectrum(
        freqs: &[f32],
        mags: &[f32],
        fundamental_freq: f32,
        num_harmonics: usize,
    ) -> Vec<Harmonic> {
        if freqs.len() < 2 || mags.len() < freqs.len() {
            return Vec::new();
        }
        let bin_hz = freqs[1] - freqs[0];
        if !(bin_hz > 0.0) || !(fundamental_freq > 0.0) {
            return Vec::new();
        }
        let peak_in_window = |center: f32| -> (f32, f32) {
            let half = (center * 0.03).max(bin_hz * 3.0);
            let lo = ((center - half) / bin_hz).floor().max(1.0) as usize;
            let hi = (((center + half) / bin_hz).ceil() as usize).min(mags.len() - 1);
            let mut best_i = lo;
            let mut best = 0.0f32;
            for i in lo..=hi.max(lo) {
                if i < mags.len() && mags[i] > best {
                    best = mags[i];
                    best_i = i;
                }
            }
            (freqs[best_i], best)
        };

        // Refine the fundamental.
        let (f0, m0) = peak_in_window(fundamental_freq);
        let m0 = m0.max(1e-12);

        let f_end = freqs[freqs.len() - 1];
        let mut harmonics = Vec::new();
        for n in 1..=num_harmonics {
            let target = f0 * n as f32;
            if target >= f_end {
                break;
            }
            let (freq, mag) = peak_in_window(target);
            harmonics.push(Harmonic {
                n,
                frequency: freq,
                magnitude: mag,
                magnitude_db: 20.0 * mag.max(1e-12).log10(),
                magnitude_dbc: 20.0 * (mag.max(1e-12) / m0).log10(),
            });
        }
        harmonics
    }

    /// One-shot tone analysis: FFT the signal, locate the fundamental
    /// and the levels of harmonics 2..=num_harmonics, and compute THD.
    pub fn analyze_harmonics(
        signal: &[f32],
        sample_rate: u32,
        fundamental_freq: f32,
        num_harmonics: usize,
    ) -> HarmonicResult {
        use crate::audio::fft::FftProcessor;

        let mut fft = FftProcessor::new();
        let spectrum = fft.process_real(signal, sample_rate);
        let freqs = &spectrum.frequencies;
        let mags = &spectrum.magnitudes;

        let harmonics =
            Self::harmonics_from_spectrum(freqs, mags, fundamental_freq, num_harmonics);
        if harmonics.is_empty() {
            return HarmonicResult {
                fundamental_freq,
                harmonics,
                thd_percent: 0.0,
                thd_db: f32::NEG_INFINITY,
            };
        }
        let f0 = harmonics[0].frequency;
        let m0 = harmonics[0].magnitude.max(1e-12);
        let harmonic_power_sum: f32 = harmonics
            .iter()
            .filter(|h| h.n >= 2)
            .map(|h| h.magnitude * h.magnitude)
            .sum();

        let thd_ratio = harmonic_power_sum.sqrt() / m0;
        HarmonicResult {
            fundamental_freq: f0,
            harmonics,
            thd_percent: thd_ratio * 100.0,
            thd_db: if thd_ratio > 0.0 {
                (20.0 * thd_ratio.log10()).max(-200.0)
            } else {
                -200.0
            },
        }
    }

    /// Compute THD (harmonics only) and THD+N (harmonics + noise) for a captured
    /// tone in one FFT. Returns `(thd_ratio, thd_n_ratio, fundamental_mag)`,
    /// where the ratios are linear (multiply by 100 for percent, 20*log10 for dB).
    ///
    /// Delegates to the lobe-integrating `calculate_thd` / `calculate_thd_n` so
    /// the sweep path matches the live tiles and theory (a single-bin / narrow-
    /// exclusion version over-read THD+N by >10 dB). THD+N is the 20 Hz–20 kHz
    /// residual; `fundamental_mag` is the integrated main-lobe amplitude.
    pub fn thd_suite(
        signal: &[f32],
        sample_rate: u32,
        fundamental_freq: f32,
        num_harmonics: usize,
    ) -> (f32, f32, f32) {
        use crate::audio::fft::FftProcessor;
        let mut fft = FftProcessor::new();
        let spectrum = fft.process_real(signal, sample_rate);
        let freqs = &spectrum.frequencies;
        let mags = &spectrum.magnitudes;
        if freqs.len() < 4 {
            return (0.0, 0.0, 0.0);
        }
        let thd = Self::calculate_thd(mags, freqs, fundamental_freq, num_harmonics) / 100.0;
        let thd_n = Self::calculate_thd_n(mags, freqs, fundamental_freq, 20000.0) / 100.0;
        let (fund_power, _) = Self::integrate_lobe(mags, freqs, fundamental_freq);
        let fundamental_mag = fund_power.sqrt() as f32;
        (thd, thd_n, fundamental_mag)
    }

}

/// Frequency response measurement
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrequencyResponse {
    pub frequencies: Vec<f32>,
    pub magnitudes_db: Vec<f32>,
    pub phases: Vec<f32>,
}

impl FrequencyResponse {
    /// Create new frequency response measurement
    pub fn new() -> Self {
        Self {
            frequencies: Vec::new(),
            magnitudes_db: Vec::new(),
            phases: Vec::new(),
        }
    }

    /// Add measurement point
    pub fn add_point(&mut self, frequency: f32, magnitude_db: f32, phase: f32) {
        self.frequencies.push(frequency);
        self.magnitudes_db.push(magnitude_db);
        self.phases.push(phase);
    }

    /// Sort by frequency
    pub fn sort(&mut self) {
        let mut data: Vec<_> = self
            .frequencies
            .iter()
            .zip(self.magnitudes_db.iter())
            .zip(self.phases.iter())
            .map(|((&f, &m), &p)| (f, m, p))
            .collect();

        data.sort_by(|a, b| a.0.total_cmp(&b.0));

        self.frequencies = data.iter().map(|(f, _, _)| *f).collect();
        self.magnitudes_db = data.iter().map(|(_, m, _)| *m).collect();
        self.phases = data.iter().map(|(_, _, p)| *p).collect();
    }
}

impl Default for FrequencyResponse {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rms_calculation() {
        let signal = vec![1.0, -1.0, 1.0, -1.0];
        let rms = AudioAnalyzer::calculate_rms(&signal);
        assert!((rms - 1.0).abs() < 1e-6);
    }

    #[test]
    fn test_peak_calculation() {
        let signal = vec![0.5, -0.8, 0.3, -0.2];
        let peak = AudioAnalyzer::calculate_peak(&signal);
        assert!((peak - 0.8).abs() < 1e-6);
    }

    #[test]
    fn test_dc_offset() {
        let signal = vec![1.0, 2.0, 3.0, 4.0];
        let dc = AudioAnalyzer::calculate_dc_offset(&signal);
        assert!((dc - 2.5).abs() < 1e-6);
    }

    #[test]
    fn band_rms_fraction_isolates_the_tone_near_the_target() {
        // Synthetic 10 Hz-per-bin spectrum: a "windowed tone" spread over
        // three bins at 1 kHz, plus an equal-power interferer at 5 kHz.
        let n = 1024;
        let freqs: Vec<f32> = (0..n).map(|i| i as f32 * 10.0).collect();
        let mut mags = vec![0.0f32; n];
        let lobe = [0.5f32, 0.8, 0.5];
        for (o, &m) in lobe.iter().enumerate() {
            mags[99 + o] = m; // around bin 100 = 1 kHz
            mags[499 + o] = m; // around bin 500 = 5 kHz
        }
        // Alone-in-band it would be 1; with an equal-power tone elsewhere the
        // 1 kHz share of the total RMS is exactly 1/√2.
        let f = AudioAnalyzer::band_rms_fraction(&mags, &freqs, 1000.0);
        assert!((f - std::f32::consts::FRAC_1_SQRT_2).abs() < 1e-6, "fraction {f}");
        // Lobe integration: the whole 3-bin lobe counts, not one bin (a
        // single-bin read would report 0.8/√(2·1.14) instead).
        let mut solo = vec![0.0f32; n];
        for (o, &m) in lobe.iter().enumerate() {
            solo[99 + o] = m;
        }
        let f = AudioAnalyzer::band_rms_fraction(&solo, &freqs, 1000.0);
        assert!((f - 1.0).abs() < 1e-6, "solo tone fraction {f}");
        // Degenerate spectrum → 0, not NaN.
        assert_eq!(AudioAnalyzer::band_rms_fraction(&vec![0.0; n], &freqs, 1000.0), 0.0);
    }
}

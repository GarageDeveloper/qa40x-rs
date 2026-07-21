use crate::audio::fft::{FftProcessor, FftResult};
use serde::{Deserialize, Serialize};

/// Spectrum analyzer configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpectrumConfig {
    /// FFT size
    pub fft_size: usize,
    /// Number of averages
    pub num_averages: usize,
    /// Minimum frequency to display (Hz)
    pub freq_min: f32,
    /// Maximum frequency to display (Hz)
    pub freq_max: f32,
    /// Use logarithmic frequency scale
    pub log_scale: bool,
}

impl Default for SpectrumConfig {
    fn default() -> Self {
        Self {
            fft_size: 8192,
            num_averages: 4,
            freq_min: 20.0,
            freq_max: 20000.0,
            log_scale: true,
        }
    }
}

/// Spectrum analyzer result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpectrumResult {
    /// Frequency bins (Hz)
    pub frequencies: Vec<f32>,
    /// Magnitude spectrum in dB
    pub magnitudes_db: Vec<f32>,
    /// Peak frequencies and their magnitudes
    pub peaks: Vec<Peak>,
}

/// Frequency peak information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Peak {
    pub frequency: f32,
    pub magnitude_db: f32,
    pub index: usize,
}

/// Real-time spectrum analyzer
pub struct SpectrumAnalyzer {
    config: SpectrumConfig,
    fft_processor: FftProcessor,
    /// Rolling window of the last N power spectra for power-averaging mode.
    /// A window (not a batch accumulator): once full it keeps rolling, so the
    /// displayed average never restarts from a single frame (issue #10).
    power_buf: std::collections::VecDeque<Vec<f32>>,
    /// Coherent (complex) averaging mode: sum the complex spectra so the phase-
    /// locked signal adds while random noise cancels. Off = power averaging.
    coherent: bool,
    /// Rolling window of the last N (re, im) complex spectra for coherent mode.
    complex_buf: std::collections::VecDeque<(Vec<f32>, Vec<f32>)>,
    /// Last averaged FULL-range LINEAR magnitude spectrum + its frequencies, so
    /// the metrics (THD/THD+N/SNR) can be computed from the averaged spectrum
    /// (not a single frame) when coherent averaging is on.
    last_lin: Vec<f32>,
    last_freqs: Vec<f32>,
}

impl SpectrumAnalyzer {
    /// Create a new spectrum analyzer
    pub fn new(config: SpectrumConfig) -> Self {
        Self {
            config,
            fft_processor: FftProcessor::new(),
            power_buf: std::collections::VecDeque::new(),
            coherent: false,
            complex_buf: std::collections::VecDeque::new(),
            last_lin: Vec::new(),
            last_freqs: Vec::new(),
        }
    }

    /// The last averaged full-range linear magnitude spectrum + its frequencies
    /// (populated by the accumulating paths). Used to compute the metrics from
    /// the averaged spectrum instead of a single frame.
    pub fn last_averaged(&self) -> (&[f32], &[f32]) {
        (&self.last_lin, &self.last_freqs)
    }

    /// Enable/disable coherent (complex) averaging. Switching modes clears the
    /// accumulators so the two paths never mix.
    pub fn set_coherent(&mut self, on: bool) {
        if self.coherent != on {
            self.coherent = on;
            self.power_buf.clear();
            self.complex_buf.clear();
        }
    }

    /// Set the number of frames to average (rolling window). 1 = no averaging.
    pub fn set_num_averages(&mut self, n: usize) {
        self.config.num_averages = n.max(1);
        while self.complex_buf.len() > self.config.num_averages {
            self.complex_buf.pop_front();
        }
        while self.power_buf.len() > self.config.num_averages {
            self.power_buf.pop_front();
        }
    }

    /// Process audio data and update spectrum (Hann window, the default).
    pub fn process(&mut self, signal: &[f32], sample_rate: u32) -> SpectrumResult {
        self.process_windowed(signal, sample_rate, crate::audio::WindowFunction::Hann)
    }

    /// Process audio data with a caller-chosen analysis window (accumulating).
    pub fn process_windowed(
        &mut self,
        signal: &[f32],
        sample_rate: u32,
        window: crate::audio::WindowFunction,
    ) -> SpectrumResult {
        self.process_windowed_ex(signal, sample_rate, window, true)
    }

    /// Process one block. `accumulate` feeds the averagers (power or coherent);
    /// pass false for one-off spectra (e.g. the ideal generator stimulus) so they
    /// never mix into the captured-signal average.
    pub fn process_windowed_ex(
        &mut self,
        signal: &[f32],
        sample_rate: u32,
        window: crate::audio::WindowFunction,
        accumulate: bool,
    ) -> SpectrumResult {
        // Perform FFT
        let fft_result = self
            .fft_processor
            .process_real_windowed(signal, sample_rate, window);

        // One-off (non-accumulating): single-block spectrum, averagers untouched.
        if !accumulate {
            let mags_db: Vec<f32> = fft_result
                .power
                .iter()
                .map(|&p| 10.0 * (p.max(1e-20)).log10())
                .collect();
            return self.build_result(&fft_result.frequencies, &mags_db);
        }

        // Coherent (complex) averaging: sum the complex spectra across frames so
        // the phase-locked signal (fundamental + harmonics) adds while random
        // noise cancels (~10·log10(N) lower floor). Phase stability of the
        // loopback capture was verified empirically. Falls back to power
        // averaging when off.
        if self.coherent {
            return self.accumulate_coherent(&fft_result, sample_rate);
        }

        // Power averaging: rolling window of the last N power spectra, same
        // shape as the coherent path. Drop the history if the FFT size changed
        // (e.g. the caller switched sample counts); averaging across different
        // lengths would index out of bounds.
        let power = fft_result.power;
        if self.power_buf.back().is_some_and(|b| b.len() != power.len()) {
            self.power_buf.clear();
        }
        self.power_buf.push_back(power);
        while self.power_buf.len() > self.config.num_averages.max(1) {
            self.power_buf.pop_front();
        }

        self.compute_result(&fft_result.frequencies, sample_rate)
    }

    /// Compute spectrum result by averaging the rolling power window.
    fn compute_result(&self, frequencies: &[f32], _sample_rate: u32) -> SpectrumResult {
        let n = self.power_buf.len().max(1) as f32;
        let bins = self.power_buf.back().map_or(0, |b| b.len());

        // Average power spectrum over the window
        let mut averaged_power = vec![0.0f32; bins];
        for frame in &self.power_buf {
            for (a, &p) in averaged_power.iter_mut().zip(frame.iter()) {
                *a += p;
            }
        }
        for a in &mut averaged_power {
            *a /= n;
        }

        // Convert to magnitude in dB. Floor at 1e-20 (→ -200 dBFS) rather than
        // 1e-10: for a POWER value 10·log10(1e-10) = -100 dB, which clamped the
        // real noise floor (~-130 dBFS/bin) up to a flat -100 dB line, hiding
        // ~40 dB of dynamic range. 1e-20 keeps log10 finite without clipping any
        // real bin (matches the magnitude path's -200 dB floor).
        let magnitudes_db: Vec<f32> = averaged_power
            .iter()
            .map(|&p| 10.0 * (p.max(1e-20)).log10())
            .collect();

        self.build_result(frequencies, &magnitudes_db)
    }

    /// Phase-align a complex spectrum so its fundamental (strongest bin) sits at
    /// phase 0, using a linear per-bin phase slope — which is exactly a pure time
    /// shift, so it aligns every harmonic and correlated bin too. Returns (re,im).
    fn phase_align(re: &[f32], im: &[f32]) -> (Vec<f32>, Vec<f32>) {
        let bins = re.len();
        if bins < 2 {
            return (re.to_vec(), im.to_vec());
        }
        // Fundamental = strongest bin (skip DC).
        let mut k = 1usize;
        let mut best = -1.0f32;
        for i in 1..bins {
            let p = re[i] * re[i] + im[i] * im[i];
            if p > best {
                best = p;
                k = i;
            }
        }
        let phi = im[k].atan2(re[k]);
        let theta = phi / k as f32; // per-bin slope that drives bin k to phase 0
        let mut are = vec![0.0f32; bins];
        let mut aim = vec![0.0f32; bins];
        for m in 0..bins {
            let ang = -(m as f32) * theta;
            let (s, c) = ang.sin_cos();
            are[m] = re[m] * c - im[m] * s;
            aim[m] = re[m] * s + im[m] * c;
        }
        (are, aim)
    }

    /// Coherent (complex) averaging: keep a rolling window of the last N complex
    /// spectra, average re/im, and take the magnitude of the average. The signal
    /// (fundamental + harmonics) adds; uncorrelated noise averages toward zero
    /// (~10·log10(N)).
    ///
    /// Each frame is phase-aligned first: the loopback capture phase drifts
    /// between acquisitions (especially at large FFT / slow frames), so we undo
    /// that drift with a linear (time-shift) phase correction keyed on the
    /// fundamental. Because a per-bin phase slope IS a pure time shift, this
    /// aligns the fundamental AND its harmonics AND any correlated content across
    /// frames, while random noise stays random and cancels. Without this, drift
    /// makes coherent averaging DEGRADE the result instead of improving it.
    fn accumulate_coherent(&mut self, fft: &FftResult, sample_rate: u32) -> SpectrumResult {
        // Drop the history if the FFT size changed.
        if self
            .complex_buf
            .back()
            .is_some_and(|(re, _)| re.len() != fft.re.len())
        {
            self.complex_buf.clear();
        }
        self.complex_buf.push_back(Self::phase_align(&fft.re, &fft.im));
        while self.complex_buf.len() > self.config.num_averages.max(1) {
            self.complex_buf.pop_front();
        }

        let bins = fft.re.len();
        let n = self.complex_buf.len().max(1) as f32;
        let mut mags_db = vec![-200.0f32; bins];
        let mut mags_lin = vec![0.0f32; bins];
        for i in 0..bins {
            let mut sre = 0.0f32;
            let mut sim = 0.0f32;
            for (re, im) in &self.complex_buf {
                sre += re[i];
                sim += im[i];
            }
            let mag = ((sre / n).powi(2) + (sim / n).powi(2)).sqrt();
            mags_lin[i] = mag;
            mags_db[i] = 20.0 * mag.max(1e-10).log10();
        }
        // Keep the averaged linear spectrum so the metrics can use it.
        self.last_lin = mags_lin;
        self.last_freqs = fft.frequencies.clone();
        let _ = sample_rate;
        self.build_result(&fft.frequencies, &mags_db)
    }

    /// Filter a full-length dB magnitude spectrum to the display band and find
    /// its peaks. Shared by the power and coherent averaging paths.
    fn build_result(&self, frequencies: &[f32], magnitudes_db: &[f32]) -> SpectrumResult {
        let mut filtered_freqs = Vec::new();
        let mut filtered_mags = Vec::new();

        for (i, &freq) in frequencies.iter().enumerate() {
            if i >= magnitudes_db.len() {
                break;
            }
            if freq >= self.config.freq_min && freq <= self.config.freq_max {
                filtered_freqs.push(freq);
                filtered_mags.push(magnitudes_db[i]);
            }
        }

        let peaks = self.find_peaks(&filtered_freqs, &filtered_mags);

        SpectrumResult {
            frequencies: filtered_freqs,
            magnitudes_db: filtered_mags,
            peaks,
        }
    }

    /// Find spectral peaks
    fn find_peaks(&self, frequencies: &[f32], magnitudes: &[f32]) -> Vec<Peak> {
        let mut peaks = Vec::new();
        let threshold = -60.0; // dB threshold for peak detection

        // Simple peak detection: find local maxima
        for i in 1..magnitudes.len() - 1 {
            if magnitudes[i] > threshold
                && magnitudes[i] > magnitudes[i - 1]
                && magnitudes[i] > magnitudes[i + 1]
            {
                peaks.push(Peak {
                    frequency: frequencies[i],
                    magnitude_db: magnitudes[i],
                    index: i,
                });
            }
        }

        // Sort by magnitude (descending)
        peaks.sort_by(|a, b| b.magnitude_db.total_cmp(&a.magnitude_db));

        // Keep top 10 peaks
        peaks.truncate(10);
        peaks
    }

    /// Reset the analyzer: empty BOTH accumulation paths (power window and
    /// the coherent complex window) so the next frame starts from scratch
    /// whichever averaging mode is active.
    pub fn reset(&mut self) {
        self.power_buf.clear();
        self.complex_buf.clear();
    }

    /// Update configuration
    pub fn set_config(&mut self, config: SpectrumConfig) {
        self.config = config;
        self.reset();
    }

    /// Get current configuration
    pub fn get_config(&self) -> &SpectrumConfig {
        &self.config
    }
}

/// Waterfall display data structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaterfallData {
    /// Time axis (seconds)
    pub time: Vec<f32>,
    /// Frequency axis (Hz)
    pub frequencies: Vec<f32>,
    /// 2D magnitude data [time][frequency] in dB
    pub magnitudes: Vec<Vec<f32>>,
}

/// Waterfall display for time-frequency analysis
pub struct WaterfallDisplay {
    data: WaterfallData,
    max_time_samples: usize,
    time_offset: f32,
}

impl WaterfallDisplay {
    /// Create a new waterfall display
    pub fn new(max_time_samples: usize) -> Self {
        Self {
            data: WaterfallData {
                time: Vec::new(),
                frequencies: Vec::new(),
                magnitudes: Vec::new(),
            },
            max_time_samples,
            time_offset: 0.0,
        }
    }

    /// Add a new spectrum to the waterfall
    pub fn add_spectrum(&mut self, spectrum: &SpectrumResult, time_increment: f32) {
        // Initialize frequency axis on first call
        if self.data.frequencies.is_empty() {
            self.data.frequencies = spectrum.frequencies.clone();
        }

        // Add magnitude data
        self.data.magnitudes.push(spectrum.magnitudes_db.clone());
        self.data.time.push(self.time_offset);
        self.time_offset += time_increment;

        // Remove old data if exceeding max samples
        if self.data.magnitudes.len() > self.max_time_samples {
            self.data.magnitudes.remove(0);
            self.data.time.remove(0);
        }
    }

    /// Get waterfall data
    pub fn get_data(&self) -> &WaterfallData {
        &self.data
    }

    /// Clear waterfall data
    pub fn clear(&mut self) {
        self.data.magnitudes.clear();
        self.data.time.clear();
        self.time_offset = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_spectrum_analyzer() {
        let config = SpectrumConfig {
            fft_size: 1024,
            num_averages: 1,
            freq_min: 20.0,
            freq_max: 20000.0,
            log_scale: true,
        };

        let mut analyzer = SpectrumAnalyzer::new(config);
        let sample_rate = 48000;

        // Generate test signal
        let signal: Vec<f32> = (0..1024)
            .map(|i| {
                let t = i as f32 / sample_rate as f32;
                (2.0 * std::f32::consts::PI * 1000.0 * t).sin()
            })
            .collect();

        let result = analyzer.process(&signal, sample_rate);

        assert!(!result.frequencies.is_empty());
        assert_eq!(result.frequencies.len(), result.magnitudes_db.len());
    }

    /// "Reset avg": after reset() the next frame must start a FRESH window in
    /// both averaging modes — a stale accumulator (power) or complex window
    /// (coherent) would keep the pre-reset signal in the display for up to
    /// `num_averages` frames.
    #[test]
    fn test_reset_empties_both_averaging_paths() {
        let config = SpectrumConfig {
            fft_size: 1024,
            num_averages: 8,
            freq_min: 20.0,
            freq_max: 20000.0,
            log_scale: true,
        };
        let sample_rate = 48000;
        let loud: Vec<f32> = (0..1024)
            .map(|i| {
                let t = i as f32 / sample_rate as f32;
                0.9 * (2.0 * std::f32::consts::PI * 1000.0 * t).sin()
            })
            .collect();
        let silence = vec![0.0f32; 1024];

        for coherent in [false, true] {
            let mut analyzer = SpectrumAnalyzer::new(config.clone());
            analyzer.set_coherent(coherent);
            for _ in 0..4 {
                analyzer.process(&loud, sample_rate);
            }
            analyzer.reset();
            let after = analyzer.process(&silence, sample_rate);
            let peak = after
                .magnitudes_db
                .iter()
                .fold(f32::NEG_INFINITY, |m, &v| m.max(v));
            // A silent frame after reset must read silent — any remnant of the
            // 0.9-peak tone (≈ −3 dBFS) means an accumulator survived reset.
            assert!(
                peak < -80.0,
                "coherent={coherent}: stale averaging after reset (peak {peak} dBFS)"
            );
        }
    }

    /// Issue #10: power averaging must be a ROLLING window, like the coherent
    /// path. After 8 loud frames, one silent frame should still read ≈ the tone
    /// level (7 of the 8 window slots still hold it, 10·log10(7/8) ≈ −0.6 dB).
    /// A batch-and-reset accumulator instead starts over after frame N, so
    /// frame N+1 reads the silent frame alone (≈ −200 dB) — the "averages
    /// restart on the 8th average" a user reported.
    #[test]
    fn test_power_averaging_rolls_instead_of_resetting() {
        let config = SpectrumConfig {
            fft_size: 1024,
            num_averages: 8,
            freq_min: 20.0,
            freq_max: 20000.0,
            log_scale: true,
        };
        let sample_rate = 48000;
        let loud: Vec<f32> = (0..1024)
            .map(|i| {
                let t = i as f32 / sample_rate as f32;
                0.9 * (2.0 * std::f32::consts::PI * 1000.0 * t).sin()
            })
            .collect();
        let silence = vec![0.0f32; 1024];

        let mut analyzer = SpectrumAnalyzer::new(config);
        for _ in 0..8 {
            analyzer.process(&loud, sample_rate);
        }
        let ninth = analyzer.process(&silence, sample_rate);
        let peak = ninth
            .magnitudes_db
            .iter()
            .fold(f32::NEG_INFINITY, |m, &v| m.max(v));
        assert!(
            peak > -10.0,
            "window was dropped after frame 8: frame 9 reads {peak} dBFS instead of ≈ the tone level"
        );
    }
}

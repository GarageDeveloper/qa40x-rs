use std::f32::consts::PI;

/// Signal generator for test signals
pub struct SignalGenerator;

impl SignalGenerator {
    /// Generate sine wave.
    ///
    /// The phase is accumulated in f64 and wrapped to keep the argument small,
    /// otherwise `sin(2*pi*f*t)` in f32 loses precision as the argument grows
    /// (high frequency × large sample index), adding phase noise that shows up
    /// as a rising noise floor / degraded THD+N at high frequencies.
    pub fn sine(frequency: f32, amplitude: f32, sample_rate: u32, num_samples: usize) -> Vec<f32> {
        let two_pi = 2.0 * std::f64::consts::PI;
        let w = two_pi * frequency as f64 / sample_rate as f64;
        let amp = amplitude as f64;
        (0..num_samples)
            .map(|i| {
                let phase = (w * i as f64) % two_pi;
                (amp * phase.sin()) as f32
            })
            .collect()
    }

    /// Generate square wave
    pub fn square(frequency: f32, amplitude: f32, sample_rate: u32, num_samples: usize) -> Vec<f32> {
        (0..num_samples)
            .map(|i| {
                let t = i as f32 / sample_rate as f32;
                let phase = (2.0 * PI * frequency * t) % (2.0 * PI);
                if phase < PI {
                    amplitude
                } else {
                    -amplitude
                }
            })
            .collect()
    }

    /// Generate triangle wave
    pub fn triangle(frequency: f32, amplitude: f32, sample_rate: u32, num_samples: usize) -> Vec<f32> {
        (0..num_samples)
            .map(|i| {
                let t = i as f32 / sample_rate as f32;
                let phase = (frequency * t) % 1.0;
                amplitude * (4.0 * (phase - 0.5).abs() - 1.0)
            })
            .collect()
    }

    /// Generate sawtooth wave
    pub fn sawtooth(frequency: f32, amplitude: f32, sample_rate: u32, num_samples: usize) -> Vec<f32> {
        (0..num_samples)
            .map(|i| {
                let t = i as f32 / sample_rate as f32;
                let phase = (frequency * t) % 1.0;
                amplitude * (2.0 * phase - 1.0)
            })
            .collect()
    }

    /// Generate white noise
    pub fn white_noise(amplitude: f32, num_samples: usize) -> Vec<f32> {
        use rand::Rng;
        let mut rng = rand::thread_rng();
        (0..num_samples)
            .map(|_| amplitude * (rng.gen::<f32>() * 2.0 - 1.0))
            .collect()
    }

    /// Generate pink noise (1/f noise)
    pub fn pink_noise(amplitude: f32, num_samples: usize) -> Vec<f32> {
        use rand::Rng;
        let mut rng = rand::thread_rng();
        let mut b0 = 0.0;
        let mut b1 = 0.0;
        let mut b2 = 0.0;
        let mut b3 = 0.0;
        let mut b4 = 0.0;
        let mut b5 = 0.0;
        let mut b6 = 0.0;

        (0..num_samples)
            .map(|_| {
                let white = rng.gen::<f32>() * 2.0 - 1.0;
                b0 = 0.99886 * b0 + white * 0.0555179;
                b1 = 0.99332 * b1 + white * 0.0750759;
                b2 = 0.96900 * b2 + white * 0.1538520;
                b3 = 0.86650 * b3 + white * 0.3104856;
                b4 = 0.55000 * b4 + white * 0.5329522;
                b5 = -0.7616 * b5 - white * 0.0168980;
                let pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
                b6 = white * 0.115926;
                amplitude * pink * 0.11
            })
            .collect()
    }

    /// Generate a linear frequency sweep (chirp).
    pub fn chirp(
        start_freq: f32,
        end_freq: f32,
        amplitude: f32,
        sample_rate: u32,
        num_samples: usize,
    ) -> Vec<f32> {
        let duration = num_samples as f32 / sample_rate as f32;
        let k = (end_freq - start_freq) / duration;

        (0..num_samples)
            .map(|i| {
                let t = i as f32 / sample_rate as f32;
                let phase = 2.0 * PI * (start_freq * t + 0.5 * k * t * t);
                amplitude * phase.sin()
            })
            .collect()
    }

    /// Generate a logarithmic (exponential) frequency sweep — the Farina sweep.
    ///
    /// Equal energy per octave gives a far better low-frequency signal-to-noise
    /// ratio than a linear chirp, which is what makes the resulting frequency
    /// response usable down to 20 Hz. Short raised-cosine fades at both ends
    /// suppress the start/stop transient that would otherwise splatter across
    /// the spectrum.
    pub fn log_chirp(
        start_freq: f32,
        end_freq: f32,
        amplitude: f32,
        sample_rate: u32,
        num_samples: usize,
    ) -> Vec<f32> {
        if num_samples == 0 {
            return Vec::new();
        }
        let f0 = start_freq.max(1.0);
        let f1 = end_freq.max(f0 * 1.0001);
        let t_end = num_samples as f32 / sample_rate as f32;
        let ratio = (f1 / f0).ln();

        let fade_len = (num_samples / 20).max(1); // ~5% raised-cosine fade each end

        (0..num_samples)
            .map(|i| {
                let t = i as f32 / sample_rate as f32;
                let phase = 2.0 * PI * f0 * t_end / ratio * ((ratio * t / t_end).exp() - 1.0);
                let mut s = amplitude * phase.sin();

                // Fade in / fade out (raised cosine).
                if i < fade_len {
                    let w = 0.5 * (1.0 - (PI * i as f32 / fade_len as f32).cos());
                    s *= w;
                } else if i >= num_samples - fade_len {
                    let j = num_samples - 1 - i;
                    let w = 0.5 * (1.0 - (PI * j as f32 / fade_len as f32).cos());
                    s *= w;
                }
                s
            })
            .collect()
    }

    /// Generate multi-tone signal
    pub fn multitone(
        frequencies: &[f32],
        amplitudes: &[f32],
        sample_rate: u32,
        num_samples: usize,
    ) -> Vec<f32> {
        assert_eq!(frequencies.len(), amplitudes.len());

        let mut signal = vec![0.0; num_samples];

        for (&freq, &amp) in frequencies.iter().zip(amplitudes.iter()) {
            for (i, sample) in signal.iter_mut().enumerate() {
                let t = i as f32 / sample_rate as f32;
                *sample += amp * (2.0 * PI * freq * t).sin();
            }
        }

        signal
    }

    /// Generate DC signal
    pub fn dc(amplitude: f32, num_samples: usize) -> Vec<f32> {
        vec![amplitude; num_samples]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sine_generation() {
        let signal = SignalGenerator::sine(1000.0, 1.0, 48000, 48);
        assert_eq!(signal.len(), 48);
        assert!(signal[0].abs() < 0.1); // Should be close to 0 at start
    }

    #[test]
    fn test_multitone() {
        let freqs = vec![1000.0, 2000.0];
        let amps = vec![0.5, 0.5];
        let signal = SignalGenerator::multitone(&freqs, &amps, 48000, 1000);
        assert_eq!(signal.len(), 1000);
    }
}

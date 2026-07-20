//! Synthetic-signal validation of our measurement pipeline against known
//! theoretical values, mirroring a local-only reference script (kept out of
//! the public tree).
//!
//! We generate signals whose amplitude / THD / THD+N are known exactly, push
//! them through our REAL analysis path (`FftProcessor` → `AudioAnalyzer`), and
//! compare to theory. Run with:
//!     cargo test -p qa40x-rs --lib audio::validation -- --nocapture
//!
//! Both the reference and our pipeline integrate each tone over its window lobe
//! (the ratios make the coherent-gain / ENBW constants cancel). These tests
//! confirm the pipeline matches theory: RMS exact, THD and THD+N within a few
//! hundredths of a dB at 48 kHz / 32768.

#![cfg(test)]

use crate::audio::{AudioAnalyzer, FftProcessor, WindowFunction};
use std::f32::consts::PI;

const FS: u32 = 48000;
const N: usize = 32768;

/// A sine of `v_rms` volts RMS (peak = v_rms·√2), like the Python `sinus()`.
fn sinus(fs: u32, n: usize, f0: f32, v_rms: f32, phase: f32) -> Vec<f32> {
    (0..n)
        .map(|i| {
            let t = i as f32 / fs as f32;
            v_rms * 2f32.sqrt() * (2.0 * PI * f0 * t + phase).sin()
        })
        .collect()
}

fn db(x: f32) -> f32 {
    20.0 * x.log10()
}

/// Deterministic Gaussian noise (Box–Muller over a fixed LCG) so THD+N is
/// reproducible run to run.
struct Lcg(u64);
impl Lcg {
    fn unit(&mut self) -> f64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((self.0 >> 11) as f64) / ((1u64 << 53) as f64)
    }
    fn gauss(&mut self, sigma: f32) -> f32 {
        let u1 = self.unit().max(1e-12);
        let u2 = self.unit();
        (sigma as f64 * (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos()) as f32
    }
}

/// Our real spectrum path: Hann-windowed FFT → (linear magnitudes, frequencies).
fn our_spectrum(sig: &[f32]) -> (Vec<f32>, Vec<f32>) {
    let mut fft = FftProcessor::new();
    let r = fft.process_real_windowed(sig, FS, WindowFunction::Hann);
    (r.magnitudes, r.frequencies)
}

/// The 997 Hz signal with H2 = −60 dBc, H3 = −70 dBc (Python TEST 2).
fn harmonic_signal(n: usize) -> (f32, Vec<f32>) {
    let f0 = 997.0;
    let mut x = sinus(FS, n, f0, 1.0, 0.0);
    for (a, b) in x.iter_mut().zip(sinus(FS, n, 2.0 * f0, 10f32.powf(-60.0 / 20.0), 1.0)) {
        *a += b;
    }
    for (a, b) in x.iter_mut().zip(sinus(FS, n, 3.0 * f0, 10f32.powf(-70.0 / 20.0), 2.0)) {
        *a += b;
    }
    (f0, x)
}

const SIGMA: f32 = 100e-6; // 100 µV RMS wideband noise

/// Theoretical in-band (20 Hz–20 kHz) noise RMS for white noise of `SIGMA`.
fn theory_band_noise() -> f32 {
    SIGMA * ((20000.0 - 20.0) / (FS as f32 / 2.0)).sqrt()
}

#[test]
fn rms_matches_theory() {
    // Time-domain RMS is what the app shows as "level" — must be exact.
    let x = sinus(FS, N, 997.0, 1.0, 0.0);
    let rms = AudioAnalyzer::calculate_rms(&x);
    let d = db(rms) - 0.0; // 1 Vrms → 0 dBV
    println!("RMS       ours={:+.3} dB  theory=+0.000 dB  delta={:+.3} dB", db(rms), d);
    assert!(d.abs() < 0.05, "RMS off by {:.3} dB", d);
}

#[test]
fn thd_matches_theory() {
    let (f0, x) = harmonic_signal(N);
    let (mags, freqs) = our_spectrum(&x);
    let thd = AudioAnalyzer::calculate_thd(&mags, &freqs, f0, 10) / 100.0;
    let ours = db(thd);
    let theory = 10.0 * (10f32.powf(-60.0 / 10.0) + 10f32.powf(-70.0 / 10.0)).log10();
    println!("THD       ours={:+.3} dB  theory={:+.3} dB  delta={:+.3} dB", ours, theory, ours - theory);
    assert!((ours - theory).abs() < 0.1, "THD off by {:.3} dB (tol 0.1)", ours - theory);
}

/// Minimal WAV reader → mono f32 [-1,1] (channel 0), for real captures exported
/// from the official QA40x app. Supports PCM 16/24/32-bit and IEEE float32.
#[cfg(test)]
fn read_wav_mono(path: &str) -> (u32, Vec<f32>) {
    let b = std::fs::read(path).expect("read wav");
    assert_eq!(&b[0..4], b"RIFF", "not a RIFF file");
    assert_eq!(&b[8..12], b"WAVE", "not a WAVE file");
    let (mut fmt, mut chans, mut rate, mut bits) = (1u16, 1u16, 48000u32, 16u16);
    let (mut data_off, mut data_len) = (0usize, 0usize);
    let mut i = 12usize;
    while i + 8 <= b.len() {
        let id = &b[i..i + 4];
        let sz = u32::from_le_bytes([b[i + 4], b[i + 5], b[i + 6], b[i + 7]]) as usize;
        let body = i + 8;
        if id == b"fmt " {
            fmt = u16::from_le_bytes([b[body], b[body + 1]]);
            chans = u16::from_le_bytes([b[body + 2], b[body + 3]]);
            rate = u32::from_le_bytes([b[body + 4], b[body + 5], b[body + 6], b[body + 7]]);
            bits = u16::from_le_bytes([b[body + 14], b[body + 15]]);
        } else if id == b"data" {
            data_off = body;
            data_len = sz.min(b.len() - body);
        }
        i = body + sz + (sz & 1); // chunks are word-aligned
    }
    assert!(data_off > 0, "no data chunk");
    let bytes_per = (bits / 8) as usize;
    let frame = bytes_per * chans as usize;
    let mut out = Vec::with_capacity(data_len / frame);
    let mut p = data_off;
    while p + frame <= data_off + data_len {
        let s = &b[p..p + bytes_per]; // channel 0 only
        let v = match (fmt, bits) {
            (3, 32) => f32::from_le_bytes([s[0], s[1], s[2], s[3]]),
            (1, 16) => i16::from_le_bytes([s[0], s[1]]) as f32 / 32768.0,
            (1, 24) => {
                let x = ((s[0] as i32) | ((s[1] as i32) << 8) | ((s[2] as i32) << 16)) << 8;
                (x >> 8) as f32 / 8_388_608.0
            }
            (1, 32) => i32::from_le_bytes([s[0], s[1], s[2], s[3]]) as f32 / 2_147_483_648.0,
            _ => panic!("unsupported WAV format {fmt} / {bits}-bit"),
        };
        out.push(v);
        p += frame;
    }
    (rate, out)
}

/// Compare our DSP against the official QA40x app on a REAL exported capture
/// (local-only fixture, git-ignored). This is a regression guard against
/// QuantAsylum: on a 999.75 Hz / -12 dBV loopback the QA40x app (v1.220)
/// reported THD -101.57 dB and THD+N -94.28 dB; our pipeline on the same
/// samples must stay within a few tenths of a dB. Skipped when the fixture is
/// absent. Override the file/level with QA_WAV / QA_FSDBV.
#[test]
fn compare_with_qa40x_wav() {
    let default_wav =
        concat!(env!("CARGO_MANIFEST_DIR"), "/../doc/samples/qa40x-1khz-loopback-192k.wav");
    let path = std::env::var("QA_WAV").unwrap_or_else(|_| default_wav.to_string());
    if !std::path::Path::new(&path).exists() {
        eprintln!("skipping: WAV fixture not present at {path} (set QA_WAV to override)");
        return;
    }
    let fs_dbv: f32 = std::env::var("QA_FSDBV").ok().and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let (rate, sig) = read_wav_mono(&path);
    println!("WAV: {} samples @ {} Hz", sig.len(), rate);

    // Fundamental: our detected peak near 1 kHz (report whatever it is).
    let mut fft = FftProcessor::new();
    let sp = fft.process_real_windowed(&sig, rate, WindowFunction::Hann);
    // crude peak find in 500–2000 Hz to get the fundamental
    let bin_hz = rate as f32 / sig.len() as f32;
    let (mut pk_i, mut pk) = (0usize, 0.0f32);
    for (k, &m) in sp.magnitudes.iter().enumerate() {
        let f = k as f32 * bin_hz;
        if f > 500.0 && f < 2000.0 && m > pk {
            pk = m;
            pk_i = k;
        }
    }
    let f0 = pk_i as f32 * bin_hz;

    let rms = AudioAnalyzer::calculate_rms(&sig);
    let level_dbv = db(rms) + fs_dbv; // dBFS + full-scale offset → dBV
    let thd = AudioAnalyzer::calculate_thd(&sp.magnitudes, &sp.frequencies, f0, 10) / 100.0;
    let thdn = AudioAnalyzer::calculate_thd_n(&sp.magnitudes, &sp.frequencies, f0, 20000.0) / 100.0;
    println!("f0        = {:.2} Hz", f0);
    println!("Level     = {:+.2} dBV   ({:.1} mVrms)", level_dbv, rms * 1000.0);
    println!("THD       = {:.5} %   ({:+.2} dB)   QA40x: -101.57 dB", thd * 100.0, db(thd));
    println!("THD+N     = {:.5} %   ({:+.2} dB)   QA40x:  -94.28 dB", thdn * 100.0, db(thdn));

    // Regression guard: agreement with the QA40x app on the committed capture.
    // (Skipped only if a custom QA_WAV is supplied.)
    if std::env::var("QA_WAV").is_err() {
        assert!((f0 - 999.75).abs() < 1.0, "f0 drifted: {f0:.2} Hz");
        assert!((db(thd) - (-101.57)).abs() < 0.4, "THD vs QA40x off: {:.2} dB", db(thd));
        assert!((db(thdn) - (-94.28)).abs() < 0.4, "THD+N vs QA40x off: {:.2} dB", db(thdn));
    }
}

// The sweep path (measure_thd_point) uses AudioAnalyzer::thd_suite, a SEPARATE
// THD/THD+N implementation. Validate it on the same signal so THD-vs-frequency
// sweeps are as trustworthy as the live tiles.
#[test]
fn thd_suite_matches_theory() {
    let (f0, mut x) = harmonic_signal(N);
    let mut rng = Lcg(42);
    for v in x.iter_mut() {
        *v += rng.gauss(SIGMA);
    }
    let (thd_ratio, thdn_ratio, _fund) = AudioAnalyzer::thd_suite(&x, FS, f0, 10);
    let thd_db = db(thd_ratio);
    let thdn_db = db(thdn_ratio);
    let thd_theory = 10.0 * (10f32.powf(-60.0 / 10.0) + 10f32.powf(-70.0 / 10.0)).log10();
    let p_harm = 10f32.powf(-60.0 / 10.0) + 10f32.powf(-70.0 / 10.0);
    let thdn_theory = 10.0 * (p_harm + theory_band_noise().powi(2)).log10();
    println!("suite THD   ours={:+.3} dB  theory={:+.3} dB  delta={:+.3} dB", thd_db, thd_theory, thd_db - thd_theory);
    println!("suite THD+N ours={:+.3} dB  theory={:+.3} dB  delta={:+.3} dB", thdn_db, thdn_theory, thdn_db - thdn_theory);
    assert!((thd_db - thd_theory).abs() < 0.2, "sweep THD off by {:.3} dB", thd_db - thd_theory);
    assert!((thdn_db - thdn_theory).abs() < 0.5, "sweep THD+N off by {:.3} dB", thdn_db - thdn_theory);
}

#[test]
fn thdn_matches_theory() {
    let (f0, mut x) = harmonic_signal(N);
    let mut rng = Lcg(42);
    for v in x.iter_mut() {
        *v += rng.gauss(SIGMA);
    }
    let (mags, freqs) = our_spectrum(&x);
    let thdn = AudioAnalyzer::calculate_thd_n(&mags, &freqs, f0, 20000.0) / 100.0;
    let ours = db(thdn);
    let p_harm = 10f32.powf(-60.0 / 10.0) + 10f32.powf(-70.0 / 10.0);
    let p_noise = theory_band_noise().powi(2);
    let theory = 10.0 * (p_harm + p_noise).log10();
    println!("THD+N     ours={:+.3} dB  theory={:+.3} dB  delta={:+.3} dB", ours, theory, ours - theory);
    assert!((ours - theory).abs() < 0.3, "THD+N off by {:.3} dB (tol 0.3)", ours - theory);
}

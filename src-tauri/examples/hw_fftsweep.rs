//! FFT-size sweep on the loopback: does the noise floor drop as the FFT grows
//! (expected: finer bins → lower per-bin floor), or does it stay/rise (a
//! large-acquisition capture artifact)? Also reports THD / THD+N per size.
//!
//! Wiring: OUT L+ -> IN L+, IN L- terminated. GUI app must be disconnected.
//! Run with: cargo run --example hw_fftsweep

use tauri_app_lib::audio::{AudioAnalyzer, FftProcessor, WindowFunction};
use tauri_app_lib::qa40x::{Channel, InputGain, OutputGain, QA40xDevice, SampleRate};
use tauri_app_lib::utils::SignalGenerator;

/// Median dBFS of the noise floor: all bins in [20, 20k] Hz except a ±40 Hz
/// zone around the fundamental and each harmonic (up to the 10th).
fn noise_floor_db(mags: &[f32], freqs: &[f32], fund: f32) -> f32 {
    let mut v: Vec<f32> = Vec::new();
    for (i, &f) in freqs.iter().enumerate() {
        if !(20.0..=20_000.0).contains(&f) {
            continue;
        }
        let mut near = false;
        for h in 1..=10 {
            if (f - fund * h as f32).abs() < 40.0 {
                near = true;
                break;
            }
        }
        if !near {
            v.push(20.0 * mags[i].max(1e-12).log10());
        }
    }
    if v.is_empty() {
        return f32::NAN;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

#[tokio::main]
async fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn")).init();
    let device = QA40xDevice::new();
    println!("== Connecting (GUI must be disconnected) ==");
    if let Err(e) = device.connect().await {
        eprintln!("connect failed: {e}\n→ Disconnect the app (GUI) first — single connection only.");
        std::process::exit(1);
    }
    // Match the official test: input 0 dBV FS, output -12 dBV so the loopback
    // tone (~-12 dBV) sits well under the 0 dBV input full-scale — no overload,
    // no input attenuator. (Driving hotter than 0 dBV into input 0 dBV trips the
    // ADC-protection attenuator, which then reads ~40 dB low.)
    // Toggle the input gain to clear any attenuator left engaged from a prior run.
    device.set_input_gain(InputGain::Gain6dBV).await.unwrap();
    device.set_input_gain(InputGain::Gain0dBV).await.unwrap();
    device.set_output_gain(OutputGain::GainMinus2dBV).await.unwrap();
    device.set_sample_rate(SampleRate::Rate48kHz).await.unwrap();
    let cfg = device.get_config().await;
    println!(
        "config: input={} dBV  output={} dBV  rate={} Hz",
        cfg.input_gain.as_dbv(), cfg.output_gain.as_dbv(), cfg.sample_rate.as_hz()
    );

    let sr = 48_000u32;
    // -12 dBV output at the -2 dBV range = -10 dBFS DAC = 0.316 linear.
    let amp = 0.316f32;
    const GUARD: usize = 4096;

    println!("\n== FFT-size sweep @ 48k, input 0 dBV, out -2 dBV, tone ~1 kHz (-12 dBV), Hann ==");
    println!(
        "  {:>9}  {:>10}  {:>12}  {:>10}  {:>10}  {:>12}",
        "NFFT", "THD %", "THD+N %", "fund dBFS", "RMS dBFS", "floor dBFS"
    );

    let mut fftp = FftProcessor::new();

    for &nfft in &[8_192usize, 16_384, 65_536, 262_144] {
        // Snap 1 kHz to an exact bin (round to eliminate leakage).
        let bin = (1000.0 * nfft as f32 / sr as f32).round().max(1.0);
        let fb = bin * sr as f32 / nfft as f32;

        let segn = nfft + 2 * GUARD;
        let tone = SignalGenerator::sine(fb, amp, sr, segn);
        let silence = vec![0.0f32; tone.len()];
        let cap = match device.generate_and_capture(&tone, &silence).await {
            Ok(c) => c,
            Err(e) => {
                println!("  {:>9}  capture failed: {e}", nfft);
                continue;
            }
        };
        // Take a clean NFFT window past the lead-in guard.
        let start = GUARD.min(cap.left_channel.len().saturating_sub(nfft));
        let end = (start + nfft).min(cap.left_channel.len());
        let seg = &cap.left_channel[start..end];
        if seg.len() < nfft {
            println!("  {:>9}  short capture: {} samples", nfft, seg.len());
            continue;
        }

        // Captured RMS in dBFS (unambiguous level check).
        let rms = (seg.iter().map(|&x| (x as f64) * (x as f64)).sum::<f64>() / seg.len() as f64)
            .sqrt();
        let rms_dbfs = 20.0 * (rms.max(1e-12)).log10();

        let (thd, thd_n, _) = AudioAnalyzer::thd_suite(seg, sr, fb, 7);

        let fr = fftp.process_real_windowed(seg, sr, WindowFunction::Hann);
        let floor = noise_floor_db(&fr.magnitudes, &fr.frequencies, fb);
        // Fundamental level in dBFS.
        let fbin = (fb * nfft as f32 / sr as f32).round() as usize;
        let fund_db = 20.0
            * fr.magnitudes
                .get(fbin)
                .copied()
                .unwrap_or(0.0)
                .max(1e-12)
                .log10();

        println!(
            "  {:>9}  {:>10.5}  {:>12.5}  {:>10.1}  {:>10.1}  {:>12.1}",
            nfft,
            thd * 100.0,
            thd_n * 100.0,
            fund_db,
            rms_dbfs,
            floor
        );
    }

    // Continuous-loop test at 8192, mimicking the GUI live loop: many back-to-
    // back generate_and_capture calls, measured on the last frame. If the floor
    // here is much higher than the single discrete 8192 capture above, the live
    // continuous path is the noise source.
    {
        let nfft = 8_192usize;
        let bin = (1000.0 * nfft as f32 / sr as f32).round().max(1.0);
        let fb = bin * sr as f32 / nfft as f32;
        let segn = nfft + 2 * GUARD;
        let tone = SignalGenerator::sine(fb, amp, sr, segn);
        let silence = vec![0.0f32; tone.len()];
        let mut last = None;
        for _ in 0..30 {
            if let Ok(c) = device.generate_and_capture(&tone, &silence).await {
                last = Some(c);
            }
        }
        if let Some(cap) = last {
            let start = GUARD.min(cap.left_channel.len().saturating_sub(nfft));
            let seg = &cap.left_channel[start..(start + nfft).min(cap.left_channel.len())];
            let (thd, thd_n, _) = AudioAnalyzer::thd_suite(seg, sr, fb, 7);
            let fr = fftp.process_real_windowed(seg, sr, WindowFunction::Hann);
            let floor = noise_floor_db(&fr.magnitudes, &fr.frequencies, fb);
            println!(
                "\n== Continuous loop @ 8192 (30 back-to-back, like live) ==\n  THD {:.5}% | THD+N {:.5}% | floor {:.1} dBFS",
                thd * 100.0, thd_n * 100.0, floor
            );
        }
    }

    // Reproduce the GUI buffer: generate EXACTLY nfft samples of tone (no guard),
    // capture nfft, analyze the returned block. If this floor jumps up to ~-127
    // like the GUI, the edge transient (tone start/end clipped by the latency
    // shift) is the noise source.
    for &nfft in &[8_192usize, 262_144] {
        let bin = (1000.0 * nfft as f32 / sr as f32).round().max(1.0);
        let fb = bin * sr as f32 / nfft as f32;
        let tone = SignalGenerator::sine(fb, amp, sr, nfft); // exactly nfft, no guard
        let silence = vec![0.0f32; tone.len()];
        if let Ok(cap) = device.generate_and_capture(&tone, &silence).await {
            let n = cap.left_channel.len().min(nfft);
            let seg = &cap.left_channel[..n];
            let (thd, thd_n, _) = AudioAnalyzer::thd_suite(seg, sr, fb, 7);
            let fr = fftp.process_real_windowed(seg, sr, WindowFunction::Hann);
            let floor = noise_floor_db(&fr.magnitudes, &fr.frequencies, fb);
            println!(
                "== GUI-style buffer (exactly {} samples, no guard) ==\n  THD {:.5}% | THD+N {:.5}% | floor {:.1} dBFS",
                nfft, thd * 100.0, thd_n * 100.0, floor
            );
        }
    }

    // Calibrated level check at the safe level: out -2 dBV @ -10 dBFS = -12 dBV
    // output → should loop back to ~-12 dBV at the input (unity), NOT ~-54.
    println!("\n== Level check: 1 kHz, out -2 dBV @ -10 dBFS (-12 dBV out), in 0 dBV ==");
    match device
        .measure_levels(Channel::Left, Channel::Left, 1.0, true, 1000.0, -10.0)
        .await
    {
        Ok(lv) => println!(
            "  captured: {:.2} dBFS | {:.5} Vrms | {:.2} dBV (expect ~-12 dBV / 0.25 Vrms if unity)",
            lv.rms_dbfs, lv.rms_vrms, lv.rms_dbv
        ),
        Err(e) => println!("  measure_levels failed: {e}"),
    }

    device.disconnect().await.unwrap();
    println!("\nDone.");
}

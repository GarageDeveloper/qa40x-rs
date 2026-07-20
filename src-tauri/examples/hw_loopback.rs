//! Hardware loopback validation for the QA402.
//!
//! Wiring assumption: OUT L+ -> IN L+, OUT R+ -> IN R+, IN L-/R- terminated.
//! Run with: cargo run --example hw_loopback [--release]
//!
//! Exercises connection, register read-back, acquisition, and frequency
//! response, then prints coherence statistics (a loopback response must be
//! flat).

use tauri_app_lib::qa40x::{Channel, InputGain, OutputGain, QA40xDevice, SampleRate};

fn stats(label: &str, freqs: &[f32], mags: &[f32], lo: f32, hi: f32) {
    let band: Vec<f32> = freqs
        .iter()
        .zip(mags.iter())
        .filter(|(f, _)| **f >= lo && **f <= hi)
        .map(|(_, m)| *m)
        .collect();
    if band.is_empty() {
        println!("{label}: no points in {lo}-{hi} Hz band");
        return;
    }
    let mean = band.iter().sum::<f32>() / band.len() as f32;
    let var = band.iter().map(|m| (m - mean).powi(2)).sum::<f32>() / band.len() as f32;
    let min = band.iter().cloned().fold(f32::INFINITY, f32::min);
    let max = band.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    println!(
        "{label}: {} pts in {lo}-{hi} Hz | mean {mean:.2} dB | std {:.3} dB | min {min:.2} | max {max:.2} | p-p {:.3} dB",
        band.len(),
        var.sqrt(),
        max - min
    );
}

#[tokio::main]
async fn main() {
    env_logger::init();

    let device = QA40xDevice::new();
    println!("== Connecting ==");
    device.connect().await.expect("connect failed");

    println!("== Configuring: input FS 6 dBV, output FS -2 dBV, 48 kHz ==");
    device.set_input_gain(InputGain::Gain6dBV).await.unwrap();
    device
        .set_output_gain(OutputGain::GainMinus2dBV)
        .await
        .unwrap();
    device.set_sample_rate(SampleRate::Rate48kHz).await.unwrap();

    let cfg = device.read_config_from_device().await.expect("read config");
    println!(
        "Read-back config: input {} dBV, output {} dBV, rate {} Hz",
        cfg.input_gain.as_dbv(),
        cfg.output_gain.as_dbv(),
        cfg.sample_rate.as_hz()
    );

    println!("\n== Acquisition (silence on DAC), 32768 samples ==");
    let acq = device.acquire_data(32768).await.expect("acquire failed");
    let rms_l = (acq.left_channel.iter().map(|x| x * x).sum::<f32>()
        / acq.left_channel.len() as f32)
        .sqrt();
    let rms_r = (acq.right_channel.iter().map(|x| x * x).sum::<f32>()
        / acq.right_channel.len() as f32)
        .sqrt();
    println!(
        "Acquired {} samples/ch | RMS L {:.1} dBFS | RMS R {:.1} dBFS (should be low: noise floor)",
        acq.left_channel.len(),
        20.0 * rms_l.max(1e-12).log10(),
        20.0 * rms_r.max(1e-12).log10()
    );

    println!("\n== Frequency response L->L, 20 Hz - 20 kHz, 2 s ==");
    let fr = device
        .measure_frequency_response(20.0, 20000.0, Channel::Left, Channel::Left, 2.0, -6.0)
        .await
        .expect("freq response failed");
    println!("Points: {}", fr.frequencies.len());
    stats("  full band ", &fr.frequencies, &fr.magnitudes_db, 20.0, 20000.0);
    stats("  mid band  ", &fr.frequencies, &fr.magnitudes_db, 100.0, 10000.0);

    // Print a decimated table
    let n = fr.frequencies.len();
    let step = (n / 24).max(1);
    for i in (0..n).step_by(step) {
        println!(
            "  {:>9.1} Hz  {:>8.2} dB  {:>8.1} deg",
            fr.frequencies[i], fr.magnitudes_db[i], fr.phases[i]
        );
    }

    println!("\n== Frequency response R->R, 20 Hz - 20 kHz, 2 s ==");
    let frr = device
        .measure_frequency_response(20.0, 20000.0, Channel::Right, Channel::Right, 2.0, -6.0)
        .await
        .expect("freq response failed");
    stats("  mid band  ", &frr.frequencies, &frr.magnitudes_db, 100.0, 10000.0);

    println!("\n== Tone + harmonics (1 kHz @ -6 dBFS, generate+capture via loopback) ==");
    let fs = 48000u32;
    let n = 32768usize;
    let tone = tauri_app_lib::utils::SignalGenerator::sine(1000.0, 0.5, fs, n);
    let silence = vec![0.0f32; n];
    // Output the tone on Left, capture the loopback.
    let captured = device
        .generate_and_capture(&tone, &silence)
        .await
        .expect("generate_and_capture failed");
    let harm = tauri_app_lib::audio::AudioAnalyzer::analyze_harmonics(
        &captured.left_channel,
        captured.sample_rate,
        1000.0,
        7,
    );
    println!(
        "  fundamental {:.1} Hz | THD {:.5}% ({:.1} dB)",
        harm.fundamental_freq, harm.thd_percent, harm.thd_db
    );
    for h in &harm.harmonics {
        println!(
            "    H{}: {:>8.1} Hz  {:>7.1} dBFS  {:>7.1} dBc",
            h.n, h.frequency, h.magnitude_db, h.magnitude_dbc
        );
    }

    device.disconnect().await.unwrap();
    println!("\nDone.");
}

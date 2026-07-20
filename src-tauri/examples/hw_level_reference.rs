//! Settle the generator level reference: is `level` in dBV peak- or RMS-referenced?
//!
//! Task #48. `GeneratorParams.level` is documented as "the target OUTPUT level
//! in dBV". The app turns it into a waveform *amplitude* (a PEAK) via
//! `amplitude = 10^((level - output_range)/20)` — but dBV is an RMS unit. Either
//! we are systematically 3.01 dB low on every sine, or `level` is really
//! peak-dBV and is mislabelled.
//!
//! The decisive part needs no trust in the calibration: a **sine and a square at
//! the same `level`** go through the identical input path, so their *difference*
//! is a calibration-free readout of the convention.
//!
//!   - amplitude is PEAK  → sine RMS = level - 3.01, square RMS = level
//!                          → square - sine = +3.01 dB
//!   - amplitude is RMS   → both read `level`
//!                          → square - sine = 0 dB
//!
//! The absolute readings then say which of the two is the *intended* one.
//!
//! Loopback required (OUT L -> IN L). Close the desktop app first: the device
//! is single-connection.
//!
//! Run with: cargo run --example hw_level_reference [--release]

use tauri_app_lib::qa40x::types::{Channel, InputGain, OutputGain, SampleRate};
use tauri_app_lib::qa40x::QA40xDevice;
use tauri_app_lib::sources::Waveform;

const SR: u32 = 48_000;
const N: usize = 16_384;
/// Output range under test. Fixed (not auto) so `level -> amplitude` is exact.
const OUT_RANGE_DBV: i32 = 8;
/// Input range: well clear of the attenuator threshold (it engages at >= 24 dBV)
/// and with headroom for the hottest level below.
const IN_RANGE_DBV: i32 = 6;

/// The app's own conversion (src/main.ts `generatorLevelToDbfs` + the amplitude
/// it feeds to the generator): level dBV -> dBFS -> a linear PEAK amplitude.
fn app_amplitude(level_dbv: f32) -> f32 {
    let dbfs = (level_dbv - OUT_RANGE_DBV as f32).clamp(-120.0, 0.0);
    10f32.powf(dbfs / 20.0)
}

/// RMS of a full-scale-referenced digital block, in dBFS.
fn rms_dbfs(x: &[f32]) -> f32 {
    let sum: f64 = x.iter().map(|&v| (v as f64) * (v as f64)).sum();
    let rms = (sum / x.len() as f64).sqrt();
    20.0 * (rms.max(1e-12)).log10() as f32
}

/// Snap to an exact FFT bin so an integer number of cycles fills the block —
/// makes the RMS of the captured window exact rather than window-dependent.
fn snap(freq: f32) -> f32 {
    let bin = ((freq * N as f32) / SR as f32).round().max(1.0);
    bin * SR as f32 / N as f32
}

#[tokio::main]
async fn main() {
    env_logger::init();
    let device = QA40xDevice::new();

    println!("== Level reference probe — POST crest-factor fix (task #48/#46) ==");
    if let Err(e) = device.connect().await {
        eprintln!("connect failed: {e}");
        eprintln!("If the desktop app is open it holds the single connection — close it and retry.");
        std::process::exit(1);
    }

    device.set_sample_rate(SampleRate::try_from(SR).unwrap()).await.expect("sample rate");
    device
        .set_output_gain(OutputGain::from_dbv(OUT_RANGE_DBV).expect("output range"))
        .await
        .expect("set output range");
    device
        .set_input_gain(InputGain::from_dbv(IN_RANGE_DBV).expect("input range"))
        .await
        .expect("set input range");

    // Relays are mechanical: let them settle before the first capture, or we
    // measure a contact mid-flight (the very thing task #46 is about).
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

    let (dbv_off, calibrated) = device.input_dbv_offset(Channel::Left).await;
    println!(
        "output range {OUT_RANGE_DBV:+} dBV | input range {IN_RANGE_DBV:+} dBV | \
         dBFS->dBV offset {dbv_off:+.2} dB (calibrated: {calibrated})"
    );
    if !calibrated {
        println!("  ! calibration page unavailable — ABSOLUTE dBV below is approximate.");
        println!("    The square-minus-sine delta is still exact (same input path).");
    }

    let freq = snap(997.0);
    println!("\ntone {freq:.3} Hz (bin-snapped), {N} samples\n");
    println!(
        "{:>8} | {:>9} | {:>11} | {:>11} | {:>9}",
        "level", "amp(peak)", "sine RMS", "square RMS", "sq - sin"
    );
    println!("{}", "-".repeat(62));

    let mut deltas = Vec::new();
    for level in [-12.0f32, -20.0, -30.0] {
        let amp = app_amplitude(level);
        let silence = vec![0.0f32; N];

        let sine = Waveform::Sine.generate(freq, amp, SR, N);
        let cap_s = device.generate_and_capture(&sine, &silence).await.expect("sine capture");
        let sine_dbv = rms_dbfs(&cap_s.left_channel) + dbv_off;

        let square = Waveform::Square.generate(freq, amp, SR, N);
        let cap_q = device.generate_and_capture(&square, &silence).await.expect("square capture");
        let square_dbv = rms_dbfs(&cap_q.left_channel) + dbv_off;

        let delta = square_dbv - sine_dbv;
        deltas.push(delta);
        println!(
            "{level:>+7.1} | {amp:>9.5} | {sine_dbv:>+10.2} | {square_dbv:>+10.2} | {delta:>+8.2}"
        );
    }

    // --- Does the crest-factor model predict every waveform, or only the square?
    // If `level` is the RMS of a SINE, then for a waveform of crest factor CF the
    // RMS lands at level + 20*log10(sqrt(2)/CF). Sine CF=sqrt(2) -> 0 dB;
    // square CF=1 -> +3.01; triangle & sawtooth CF=sqrt(3) -> -1.76.
    println!("\n== Crest-factor model check (level -12 dBV) ==");
    println!("{:>10} | {:>9} | {:>9} | {:>8}", "waveform", "measured", "predicted", "err");
    println!("{}", "-".repeat(44));
    let amp = app_amplitude(-12.0);
    let silence = vec![0.0f32; N];
    let sqrt2 = 2f32.sqrt();
    let sqrt3 = 3f32.sqrt();
    let cases: [(&str, Vec<f32>, f32); 4] = [
        ("sine", Waveform::Sine.generate(freq, amp, SR, N), sqrt2),
        ("square", Waveform::Square.generate(freq, amp, SR, N), 1.0),
        ("triangle", Waveform::Triangle.generate(freq, amp, SR, N), sqrt3),
        ("sawtooth", Waveform::Sawtooth.generate(freq, amp, SR, N), sqrt3),
    ];
    for (name, wave, cf) in cases {
        let cap = device.generate_and_capture(&wave, &silence).await.expect("capture");
        let measured = rms_dbfs(&cap.left_channel) + dbv_off;
        let _ = cf;
        let predicted = -12.0f32; // post-fix: EVERY waveform must land at `level`
        println!(
            "{name:>10} | {measured:>+8.2} | {predicted:>+8.2} | {:>+7.2}",
            measured - predicted
        );
    }
    println!("(a constant err across rows = loopback/cal offset, not a model failure)");

    // --- Verdict. Two independent readings, and they answer different questions:
    // the ABSOLUTE sine reading says whether the sine chain is right; the
    // square-minus-sine delta says whether `level` means the same thing for
    // every waveform.
    let mean_delta = deltas.iter().sum::<f32>() / deltas.len() as f32;
    let sine_at_12 = {
        let amp = app_amplitude(-12.0);
        let silence = vec![0.0f32; N];
        let sine = Waveform::Sine.generate(freq, amp, SR, N);
        let cap = device.generate_and_capture(&sine, &silence).await.expect("final sine");
        rms_dbfs(&cap.left_channel) + dbv_off
    };

    println!("\n== Verdict ==");
    println!("sine requested -12.00 dBV -> measured {sine_at_12:+.2} dBV");
    println!("mean (square - sine)      = {mean_delta:+.2} dB");

    let sine_ok = (sine_at_12 + 12.0).abs() < 1.0;
    if sine_ok {
        println!(
            "\n  The SINE chain is correct: the output range's dBV is the RMS of a sine\n  \
             (full-scale peak = 10^(R/20)*sqrt(2)), so a sine requested at L lands at L dBV RMS."
        );
    } else {
        println!("\n  ! The sine itself is off by {:+.2} dB — investigate before anything else.", sine_at_12 + 12.0);
    }

    if mean_delta.abs() < 0.6 {
        println!("  And every waveform is RMS-normalized: `level` means the same thing for all. Nothing to fix.");
    } else {
        println!(
            "\n  But `level` is SINE-REFERENCED, not waveform-neutral: the amplitude fed to the\n  \
             generator is a PEAK, so a waveform of crest factor CF lands at\n      \
             level + 20*log10(sqrt(2)/CF)\n  \
             i.e. square (CF=1) {:+.2} dB hot, triangle/sawtooth (CF=sqrt(3)) {:+.2} dB low.\n  \
             Two sources set to the same `level` do NOT produce the same RMS — which is exactly\n  \
             what a mixer must not tolerate.\n\n  \
             Fix: divide the amplitude by the waveform's crest factor (relative to a sine) so\n  \
             `level` is an RMS target for every waveform. Sines are unaffected — no regression\n  \
             on anything already validated.",
            20.0 * (2f32.sqrt() / 1.0).log10(),
            20.0 * (2f32.sqrt() / 3f32.sqrt()).log10(),
        );
    }

    device.disconnect().await.ok();
}

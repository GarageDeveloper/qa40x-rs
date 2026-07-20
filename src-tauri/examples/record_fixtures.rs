//! Record REAL QA402 loopback captures as JSON fixtures (task #54).
//!
//! The UI harness (branch history: test/e2e-playwright) replays frames through a
//! fake backend. Replaying REAL captured samples instead of synthetic ones buys
//! three things: README/doc screenshots show genuine measurements (not invented
//! numbers, which on a measurement instrument would be dishonest); tests are
//! deterministic; and the fake stops encoding my assumptions — recorded frames
//! are reality.
//!
//! Each fixture is one raw stereo capture plus the config context needed to
//! interpret it. The frontend does its OWN real FFT + level conversion on these
//! samples, so nothing here bakes in an analysis result.
//!
//! Loopback required (OUT L -> IN L, and OUT R -> IN R for the stereo cases).
//! Close the desktop app first. Writes tests/e2e/fixtures/*.json.
//!
//! Run with: cargo run --example record_fixtures [--release]

use std::io::Write;

use tauri_app_lib::qa40x::types::{InputGain, OutputGain, SampleRate};
use tauri_app_lib::qa40x::QA40xDevice;
use tauri_app_lib::utils::SignalGenerator;

const SR: u32 = 48_000;
const N: usize = 8_192;

/// Digital peak that produces `level` dBV RMS for a sine out of output range `r`
/// (sine-RMS full-scale convention, verified in #48).
fn sine_amp(level_dbv: f32, r: i32) -> f32 {
    10f32.powf((level_dbv - r as f32) / 20.0)
}

/// A minimal, self-describing fixture line. The replay side (fake FrameProvider)
/// reads these; keep the field names stable.
fn write_fixture(
    dir: &str,
    name: &str,
    input_range_dbv: i32,
    output_range_dbv: i32,
    driven: &str,
    left: &[f32],
    right: &[f32],
) {
    let path = format!("{dir}/{name}.json");
    let mut f = std::fs::File::create(&path).expect("create fixture");
    // Hand-rolled JSON: no serde dependency needed for a flat record, and it
    // keeps the float formatting explicit (7 sig figs — plenty for a capture).
    let arr = |x: &[f32]| {
        let mut s = String::from("[");
        for (i, v) in x.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            s.push_str(&format!("{v:.7}"));
        }
        s.push(']');
        s
    };
    write!(
        f,
        "{{\n  \"name\": \"{name}\",\n  \"sampleRate\": {SR},\n  \
         \"inputRangeDbv\": {input_range_dbv},\n  \"outputRangeDbv\": {output_range_dbv},\n  \
         \"driven\": \"{driven}\",\n  \"n\": {},\n  \"left\": {},\n  \"right\": {}\n}}\n",
        left.len(),
        arr(left),
        arr(right)
    )
    .expect("write fixture");
    println!("  wrote {path} ({} samples/ch)", left.len());
}

#[tokio::main]
async fn main() {
    env_logger::init();
    // Repo-root tests/e2e/fixtures, computed from the crate dir so it lands in
    // the right place no matter cargo's CWD (which is the package dir).
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/e2e/fixtures");
    std::fs::create_dir_all(dir).expect("mkdir fixtures");

    let device = QA40xDevice::new();
    println!("== Fixture recorder (task #54) — writing to {dir}/ ==");
    if let Err(e) = device.connect().await {
        eprintln!("connect failed: {e}");
        eprintln!("If the desktop app is open it holds the single connection — close it and retry.");
        std::process::exit(1);
    }
    device.set_sample_rate(SampleRate::try_from(SR).unwrap()).await.expect("rate");

    let out_r = 8;
    let in_r = 18; // headroom for -12 dBV, below the attenuator boundary
    device.set_output_gain(OutputGain::from_dbv(out_r).unwrap()).await.expect("out");
    device.set_input_gain(InputGain::from_dbv(in_r).unwrap()).await.expect("in");

    let freq = {
        let bin = ((1000.0 * N as f32) / SR as f32).round().max(1.0);
        bin * SR as f32 / N as f32
    };
    let amp = sine_amp(-12.0, out_r);
    let silence = vec![0.0f32; N];
    let sine = SignalGenerator::sine(freq, amp, SR, N);
    let square = SignalGenerator::square(freq, amp, SR, N);

    // A settling throwaway capture so the first fixture isn't a cold-start frame.
    let _ = device.generate_and_capture(&silence, &silence).await;

    // 1. Idle — the device's own noise floor, both channels silent.
    let cap = device.generate_and_capture(&silence, &silence).await.expect("idle");
    write_fixture(dir, "idle", in_r, out_r, "none", &cap.left_channel, &cap.right_channel);

    // 2. Sine 1 kHz -12 dBV on L only.
    let cap = device.generate_and_capture(&sine, &silence).await.expect("sine-l");
    write_fixture(dir, "sine-1k-left", in_r, out_r, "left", &cap.left_channel, &cap.right_channel);

    // 3. Square 1 kHz -12 dBV on R only (the crest-factor / harmonics case).
    let cap = device.generate_and_capture(&silence, &square).await.expect("square-r");
    write_fixture(dir, "square-1k-right", in_r, out_r, "right", &cap.left_channel, &cap.right_channel);

    // 4. The stereo mix: sine on L, square on R at once (the sine+square scenario
    //    that started the whole Traces V2 rework — for the README hero shot).
    let cap = device.generate_and_capture(&sine, &square).await.expect("mix");
    write_fixture(dir, "mix-sine-l-square-r", in_r, out_r, "both", &cap.left_channel, &cap.right_channel);

    // 5. A quiet sine (-40 dBV) — a low-level frame so the noise floor is visible.
    let quiet = SignalGenerator::sine(freq, sine_amp(-40.0, out_r), SR, N);
    let cap = device.generate_and_capture(&quiet, &silence).await.expect("quiet");
    write_fixture(dir, "sine-1k-quiet-left", in_r, out_r, "left", &cap.left_channel, &cap.right_channel);

    println!("\nDone. These are real QA402 loopback captures — the frontend runs its\n\
              own FFT/level conversion on them, so replayed screenshots show real data.");

    device.set_input_gain(InputGain::from_dbv(42).unwrap()).await.ok();
    device.disconnect().await.ok();
}

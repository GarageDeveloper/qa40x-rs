//! Measure the per-frame IPC payload cost at the FFT extremes (M6 decision:
//! keep JSON frames or move the Channel to a binary payload).
//!
//! No hardware needed: builds a realistic worst-case `StreamFrame` (full-range
//! noise-ish samples so the JSON digit count is honest, all four spectra
//! requested) and times what the wire actually costs on the Rust side:
//! `serde_json::to_vec` (what a Tauri Channel does per message) versus a raw
//! f32 concat (the planned binary path). The JS half of the measurement lives
//! in the companion node script (JSON.parse + Float64Array.from of the same
//! payload).
//!
//! Run with: cargo run --release --example bench_stream_payload

use std::time::Instant;

use tauri_app_lib::qa40x::types::AudioData;
use tauri_app_lib::stream::{
    ClipState, LevelOffsetsDb, MeasuresMsg, MixStatus, ScopeMeasures, ScopeStat, SpectraMsg,
    StereoFrame, StreamFrame, StreamMetrics, StreamMsg, StreamStats, TriggerMsg,
};

/// A representative fully-populated stat (value + full window).
fn scope_stat(v: f64) -> ScopeStat {
    ScopeStat { value: Some(v), avg: v, min: v * 0.99, max: v * 1.01, sd: v * 0.001, n: 100 }
}

/// Deterministic full-scale-ish samples with noisy mantissas — a constant or a
/// pure sine serializes to unrealistically few digits and flatters JSON.
fn samples(n: usize, seed: u32) -> Vec<f32> {
    let mut x = seed | 1;
    (0..n)
        .map(|_| {
            // xorshift32
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            (x as f32 / u32::MAX as f32) * 1.9 - 0.95
        })
        .collect()
}

fn frame(n: usize) -> StreamMsg {
    let bins = n / 2 + 1;
    let mag = |seed| samples(bins, seed).iter().map(|v| v * 90.0 - 100.0).collect::<Vec<f32>>();
    StreamMsg::Frame(Box::new(StreamFrame {
        seq: 123_456,
        device_id: Some("usb/AB12_CD34".into()),
        captured: AudioData {
            left_channel: samples(n, 2),
            right_channel: samples(n, 3),
            sample_rate: 48_000,
        },
        stimulus: Some(StereoFrame {
            left: samples(n, 4),
            right: samples(n, 5),
        }),
        spectra: SpectraMsg {
            frequencies: (0..bins).map(|i| i as f32 * 48_000.0 / n as f32).collect(),
            input_l: Some(mag(6)),
            input_r: Some(mag(7)),
            output_l: Some(mag(8)),
            output_r: Some(mag(9)),
        },
        metrics: StreamMetrics {
            input_l: None,
            input_r: None,
            harmonics_l: None,
            harmonics_r: None,
        },
        trigger: TriggerMsg::default(),
        // One populated endpoint: the bench exists to pin payload growth,
        // and an all-None suite would pin the 0-cost case (review lot B #6).
        // 7 stats × 6 numbers is the per-endpoint worst case.
        measures: MeasuresMsg {
            input_l: Some(ScopeMeasures {
                vpp: scope_stat(0.710),
                vmean: scope_stat(0.001),
                rms_ac: scope_stat(0.251),
                freq_hz: scope_stat(1000.488),
                rise_s: scope_stat(296e-6),
                fall_s: scope_stat(297e-6),
                duty: scope_stat(0.5),
            }),
            ..MeasuresMsg::default()
        },
        mix: MixStatus {
            sigma_peak_dbv: Some(-3.2),
            clip_input: ClipState::None,
            clip_output: false,
            fitted_output_range_dbv: 8,
        },
        offsets: LevelOffsetsDb {
            input_l: 20.81,
            input_r: 20.79,
            output_l: 11.03,
            output_r: 11.01,
            calibrated: true,
        },
        stats: StreamStats {
            frames: 42,
            fps: 0.04,
            frame_ms: 21_845.0,
        },
        errors: vec![],
    }))
}

fn main() {
    for &n in &[32_768usize, 262_144, 1_048_576] {
        let msg = frame(n);

        let t = Instant::now();
        let json = serde_json::to_vec(&msg).expect("serialize");
        let ser_ms = t.elapsed().as_secs_f64() * 1e3;

        // Binary path: the six f32 buffers memcpy'd after a small JSON header.
        let (td, bins) = (n, n / 2 + 1);
        let t = Instant::now();
        let mut raw = Vec::with_capacity((4 * td + 5 * bins) * 4 + 256);
        if let StreamMsg::Frame(f) = &msg {
            for buf in [
                &f.captured.left_channel,
                &f.captured.right_channel,
                &f.stimulus.as_ref().unwrap().left,
                &f.stimulus.as_ref().unwrap().right,
                &f.spectra.frequencies,
                f.spectra.input_l.as_ref().unwrap(),
                f.spectra.input_r.as_ref().unwrap(),
                f.spectra.output_l.as_ref().unwrap(),
                f.spectra.output_r.as_ref().unwrap(),
            ] {
                for v in buf.iter() {
                    raw.extend_from_slice(&v.to_le_bytes());
                }
            }
        }
        let bin_ms = t.elapsed().as_secs_f64() * 1e3;

        let frame_s = n as f64 / 48_000.0;
        println!(
            "FFT {:>9}: JSON {:>6.1} MB in {:>7.1} ms | raw f32 {:>6.1} MB in {:>6.1} ms | frame period {:.1} s @48k",
            n,
            json.len() as f64 / 1e6,
            ser_ms,
            raw.len() as f64 / 1e6,
            bin_ms,
            frame_s
        );

        if n == 1_048_576 {
            std::fs::write("/tmp/qa40x-bench-frame-1m.json", &json).expect("write");
            println!("  wrote /tmp/qa40x-bench-frame-1m.json for the JS half");
        }
    }
}

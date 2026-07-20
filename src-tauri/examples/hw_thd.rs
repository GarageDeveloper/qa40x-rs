//! THD / THD+N sweep validation on the loopback.
//! Wiring: OUT L+ -> IN L+, OUT R+ -> IN R+, IN L-/R- terminated.
//! Run with: cargo run --example hw_thd

use tauri_app_lib::qa40x::{Channel, InputGain, OutputGain, QA40xDevice, SampleRate};

#[tokio::main]
async fn main() {
    env_logger::init();
    let device = QA40xDevice::new();
    println!("== Connecting ==");
    device.connect().await.expect("connect failed");
    device.set_input_gain(InputGain::Gain6dBV).await.unwrap();
    device
        .set_output_gain(OutputGain::GainMinus2dBV)
        .await
        .unwrap();
    device.set_sample_rate(SampleRate::Rate48kHz).await.unwrap();

    println!("\n== THD vs frequency (-6 dBFS, L->L) ==");
    println!(
        "  {:>9}  {:>10}  {:>12}  {:>10}",
        "freq Hz", "THD %", "THD+N %", "fund dBFS"
    );
    for f in [100.0, 200.0, 500.0, 1000.0, 2000.0, 5000.0, 10000.0] {
        let pt = device
            .measure_thd_point(f, -6.0, Channel::Left, Channel::Left)
            .await
            .expect("thd point failed");
        println!(
            "  {:>9.1}  {:>10.5}  {:>12.5}  {:>10.2}   (THD {:.1} dB, THD+N {:.1} dB)",
            pt.frequency, pt.thd_percent, pt.thd_n_percent, pt.fundamental_dbfs, pt.thd_db, pt.thd_n_db
        );
    }

    println!("\n== THD vs level @ 1 kHz (L->L) ==");
    for lvl in [-40.0, -20.0, -12.0, -6.0, -1.0] {
        let pt = device
            .measure_thd_point(1000.0, lvl, Channel::Left, Channel::Left)
            .await
            .expect("thd point failed");
        println!(
            "  {:>6.0} dBFS -> THD {:.5}% ({:.1} dB) | THD+N {:.5}% ({:.1} dB) | fund {:.2} dBFS",
            lvl, pt.thd_percent, pt.thd_db, pt.thd_n_percent, pt.thd_n_db, pt.fundamental_dbfs
        );
    }

    println!("\n== Wow & flutter (3150 Hz, generate+capture loopback, 4 s) ==");
    let wf = device
        .measure_wow_flutter(3150.0, 4.0, Channel::Left, Channel::Left, true)
        .await
        .expect("w&f failed");
    println!(
        "  weighted RMS {:.4}% | unweighted RMS {:.4}% | peak {:.4}% | static offset {:.3} Hz",
        wf.weighted_rms_percent, wf.unweighted_rms_percent, wf.peak_weighted_percent, wf.static_offset_hz
    );
    println!(
        "  (loopback is clock-stable, so all should be ~0; demod rate {:.0} Hz, {} spectrum pts)",
        wf.demod_rate,
        wf.rate_hz.len()
    );

    println!("\n== Levels: 1 kHz tone @ -6 dBFS, output +18 dBV / input +18 dBV ==");
    device.set_output_gain(OutputGain::Gain18dBV).await.unwrap();
    device.set_input_gain(InputGain::Gain18dBV).await.unwrap();
    let lv = device
        .measure_levels(Channel::Left, Channel::Left, 1.0, true, 1000.0, -6.0)
        .await
        .expect("levels failed");
    println!(
        "  RMS {:.2} dBFS | {:.4} Vrms | {:.2} dBV | {:.2} dBu | peak {:.2} dBFS | calibrated={}",
        lv.rms_dbfs, lv.rms_vrms, lv.rms_dbv, lv.rms_dbu, lv.peak_dbfs, lv.calibrated
    );
    println!("  (expect ~4 Vrms for +18 dBV FS driven at -6 dBFS)");

    println!("\n== Noise floor: silence, input +6 dBV, A-weighted ==");
    device.set_input_gain(InputGain::Gain6dBV).await.unwrap();
    let nz = device
        .measure_levels(Channel::Left, Channel::Left, 2.0, false, 0.0, 0.0)
        .await
        .expect("noise failed");
    println!(
        "  RMS {:.1} dBFS (unweighted) | {:.1} dBFS (A) | {:.1} dBV | {:.1} dBV (A) | peak {:.1} dBFS",
        nz.rms_dbfs, nz.rms_a_dbfs, nz.rms_dbv, nz.rms_a_dbv, nz.peak_dbfs
    );

    println!("\n== Batched THD sweep (single stream, 6 freqs, -6 dBFS) ==");
    device.set_output_gain(OutputGain::GainMinus2dBV).await.unwrap();
    device.set_input_gain(InputGain::Gain6dBV).await.unwrap();
    let sr = 48000u32;
    const NFFT: usize = 32768;
    const GUARD: usize = 2048;
    let segn = NFFT + 2 * GUARD;
    let freqs = [100.0f32, 300.0, 1000.0, 3000.0, 6000.0, 10000.0];
    let mut tone: Vec<f32> = Vec::new();
    let mut bins = Vec::new();
    for f in freqs {
        let bin = (f * NFFT as f32 / sr as f32).round().max(1.0);
        let fb = bin * sr as f32 / NFFT as f32;
        bins.push(fb);
        tone.extend(tauri_app_lib::utils::SignalGenerator::sine(fb, 0.5, sr, segn));
    }
    let silence = vec![0.0f32; tone.len()];
    let cap = device
        .generate_and_capture(&tone, &silence)
        .await
        .expect("batch capture failed");
    println!("  one stream captured {} samples", cap.left_channel.len());
    for (i, fb) in bins.iter().enumerate() {
        let start = i * segn + GUARD;
        let end = (start + NFFT).min(cap.left_channel.len());
        let (thd, thd_n, _) =
            tauri_app_lib::audio::AudioAnalyzer::thd_suite(&cap.left_channel[start..end], sr, *fb, 7);
        println!(
            "  {:>8.1} Hz -> THD {:.5}% ({:.1} dB) | THD+N {:.5}%",
            fb,
            thd * 100.0,
            20.0 * thd.max(1e-12).log10(),
            thd_n * 100.0
        );
    }

    device.disconnect().await.unwrap();
    println!("\nDone.");
}

//! End-to-end exercise of the embedded virtual QA40x (demo mode): connect,
//! identity, register bus, a real-time-paced generate-and-capture through the
//! simulated loopback, then detach/reattach. No hardware, no USB — this is
//! the same path the app's "Demo" button drives.

use tauri_app_lib::qa40x::{Channel, InputGain, OutputGain, QA40xDevice};
use tauri_app_lib::utils::SignalGenerator;

/// The embedded simulator is one per process (the single-attach guard): tests
/// in this binary must not attach concurrently.
static SIM_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test(flavor = "multi_thread")]
async fn virtual_demo_device_connect_capture_reconnect() {
    let _sim = SIM_LOCK.lock().await;
    let device = QA40xDevice::new();
    device.connect_virtual().await.expect("virtual connect");

    let meta = device.device_meta().await.expect("meta after connect");
    assert!(meta.is_virtual);
    assert_eq!(meta.model, "QA403");
    assert!(
        !meta.supports_flash,
        "the demo device must never offer a firmware flash"
    );
    assert_eq!(meta.sample_rates.last().copied(), Some(384_000));
    assert!(device.is_present().await);
    assert!(device.check_physical_connection().await);

    // Telemetry rides the same register bus as hardware.
    let t = device.read_telemetry().await.expect("telemetry");
    assert!(
        t.usb_voltage_v > 4.0 && t.usb_voltage_v < 6.0,
        "USB voltage {} V",
        t.usb_voltage_v
    );

    // A tone through the simulated DAC→ADC loopback comes back at the level
    // the range/calibration model predicts. At out 8 dBV / in 18 dBV the
    // digital gain is outFS − inFS + 9 − trims ≈ −9.5 dB, so a 0.5-peak sine
    // captures at ≈ 0.17 — the bounds stay loose against trim details.
    device.set_input_gain(InputGain::Gain18dBV).await.unwrap();
    device.set_output_gain(OutputGain::Gain8dBV).await.unwrap();
    let tone = SignalGenerator::sine(1000.0, 0.5, 48_000, 4_800);
    let captured = device
        .generate_and_capture(&tone, &tone)
        .await
        .expect("generate_and_capture through the virtual loopback");
    assert_eq!(captured.sample_rate, 48_000);
    let peak = |ch: &[f32]| ch.iter().fold(0f32, |m, s| m.max(s.abs()));
    let (l, r) = (peak(&captured.left_channel), peak(&captured.right_channel));
    assert!(l > 0.05 && l < 0.5, "left loopback peak {l}");
    assert!(r > 0.05 && r < 0.5, "right loopback peak {r}");

    device.disconnect().await.expect("disconnect");
    assert!(!device.is_connected().await);
    assert!(!device.is_present().await, "no bus presence once detached");

    // The single-attach guard must release on disconnect: a second demo
    // session (same simulator, state kept) attaches cleanly.
    device.connect_virtual().await.expect("virtual reconnect");
    assert!(device.is_connected().await);
    device.disconnect().await.expect("second disconnect");
}

/// Issue #8 closure: a dBV-denominated stimulus pre-compensated by the
/// per-unit DAC trims must come back — through the sim's calibrated
/// DAC→loopback→ADC chain and the ADC-calibrated readout — at exactly the
/// commanded level. Without the trims the +8 dBV range reads ~0.36 dB (L) /
/// ~0.42 dB (R) hot (the trims of the sim's real factory page — the same
/// offsets the A/B bench measured on hardware), so the 0.1 dB bound fails.
#[tokio::test(flavor = "multi_thread")]
async fn dbv_stimulus_lands_at_the_commanded_level_once_trimmed() {
    let _sim = SIM_LOCK.lock().await;
    let device = QA40xDevice::new();
    device.connect_virtual().await.expect("virtual connect");
    device.set_input_gain(InputGain::Gain6dBV).await.unwrap();
    device.set_output_gain(OutputGain::Gain8dBV).await.unwrap();

    let (trims, calibrated) = device.dac_trims().await;
    assert!(calibrated, "the sim serves a real factory calibration page");

    // −10 dBV on the +8 dBV range: ideal digital amplitude 10^(−18/20),
    // then the per-channel trim (the REST acquisition path's math).
    let sr = 48_000u32;
    let n = 4_800usize;
    let ideal = 10f32.powf((-10.0 - 8.0) / 20.0);
    let left = SignalGenerator::sine(1000.0, ideal * trims.0, sr, n);
    let right = SignalGenerator::sine(1000.0, ideal * trims.1, sr, n);
    let captured = device
        .generate_and_capture(&left, &right)
        .await
        .expect("loopback capture");

    // RMS over the LAST 70 % — an integer 70 cycles of 1 kHz, clear of the
    // sim's loopback latency (1200 zero samples lead the returned window) —
    // converted to dBV through the ADC calibration.
    let level_dbv = |sig: &[f32], offset_db: f32| -> f32 {
        let tail = &sig[3 * n / 10..];
        let rms = (tail.iter().map(|s| s * s).sum::<f32>() / tail.len() as f32).sqrt();
        20.0 * rms.log10() + offset_db
    };
    let (off_l, cal_l) = device.input_dbv_offset(Channel::Left).await;
    let (off_r, _) = device.input_dbv_offset(Channel::Right).await;
    assert!(cal_l, "ADC side reads the same calibration page");
    let l = level_dbv(&captured.left_channel, off_l);
    let r = level_dbv(&captured.right_channel, off_r);
    assert!((l + 10.0).abs() < 0.1, "left loopback level {l} dBV, commanded -10");
    assert!((r + 10.0).abs() < 0.1, "right loopback level {r} dBV, commanded -10");

    device.disconnect().await.expect("disconnect");
}

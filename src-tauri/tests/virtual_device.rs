//! End-to-end exercise of the embedded virtual QA40x (demo mode): connect,
//! identity, register bus, a real-time-paced generate-and-capture through the
//! simulated loopback, then detach/reattach. No hardware, no USB — this is
//! the same path the app's "Demo" button drives.

use tauri_app_lib::qa40x::{InputGain, OutputGain, QA40xDevice};
use tauri_app_lib::utils::SignalGenerator;

#[tokio::test(flavor = "multi_thread")]
async fn virtual_demo_device_connect_capture_reconnect() {
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

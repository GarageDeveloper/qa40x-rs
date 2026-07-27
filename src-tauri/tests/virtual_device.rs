//! End-to-end exercise of the embedded virtual QA40x (demo mode): connect,
//! identity, register bus, a real-time-paced generate-and-capture through the
//! simulated loopback, then detach/reattach. No hardware, no USB — this is
//! the same path the app's "Demo" button drives.

use std::sync::Arc;
use std::time::{Duration, Instant};

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

/// Issue #28 review point 3: `measure_wow_flutter` clamps `reference_freq`
/// to a safe sub-Nyquist range and reports the frequency it ACTUALLY used
/// (not the raw request) in `WowFlutterResult::reference_freq` — above the
/// clamp, both the generated tone and the heterodyne demodulation would
/// alias silently. The default sample rate is 48 kHz (Nyquist 24 kHz), so
/// the upper clamp is `24_000 * 0.9 = 21_600` Hz. Asking for 50 kHz (above
/// even the sample rate itself) through a real generate+capture loopback
/// must land the reported frequency at the clamp, not at 50 kHz.
#[tokio::test(flavor = "multi_thread")]
async fn wow_flutter_reference_freq_is_clamped_below_nyquist() {
    let _sim = SIM_LOCK.lock().await;
    let device = QA40xDevice::new();
    device.connect_virtual().await.expect("virtual connect");

    let result = device
        .measure_wow_flutter(50_000.0, 2.0, Channel::Left, Channel::Left, true, None)
        .await
        .expect("a clamped, in-range tone must still be a valid measurement");
    assert!(
        (result.reference_freq - 21_600.0).abs() < 1.0,
        "reference_freq {} was not clamped to 21600 Hz (0.9 * Nyquist at 48 kHz)",
        result.reference_freq
    );

    device.disconnect().await.expect("disconnect");
}

/// Issue #28: `measure_wow_flutter` takes the SAME cooperative-cancel flag
/// the batched THD sweep uses (`Option<&AtomicBool>`) so a Stop button can
/// abort a long capture. A flag that is ALREADY set before the call starts
/// must abort the very first block rather than being checked too late (or
/// not at all) — the caller (`lib.rs::measure_wow_flutter`) maps this
/// specific variant to "wow & flutter measurement cancelled", which the
/// frontend matches on to show a "stopped" toast instead of an error one
/// (see `src/panels/programs/wowflutterdialog.ts`'s `message.includes(
/// "cancelled")` and `wow-flutter.pw.ts`'s Stop test — both exercise the
/// fake device, not this real cancel path).
#[tokio::test(flavor = "multi_thread")]
async fn wow_flutter_honors_a_preset_cancel_flag() {
    let _sim = SIM_LOCK.lock().await;
    let device = QA40xDevice::new();
    device.connect_virtual().await.expect("virtual connect");

    let cancel = std::sync::atomic::AtomicBool::new(true);
    let err = device
        .measure_wow_flutter(3150.0, 2.0, Channel::Left, Channel::Left, true, Some(&cancel))
        .await
        .expect_err("a pre-armed cancel flag must abort the capture, not run it to completion");
    assert!(
        matches!(err, tauri_app_lib::qa40x::QA40xError::Cancelled),
        "unexpected error: {err:?}"
    );

    device.disconnect().await.expect("disconnect");
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

/// Issue #54: during a capture the stream pump itself must fire the LINK
/// keepalive at ~1 Hz (`QA40xDevice::pump_keepalive_if_due`), not just once
/// before the stream starts (`run_keepalive_if_due`) — otherwise a long FFT's
/// single capture leaves the LINK LED to time out mid-run. The embedded
/// simulator is real-time-paced at the sample rate, so a ~3 s @ 48 kHz
/// capture takes ~3 s of wall time, long enough for the 1 Hz rate limiter to
/// let more than one in-capture keepalive through.
///
/// The test isolates the in-capture path from the ordinary pre-stream ping:
/// a `keepalive()` fired immediately before starting the capture consumes
/// the shared rate-limit slot, so `run_keepalive_if_due` (called first thing
/// inside `stream_io`) is itself rate-limited away — every stamp recorded
/// strictly after that baseline can only have come from
/// `pump_keepalive_if_due`, run from inside the collection loop while the
/// pump holds the endpoint mutex for the whole capture.
#[tokio::test(flavor = "multi_thread")]
async fn in_capture_keepalive_fires_at_roughly_1hz_during_a_long_capture() {
    let _sim = SIM_LOCK.lock().await;
    let device = Arc::new(QA40xDevice::new());
    device.connect_virtual().await.expect("virtual connect");

    // Fresh connect: neither the keepalive stamp nor the telemetry cache has
    // been touched yet (connect/init never call `keepalive`/`read_telemetry`
    // — only the idle-poll command, the between-stream ping and the
    // in-capture ping do).
    assert!(device.last_keepalive_at().await.is_none());
    assert!(device.last_telemetry().await.is_none());

    // Baseline keepalive: stamps `last_keepalive` right before the capture
    // starts, so the capture's own pre-stream ping is rate-limited away and
    // every later stamp is attributable to the in-capture path.
    device.keepalive().await.expect("baseline keepalive");
    let baseline = device
        .last_keepalive_at()
        .await
        .expect("baseline stamp recorded");
    assert!(device.last_telemetry().await.is_some());

    // ~3.1 s @ 48 kHz: long enough for the ~1 Hz rate limiter to open more
    // than one slot during the capture, short enough to keep the test fast.
    let sr = 48_000u32;
    let n = 150_000usize;
    let tone = SignalGenerator::sine(1000.0, 0.2, sr, n);

    // Watcher: polls `last_keepalive_at()` — a mutex read with no device I/O,
    // so it never blocks on or contends with the pump holding `eps` for the
    // whole capture — and records every distinct stamp it observes.
    let watcher_dev = device.clone();
    let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<()>();
    let watcher = tokio::spawn(async move {
        let mut stamps: Vec<Instant> = Vec::new();
        loop {
            if let Some(t) = watcher_dev.last_keepalive_at().await {
                if stamps.last() != Some(&t) {
                    stamps.push(t);
                }
            }
            tokio::select! {
                _ = &mut stop_rx => break,
                _ = tokio::time::sleep(Duration::from_millis(50)) => {}
            }
        }
        stamps
    });

    let captured = device
        .generate_and_capture(&tone, &tone)
        .await
        .expect("generate_and_capture through the virtual loopback");

    let _ = stop_tx.send(());
    let stamps = watcher.await.expect("watcher task");

    // The capture must come back intact regardless of the interleaved
    // register I/O.
    assert_eq!(captured.sample_rate, sr);
    assert_eq!(captured.left_channel.len(), n, "left channel truncated");
    assert_eq!(captured.right_channel.len(), n, "right channel truncated");

    // Every stamp after the baseline was fired DURING this capture (nothing
    // else in this test calls `keepalive`/`run_keepalive_if_due` again), and
    // since the baseline consumed the rate-limit slot right before the
    // capture started, these can only be `pump_keepalive_if_due` firings.
    let in_capture = stamps.iter().filter(|t| **t > baseline).count();
    assert!(
        in_capture >= 2,
        "expected the pump to fire the in-capture keepalive at least twice \
         during a ~3 s capture (~1 Hz), got {in_capture} stamps after baseline: {stamps:?}"
    );

    // `last_telemetry` (refreshed by the SAME in-capture keepalive cycle,
    // see `pump_keepalive_if_due`) must have moved past the baseline too.
    let after = device
        .last_keepalive_at()
        .await
        .expect("stamp after capture");
    assert!(
        after > baseline,
        "last_keepalive_at did not advance past the pre-capture baseline"
    );
    assert!(device.last_telemetry().await.is_some());

    device.disconnect().await.expect("disconnect");
}

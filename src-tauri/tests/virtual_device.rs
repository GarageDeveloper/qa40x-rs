//! End-to-end exercise of the embedded virtual QA40x (demo mode): connect,
//! identity, register bus, a real-time-paced generate-and-capture through the
//! simulated loopback, then detach/reattach. No hardware, no USB — this is
//! the same path the app's "Demo" button drives.

use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri_app_lib::device::{DeviceRuntime, I2sRequest};
use tauri_app_lib::mixer::{MixerSlotDesc, SlotSource};
use tauri_app_lib::qa40x::i2s::I2sWidth;
use tauri_app_lib::qa40x::register::{registers, RegisterOps};
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

/* -------------------------------------------------------------------------- */
/* Front-panel I2S output (issue #71)                                          */
/* -------------------------------------------------------------------------- */

/// A runtime attached to the embedded virtual QA403 — the I2S tests drive
/// the engine exactly as the `i2s_apply` command does.
async fn connected_runtime() -> DeviceRuntime {
    let rt = DeviceRuntime::new();
    {
        let handle = rt.handle();
        let dev = handle.lock().await;
        dev.connect_virtual().await.expect("virtual connect");
    }
    rt
}

fn i2s_sine_request(enabled: bool) -> I2sRequest {
    I2sRequest {
        enabled,
        slots: vec![MixerSlotDesc {
            id: "tone".into(),
            source: SlotSource::Waveform {
                waveform: "sine".into(),
                frequency_hz: 1000.0,
                amplitude: 0.5,
            },
            route: "both".into(),
            enabled: true,
        }],
        reference_dbv: 0.0,
        width: I2sWidth::Bits32,
    }
}

/// The whole port protocol against the simulator's real EP3 sink: apply →
/// register 0x0A reads 1 and device-paced blocks flow (~23.4/s at 48 kHz);
/// a re-apply while running swaps the mix WITHOUT restarting the writer;
/// disable → register reads 0 and the writer exits.
#[tokio::test(flavor = "multi_thread")]
async fn i2s_streams_paced_blocks_and_stop_is_visible_on_the_register() {
    let _sim = SIM_LOCK.lock().await;
    let rt = connected_runtime().await;
    let engine = rt.i2s();

    let st = engine.apply(i2s_sine_request(true)).await.expect("i2s start");
    assert!(st.supported && st.enabled && st.running);
    assert_eq!(st.width_bits, 32);
    assert!(st.sigma_peak_dbv.is_some(), "a 0.5 sine mix is not silent");
    assert!(!st.clipped);

    // The simulator readable-registers path: 0x0A reads back 1 while the
    // port runs (vqa40x-core v0.5.0).
    let reg = {
        let handle = rt.handle();
        let dev = handle.lock().await;
        dev.read_register(registers::I2S_CTRL).await.expect("read 0x0A")
    };
    assert_eq!(u32::from_be_bytes([reg[0], reg[1], reg[2], reg[3]]), 1);

    // Device-paced flow: ~1 s must accept roughly 23 blocks (2048 frames @
    // 48 kHz each). Loose bounds — pacing jitter and the two primed blocks.
    tokio::time::sleep(Duration::from_secs(1)).await;
    let blocks = engine.status().await.blocks_written;
    assert!(
        (10..=40).contains(&blocks),
        "expected ~23 device-paced blocks in 1 s, got {blocks}"
    );

    // Re-mix while running: no register cycle, the writer keeps its pace.
    let st = engine.apply(i2s_sine_request(true)).await.expect("i2s re-mix");
    assert!(st.running, "a re-apply must not stop the port");

    let st = engine.apply(i2s_sine_request(false)).await.expect("i2s stop");
    assert!(!st.enabled && !st.running);
    let reg = {
        let handle = rt.handle();
        let dev = handle.lock().await;
        dev.read_register(registers::I2S_CTRL).await.expect("read 0x0A")
    };
    assert_eq!(u32::from_be_bytes([reg[0], reg[1], reg[2], reg[3]]), 0);

    rt.handle().lock().await.disconnect().await.expect("disconnect");
}

/// THE acceptance pin of issue #71: the I2S stream, a long acquisition and
/// the ~1 Hz keepalive all run CONCURRENTLY — no endpoint is serialized
/// behind another (device notes §10). During one real-time ~3 s capture,
/// I2S blocks keep flowing AND completed keepalive cycles keep counting,
/// while the capture itself comes back intact.
#[tokio::test(flavor = "multi_thread")]
async fn i2s_keeps_flowing_during_a_long_capture_while_the_keepalive_still_fires() {
    let _sim = SIM_LOCK.lock().await;
    let rt = connected_runtime().await;
    let engine = rt.i2s();

    engine.apply(i2s_sine_request(true)).await.expect("i2s start");

    let (blocks_before, keepalives_before, tone, sr, n) = {
        let handle = rt.handle();
        let dev = handle.lock().await;
        // Same ranges as the plain loopback test: at out 8 dBV / in 18 dBV
        // a 0.2-peak sine captures at ≈ 0.068 (the connect forces the safe
        // 42 dBV input range, which would bury the tone).
        dev.set_input_gain(InputGain::Gain18dBV).await.unwrap();
        dev.set_output_gain(OutputGain::Gain8dBV).await.unwrap();
        // Baseline keepalive so later count deltas are in-capture firings.
        dev.keepalive().await.expect("baseline keepalive");
        let sr = 48_000u32;
        let n = 150_000usize; // ~3.1 s of real-time-paced capture
        (
            engine.status().await.blocks_written,
            dev.keepalive_ok_count(),
            SignalGenerator::sine(1000.0, 0.2, sr, n),
            sr,
            n,
        )
    };

    let captured = {
        let handle = rt.handle();
        let dev = handle.lock().await;
        dev.generate_and_capture(&tone, &tone)
            .await
            .expect("capture with the I2S port streaming")
    };

    // The capture is intact — the I2S stream corrupted nothing.
    assert_eq!(captured.sample_rate, sr);
    assert_eq!(captured.left_channel.len(), n);
    let peak = captured
        .left_channel
        .iter()
        .fold(0f32, |m, s| m.max(s.abs()));
    assert!(
        peak > 0.03 && peak < 0.3,
        "loopback peak {peak} out of range — the capture path changed with I2S running"
    );

    // I2S kept flowing DURING the capture: ≥ 50 paced blocks over ~3 s
    // (~23.4/s nominal — loose lower bound).
    let blocks_during = engine.status().await.blocks_written - blocks_before;
    assert!(
        blocks_during >= 50,
        "I2S starved during the capture: only {blocks_during} blocks in ~3 s"
    );
    assert!(engine.status().await.running, "the writer must survive the capture");

    // And the in-capture keepalive kept completing (issue #54's guarantee,
    // now with a third stream on the wire).
    let keepalives_during = {
        let handle = rt.handle();
        let dev = handle.lock().await;
        dev.keepalive_ok_count() - keepalives_before
    };
    assert!(
        keepalives_during >= 2,
        "keepalive starved while I2S streamed: {keepalives_during} completed cycles in ~3 s"
    );

    engine.apply(i2s_sine_request(false)).await.expect("i2s stop");
    rt.handle().lock().await.disconnect().await.expect("disconnect");
}

/// The clip verdict through the REAL engine (test-sheet A4): a mix whose
/// peak exceeds the reference reports `clipped` in the apply status AND in
/// the later cache reads; back inside the reference the flag clears on the
/// next declaration. (The sine slot's amplitude is 0.5 = a −6.02 dBV
/// source, peak 0.5 FS at the default 0 dBV reference — so it clips a
/// −20 dBV reference by ~14 dB and fits the default with margin.)
#[tokio::test(flavor = "multi_thread")]
async fn a_mix_beyond_the_reference_reports_clip_and_clears_when_back_inside() {
    let _sim = SIM_LOCK.lock().await;
    let rt = connected_runtime().await;
    let engine = rt.i2s();

    let mut hot = i2s_sine_request(true);
    hot.reference_dbv = -20.0;
    let st = engine.apply(hot).await.expect("i2s start");
    assert!(st.clipped, "a −6 dBV sine must clip a −20 dBV reference");
    assert!(st.running);
    assert!(engine.status().await.clipped, "the poll reads the same verdict");

    // Same mix, default reference: fits — the flag clears without any
    // register cycle (the port keeps running).
    let st = engine.apply(i2s_sine_request(true)).await.expect("re-declare");
    assert!(!st.clipped);
    assert!(st.running);

    engine.apply(i2s_sine_request(false)).await.expect("stop");
    rt.handle().lock().await.disconnect().await.expect("disconnect");
}

/// Review MUST-FIX #2's pin: quiesce must leave register 0x0A at 0 even
/// when a capture holds the device mutex at the moment the stop lands —
/// the stream teardown runs FIRST, so the I2S stop's register write gets
/// a free mutex instead of timing out and leaving the hardware port
/// asserted while the UI says "off".
#[tokio::test(flavor = "multi_thread")]
async fn quiesce_stops_the_port_register_even_around_a_live_capture() {
    let _sim = SIM_LOCK.lock().await;
    let rt = connected_runtime().await;
    let engine = rt.i2s();
    engine.apply(i2s_sine_request(true)).await.expect("i2s start");

    // A ~2 s real-time capture holding the device mutex, racing the quiesce.
    let capture = {
        let handle = rt.handle();
        tokio::spawn(async move {
            let dev = handle.lock().await;
            let tone = SignalGenerator::sine(1000.0, 0.2, 48_000, 96_000);
            let _ = dev.generate_and_capture(&tone, &tone).await;
        })
    };
    tokio::time::sleep(Duration::from_millis(300)).await; // capture underway

    rt.quiesce().await;
    capture.await.expect("capture task");

    let st = engine.status().await;
    assert!(!st.running && !st.enabled);
    let reg = {
        let handle = rt.handle();
        let dev = handle.lock().await;
        dev.read_register(registers::I2S_CTRL).await.expect("read 0x0A")
    };
    assert_eq!(
        u32::from_be_bytes([reg[0], reg[1], reg[2], reg[3]]),
        0,
        "the hardware port must be OFF after quiesce, capture or not"
    );

    rt.handle().lock().await.disconnect().await.expect("disconnect");
}

/// Review fix (#71, 6a04efa): `start_port`'s device-mutex acquisitions are
/// bounded by `DEVICE_LOCK_BOUND` (3 s) — a long capture holding the device
/// mutex must make an enabling `apply` answer "busy" within that bound
/// instead of parking the apply gate (and every other I2S command behind
/// it) for the capture's whole duration. A plain lock-hold stands in for
/// the capture; no need to actually run one.
#[tokio::test(flavor = "multi_thread")]
async fn start_port_answers_busy_instead_of_parking_on_a_held_device_mutex() {
    let _sim = SIM_LOCK.lock().await;
    let rt = connected_runtime().await;
    let engine = rt.i2s();

    // Hold the device mutex for longer than the 3 s bound. `lock_owned`
    // (not a borrowed `lock()`) so the guard can move into the spawned task
    // without tying it to a local borrow.
    let guard = rt.handle().lock_owned().await;
    let holder = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(4)).await;
        drop(guard);
    });

    let start = Instant::now();
    let err = engine
        .apply(i2s_sine_request(true))
        .await
        .expect_err("apply must answer busy, not silently adopt the held mutex");
    let elapsed = start.elapsed();
    assert!(
        elapsed < Duration::from_secs(4),
        "apply parked past the 3 s DEVICE_LOCK_BOUND instead of answering busy: {elapsed:?}"
    );
    assert!(err.to_string().contains("busy"), "unexpected error: {err}");

    holder.await.expect("lock holder task");
    rt.handle().lock().await.disconnect().await.expect("disconnect");
}

/// Teardown: quiescing the runtime (the disconnect/shutdown path) stops the
/// port, and a fresh reconnect reports it off — never a stale "running".
#[tokio::test(flavor = "multi_thread")]
async fn disconnect_stops_the_i2s_port() {
    let _sim = SIM_LOCK.lock().await;
    let rt = connected_runtime().await;
    let engine = rt.i2s();

    engine.apply(i2s_sine_request(true)).await.expect("i2s start");
    assert!(engine.status().await.running);

    rt.quiesce().await;
    let st = engine.status().await;
    assert!(!st.running, "quiesce must stop the writer");
    assert!(!st.enabled, "quiesce reports the port off");

    {
        let handle = rt.handle();
        let dev = handle.lock().await;
        dev.disconnect().await.expect("disconnect");
        assert!(!dev.i2s_available().await, "no EP 0x03 claim once disconnected");
    }
    assert!(!engine.status().await.supported);
}

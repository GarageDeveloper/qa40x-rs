//! In-app Rhai scripting for automation (dashboard task #22, split into the
//! Traces V2 families in Phase E).
//!
//! A script trace runs as one of **two families**, and the distinction is the
//! core of the design:
//!
//! - a **signal-source script** *produces a signal*: it plots frames and/or
//!   defines `fn render(ctx)` (see `crate::sources` for the render contract).
//!   It has **no device access** — sources are pull-based and additive, so
//!   several can coexist once the mixer (Phase F) sums them;
//! - a **measurement script** *drives the instrument*: it runs as a
//!   [`MeasurementProgram`] against an exclusive device [`Session`]
//!   (`crate::measurement`) — this is where `acquire()` and the `measure_*`
//!   verbs live, and the only place.
//!
//! The frontend classifies each script trace (`ScriptParams.role`, migrated
//! for old saves): a script that calls `acquire()`/`set_gen*`/measurement
//! verbs is a measurement script; one that only generates/plots is a source
//! script. A source script that still calls a device verb gets a clear error
//! naming what to change — never a silent misbehaviour.
//!
//! # API surface
//!
//! Available to **both** families:
//!
//! | Rhai                                   | Notes                            |
//! |----------------------------------------|----------------------------------|
//! | `print(x)` / `log(x)`                  | streams to the script output log |
//! | `sleep_ms(n)`                          | cancellation-aware, capped       |
//! | `connected()` / `model()` / `firmware_version()` | cached status (no I/O) |
//! | `sample_rate()` / `input_range()` / `output_range()` | cached config readback |
//! | `plot_sweep([label,] freqs, values)`   | emits a sweep frame              |
//! | `plot_spectrum(freqs, mag_db)`         | emits a spectrum (fd) frame      |
//! | `plot_scope(samples [, sample_rate])`  | emits a scope (td) frame         |
//!
//! **Measurement scripts only** (they mirror the REST endpoints and drive the
//! device through the session verbs):
//!
//! | Rhai                             | Session verb / REST equivalent         |
//! |----------------------------------|----------------------------------------|
//! | `default_settings()`             | `apply_config` / `/Settings/Default`   |
//! | `set_sample_rate(hz)`            | `apply_config` / `/Settings/SampleRate`|
//! | `set_input_range(dbv)`           | `apply_config` / `/Settings/Input/Max` |
//! | `set_output_range(dbv)`          | `apply_config`                         |
//! | `set_buffer_size(n)`             | `apply_config` / `/Settings/BufferSize`|
//! | `set_gen(on, hz, dbfs)`          | `apply_config` / `/Settings/AudioGen`  |
//! | `set_waveform(name)`             | `apply_config` (sine/square/tri/saw)   |
//! | `set_gen_output(ch)`             | `apply_config` (left/right/both)       |
//! | `acquire()`                      | `Session::acquire` / `/Acquisition`    |
//! | `thd_db(f)` / `thd_pct(f)`       | `measure_thd` / `/ThdDb` `/ThdPct`     |
//! | `thdn_db(f)` / `thdn_pct(f)`     | `measure_thdn` / `/ThdnDb` `/ThdnPct`  |
//! | `snr_db(f)`                      | `analyze` / `/SnrDb`                   |
//! | `rms_dbv(lo, hi)`                | `measure_rms` / `/RmsDbv`              |
//! | `peak_dbv(lo, hi)`               | `measure_peak_level` / `/PeakDbv`      |
//! | `peak_hz(lo, hi)`                | `find_peak` / `/PeakHz`                |
//! | `auto_level(vrms, hz)`           | `Session::auto_level` (probe −40 dB)   |
//!
//! Measurements return `#{ left: <f64>, right: <f64> }` computed over the last
//! `acquire()` capture, using the exact analysis code the REST server uses.
//! Generator levels are **RMS targets** whatever the waveform (task #48): a
//! square at −6 dBFS has the same RMS as a −6 dBFS sine — the crest-factor
//! normalization lives in `crate::sources`, shared with the mixer path.
//! `auto_level` probes the DUT 40 dB below the target, measures its gain, and
//! returns `#{ probe_vrms, measured_vrms, gain_db, drive_vrms }` — or errors
//! when the gain can't be determined or the required drive exceeds the
//! model's output limit (refuse, don't clamp).
//!
//! **Source scripts only**: `fn render(ctx)` — the host calls it for samples
//! (contract in `crate::sources`). Playing such a trace routes it into the
//! mixer (`crate::mixer`, Phase F), summed with the other signal sources; a
//! one-shot run here still emits one rendered frame as a scope preview (an
//! explicit `plot_scope` wins).
//!
//! # Emission API (script traces, task #39)
//!
//! Repeated `plot_sweep` calls redraw progressively (the whole frame is
//! re-emitted each call, curves upserted by label). Precedence: an explicitly
//! emitted fd/td wins; otherwise, when a measurement run finishes, the fd/td
//! derived from the last `acquire()` capture is emitted as a fallback — so a
//! plain `set_gen(...); acquire();` script shows its capture like a generator
//! trace.
//!
//! Additionally, every `acquire()` streams its full capture (both channels +
//! the stimulus played) as a `script-acquire` event: acquisition is a hardware
//! fact (Traces V2), so the frontend feeds it to the hardware Input L/R (+
//! Output = stimulus) traces through the same pipeline as a live-loop frame,
//! regardless of which source drives the stream.
//!
//! # Sandbox
//!
//! Scripts are untrusted: they can only reach the functions registered here.
//! - Operation / depth / size limits (see the `MAX_*` consts) terminate
//!   runaway scripts.
//! - `import` is dead: the module resolver is a `DummyModuleResolver`, so the
//!   default filesystem resolver is NOT installed. `eval` is disabled too.
//! - No filesystem, process, network, or shell access is registered.
//! - Firmware flashing / bootloader entry is deliberately NOT exposed — a
//!   script cannot brick the device.
//! - The Stop button sets a cancel flag checked by the engine's progress hook,
//!   `sleep_ms`, and before every device operation. A stop takes effect as
//!   soon as any in-flight USB transaction returns.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use async_trait::async_trait;
use rhai::{Array, Dynamic, Engine, EvalAltResult, Map, Position, AST};
use tauri::Emitter;
use tokio::sync::Mutex;

use crate::audio::{FftProcessor, WindowFunction};
use crate::dashboard::{Frame, ScriptRole, SweepCurve};
use crate::measurement::{
    Band, CancelToken, Fundamental, LeftRight, MeasurementProgram, Session, SessionConfig,
};
use crate::qa40x::{AudioData, InputGain, OutputGain, QA40xDevice, SampleRate};
use crate::rest;
use crate::sources::{route_stimulus, Route, Waveform};

/* -------------------------------------------------------------------------- */
/* Sandbox limits                                                              */
/* -------------------------------------------------------------------------- */

/// Hard cap on interpreted operations — terminates infinite loops. Device I/O
/// counts as one operation regardless of how long it blocks, so realistic
/// sweeps (hundreds of points) sit far below this.
const MAX_OPERATIONS: u64 = 10_000_000;
/// Expression nesting depth at global level / inside function bodies.
const MAX_EXPR_DEPTH: usize = 64;
const MAX_FN_EXPR_DEPTH: usize = 32;
/// Max string length a script can build (bytes).
const MAX_STRING_SIZE: usize = 64 * 1024;
/// Max array length a script can build. Tied to [`crate::sources::MAX_RENDER_SAMPLES`]
/// so a signal-source `render(ctx)` can build the `ctx.buffer_size` array the
/// mixer asks of it — the mixer's buffer_size guard uses the same constant, so
/// any buffer the mixer accepts, the sandbox can produce (bug #59: this was
/// 65_536, smaller than the FFT+padding buffers the app requests).
const MAX_ARRAY_SIZE: usize = crate::sources::MAX_RENDER_SAMPLES;
/// Max object-map size a script can build.
const MAX_MAP_SIZE: usize = 1_024;
/// Max nested call levels (recursion guard).
const MAX_CALL_LEVELS: usize = 64;
/// A single `sleep_ms` call is capped to this (the script can loop for more).
const MAX_SLEEP_MS: i64 = 60_000;
/// Max script source size accepted by `script_run`.
pub const MAX_SOURCE_BYTES: usize = 256 * 1024;

/// Apply the shared sandbox to an engine: resource caps, no filesystem
/// modules, no `eval`. Every Rhai engine in this app goes through this.
pub(crate) fn apply_sandbox(engine: &mut Engine) {
    engine.set_max_operations(MAX_OPERATIONS);
    engine.set_max_expr_depths(MAX_EXPR_DEPTH, MAX_FN_EXPR_DEPTH);
    engine.set_max_string_size(MAX_STRING_SIZE);
    engine.set_max_array_size(MAX_ARRAY_SIZE);
    engine.set_max_map_size(MAX_MAP_SIZE);
    engine.set_max_call_levels(MAX_CALL_LEVELS);
    engine.set_max_modules(0);
    // Replace the default FileModuleResolver: `import` must never touch disk.
    engine.set_module_resolver(rhai::module_resolvers::DummyModuleResolver::new());
    engine.disable_symbol("eval");
}

/* -------------------------------------------------------------------------- */
/* Events                                                                      */
/* -------------------------------------------------------------------------- */

/// One line of script output (from `print`/`log`/errors), streamed to the
/// frontend as the `script-log` event.
#[derive(Clone, serde::Serialize)]
pub struct ScriptLog {
    pub line: String,
    pub error: bool,
}

/// Run-state notification, streamed to the frontend as the `script-state`
/// event when a run starts and when it finishes (with the error, if any).
#[derive(Clone, serde::Serialize)]
pub struct ScriptState {
    pub running: bool,
    pub error: Option<String>,
}

/// The stimulus played during one script acquisition — the exact buffers the
/// DAC drove — plus the tone frequency, so the frontend can analyse/route it.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct ScriptStimulus {
    pub left: Vec<f32>,
    pub right: Vec<f32>,
    pub freq: f32,
    /// Which DAC channel(s) were driven: "Left" | "Right" | "Both".
    pub channel: String,
}

/// One `acquire()` capture, streamed to the frontend as the `script-acquire`
/// event. Acquisition is a hardware fact (Traces V2): the frontend runs this
/// through the same pipeline as a live-loop frame, so the hardware Input L/R
/// (+ Output = stimulus) traces update regardless of which source drives the
/// stream — not only the script's own trace. Mirrors `ScriptCaptureEvent` in
/// `src/live.ts`.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct ScriptCapture {
    pub sample_rate: u32,
    pub left: Vec<f32>,
    pub right: Vec<f32>,
    /// None when the generator was off (a monitor capture, silence out).
    pub stimulus: Option<ScriptStimulus>,
}

/// Where script output lines go (frontend event, test buffer, ...).
type Sink = Arc<dyn Fn(&str, bool) + Send + Sync>;

/// Where emitted frames go (`script-frame` event in the app, a Vec in tests).
type FrameSink = Arc<dyn Fn(&Frame) + Send + Sync>;

/// Where acquisitions go (`script-acquire` event in the app, a Vec in tests).
type CaptureSink = Arc<dyn Fn(&ScriptCapture) + Send + Sync>;

/// Where the end-of-run analysis goes (`script-metrics` event in the app).
type MetricsSink = Arc<dyn Fn(&crate::audio::AnalysisResult) + Send + Sync>;

/* -------------------------------------------------------------------------- */
/* Script environment                                                          */
/* -------------------------------------------------------------------------- */

/// Which domains a script emitted explicitly (via `plot_*`), plus the sweep
/// accumulator (curves upserted by label across repeated `plot_sweep` calls).
#[derive(Default)]
struct Emitted {
    fd: bool,
    td: bool,
    sweep_freqs: Vec<f32>,
    sweep_curves: Vec<SweepCurve>,
}

/// Everything a running script can reach: the device session (measurement
/// scripts drive it; source scripts only read cached status from it), the
/// tokio runtime to drive async operations, the cancel flag, the output
/// sinks, and the per-run emission state.
pub struct ScriptEnv {
    session: Session,
    rt: tokio::runtime::Handle,
    cancel: Arc<AtomicBool>,
    sink: Sink,
    frame_sink: FrameSink,
    capture_sink: CaptureSink,
    emitted: StdMutex<Emitted>,
}

impl ScriptEnv {
    pub fn new(
        session: Session,
        rt: tokio::runtime::Handle,
        cancel: Arc<AtomicBool>,
        sink: Sink,
        frame_sink: FrameSink,
        capture_sink: CaptureSink,
    ) -> Self {
        Self {
            session,
            rt,
            cancel,
            sink,
            frame_sink,
            capture_sink,
            emitted: StdMutex::new(Emitted::default()),
        }
    }

    /// Drive an async device operation to completion from the script's
    /// blocking thread.
    fn block<F: std::future::Future>(&self, fut: F) -> F::Output {
        self.rt.block_on(fut)
    }

    /// Bail out (as a Rhai termination) if the user pressed Stop.
    fn check_cancel(&self) -> Result<(), Box<EvalAltResult>> {
        if self.cancel.load(Ordering::SeqCst) {
            Err(Box::new(EvalAltResult::ErrorTerminated(
                "stopped by user".into(),
                Position::NONE,
            )))
        } else {
            Ok(())
        }
    }
}

/// A Rhai runtime error carrying `msg`.
fn rt_err(msg: impl Into<String>) -> Box<EvalAltResult> {
    Box::new(EvalAltResult::ErrorRuntime(
        Dynamic::from(msg.into()),
        Position::NONE,
    ))
}

/// Accept either a Rhai int or float where the API takes a number.
fn as_f64(v: &Dynamic, what: &str) -> Result<f64, Box<EvalAltResult>> {
    if let Ok(i) = v.as_int() {
        return Ok(i as f64);
    }
    v.as_float()
        .map_err(|t| rt_err(format!("{what} must be a number, got a {t}")))
}

/// `#{ left: l, right: r }` — the shape every measurement returns.
fn left_right_map(v: LeftRight) -> Map {
    let mut m = Map::new();
    m.insert("left".into(), Dynamic::from_float(v.left));
    m.insert("right".into(), Dynamic::from_float(v.right));
    m
}

/// Build the `script-acquire` event payload for one capture: the raw stereo
/// capture plus (when the generator was on) the exact stimulus buffers played
/// on each DAC channel and which channel(s) were driven.
pub fn build_capture(cap: &AudioData, tone: Option<(&[f32], f32, Route)>) -> ScriptCapture {
    ScriptCapture {
        sample_rate: cap.sample_rate,
        left: cap.left_channel.clone(),
        right: cap.right_channel.clone(),
        stimulus: tone.map(|(t, freq, route)| {
            let (left, right) = route_stimulus(t, route);
            ScriptStimulus { left, right, freq, channel: route.tag().to_string() }
        }),
    }
}

/// `acquire()` — play the configured tone and capture the loopback through
/// the session, then broadcast the capture (`script-acquire`) so the frontend
/// feeds the hardware Input/Output traces exactly like a live-loop frame.
fn do_acquire(env: &ScriptEnv) -> Result<(), Box<EvalAltResult>> {
    env.check_cancel()?;
    let capture = env.block(env.session.acquire()).map_err(rt_err)?;
    let event = build_capture(
        &capture.audio,
        capture.tone.as_ref().map(|t| (t.samples.as_slice(), t.freq, t.route)),
    );
    (env.capture_sink)(&event);
    Ok(())
}

/* -------------------------------------------------------------------------- */
/* Emission API (plot_* → dashboard frames)                                    */
/* -------------------------------------------------------------------------- */

/// Convert a Rhai array of numbers (ints or floats) into `Vec<f32>`.
fn to_f32_vec(arr: &Array, what: &str) -> Result<Vec<f32>, Box<EvalAltResult>> {
    arr.iter()
        .map(|v| as_f64(v, what).map(|x| x as f32))
        .collect()
}

/// Validate a parallel (x, y) pair for a plot call: equal, non-empty lengths.
fn check_pair(x: &[f32], y: &[f32], what: &str) -> Result<(), Box<EvalAltResult>> {
    if x.is_empty() {
        return Err(rt_err(format!("{what}: the arrays are empty")));
    }
    if x.len() != y.len() {
        return Err(rt_err(format!(
            "{what}: array lengths differ ({} vs {})",
            x.len(),
            y.len()
        )));
    }
    Ok(())
}

/// `plot_spectrum(freqs, mag_db)` — emit a frequency-domain (spectrum) frame.
fn plot_spectrum(env: &ScriptEnv, freqs: &Array, mag_db: &Array) -> Result<(), Box<EvalAltResult>> {
    let freqs = to_f32_vec(freqs, "plot_spectrum frequency")?;
    let mags = to_f32_vec(mag_db, "plot_spectrum magnitude")?;
    check_pair(&freqs, &mags, "plot_spectrum")?;
    env.emitted.lock().expect("script state lock poisoned").fd = true;
    (env.frame_sink)(&Frame::fd(freqs, mags));
    Ok(())
}

/// `plot_scope(samples, sample_rate)` — emit a time-domain (scope) frame.
fn plot_scope(env: &ScriptEnv, samples: &Array, sample_rate: f64) -> Result<(), Box<EvalAltResult>> {
    let samples = to_f32_vec(samples, "plot_scope sample")?;
    if samples.is_empty() {
        return Err(rt_err("plot_scope: the sample array is empty"));
    }
    if !(sample_rate > 0.0) {
        return Err(rt_err(format!("plot_scope: invalid sample rate {sample_rate}")));
    }
    env.emitted.lock().expect("script state lock poisoned").td = true;
    (env.frame_sink)(&Frame::td(sample_rate, samples));
    Ok(())
}

/// `plot_sweep(label, freqs, values)` — upsert the labelled curve into the
/// run's sweep frame and re-emit the whole frame (progressive redraw).
fn plot_sweep(
    env: &ScriptEnv,
    label: &str,
    freqs: &Array,
    values: &Array,
) -> Result<(), Box<EvalAltResult>> {
    let freqs = to_f32_vec(freqs, "plot_sweep frequency")?;
    let values = to_f32_vec(values, "plot_sweep value")?;
    check_pair(&freqs, &values, "plot_sweep")?;
    let frame = {
        let mut em = env.emitted.lock().expect("script state lock poisoned");
        em.sweep_freqs = freqs;
        match em.sweep_curves.iter_mut().find(|c| c.label == label) {
            Some(c) => c.values = values,
            None => em.sweep_curves.push(SweepCurve {
                label: label.to_string(),
                values,
                phase_deg: None,
            }),
        }
        Frame::sweep(em.sweep_freqs.clone(), em.sweep_curves.clone())
    };
    (env.frame_sink)(&frame);
    Ok(())
}

/// The fd/td frames derived from the last `acquire()` capture, for the domains
/// the script did NOT emit explicitly (emitted frames win — see the module
/// docs). Empty when the script never acquired. The analysed channel is Left,
/// matching the acquisition path's single-tone convention.
pub fn fallback_frames(env: &ScriptEnv) -> Vec<Frame> {
    let Some(cap) = env.session.last_capture() else {
        return Vec::new();
    };
    let em = env.emitted.lock().expect("script state lock poisoned");
    let mut frames = Vec::new();
    if !em.td {
        frames.push(Frame::td(cap.sample_rate as f64, cap.left_channel.clone()));
    }
    if !em.fd {
        let mut fft = FftProcessor::new();
        let r = fft.process_real_windowed(&cap.left_channel, cap.sample_rate, WindowFunction::Hann);
        frames.push(Frame::fd(r.frequencies.clone(), r.magnitudes_db()));
    }
    frames
}

/// The analysis (THD/THD+N/SNR/…) over the last `acquire()` capture — left
/// channel, at its strongest bin — for the trace's measurement strip. `None`
/// when the script never acquired (a synthetic `plot_*`-only script has no
/// signal to analyse). Uses the same analysis code as the REST server.
pub fn last_metrics(env: &ScriptEnv) -> Option<crate::audio::AnalysisResult> {
    let cap = env.session.last_capture()?;
    let fund = rest::peak_freq(&cap.left_channel, cap.sample_rate, 20.0, 20_000.0);
    Some(rest::analyze_channel(&cap.left_channel, cap.sample_rate, fund))
}

/* -------------------------------------------------------------------------- */
/* Engine construction                                                         */
/* -------------------------------------------------------------------------- */

/// Register the API both families share: output, timing, cached status /
/// config readback (no register I/O), and the plot emission functions.
fn register_common(engine: &mut Engine, env: &Arc<ScriptEnv>) {
    // ---- cancellation (Stop button) ---------------------------------------
    let cancel = env.cancel.clone();
    engine.on_progress(move |_ops| {
        if cancel.load(Ordering::Relaxed) {
            Some("stopped by user".into())
        } else {
            None
        }
    });

    // ---- output ------------------------------------------------------------
    let sink = env.sink.clone();
    engine.on_print(move |s| sink(s, false));
    let sink = env.sink.clone();
    engine.on_debug(move |s, _src, pos| sink(&format!("[debug {pos}] {s}"), false));
    let e = env.clone();
    engine.register_fn("log", move |msg: &str| (e.sink)(msg, false));

    // ---- status (cached; reading it is not driving the device) -------------
    let e = env.clone();
    engine.register_fn("connected", move || -> bool { e.block(e.session.connected()) });
    let e = env.clone();
    engine.register_fn("firmware_version", move || -> String {
        e.block(e.session.firmware_version())
    });
    let e = env.clone();
    engine.register_fn("model", move || -> String { e.block(e.session.model_name()) });

    // ---- config readback -----------------------------------------------------
    let e = env.clone();
    engine.register_fn("sample_rate", move || -> i64 {
        e.block(e.session.sample_rate_hz()) as i64
    });
    let e = env.clone();
    engine.register_fn("input_range", move || -> i64 {
        e.block(e.session.input_range_dbv()) as i64
    });
    let e = env.clone();
    engine.register_fn("output_range", move || -> i64 {
        e.block(e.session.output_range_dbv()) as i64
    });

    // ---- emission (script traces draw into the dashboard, task #39) ----------
    let e = env.clone();
    engine.register_fn(
        "plot_spectrum",
        move |freqs: Array, mag_db: Array| -> Result<(), Box<EvalAltResult>> {
            plot_spectrum(&e, &freqs, &mag_db)
        },
    );
    let e = env.clone();
    engine.register_fn("plot_scope", move |samples: Array| -> Result<(), Box<EvalAltResult>> {
        // No explicit rate: samples are at the device's current sample rate.
        let sr = e.block(e.session.sample_rate_hz());
        plot_scope(&e, &samples, sr as f64)
    });
    let e = env.clone();
    engine.register_fn(
        "plot_scope",
        move |samples: Array, sample_rate: i64| -> Result<(), Box<EvalAltResult>> {
            plot_scope(&e, &samples, sample_rate as f64)
        },
    );
    let e = env.clone();
    engine.register_fn(
        "plot_sweep",
        move |freqs: Array, values: Array| -> Result<(), Box<EvalAltResult>> {
            plot_sweep(&e, "Script", &freqs, &values)
        },
    );
    let e = env.clone();
    engine.register_fn(
        "plot_sweep",
        move |label: &str, freqs: Array, values: Array| -> Result<(), Box<EvalAltResult>> {
            plot_sweep(&e, label, &freqs, &values)
        },
    );

    // ---- timing -------------------------------------------------------------
    let e = env.clone();
    engine.register_fn("sleep_ms", move |ms: i64| -> Result<(), Box<EvalAltResult>> {
        let mut remaining = ms.clamp(0, MAX_SLEEP_MS) as u64;
        while remaining > 0 {
            e.check_cancel()?;
            let step = remaining.min(50);
            std::thread::sleep(std::time::Duration::from_millis(step));
            remaining -= step;
        }
        e.check_cancel()
    });
}

/// Register the measurement-only verbs: settings, acquisition, and the
/// analysis functions — everything that drives the instrument.
fn register_measurement_api(engine: &mut Engine, env: &Arc<ScriptEnv>) {
    // ---- settings (session config; register writes skip no-ops) -------------
    let e = env.clone();
    engine.register_fn("set_sample_rate", move |hz: i64| -> Result<(), Box<EvalAltResult>> {
        e.check_cancel()?;
        let rate = SampleRate::from_hz(u32::try_from(hz).unwrap_or(0))
            .ok_or_else(|| rt_err(format!("invalid sample rate {hz} Hz (valid: 48000, 96000, 192000, 384000)")))?;
        e.block(e.session.apply_config(SessionConfig {
            sample_rate: Some(rate),
            ..SessionConfig::default()
        }))
        .map_err(rt_err)
    });
    let e = env.clone();
    engine.register_fn("set_input_range", move |dbv: i64| -> Result<(), Box<EvalAltResult>> {
        e.check_cancel()?;
        let gain = InputGain::from_dbv(dbv as i32)
            .ok_or_else(|| rt_err(format!("invalid input range {dbv} dBV (valid: 0, 6, 12, 18, 24, 30, 36, 42)")))?;
        e.block(e.session.apply_config(SessionConfig {
            input_range: Some(gain),
            ..SessionConfig::default()
        }))
        .map_err(rt_err)
    });
    let e = env.clone();
    engine.register_fn("set_output_range", move |dbv: i64| -> Result<(), Box<EvalAltResult>> {
        e.check_cancel()?;
        let gain = OutputGain::from_dbv(dbv as i32)
            .ok_or_else(|| rt_err(format!("invalid output range {dbv} dBV (valid: -12, -2, 8, 18)")))?;
        e.block(e.session.apply_config(SessionConfig {
            output_range: Some(gain),
            ..SessionConfig::default()
        }))
        .map_err(rt_err)
    });
    let e = env.clone();
    engine.register_fn("set_buffer_size", move |n: i64| -> Result<(), Box<EvalAltResult>> {
        if !(1024..=1_048_576).contains(&n) {
            return Err(rt_err(format!("buffer size {n} out of range (1024..=1048576)")));
        }
        e.block(e.session.apply_config(SessionConfig {
            buffer_size: Some(n as usize),
            ..SessionConfig::default()
        }))
        .map_err(rt_err)
    });
    let e = env.clone();
    engine.register_fn(
        "set_gen",
        move |on: bool, freq: Dynamic, amp_dbfs: Dynamic| -> Result<(), Box<EvalAltResult>> {
            let freq = as_f64(&freq, "generator frequency")?;
            let amp = as_f64(&amp_dbfs, "generator amplitude (dBFS)")?;
            if !(0.1..=100_000.0).contains(&freq) {
                return Err(rt_err(format!("generator frequency {freq} Hz out of range (0.1..=100000)")));
            }
            e.block(e.session.apply_config(SessionConfig {
                gen_enabled: Some(on),
                gen_frequency_hz: Some(freq as f32),
                gen_amplitude_dbfs: Some(amp as f32),
                ..SessionConfig::default()
            }))
            .map_err(rt_err)
        },
    );
    let e = env.clone();
    engine.register_fn("set_waveform", move |name: &str| -> Result<(), Box<EvalAltResult>> {
        let w = Waveform::parse(name).ok_or_else(|| {
            rt_err(format!("unknown waveform {name:?} (sine, square, triangle, sawtooth)"))
        })?;
        e.block(e.session.apply_config(SessionConfig {
            gen_waveform: Some(w),
            ..SessionConfig::default()
        }))
        .map_err(rt_err)
    });
    let e = env.clone();
    engine.register_fn("set_gen_output", move |ch: &str| -> Result<(), Box<EvalAltResult>> {
        let route = Route::parse(ch).ok_or_else(|| {
            rt_err(format!("unknown output channel {ch:?} (left, right, both, off)"))
        })?;
        e.block(e.session.apply_config(SessionConfig {
            gen_route: Some(route),
            ..SessionConfig::default()
        }))
        .map_err(rt_err)
    });
    let e = env.clone();
    engine.register_fn("default_settings", move || -> Result<(), Box<EvalAltResult>> {
        e.block(e.session.apply_config(SessionConfig::default_settings())).map_err(rt_err)
    });

    // ---- acquisition ------------------------------------------------------------
    let e = env.clone();
    engine.register_fn("acquire", move || -> Result<(), Box<EvalAltResult>> { do_acquire(&e) });

    // ---- measurements over the last acquisition ----------------------------------
    let e = env.clone();
    engine.register_fn("thd_db", move |fund: Dynamic| -> Result<Map, Box<EvalAltResult>> {
        let f = as_f64(&fund, "fundamental frequency")? as f32;
        let v = e.session.measure_thd(Fundamental { hz: f }).map_err(rt_err)?;
        Ok(left_right_map(LeftRight {
            left: rest::db(v.left / 100.0),
            right: rest::db(v.right / 100.0),
        }))
    });
    let e = env.clone();
    engine.register_fn("thd_pct", move |fund: Dynamic| -> Result<Map, Box<EvalAltResult>> {
        let f = as_f64(&fund, "fundamental frequency")? as f32;
        let v = e.session.measure_thd(Fundamental { hz: f }).map_err(rt_err)?;
        Ok(left_right_map(v))
    });
    let e = env.clone();
    engine.register_fn("thdn_db", move |fund: Dynamic| -> Result<Map, Box<EvalAltResult>> {
        let f = as_f64(&fund, "fundamental frequency")? as f32;
        let v = e.session.measure_thdn(Fundamental { hz: f }).map_err(rt_err)?;
        Ok(left_right_map(LeftRight {
            left: rest::db(v.left / 100.0),
            right: rest::db(v.right / 100.0),
        }))
    });
    let e = env.clone();
    engine.register_fn("thdn_pct", move |fund: Dynamic| -> Result<Map, Box<EvalAltResult>> {
        let f = as_f64(&fund, "fundamental frequency")? as f32;
        let v = e.session.measure_thdn(Fundamental { hz: f }).map_err(rt_err)?;
        Ok(left_right_map(v))
    });
    let e = env.clone();
    engine.register_fn("snr_db", move |fund: Dynamic| -> Result<Map, Box<EvalAltResult>> {
        let f = as_f64(&fund, "fundamental frequency")? as f32;
        let (l, r) = e.session.analyze(Fundamental { hz: f }).map_err(rt_err)?;
        Ok(left_right_map(LeftRight { left: l.snr as f64, right: r.snr as f64 }))
    });
    let e = env.clone();
    engine.register_fn(
        "rms_dbv",
        move |lo: Dynamic, hi: Dynamic| -> Result<Map, Box<EvalAltResult>> {
            let band = Band {
                lo_hz: as_f64(&lo, "low frequency")? as f32,
                hi_hz: as_f64(&hi, "high frequency")? as f32,
            };
            let v = e.block(e.session.measure_rms(band)).map_err(rt_err)?;
            Ok(left_right_map(v))
        },
    );
    let e = env.clone();
    engine.register_fn(
        "peak_dbv",
        move |lo: Dynamic, hi: Dynamic| -> Result<Map, Box<EvalAltResult>> {
            let band = Band {
                lo_hz: as_f64(&lo, "low frequency")? as f32,
                hi_hz: as_f64(&hi, "high frequency")? as f32,
            };
            let v = e.block(e.session.measure_peak_level(band)).map_err(rt_err)?;
            Ok(left_right_map(v))
        },
    );
    let e = env.clone();
    engine.register_fn(
        "peak_hz",
        move |lo: Dynamic, hi: Dynamic| -> Result<Map, Box<EvalAltResult>> {
            let band = Band {
                lo_hz: as_f64(&lo, "low frequency")? as f32,
                hi_hz: as_f64(&hi, "high frequency")? as f32,
            };
            let v = e.session.find_peak(band).map_err(rt_err)?;
            Ok(left_right_map(v))
        },
    );
    let e = env.clone();
    engine.register_fn(
        "auto_level",
        move |target_vrms: Dynamic, freq_hz: Dynamic| -> Result<Map, Box<EvalAltResult>> {
            let target = as_f64(&target_vrms, "auto-level target (Vrms)")?;
            let hz = as_f64(&freq_hz, "auto-level frequency (Hz)")?;
            let r = e.block(e.session.auto_level(target, hz)).map_err(rt_err)?;
            let mut m = Map::new();
            m.insert("probe_vrms".into(), Dynamic::from_float(r.probe_vrms));
            m.insert("measured_vrms".into(), Dynamic::from_float(r.measured_vrms));
            m.insert("gain_db".into(), Dynamic::from_float(r.gain_db));
            m.insert("drive_vrms".into(), Dynamic::from_float(r.required_drive_vrms));
            Ok(m)
        },
    );
}

/// The error a *source* script gets when it calls a measurement verb: name
/// the verb and what to change, never misbehave silently.
fn measurement_only_err(name: &str) -> Box<EvalAltResult> {
    rt_err(format!(
        "{name}() drives the instrument, so it is only available in a measurement \
         script. This trace runs as a signal source (it produces/plots a signal \
         without touching the device). Edit the script via the trace's gear and \
         Apply — a script that calls {name}() is classified as a measurement \
         script automatically — or remove the device calls."
    ))
}

/// Register legible rejection stubs for every measurement-only verb, matching
/// the real arities so the call resolves to the explanation, not to a generic
/// "function not found".
fn register_source_stubs(engine: &mut Engine) {
    macro_rules! stub {
        ($name:literal $(, $arg:ty)*) => {
            engine.register_fn($name, move |$(_: $arg),*| -> Result<(), Box<EvalAltResult>> {
                Err(measurement_only_err($name))
            });
        };
    }
    stub!("acquire");
    stub!("default_settings");
    stub!("set_gen", bool, Dynamic, Dynamic);
    stub!("set_waveform", &str);
    stub!("set_gen_output", &str);
    stub!("set_sample_rate", i64);
    stub!("set_input_range", i64);
    stub!("set_output_range", i64);
    stub!("set_buffer_size", i64);
    stub!("thd_db", Dynamic);
    stub!("thd_pct", Dynamic);
    stub!("thdn_db", Dynamic);
    stub!("thdn_pct", Dynamic);
    stub!("snr_db", Dynamic);
    stub!("rms_dbv", Dynamic, Dynamic);
    stub!("peak_dbv", Dynamic, Dynamic);
    stub!("peak_hz", Dynamic, Dynamic);
    stub!("auto_level", Dynamic, Dynamic);
}

/// Build the sandboxed engine for a **measurement** script (the full curated
/// automation API).
pub fn build_measurement_engine(env: Arc<ScriptEnv>) -> Engine {
    let mut engine = Engine::new();
    apply_sandbox(&mut engine);
    register_common(&mut engine, &env);
    register_measurement_api(&mut engine, &env);
    engine
}

/// Build the sandboxed engine for a **source** script: plotting + status only
/// — no device verbs (they are stubs that explain the split).
pub fn build_source_engine(env: Arc<ScriptEnv>) -> Engine {
    let mut engine = Engine::new();
    apply_sandbox(&mut engine);
    register_common(&mut engine, &env);
    register_source_stubs(&mut engine);
    engine
}

/// Compile and run `source` as a measurement script in a fresh sandboxed
/// engine. Blocking — call from a blocking-friendly thread (`spawn_blocking`
/// in the app, a plain thread in tests).
pub fn run_measurement_script(env: Arc<ScriptEnv>, source: &str) -> Result<(), String> {
    let engine = build_measurement_engine(env.clone());
    let ast = engine.compile(source).map_err(|e| e.to_string())?;
    if crate::sources::has_render_fn(&ast) {
        // Never a silent misbehaviour: a measurement script's render is dead
        // code (only source scripts are asked for samples) — say so.
        (env.sink)(
            "note: fn render(ctx) is ignored in a measurement script — remove the \
             device calls (acquire/set_gen/…) to run this trace as a signal source",
            false,
        );
    }
    engine.run_ast(&ast).map_err(|e| friendly_error(&e))
}

/// Compile and run `source` as a signal-source script: top-level statements
/// run with the source API (plots, no device), then a defined `fn render(ctx)`
/// is called once and emitted as a scope preview (an explicit `plot_scope`
/// wins). This is the one-shot path; *playing* a render-defining trace goes
/// through the mixer (`crate::mixer`) instead. Blocking, like
/// [`run_measurement_script`].
pub fn run_source_script(env: Arc<ScriptEnv>, source: &str) -> Result<(), String> {
    let engine = build_source_engine(env.clone());
    let ast = engine.compile(source).map_err(|e| e.to_string())?;
    engine.run_ast(&ast).map_err(|e| friendly_error(&e))?;
    emit_render_preview(&engine, &ast, &env)
}

/// One rendered frame as a scope preview for a source script that defines
/// `render` (see `crate::sources` for the contract). The preview shows the
/// left channel (a mono render fills both identically; a stereo map's right
/// channel becomes visible when the mixer's Output R endpoint lands).
fn emit_render_preview(engine: &Engine, ast: &AST, env: &ScriptEnv) -> Result<(), String> {
    if !crate::sources::has_render_fn(ast) {
        return Ok(());
    }
    {
        let em = env.emitted.lock().expect("script state lock poisoned");
        if em.td {
            return Ok(()); // the script plotted its own scope — explicit wins
        }
    }
    let sample_rate = env.block(env.session.sample_rate_hz());
    let ctx = crate::sources::RenderContext {
        sample_rate,
        buffer_size: env.session.buffer_size(),
        params: Default::default(),
    };
    // Raw error + friendly_error, so Stop still reads "stopped by user".
    let out = crate::sources::call_render_raw(engine, ast, &ctx)
        .map_err(|e| friendly_error(&e))?;
    let (left, _right) = crate::sources::stereo_from_render_value(out, ctx.buffer_size)?;
    env.emitted.lock().expect("script state lock poisoned").td = true;
    (env.frame_sink)(&Frame::td(sample_rate as f64, left));
    Ok(())
}

/// Turn an engine error into the message shown in the Script panel.
fn friendly_error(e: &EvalAltResult) -> String {
    match e {
        EvalAltResult::ErrorTerminated(tok, _) => format!("script terminated: {tok}"),
        EvalAltResult::ErrorTooManyOperations(_) => format!(
            "script exceeded the operation limit ({MAX_OPERATIONS} operations) and was terminated"
        ),
        other => other.to_string(),
    }
}

/* -------------------------------------------------------------------------- */
/* Measurement scripts as programs                                             */
/* -------------------------------------------------------------------------- */

/// A user measurement script as a [`MeasurementProgram`]: the Rhai engine
/// runs on a blocking thread against a clone of the session (cheap — shared
/// state), the async side waits for it, then emits the end-of-run fallback
/// frames + metrics and closes the session bracket.
pub struct MeasurementScript {
    source: String,
    sink: Sink,
    frame_sink: FrameSink,
    capture_sink: CaptureSink,
    metrics_sink: MetricsSink,
}

impl MeasurementScript {
    pub fn new(
        source: String,
        sink: Sink,
        frame_sink: FrameSink,
        capture_sink: CaptureSink,
        metrics_sink: MetricsSink,
    ) -> Self {
        Self { source, sink, frame_sink, capture_sink, metrics_sink }
    }
}

#[async_trait]
impl MeasurementProgram for MeasurementScript {
    async fn run(&mut self, session: &mut Session, cancel: &CancelToken) -> Result<(), String> {
        let env = Arc::new(ScriptEnv::new(
            session.clone(),
            tokio::runtime::Handle::current(),
            cancel.flag().clone(),
            self.sink.clone(),
            self.frame_sink.clone(),
            self.capture_sink.clone(),
        ));
        let source = self.source.clone();
        let metrics_sink = self.metrics_sink.clone();
        let res = tokio::task::spawn_blocking(move || {
            let res = run_measurement_script(env.clone(), &source);
            // Precedence: explicitly emitted frames win; on success, fill the
            // domains the script left out from its last acquire() capture,
            // and emit the analysis (THD/THD+N/SNR/…) so the measurement
            // strip shows it — a frame carries only samples, not the derived
            // metrics. Done here so the fallback FFT stays off async workers.
            if res.is_ok() {
                for frame in fallback_frames(&env) {
                    (env.frame_sink)(&frame);
                }
                if let Some(metrics) = last_metrics(&env) {
                    (metrics_sink)(&metrics);
                }
            }
            res
        })
        .await
        .unwrap_or_else(|e| Err(format!("script thread failed: {e}")));
        // Close the bracket on every path — including a panicked worker.
        session.end().await;
        res
    }
}

/* -------------------------------------------------------------------------- */
/* Transformer scripts (Traces V2 Phase C)                                     */
/* -------------------------------------------------------------------------- */

/// Convert a slice of f32 into a Rhai array of floats.
fn to_rhai_array(v: &[f32]) -> Array {
    v.iter().map(|&x| Dynamic::from_float(x as f64)).collect()
}

/// Read a numeric array back out of a transformer's scope.
fn scope_f32_vec(scope: &rhai::Scope, name: &str) -> Result<Vec<f32>, String> {
    let arr = scope
        .get_value::<Array>(name)
        .ok_or_else(|| format!("the transformer removed the `{name}` array"))?;
    arr.iter()
        .map(|v| {
            if let Ok(i) = v.as_int() {
                Ok(i as f32)
            } else {
                v.as_float()
                    .map(|f| f as f32)
                    .map_err(|t| format!("`{name}` must hold numbers, got a {t}"))
            }
        })
        .collect()
}

/// Run a Rhai *transformer* over one dashboard frame: a trace endpoint is
/// `source → transformer(s) → endpoint`, and a script can be a transformer,
/// not only a source. The script sees the frame as mutable scope variables —
/// `freqs` + `mag_db` (spectrum) or `samples` + `sample_rate` (scope) — edits
/// them in place (it may also resize freqs/mag_db together), and the edited
/// arrays become the endpoint's frame. Same sandbox limits as script traces;
/// no device, filesystem, or emission API is exposed.
pub fn run_transform(source: &str, frame: &Frame) -> Result<Frame, String> {
    if source.len() > MAX_SOURCE_BYTES {
        return Err(format!("script too large (>{MAX_SOURCE_BYTES} bytes)"));
    }
    let mut engine = Engine::new();
    apply_sandbox(&mut engine);

    let mut scope = rhai::Scope::new();
    match frame {
        Frame::Fd { freqs, mag_db, .. } => {
            scope.push("freqs", to_rhai_array(freqs));
            scope.push("mag_db", to_rhai_array(mag_db));
        }
        Frame::Td { samples, sample_rate, .. } => {
            scope.push("samples", to_rhai_array(samples));
            scope.push("sample_rate", *sample_rate);
        }
        Frame::Sweep { .. } => {
            return Err("sweep frames can't be script-transformed (spectrum/scope only)".into())
        }
    }

    engine
        .run_with_scope(&mut scope, source)
        .map_err(|e| friendly_error(&e))?;

    match frame {
        Frame::Fd { .. } => {
            let freqs = scope_f32_vec(&scope, "freqs")?;
            let mags = scope_f32_vec(&scope, "mag_db")?;
            if freqs.is_empty() || freqs.len() != mags.len() {
                return Err(format!(
                    "the transformer left freqs/mag_db inconsistent ({} vs {} values)",
                    freqs.len(),
                    mags.len()
                ));
            }
            Ok(Frame::fd(freqs, mags))
        }
        Frame::Td { sample_rate, .. } => {
            let samples = scope_f32_vec(&scope, "samples")?;
            if samples.is_empty() {
                return Err("the transformer left the samples array empty".into());
            }
            Ok(Frame::td(*sample_rate, samples))
        }
        Frame::Sweep { .. } => unreachable!("rejected above"),
    }
}

/* -------------------------------------------------------------------------- */
/* Run controller (held in AppState)                                           */
/* -------------------------------------------------------------------------- */

/// Owns the run/cancel flags and launches script runs. Cloneable (all shared
/// state is behind `Arc`s) so Tauri commands can grab it without holding the
/// AppState lock.
#[derive(Clone)]
pub struct ScriptControl {
    device: Arc<Mutex<QA40xDevice>>,
    generator_running: Arc<AtomicBool>,
    generator_stop: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
}

impl ScriptControl {
    pub fn new(
        device: Arc<Mutex<QA40xDevice>>,
        generator_running: Arc<AtomicBool>,
        generator_stop: Arc<AtomicBool>,
    ) -> Self {
        Self {
            device,
            generator_running,
            generator_stop,
            running: Arc::new(AtomicBool::new(false)),
            cancel: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// Request the running script to stop (takes effect at the next operation).
    pub fn stop(&self) {
        if self.is_running() {
            self.cancel.store(true, Ordering::SeqCst);
        }
    }

    /// Start `source` in its family: a *source* script runs on a blocking
    /// thread with the device-free engine; a *measurement* script runs as a
    /// [`MeasurementScript`] program against an exclusive session. Output,
    /// emitted frames, and completion stream to the frontend as `script-log` /
    /// `script-frame` / `script-state` events. One script at a time.
    pub fn start(
        &self,
        app: tauri::AppHandle,
        source: String,
        role: ScriptRole,
    ) -> Result<(), String> {
        if source.len() > MAX_SOURCE_BYTES {
            return Err(format!("script too large (>{MAX_SOURCE_BYTES} bytes)"));
        }
        if self.running.swap(true, Ordering::SeqCst) {
            return Err("a script is already running — stop it first".into());
        }
        self.cancel.store(false, Ordering::SeqCst);

        let sink_app = app.clone();
        let sink: Sink = Arc::new(move |line: &str, error: bool| {
            let _ = sink_app.emit("script-log", ScriptLog { line: line.to_string(), error });
        });
        let frame_app = app.clone();
        let frame_sink: FrameSink = Arc::new(move |frame: &Frame| {
            let _ = frame_app.emit("script-frame", frame);
        });
        let capture_app = app.clone();
        let capture_sink: CaptureSink = Arc::new(move |cap: &ScriptCapture| {
            let _ = capture_app.emit("script-acquire", cap);
        });
        let session = Session::new(
            self.device.clone(),
            self.generator_running.clone(),
            self.generator_stop.clone(),
        );

        let _ = app.emit("script-state", ScriptState { running: true, error: None });
        let running = self.running.clone();
        match role {
            ScriptRole::Source => {
                let env = Arc::new(ScriptEnv::new(
                    session,
                    tokio::runtime::Handle::current(),
                    self.cancel.clone(),
                    sink,
                    frame_sink,
                    capture_sink,
                ));
                tokio::task::spawn_blocking(move || {
                    let res = run_source_script(env, &source);
                    finish_run(&app, &running, res);
                });
            }
            ScriptRole::Measurement => {
                let metrics_app = app.clone();
                let metrics_sink: MetricsSink = Arc::new(move |m| {
                    let _ = metrics_app.emit("script-metrics", m);
                });
                let mut program =
                    MeasurementScript::new(source, sink, frame_sink, capture_sink, metrics_sink);
                let cancel = CancelToken::from_flag(self.cancel.clone());
                let mut session = session;
                tokio::spawn(async move {
                    let res = program.run(&mut session, &cancel).await;
                    finish_run(&app, &running, res);
                });
            }
        }
        Ok(())
    }
}

/// Common end-of-run bookkeeping: clear the running flag and stream the
/// completion (and the error, if any) to the frontend.
fn finish_run(app: &tauri::AppHandle, running: &Arc<AtomicBool>, res: Result<(), String>) {
    running.store(false, Ordering::SeqCst);
    let error = res.err();
    if let Some(e) = &error {
        let _ = app.emit("script-log", ScriptLog { line: e.clone(), error: true });
    }
    let _ = app.emit("script-state", ScriptState { running: false, error });
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::measurement::GenConfig;

    /// Captured output lines + emitted frames + the environment. The runtime
    /// must outlive the env (device calls are driven through its handle), so it
    /// is returned too.
    fn test_env() -> (
        Arc<ScriptEnv>,
        Arc<StdMutex<Vec<(String, bool)>>>,
        Arc<StdMutex<Vec<Frame>>>,
        tokio::runtime::Runtime,
    ) {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .expect("test runtime");
        let lines = Arc::new(StdMutex::new(Vec::<(String, bool)>::new()));
        let sunk = lines.clone();
        let sink: Sink = Arc::new(move |s: &str, e: bool| {
            sunk.lock().unwrap().push((s.to_string(), e));
        });
        let frames = Arc::new(StdMutex::new(Vec::<Frame>::new()));
        let collected = frames.clone();
        let frame_sink: FrameSink = Arc::new(move |f: &Frame| {
            collected.lock().unwrap().push(f.clone());
        });
        let capture_sink: CaptureSink = Arc::new(|_c: &ScriptCapture| {});
        let session = Session::new(
            Arc::new(Mutex::new(QA40xDevice::new())),
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicBool::new(false)),
        );
        let env = Arc::new(ScriptEnv::new(
            session,
            rt.handle().clone(),
            Arc::new(AtomicBool::new(false)),
            sink,
            frame_sink,
            capture_sink,
        ));
        (env, lines, frames, rt)
    }

    fn outputs(lines: &Arc<StdMutex<Vec<(String, bool)>>>) -> Vec<String> {
        lines.lock().unwrap().iter().map(|(s, _)| s.clone()).collect()
    }

    #[test]
    fn print_reaches_the_sink() {
        let (env, lines, _frames, _rt) = test_env();
        run_measurement_script(env, r#"print("hello from rhai");"#).unwrap();
        assert_eq!(outputs(&lines), vec!["hello from rhai"]);
    }

    #[test]
    fn runaway_loop_hits_the_operation_limit() {
        let (env, _lines, _frames, _rt) = test_env();
        let err = run_measurement_script(env, "while true {}").unwrap_err();
        assert!(err.contains("operation limit"), "got: {err}");
    }

    #[test]
    fn stop_flag_terminates_the_script() {
        let (env, _lines, _frames, _rt) = test_env();
        env.cancel.store(true, Ordering::SeqCst);
        let err = run_measurement_script(env, "while true {}").unwrap_err();
        assert!(err.contains("stopped by user"), "got: {err}");
    }

    #[test]
    fn stop_flag_interrupts_a_sleep() {
        let (env, _lines, _frames, _rt) = test_env();
        let cancel = env.cancel.clone();
        let killer = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(80));
            cancel.store(true, Ordering::SeqCst);
        });
        let t0 = std::time::Instant::now();
        let err = run_measurement_script(env, "sleep_ms(60000);").unwrap_err();
        killer.join().unwrap();
        assert!(err.contains("stopped by user"), "got: {err}");
        assert!(t0.elapsed() < std::time::Duration::from_secs(5));
    }

    #[test]
    fn config_readback_works_while_disconnected() {
        let (env, lines, _frames, _rt) = test_env();
        run_measurement_script(
            env,
            "print(input_range()); print(output_range()); print(sample_rate());",
        )
        .unwrap();
        assert_eq!(outputs(&lines), vec!["6", "8", "48000"]);
    }

    #[test]
    fn setting_the_current_range_is_recorded() {
        // The device skips redundant relay writes, so setting the range the
        // config already holds succeeds even disconnected — and reads back.
        let (env, lines, _frames, _rt) = test_env();
        run_measurement_script(
            env,
            "set_input_range(6); set_sample_rate(48000); print(input_range());",
        )
        .unwrap();
        assert_eq!(outputs(&lines), vec!["6"]);
    }

    #[test]
    fn changing_a_range_needs_the_device() {
        let (env, _lines, _frames, _rt) = test_env();
        assert!(run_measurement_script(env, "set_input_range(18);").is_err());
    }

    #[test]
    fn invalid_settings_are_rejected() {
        let (env, _lines, _frames, _rt) = test_env();
        let err = run_measurement_script(env.clone(), "set_input_range(7);").unwrap_err();
        assert!(err.contains("invalid input range"), "got: {err}");
        let err = run_measurement_script(env.clone(), "set_output_range(3);").unwrap_err();
        assert!(err.contains("invalid output range"), "got: {err}");
        let err = run_measurement_script(env.clone(), "set_sample_rate(44100);").unwrap_err();
        assert!(err.contains("invalid sample rate"), "got: {err}");
        let err = run_measurement_script(env, "set_buffer_size(1);").unwrap_err();
        assert!(err.contains("buffer size"), "got: {err}");
    }

    #[test]
    fn gen_settings_accept_ints_and_floats() {
        let (env, _lines, _frames, _rt) = test_env();
        run_measurement_script(env.clone(), "set_gen(true, 1000, -6);").unwrap();
        run_measurement_script(env, "set_gen(true, 997.0, -12.5);").unwrap();
    }

    #[test]
    fn set_waveform_validates() {
        let (env, _lines, _frames, _rt) = test_env();
        run_measurement_script(
            env.clone(),
            r#"set_waveform("square"); set_waveform("Triangle"); set_waveform("saw"); set_waveform("sine");"#,
        )
        .unwrap();
        let err = run_measurement_script(env, r#"set_waveform("noise");"#).unwrap_err();
        assert!(err.contains("unknown waveform"), "got: {err}");
    }

    #[test]
    fn acquire_requires_a_connection() {
        let (env, _lines, _frames, _rt) = test_env();
        let err = run_measurement_script(env, "acquire();").unwrap_err();
        assert!(err.contains("not connected"), "got: {err}");
    }

    #[test]
    fn auto_level_is_a_measurement_verb_and_needs_the_device() {
        // The probe drives the instrument, so the verb exists only in the
        // measurement API and needs a connection (its arithmetic is unit
        // tested in crate::measurement).
        let (env, _lines, _frames, _rt) = test_env();
        let err = run_measurement_script(env, "auto_level(2.83, 1000);").unwrap_err();
        assert!(err.contains("not connected"), "got: {err}");
    }

    #[test]
    fn measurements_require_an_acquisition() {
        let (env, _lines, _frames, _rt) = test_env();
        let err = run_measurement_script(env, "thd_db(1000.0);").unwrap_err();
        assert!(err.contains("no acquisition yet"), "got: {err}");
    }

    #[test]
    fn measurements_run_on_a_synthetic_capture() {
        // Inject a 1 kHz / -6 dBFS tone as the "last acquisition" (no device
        // I/O), like the REST tests, then measure it from a script.
        let (env, lines, _frames, _rt) = test_env();
        inject_tone(&env);
        run_measurement_script(
            env,
            r#"
            let f = peak_hz(20.0, 20000.0);
            if f.left > 995.0 && f.left < 1005.0 { print("peak ok"); }
            let rms = rms_dbv(20, 20000);
            if rms.left > -9.4 && rms.left < -8.7 { print("rms ok"); }
            let thd = thd_db(f.left);
            if thd.left < -80.0 { print("thd ok"); }
            "#,
        )
        .unwrap();
        assert_eq!(outputs(&lines), vec!["peak ok", "rms ok", "thd ok"]);
    }

    #[test]
    fn last_metrics_needs_a_capture_then_analyses_it() {
        let (env, _lines, _frames, _rt) = test_env();
        assert!(last_metrics(&env).is_none(), "no metrics before acquire()");
        inject_tone(&env);
        let m = last_metrics(&env).expect("metrics after a capture");
        assert!(m.thd < 1.0, "a clean sine's THD should be small, got {}%", m.thd);
    }

    #[test]
    fn import_is_sandboxed_off() {
        let (env, _lines, _frames, _rt) = test_env();
        assert!(run_measurement_script(env, r#"import "os" as os;"#).is_err());
    }

    #[test]
    fn eval_is_disabled() {
        let (env, _lines, _frames, _rt) = test_env();
        assert!(run_measurement_script(env, r#"eval("1 + 1");"#).is_err());
    }

    #[test]
    fn oversized_strings_are_capped() {
        let (env, _lines, _frames, _rt) = test_env();
        let err = run_measurement_script(
            env,
            r#"let s = "x"; loop { s += s; }"#,
        )
        .unwrap_err();
        // Either the string-size cap or the operation cap fires; both are fine.
        assert!(
            err.contains("string") || err.contains("operation limit"),
            "got: {err}"
        );
    }

    /* ---- the family split (Traces V2 Phase E) ------------------------------ */

    #[test]
    fn source_scripts_share_the_output_and_status_api() {
        let (env, lines, _frames, _rt) = test_env();
        run_source_script(env, r#"print("hi"); log("lo"); print(sample_rate());"#).unwrap();
        assert_eq!(outputs(&lines), vec!["hi", "lo", "48000"]);
    }

    #[test]
    fn source_scripts_reject_measurement_verbs_legibly() {
        let (env, _lines, _frames, _rt) = test_env();
        for call in [
            "acquire();",
            "set_gen(true, 1000, -6);",
            r#"set_waveform("square");"#,
            "set_sample_rate(48000);",
            "set_input_range(6);",
            "set_buffer_size(4096);",
            "default_settings();",
            "thd_db(1000.0);",
            "rms_dbv(20, 20000);",
            "peak_hz(20, 20000);",
            "auto_level(2.83, 1000);",
        ] {
            let err = run_source_script(env.clone(), call).unwrap_err();
            assert!(
                err.contains("measurement") && err.contains("signal source"),
                "{call} → {err}"
            );
        }
    }

    #[test]
    fn source_scripts_stay_sandboxed() {
        let (env, _lines, _frames, _rt) = test_env();
        assert!(run_source_script(env.clone(), r#"import "os" as os;"#).is_err());
        assert!(run_source_script(env.clone(), r#"eval("1 + 1");"#).is_err());
        let err = run_source_script(env, "while true {}").unwrap_err();
        assert!(err.contains("operation limit"), "got: {err}");
    }

    #[test]
    fn a_source_script_render_previews_a_scope_frame() {
        let (env, _lines, frames, rt) = test_env();
        // A small buffer keeps the interpreted render loop cheap.
        rt.block_on(env.session.apply_config(SessionConfig {
            buffer_size: Some(2048),
            ..SessionConfig::default()
        }))
        .unwrap();
        run_source_script(
            env,
            r#"
            fn render(ctx) {
                let out = [];
                for i in 0..ctx.buffer_size { out.push(0.25); }
                out
            }
            "#,
        )
        .unwrap();
        let frames = frames.lock().unwrap();
        assert_eq!(frames.len(), 1);
        match &frames[0] {
            Frame::Td { sample_rate, samples, .. } => {
                assert_eq!(*sample_rate, 48000.0);
                assert_eq!(samples.len(), 2048);
                assert!(samples.iter().all(|&s| s == 0.25));
            }
            other => panic!("expected a td preview frame, got {other:?}"),
        }
    }

    #[test]
    fn an_explicit_plot_scope_wins_over_the_render_preview() {
        let (env, _lines, frames, _rt) = test_env();
        run_source_script(
            env,
            r#"
            plot_scope([0.0, 1.0], 48000);
            fn render(ctx) { [9.0] }
            "#,
        )
        .unwrap();
        let frames = frames.lock().unwrap();
        assert_eq!(frames.len(), 1, "only the explicit scope frame");
        match &frames[0] {
            Frame::Td { samples, .. } => assert_eq!(samples, &vec![0.0, 1.0]),
            other => panic!("expected the explicit td frame, got {other:?}"),
        }
    }

    #[test]
    fn a_broken_render_fails_the_source_run() {
        let (env, _lines, _frames, _rt) = test_env();
        let err = run_source_script(env, "fn render(ctx) { [0.0] }").unwrap_err();
        assert!(err.contains("buffer_size"), "got: {err}");
    }

    #[test]
    fn a_measurement_script_with_render_gets_a_note() {
        // render is a source-script entry point; a measurement script defining
        // it must be told it is dead code, never silently ignored.
        let (env, lines, _frames, _rt) = test_env();
        run_measurement_script(env, "fn render(ctx) { [0.0] }\nprint(\"ran\");").unwrap();
        let out = outputs(&lines);
        assert!(
            out.iter().any(|l| l.contains("ignored in a measurement script")),
            "got: {out:?}"
        );
        assert_eq!(out.last().map(String::as_str), Some("ran"));
    }

    #[test]
    fn a_measurement_script_runs_as_a_program() {
        // The full program path: engine on a blocking thread, session bracket
        // closed at the end, completion propagated.
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();
        let lines = Arc::new(StdMutex::new(Vec::<(String, bool)>::new()));
        let sunk = lines.clone();
        let sink: Sink = Arc::new(move |s: &str, e: bool| {
            sunk.lock().unwrap().push((s.to_string(), e));
        });
        let frame_sink: FrameSink = Arc::new(|_f: &Frame| {});
        let capture_sink: CaptureSink = Arc::new(|_c: &ScriptCapture| {});
        let metrics_sink: MetricsSink = Arc::new(|_m| {});
        let mut session = Session::new(
            Arc::new(Mutex::new(QA40xDevice::new())),
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicBool::new(false)),
        );
        let mut program = MeasurementScript::new(
            r#"print("from the program");"#.into(),
            sink,
            frame_sink,
            capture_sink,
            metrics_sink,
        );
        let cancel = CancelToken::new();
        rt.block_on(program.run(&mut session, &cancel)).unwrap();
        assert_eq!(outputs(&lines), vec!["from the program"]);
        assert!(!session.is_active(), "the bracket must be closed after the run");

        let mut failing = MeasurementScript::new(
            "acquire();".into(),
            Arc::new(|_s: &str, _e: bool| {}),
            Arc::new(|_f: &Frame| {}),
            Arc::new(|_c: &ScriptCapture| {}),
            Arc::new(|_m| {}),
        );
        let err = rt.block_on(failing.run(&mut session, &cancel)).unwrap_err();
        assert!(err.contains("not connected"), "got: {err}");
    }

    /* ---- emission API (script traces, task #39) --------------------------- */

    /// A 1 kHz / -6 dBFS synthetic capture, as the "last acquisition".
    fn inject_tone(env: &ScriptEnv) {
        let sr = 48_000u32;
        let n = 32_768usize;
        let tone: Vec<f32> = (0..n)
            .map(|i| 0.5 * (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / sr as f32).sin())
            .collect();
        env.session.inject_last(AudioData {
            left_channel: tone.clone(),
            right_channel: tone,
            sample_rate: sr,
        });
    }

    #[test]
    fn plot_sweep_emits_a_sweep_frame() {
        let (env, _lines, frames, _rt) = test_env();
        run_source_script(env, "plot_sweep([100.0, 1000, 10000.0], [-90.0, -95, -100.0]);")
            .unwrap();
        let frames = frames.lock().unwrap();
        assert_eq!(frames.len(), 1);
        match &frames[0] {
            Frame::Sweep { freqs, curves } => {
                assert_eq!(freqs, &vec![100.0, 1000.0, 10000.0]);
                assert_eq!(curves.len(), 1);
                assert_eq!(curves[0].label, "Script");
                assert_eq!(curves[0].values, vec![-90.0, -95.0, -100.0]);
            }
            other => panic!("expected a sweep frame, got {other:?}"),
        }
    }

    #[test]
    fn plot_sweep_upserts_curves_by_label() {
        // Two labelled curves + a progressive re-emit of the first: the final
        // frame carries both curves with the freshest values.
        let (env, _lines, frames, _rt) = test_env();
        run_source_script(
            env,
            r#"
            plot_sweep("L", [100.0, 1000.0], [-90.0, -91.0]);
            plot_sweep("R", [100.0, 1000.0], [-80.0, -81.0]);
            plot_sweep("L", [100.0, 1000.0], [-92.0, -93.0]);
            "#,
        )
        .unwrap();
        let frames = frames.lock().unwrap();
        assert_eq!(frames.len(), 3, "each call re-emits the whole sweep frame");
        match frames.last().unwrap() {
            Frame::Sweep { freqs, curves } => {
                assert_eq!(freqs.len(), 2);
                let labels: Vec<&str> = curves.iter().map(|c| c.label.as_str()).collect();
                assert_eq!(labels, vec!["L", "R"]);
                assert_eq!(curves[0].values, vec![-92.0, -93.0]);
                assert_eq!(curves[1].values, vec![-80.0, -81.0]);
            }
            other => panic!("expected a sweep frame, got {other:?}"),
        }
    }

    #[test]
    fn plot_spectrum_and_scope_emit_fd_and_td() {
        let (env, _lines, frames, _rt) = test_env();
        run_source_script(
            env,
            r#"
            plot_spectrum([20.0, 20000.0], [-3.0, -60.0]);
            plot_scope([0.0, 0.5, -0.5], 96000);
            "#,
        )
        .unwrap();
        let frames = frames.lock().unwrap();
        assert_eq!(frames.len(), 2);
        match &frames[0] {
            Frame::Fd { freqs, mag_db, phase_deg } => {
                assert_eq!(freqs, &vec![20.0, 20000.0]);
                assert_eq!(mag_db, &vec![-3.0, -60.0]);
                assert!(phase_deg.is_none());
            }
            other => panic!("expected an fd frame, got {other:?}"),
        }
        match &frames[1] {
            Frame::Td { sample_rate, t0, samples, .. } => {
                assert_eq!(*sample_rate, 96000.0);
                assert_eq!(*t0, 0.0);
                assert_eq!(samples, &vec![0.0, 0.5, -0.5]);
            }
            other => panic!("expected a td frame, got {other:?}"),
        }
    }

    #[test]
    fn plot_scope_defaults_to_the_device_sample_rate() {
        let (env, _lines, frames, _rt) = test_env();
        run_source_script(env, "plot_scope([0.0, 1.0]);").unwrap();
        let frames = frames.lock().unwrap();
        match frames.first().unwrap() {
            Frame::Td { sample_rate, .. } => assert_eq!(*sample_rate, 48000.0),
            other => panic!("expected a td frame, got {other:?}"),
        }
    }

    #[test]
    fn plot_rejects_mismatched_or_empty_arrays() {
        let (env, _lines, _frames, _rt) = test_env();
        let err = run_source_script(env.clone(), "plot_sweep([1.0, 2.0], [3.0]);").unwrap_err();
        assert!(err.contains("lengths differ"), "got: {err}");
        let err = run_source_script(env.clone(), "plot_spectrum([], []);").unwrap_err();
        assert!(err.contains("empty"), "got: {err}");
        let err = run_source_script(env, r#"plot_sweep([1.0], ["x"]);"#).unwrap_err();
        assert!(err.contains("must be a number"), "got: {err}");
    }

    #[test]
    fn acquire_only_scripts_fall_back_to_the_capture() {
        // A script that only acquires (here: the injected synthetic capture)
        // yields td + fd frames derived from it — like a generator trace.
        let (env, _lines, _frames, _rt) = test_env();
        inject_tone(&env);
        let frames = fallback_frames(&env);
        assert_eq!(frames.len(), 2);
        let td = frames.iter().find_map(|f| match f {
            Frame::Td { sample_rate, samples, .. } => Some((*sample_rate, samples.len())),
            _ => None,
        });
        assert_eq!(td, Some((48000.0, 32_768)));
        let fd_peak = frames
            .iter()
            .find_map(|f| match f {
                Frame::Fd { freqs, mag_db, .. } => {
                    let (i, _) = mag_db
                        .iter()
                        .enumerate()
                        .max_by(|a, b| a.1.total_cmp(b.1))
                        .unwrap();
                    Some(freqs[i])
                }
                _ => None,
            })
            .expect("an fd fallback frame");
        assert!((fd_peak - 1000.0).abs() < 5.0, "fd peak at {fd_peak} Hz");
    }

    #[test]
    fn emitted_domains_win_over_the_fallback() {
        // The script emitted its own spectrum: the fallback must only fill td.
        let (env, _lines, _frames, _rt) = test_env();
        inject_tone(&env);
        run_measurement_script(env.clone(), "plot_spectrum([20.0], [-3.0]);").unwrap();
        let frames = fallback_frames(&env);
        assert_eq!(frames.len(), 1);
        assert!(matches!(frames[0], Frame::Td { .. }), "got {:?}", frames[0]);
    }

    #[test]
    fn no_acquisition_means_no_fallback_frames() {
        let (env, _lines, _frames, _rt) = test_env();
        assert!(fallback_frames(&env).is_empty());
    }

    /* ---- acquisition broadcast (script-acquire, Traces V2) ----------------- */

    #[test]
    fn build_capture_with_a_tone_carries_the_routed_stimulus() {
        // Tone on: the event carries both captured channels plus the exact
        // stimulus buffers routed to the driven channel(s) (default Left —
        // the script acquisition convention) and the tone frequency.
        let cap = AudioData {
            left_channel: vec![0.1, 0.2, 0.3],
            right_channel: vec![-0.1, -0.2, -0.3],
            sample_rate: 96_000,
        };
        let tone = vec![0.5, -0.5, 0.5];
        let ev = build_capture(&cap, Some((&tone, 1000.0, Route::Left)));
        assert_eq!(ev.sample_rate, 96_000);
        assert_eq!(ev.left, cap.left_channel);
        assert_eq!(ev.right, cap.right_channel);
        let stim = ev.stimulus.expect("stimulus present when the gen is on");
        assert_eq!(stim.left, tone);
        assert_eq!(stim.right, vec![0.0, 0.0, 0.0]);
        assert_eq!(stim.freq, 1000.0);
        assert_eq!(stim.channel, "Left");
    }

    #[test]
    fn build_capture_without_a_tone_is_a_monitor_capture() {
        let cap = AudioData {
            left_channel: vec![0.1],
            right_channel: vec![0.2],
            sample_rate: 48_000,
        };
        let ev = build_capture(&cap, None);
        assert!(ev.stimulus.is_none(), "gen off = monitor capture, no stimulus");
        assert_eq!(ev.left, vec![0.1]);
        assert_eq!(ev.right, vec![0.2]);
    }

    #[test]
    fn script_capture_serializes_like_the_frontend_expects() {
        // Mirror check for ScriptCaptureEvent in src/live.ts: field names +
        // a null stimulus when monitoring.
        let ev = build_capture(
            &AudioData {
                left_channel: vec![0.0],
                right_channel: vec![0.0],
                sample_rate: 48_000,
            },
            None,
        );
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains("\"sample_rate\":48000"), "got {json}");
        assert!(json.contains("\"stimulus\":null"), "got {json}");
        assert!(json.contains("\"left\""), "got {json}");
        assert!(json.contains("\"right\""), "got {json}");
    }

    /* ---- output routing (Traces V2 Phase B) -------------------------------- */

    #[test]
    fn set_gen_output_validates_and_sets_the_route() {
        let (env, _lines, _frames, _rt) = test_env();
        run_measurement_script(env.clone(), r#"set_gen_output("both");"#).unwrap();
        assert_eq!(env.session.gen_config().route, Route::Both);
        run_measurement_script(env.clone(), r#"set_gen_output("Right");"#).unwrap();
        assert_eq!(env.session.gen_config().route, Route::Right);
        let err = run_measurement_script(env, r#"set_gen_output("center");"#).unwrap_err();
        assert!(err.contains("unknown output channel"), "got: {err}");
    }

    /* ---- transformer scripts (Traces V2 Phase C) --------------------------- */

    #[test]
    fn a_transformer_edits_the_spectrum_in_place() {
        let input = Frame::fd(vec![100.0, 1000.0, 10000.0], vec![-40.0, -3.0, -60.0]);
        let out = run_transform(
            "for i in 0..mag_db.len() { mag_db[i] += 6.0; }",
            &input,
        )
        .unwrap();
        match out {
            Frame::Fd { freqs, mag_db, .. } => {
                assert_eq!(freqs, vec![100.0, 1000.0, 10000.0]);
                assert_eq!(mag_db, vec![-34.0, 3.0, -54.0]);
            }
            other => panic!("expected fd, got {other:?}"),
        }
    }

    #[test]
    fn a_transformer_edits_scope_samples_and_sees_the_sample_rate() {
        let input = Frame::td(48_000.0, vec![0.5, -0.5, 0.25]);
        let out = run_transform(
            "if sample_rate != 48000.0 { throw \"bad sr\"; } \
             for i in 0..samples.len() { samples[i] *= 2.0; }",
            &input,
        )
        .unwrap();
        match out {
            Frame::Td { sample_rate, samples, .. } => {
                assert_eq!(sample_rate, 48_000.0);
                assert_eq!(samples, vec![1.0, -1.0, 0.5]);
            }
            other => panic!("expected td, got {other:?}"),
        }
    }

    #[test]
    fn a_transformer_may_resample_but_not_desync_the_spectrum() {
        // Resizing both arrays together is allowed (resampling)…
        let input = Frame::fd(vec![100.0, 1000.0], vec![-10.0, -20.0]);
        let out = run_transform(
            "freqs = [500.0]; mag_db = [-15.0];",
            &input,
        )
        .unwrap();
        assert!(matches!(out, Frame::Fd { ref freqs, .. } if freqs.len() == 1));
        // …but desyncing the lengths is an error.
        let err = run_transform("mag_db.push(-1.0);", &input).unwrap_err();
        assert!(err.contains("inconsistent"), "got: {err}");
        // and removing an array entirely is an error too.
        let err = run_transform("let mag_db = 3;", &input).unwrap_err();
        // (shadowing replaces the array with an int → not readable as an array)
        assert!(err.contains("mag_db"), "got: {err}");
    }

    #[test]
    fn a_transformer_rejects_sweep_frames_and_stays_sandboxed() {
        let sweep = Frame::sweep(
            vec![100.0],
            vec![SweepCurve { label: "L".into(), values: vec![-90.0], phase_deg: None }],
        );
        let err = run_transform("1;", &sweep).unwrap_err();
        assert!(err.contains("sweep"), "got: {err}");

        let fd = Frame::fd(vec![100.0], vec![-10.0]);
        assert!(run_transform("while true {}", &fd).unwrap_err().contains("operation limit"));
        assert!(run_transform(r#"import "os" as os;"#, &fd).is_err());
        assert!(run_transform(r#"eval("1");"#, &fd).is_err());
    }

    #[test]
    fn the_default_route_is_left() {
        // Backward compat: scripts that never call set_gen_output keep the
        // historical drive-Left convention.
        assert_eq!(GenConfig::default().route, Route::Left);
        let ev = build_capture(
            &AudioData { left_channel: vec![0.0], right_channel: vec![0.0], sample_rate: 48_000 },
            Some((&[0.7], 997.0, GenConfig::default().route)),
        );
        let stim = ev.stimulus.unwrap();
        assert_eq!(stim.left, vec![0.7]);
        assert_eq!(stim.right, vec![0.0]);
    }

    #[test]
    fn the_frontend_starter_script_idioms_run() {
        // Mirrors the Rhai idioms used by DEFAULT_SCRIPT_SOURCE and the
        // "Plot demo" example in the frontend (src/dashboard/model.ts,
        // src/script-examples.ts): log-spaced loops, `**`, `.log()`, `.sin()`,
        // arrays with push/len, and the three plot_* forms. Those scripts are
        // classified as SOURCE scripts (they only plot), so run them as such.
        let (env, lines, frames, _rt) = test_env();
        run_source_script(
            env,
            r#"
            let freqs = [];
            let vals = [];
            let f = 20.0;
            while f <= 20000.0 {
                let x = (f / 1000.0).log();
                freqs.push(f);
                vals.push(-6.0 - 3.0 * x * x);
                f *= 1.1;
            }
            plot_sweep(freqs, vals);

            let sf = [];
            let sm = [];
            let i = 1;
            while i <= 200 {
                let freq = 20.0 * (1000.0 ** (i / 200.0));
                sf.push(freq);
                if freq > 950.0 && freq < 1050.0 { sm.push(-3.0); } else { sm.push(-110.0); }
                i += 1;
            }
            plot_spectrum(sf, sm);

            let samples = [];
            let n = 0;
            while n < 480 {
                samples.push(0.5 * (6.283185 * 100.0 * n / 48000.0).sin());
                n += 1;
            }
            plot_scope(samples, 48000);
            print("Plotted " + freqs.len() + " points.");
            "#,
        )
        .unwrap();
        let frames = frames.lock().unwrap();
        assert!(frames.iter().any(|f| matches!(f, Frame::Sweep { .. })));
        assert!(frames.iter().any(|f| matches!(f, Frame::Fd { .. })));
        assert!(frames.iter().any(|f| matches!(f, Frame::Td { .. })));
        assert_eq!(outputs(&lines).len(), 1);
    }
}

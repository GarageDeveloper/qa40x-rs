//! QA40x-compatible REST automation server (dashboard task #21).
//!
//! A minimal HTTP/1.1 server (tokio, no framework) that mirrors the official
//! QuantAsylum QA40x REST API (as shipped with the official app), so scripts
//! written for the QA40x work against us. Measurements reuse the
//! already-validated DSP in [`crate::audio`].
//!
//! Call signatures, units and value shapes mirror the official API — in
//! particular `/Settings/AudioGen` amplitudes are **dBV**, honored through an
//! automatic output-range fit like the official app (issue #20; they were
//! dBFS through v0.2.2 — a breaking change for scripts that relied on it).
//! Where the official parser is stricter (integer-only Hz/dB, exact
//! designators) we accept more forms with the same meaning, never forms that
//! mean something else.
//!
//! Differences from the official app (intentional): we bind `127.0.0.1` by
//! default and can optionally bind `0.0.0.0` (an explicit opt-in — see
//! [`bind_ip`]) so it's reachable from another host; network clients must then
//! present the bearer token from [`RestStatus::token`] (`QA40X_REST_TOKEN` to
//! pin it, otherwise generated per bind). Cross-origin browser access is off
//! unless `QA40X_REST_CORS` names an allowed origin. Numbers use a `.` decimal
//! separator (the official app emits the host locale's separator).

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;

use crate::audio::{AudioAnalyzer, FftProcessor, WindowFunction};
use crate::qa40x::{AudioData, Channel, InputGain, QA40xDevice, SampleRate};
use crate::sources::{route_stimulus, Route};
use crate::utils::SignalGenerator;

const SESSION_ID: &str = "qa40x-rs";

/// A measurement error mapped to an HTTP status + message.
type RestError = (u16, String);
type RestResult = Result<Value, RestError>;

/// One generator slot configured via `/Settings/AudioGen/{Gen1|Gen2}` and
/// played by `/Acquisition`. Amplitude is in **dBV** (RMS), like the official
/// app — the official API has no output-range endpoint, so the acquisition
/// auto-fits the output range to the requested level and converts to DAC
/// full scale there (issue #20; REST amplitudes were dBFS through v0.2.2).
#[derive(Clone)]
struct GenConfig {
    on: bool,
    freq: f32,    // Hz
    amp_dbv: f32, // dBV RMS at the output connectors
}
impl Default for GenConfig {
    fn default() -> Self {
        // The official app's /Settings/Default leaves the generator OFF
        // (measured on app 1.22, 2026-07-22: an untouched acquisition reads
        // the loopback noise floor). We keep Gen1 on — the historical
        // qa40x-rs behavior — as a deliberate divergence; flip it to off if
        // drop-in scripts ever rely on the official default.
        Self { on: true, freq: 1000.0, amp_dbv: -10.0 }
    }
}

/// Amplitude bounds accepted by the official app's AudioGen parser (probed on
/// app 1.22: −121 and +19 dBV get a 400). Matching them keeps a level request
/// from ever being silently shifted — the failure mode issue #20 fixed.
const AMP_DBV_MIN: f32 = -120.0;
const AMP_DBV_MAX: f32 = 18.0;

/// Shared state for the REST server: the device, the generator config, the
/// capture size, and the last acquired buffer that measurements read from.
pub struct RestState {
    device: Arc<Mutex<QA40xDevice>>,
    /// The two generator slots, `Gen1` and `Gen2` — independent, like the
    /// official app's; every enabled one plays (summed) on `/Acquisition`.
    gens: Mutex<[GenConfig; 2]>,
    buffer_size: Mutex<usize>,
    last: Mutex<Option<AudioData>>,
}

/// Both slots' defaults: Gen1 as [`GenConfig::default`], Gen2 off.
fn default_gens() -> [GenConfig; 2] {
    [GenConfig::default(), GenConfig { on: false, ..GenConfig::default() }]
}

impl RestState {
    pub fn new(device: Arc<Mutex<QA40xDevice>>) -> Self {
        Self {
            device,
            gens: Mutex::new(default_gens()),
            buffer_size: Mutex::new(32768),
            last: Mutex::new(None),
        }
    }
}

/// Default TCP port, matching the official QA40x REST server.
pub const DEFAULT_PORT: u16 = 9402;

/// Where the REST server listens. `Localhost` (default) is reachable only from
/// this machine; `Network` binds `0.0.0.0` so other hosts (e.g. a VM) can reach
/// it — an explicit, user-driven opt-in because it exposes hardware control.
fn bind_ip(expose_network: bool) -> [u8; 4] {
    if expose_network {
        [0, 0, 0, 0]
    } else {
        [127, 0, 0, 1]
    }
}

/// A running-status snapshot for the UI.
#[derive(Clone, serde::Serialize, ts_rs::TS)]
#[ts(export)]
pub struct RestStatus {
    pub running: bool,
    pub host: String,
    pub port: u16,
    /// True when bound to `0.0.0.0` (reachable from other hosts).
    pub exposed: bool,
    /// Bearer token network clients must send while exposed (`Authorization:
    /// Bearer …`). `None` when localhost-only, where no token is required.
    pub token: Option<String>,
}

/// Owns the REST listener task and lets the UI rebind it between localhost-only
/// and network-exposed at runtime. Held in the app state.
pub struct RestControl {
    state: Arc<RestState>,
    port: u16,
    exposed: bool,
    /// Required bearer token while network-exposed (`None` on localhost).
    token: Option<Arc<str>>,
    /// User-chosen fixed token (App drawer): when set, exposure always uses it
    /// instead of generating a fresh one per bind.
    fixed_token: Option<String>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl RestControl {
    /// Build the controller (does not start listening yet). Reads
    /// `QA40X_REST_PORT` (default [`DEFAULT_PORT`]) for the port.
    pub fn new(device: Arc<Mutex<QA40xDevice>>) -> Self {
        let port = std::env::var("QA40X_REST_PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(DEFAULT_PORT);
        Self {
            state: Arc::new(RestState::new(device)),
            port,
            exposed: false,
            token: None,
            fixed_token: None,
            task: None,
        }
    }

    /// Whether the app should start exposed on the network, from the
    /// `QA40X_REST_EXPOSE` env var (`1`/`true`/`yes`/`0.0.0.0`). Default false.
    pub fn expose_from_env() -> bool {
        match std::env::var("QA40X_REST_EXPOSE") {
            Ok(v) => {
                let v = v.trim().to_ascii_lowercase();
                matches!(v.as_str(), "1" | "true" | "yes" | "on" | "0.0.0.0" | "network")
            }
            Err(_) => false,
        }
    }

    fn status(&self) -> RestStatus {
        RestStatus {
            running: self.task.is_some(),
            host: if self.exposed { "0.0.0.0".into() } else { "127.0.0.1".into() },
            port: self.port,
            exposed: self.exposed,
            token: self.token.as_deref().map(str::to_owned),
        }
    }

    /// (Re)bind the listener. Aborts any current listener first and waits for it
    /// to release the port, so switching localhost⇄network is seamless. Returns
    /// the new status, or an error string if the bind fails (port in use, etc.).
    pub async fn set_exposed(&mut self, expose: bool) -> Result<RestStatus, String> {
        // Stop the old listener and wait for the task to actually drop it, so
        // the port is free before we rebind to the same one.
        if let Some(task) = self.task.take() {
            task.abort();
            let _ = task.await;
        }
        let addr = SocketAddr::from((bind_ip(expose), self.port));
        let listener = TcpListener::bind(addr)
            .await
            .map_err(|e| format!("cannot bind {addr}: {e}"))?;
        if self.port == 0 {
            // Ephemeral port requested (tests): record what the OS picked so
            // status/rebinds refer to the real port.
            if let Ok(local) = listener.local_addr() {
                self.port = local.port();
            }
        }
        // Exposing hardware control beyond this machine requires a credential:
        // the user's fixed token (App drawer) if set, else QA40X_REST_TOKEN,
        // else freshly generated on every bind.
        self.token = if expose {
            let tok = self
                .fixed_token
                .clone()
                .or_else(|| std::env::var("QA40X_REST_TOKEN").ok().filter(|t| !t.trim().is_empty()))
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            Some(Arc::from(tok.as_str()))
        } else {
            None
        };
        log::info!(
            "QA40x REST server listening on http://{addr}/ ({})",
            if expose { "network-exposed, bearer token required" } else { "localhost only" }
        );
        let st = self.state.clone();
        self.task = Some(tokio::spawn(accept_loop(listener, st, self.token.clone())));
        self.exposed = expose;
        Ok(self.status())
    }

    /// Current status (for the UI).
    pub fn current(&self) -> RestStatus {
        self.status()
    }

    /// Set (or clear, with `None`/blank) the user's fixed bearer token. When
    /// the server is currently network-exposed, it is rebound immediately so
    /// the new credential takes effect; otherwise it simply applies on the
    /// next exposure. Returns the (possibly rebound) status.
    pub async fn set_token(&mut self, token: Option<String>) -> Result<RestStatus, String> {
        self.fixed_token = token.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty());
        if self.exposed && self.task.is_some() {
            return self.set_exposed(true).await;
        }
        Ok(self.status())
    }
}

/// Accept connections until the task is aborted. `auth` is the bearer token
/// every request must carry (set while network-exposed, `None` on localhost).
async fn accept_loop(listener: TcpListener, state: Arc<RestState>, auth: Option<Arc<str>>) {
    loop {
        match listener.accept().await {
            Ok((sock, _peer)) => {
                let st = state.clone();
                let tok = auth.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_conn(sock, st, tok).await {
                        log::debug!("REST connection error: {e}");
                    }
                });
            }
            Err(e) => {
                log::debug!("REST accept error: {e}");
            }
        }
    }
}

/// How long a client may take to send its request headers before we drop the
/// connection (slow-loris guard).
const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(10);

async fn handle_conn(
    mut sock: TcpStream,
    state: Arc<RestState>,
    auth: Option<Arc<str>>,
) -> std::io::Result<()> {
    // Read up to the end of the request headers. QA40x requests are tiny GETs.
    let mut buf = Vec::with_capacity(1024);
    let read_head = async {
        let mut tmp = [0u8; 1024];
        loop {
            let n = sock.read(&mut tmp).await?;
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&tmp[..n]);
            if find_subslice(&buf, b"\r\n\r\n").is_some() || buf.len() > 16384 {
                break;
            }
        }
        std::io::Result::Ok(())
    };
    match tokio::time::timeout(HEADER_READ_TIMEOUT, read_head).await {
        Ok(r) => r?,
        Err(_elapsed) => return Ok(()), // too slow — just drop the connection
    }
    let head = String::from_utf8_lossy(&buf);
    let path = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .unwrap_or("/")
        .to_string();

    let (status, body) = if !authorized(&head, auth.as_deref()) {
        (401u16, json!({ "SessionId": SESSION_ID, "Error": "missing or invalid bearer token" }).to_string())
    } else {
        match dispatch(&path, &state).await {
            Ok(v) => (200u16, v.to_string()),
            Err((code, msg)) => (
                code,
                json!({ "SessionId": SESSION_ID, "Error": msg }).to_string(),
            ),
        }
    };
    let reason = match status {
        200 => "OK",
        401 => "Unauthorized",
        _ => "Error",
    };
    let mut extra = String::new();
    if status == 401 {
        extra.push_str("WWW-Authenticate: Bearer\r\n");
    }
    // Cross-origin browser access is opt-in: QA40X_REST_CORS names the origin
    // to allow (no wildcard by default — the API drives hardware).
    if let Ok(origin) = std::env::var("QA40X_REST_CORS") {
        if !origin.trim().is_empty() {
            extra.push_str(&format!("Access-Control-Allow-Origin: {}\r\n", origin.trim()));
        }
    }
    let resp = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\n{extra}Connection: close\r\n\r\n{body}",
        body.len()
    );
    sock.write_all(resp.as_bytes()).await?;
    sock.flush().await?;
    Ok(())
}

/// Check the request against the required bearer token. No token required
/// (localhost) always passes; otherwise the `Authorization: Bearer …` header
/// must match exactly.
fn authorized(head: &str, required: Option<&str>) -> bool {
    let Some(required) = required else { return true };
    bearer_token(head).is_some_and(|got| got == required)
}

/// Extract the value of an `Authorization: Bearer …` request header, if any.
fn bearer_token(head: &str) -> Option<&str> {
    head.lines()
        .filter_map(|l| l.split_once(':'))
        .find(|(name, _)| name.trim().eq_ignore_ascii_case("authorization"))
        .and_then(|(_, v)| v.trim().strip_prefix("Bearer "))
        .map(str::trim)
}

fn find_subslice(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// Route a path to a handler. Split into `/`-separated segments and match the
/// QA40x URL scheme.
async fn dispatch(path: &str, state: &RestState) -> RestResult {
    // Strip any query string, then split into non-empty segments.
    let path = path.split('?').next().unwrap_or(path);
    let raw = path.trim_start_matches('/');
    let segs: Vec<String> = raw
        .split('/')
        .filter(|s| !s.is_empty())
        .map(urldecode)
        .collect();
    let s: Vec<&str> = segs.iter().map(|x| x.as_str()).collect();

    match s.as_slice() {
        [] => Ok(json!({ "SessionId": SESSION_ID, "Value": "qa40x-rs REST API" })),

        ["Status", "Version"] => status_version(state).await,
        ["Status", "Connection"] => status_connection(state).await,
        ["AcquisitionBusy"] => Ok(value("False")),

        ["Acquisition"] | ["AcquisitionAsync"] => acquisition(state).await,

        ["Settings", rest @ ..] => settings(rest, state).await,

        // Tone measurements (Left/Right) over the last acquisition.
        ["ThdDb", f, _m] => measure(state, num(f)?, |a| db(a.thd as f64 / 100.0)).await,
        ["ThdPct", f, _m] => measure(state, num(f)?, |a| a.thd as f64).await,
        ["ThdnDb", f, _lo, _hi] => measure(state, num(f)?, |a| db(a.thd_n as f64 / 100.0)).await,
        ["ThdnPct", f, _lo, _hi] => measure(state, num(f)?, |a| a.thd_n as f64).await,
        ["SnrDb", f, _lo, _hi] => measure(state, num(f)?, |a| a.snr as f64).await,

        // Level readouts. dBV = dBFS + the input-range calibration offset.
        ["RmsDbv", lo, hi] => band_rms_dbv(state, num(lo)?, num(hi)?).await,
        ["PeakDbv", _lo, _hi] => peak_dbv(state).await,
        ["PeakHz", lo, hi] => peak_hz(state, num(lo)?, num(hi)?).await,

        // Raw data arrays (base64 float64 LE), like QA40x.
        ["Data", "Time", src] => data_time(state, src).await,
        ["Data", "Frequency", src] => data_frequency(state, src).await,

        _ => Err((404, format!("unknown endpoint: /{raw}"))),
    }
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                    */
/* -------------------------------------------------------------------------- */

async fn status_version(state: &RestState) -> RestResult {
    let dev = state.device.lock().await;
    let v = dev
        .device_meta()
        .await
        .map(|m| m.firmware_version.to_string())
        .unwrap_or_else(|| "0".into());
    Ok(json!({ "SessionId": SESSION_ID, "Value": v }))
}

async fn status_connection(state: &RestState) -> RestResult {
    let connected = state.device.lock().await.is_connected().await;
    Ok(value(if connected { "True" } else { "False" }))
}

async fn acquisition(state: &RestState) -> RestResult {
    let gens = state.gens.lock().await.clone();
    let n = (*state.buffer_size.lock().await).max(1024);
    let dev = state.device.lock().await;
    let cfg = dev.get_config().await;
    let sr = cfg.sample_rate.as_hz();
    // Official-app semantics (issue #20): the requested dBV is honored by
    // auto-fitting the output range to the summed peak — the API has no
    // output-range endpoint, and the hardware powers up on the −12 dBV range
    // where even the −10 dBV default would not fit. Same {+8, +18} policy as
    // the GUI mixer (the low ranges have relay-click issues). The fit uses
    // the CONFIGURED levels of both slots whether on or off — On/Off only
    // gates the tone: a generator-off noise floor measured on the power-up
    // −12 dBV range reads ~4 dB above the official app on hardware (its
    // attenuator follows the set level too), and pinning the range to the
    // configured level restores the A/B baseline.
    let peak_volts: f32 = gens.iter().map(|g| 10f32.powf(g.amp_dbv / 20.0)).sum();
    let range = crate::mixer::auto_output_range(20.0 * peak_volts.log10());
    if range != cfg.output_gain.as_dbv() {
        let gain = crate::qa40x::OutputGain::from_dbv(range)
            .ok_or((500, format!("no output range for {range} dBV")))?;
        dev.set_output_gain(gain)
            .await
            .map_err(|e| (500, format!("set output range: {e}")))?;
    }
    let active: Vec<&GenConfig> = gens.iter().filter(|g| g.on).collect();
    let tone = if !active.is_empty() {
        let mut sum = vec![0.0f32; n];
        for g in &active {
            let amp = dbv_to_dac_amp(g.amp_dbv, range);
            // Snap each tone onto the FFT bin grid, like the official app
            // (its 1 kHz plays at 1000.4883 Hz = bin 683 at 48 kHz/32768 —
            // seen in the A/B bench spectra). A coherent tone has NO window
            // skirts, so none of its energy leaks into the THD+N/SNR noise
            // residual; a tone asked between bins raised those readouts
            // ~12 dB above the official app on identical hardware (issue #7).
            let t = SignalGenerator::sine(snap_to_bin(g.freq, sr, n), amp, sr, n);
            for (s, v) in sum.iter_mut().zip(t) {
                *s += v;
            }
        }
        sum
    } else {
        // Generators off: silence (the range fit above still applies).
        vec![0.0f32; n]
    };
    // The official app drives Gen1 on both outputs; match it (the A/B bench
    // caught this driving the left channel only).
    let (mut left, mut right) = route_stimulus(&tone, Route::Both);
    // Pre-compensate the per-unit DAC factory trim so the requested dBV lands
    // at the connectors, like the official app (issue #8: the ideal range
    // model alone left the output a constant ~0.4 dB hot — this unit's trim).
    // Per channel — the two DACs carry distinct trims. Then clamp: two
    // full-tilt tones (or a trim > 1) can exceed DAC full scale — clamp,
    // never rescale (the mixer policy; relative levels are the caller's
    // choice).
    let (trims, _calibrated) = dev.dac_trims().await;
    for (chan, trim) in [(&mut left, trims.0), (&mut right, trims.1)] {
        for s in chan.iter_mut() {
            *s = (*s * trim).clamp(-1.0, 1.0);
        }
    }
    let cap = dev
        .generate_and_capture(&left, &right)
        .await
        .map_err(|e| (500, format!("acquisition failed: {e}")))?;
    drop(dev);
    *state.last.lock().await = Some(cap);
    Ok(json!({ "SessionId": SESSION_ID, "Value": "True" }))
}

async fn settings(rest: &[&str], state: &RestState) -> RestResult {
    match rest {
        ["Default"] => {
            *state.gens.lock().await = default_gens();
            *state.buffer_size.lock().await = 32768;
            Ok(value("True"))
        }
        ["SampleRate", sr] => {
            let hz = num(sr)? as u32;
            let rate = SampleRate::from_hz(hz).ok_or((400, format!("bad sample rate: {hz}")))?;
            state
                .device
                .lock()
                .await
                .set_sample_rate(rate)
                .await
                .map_err(|e| (500, e.to_string()))?;
            Ok(value("True"))
        }
        ["BufferSize", n] => {
            *state.buffer_size.lock().await = (num(n)? as usize).max(1024);
            Ok(value("True"))
        }
        // Input full-scale (dBV) — the QA40x's only range control (reg 5).
        ["Input", "Max", dbv] => {
            let v = num(dbv)? as i32;
            let gain = InputGain::from_dbv(v).ok_or((400, format!("bad input range: {v}")))?;
            state
                .device
                .lock()
                .await
                .set_input_gain(gain)
                .await
                .map_err(|e| (500, e.to_string()))?;
            Ok(value("True"))
        }
        // Generator: /Settings/AudioGen/{Gen1|Gen2}/{On|Off}/{Hz}/{Amplitude(dBV)}
        // — the official call signature and units. Where the official parser
        // is stricter (integer Hz/dB only), we accept more with the SAME
        // meaning; everything it rejects with a 400 (unknown designator or
        // state, out-of-range amplitude) is rejected here too, so a level is
        // never silently reinterpreted (issue #20).
        ["AudioGen", gen, on, hz, amp] => {
            let idx = match gen.to_ascii_lowercase().as_str() {
                "gen1" | "1" => 0,
                "gen2" | "2" => 1,
                _ => return Err((400, format!("bad generator designator: {gen} (Gen1|Gen2)"))),
            };
            let on = match on.to_ascii_lowercase().as_str() {
                "on" | "1" => true,
                "off" | "0" => false,
                _ => return Err((400, format!("bad generator state: {on} (On|Off)"))),
            };
            let freq = num(hz)?;
            if !freq.is_finite() || freq <= 0.0 {
                return Err((400, format!("bad generator frequency: {hz} Hz")));
            }
            let amp_dbv = num(amp)?;
            if !amp_dbv.is_finite() || !(AMP_DBV_MIN..=AMP_DBV_MAX).contains(&amp_dbv) {
                return Err((
                    400,
                    format!("amplitude {amp} dBV out of range [{AMP_DBV_MIN}, {AMP_DBV_MAX}]"),
                ));
            }
            state.gens.lock().await[idx] = GenConfig { on, freq, amp_dbv };
            Ok(value("True"))
        }
        _ => Err((404, format!("unknown /Settings/{}", rest.join("/")))),
    }
}

/// Run `pick` on the analysis of each channel at `fund`, returning {Left,Right}.
async fn measure(
    state: &RestState,
    fund: f32,
    pick: impl Fn(&crate::audio::AnalysisResult) -> f64,
) -> RestResult {
    let cap = last(state).await?;
    let l = pick(&analyze_channel(&cap.left_channel, cap.sample_rate, fund));
    let r = pick(&analyze_channel(&cap.right_channel, cap.sample_rate, fund));
    Ok(left_right(l, r))
}

/// Band-limited RMS in dBV: the spectrum integrated over [lo, hi] Hz
/// (ENBW-corrected) + the input-range calibration offset. Matches the
/// official app's `RmsDbv` — which honors the band — where a full-band
/// time-domain RMS also reads DC and out-of-band noise, ~31 dB above the
/// official 20 Hz–20 kHz noise floor on real hardware (issue #7).
async fn band_rms_dbv(state: &RestState, lo: f32, hi: f32) -> RestResult {
    let cap = last(state).await?;
    let (off_l, _) = state.device.lock().await.input_dbv_offset(Channel::Left).await;
    let (off_r, _) = state.device.lock().await.input_dbv_offset(Channel::Right).await;
    let band = |sig: &[f32]| {
        let r = spectrum(sig, cap.sample_rate);
        AudioAnalyzer::band_rms_from_spectrum(&r.magnitudes, &r.frequencies, lo, hi, r.enbw_bins)
    };
    let l = db(band(&cap.left_channel) as f64) + off_l as f64;
    let r = db(band(&cap.right_channel) as f64) + off_r as f64;
    Ok(left_right(l, r))
}

/// Peak level in dBV: the time-domain absolute peak + the input-range
/// calibration offset (the band arguments don't apply to a sample peak).
async fn peak_dbv(state: &RestState) -> RestResult {
    let cap = last(state).await?;
    let (off_l, _) = state.device.lock().await.input_dbv_offset(Channel::Left).await;
    let (off_r, _) = state.device.lock().await.input_dbv_offset(Channel::Right).await;
    let l = db(AudioAnalyzer::calculate_peak(&cap.left_channel) as f64) + off_l as f64;
    let r = db(AudioAnalyzer::calculate_peak(&cap.right_channel) as f64) + off_r as f64;
    Ok(left_right(l, r))
}

async fn peak_hz(state: &RestState, lo: f32, hi: f32) -> RestResult {
    let cap = last(state).await?;
    let l = peak_freq(&cap.left_channel, cap.sample_rate, lo, hi);
    let r = peak_freq(&cap.right_channel, cap.sample_rate, lo, hi);
    Ok(left_right(l as f64, r as f64))
}

async fn data_time(state: &RestState, src: &str) -> RestResult {
    // Only the Input capture is available; Output would need the played stimulus.
    if !src.eq_ignore_ascii_case("Input") {
        return Err((501, format!("Data/Time/{src} not supported (Input only)")));
    }
    let cap = last(state).await?;
    let dx = 1.0 / cap.sample_rate as f64;
    Ok(json!({
        "SessionId": SESSION_ID,
        "Length": cap.left_channel.len().to_string(),
        "Dx": fmt(dx),
        "Left": b64_f64(&cap.left_channel),
        "Right": b64_f64(&cap.right_channel),
    }))
}

async fn data_frequency(state: &RestState, src: &str) -> RestResult {
    if !src.eq_ignore_ascii_case("Input") {
        return Err((501, format!("Data/Frequency/{src} not supported (Input only)")));
    }
    let cap = last(state).await?;
    let l = spectrum(&cap.left_channel, cap.sample_rate);
    let r = spectrum(&cap.right_channel, cap.sample_rate);
    let f = &l.frequencies;
    let dx = if f.len() > 1 { (f[1] - f[0]) as f64 } else { 0.0 };
    Ok(json!({
        "SessionId": SESSION_ID,
        "Length": l.magnitudes.len().to_string(),
        "Dx": fmt(dx),
        "Left": b64_f64(&l.magnitudes),
        "Right": b64_f64(&r.magnitudes),
    }))
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

async fn last(state: &RestState) -> Result<AudioData, RestError> {
    state
        .last
        .lock()
        .await
        .clone()
        .ok_or((409, "no acquisition yet — call /Acquisition first".into()))
}

/// Analyze one channel at a given fundamental. Shared with the Rhai scripting
/// engine (`crate::script`) so both automation surfaces measure identically.
pub(crate) fn analyze_channel(sig: &[f32], sr: u32, fund: f32) -> crate::audio::AnalysisResult {
    let r = spectrum(sig, sr);
    AudioAnalyzer::analyze(sig, &r.magnitudes, &r.frequencies, fund)
}

/// Hann-windowed magnitude spectrum (with the window's ENBW for band
/// integrals). Shared with `crate::measurement` (the auto-level probe's
/// band-RMS fraction and the dashboard's band-RMS verb).
pub(crate) fn spectrum(sig: &[f32], sr: u32) -> crate::audio::FftResult {
    let mut fft = FftProcessor::new();
    fft.process_real_windowed(sig, sr, WindowFunction::Hann)
}

/// Digital peak amplitude (full-scale = 1.0) of a sine whose RMS at the
/// output connectors is `dbv`, on the `range_dbv` output range. The range's
/// dBV is by definition the RMS of a full-scale sine, so the conversion is a
/// plain level difference: `10^((dBV − range)/20)`.
fn dbv_to_dac_amp(dbv: f32, range_dbv: i32) -> f32 {
    10f32.powf((dbv - range_dbv as f32) / 20.0)
}

/// Round `freq` to the nearest bin of an `n`-point FFT at `sr` Hz, so the
/// generated tone is periodic in the capture buffer (coherent — zero spectral
/// leakage under any window). Matches the official app's generator.
pub(crate) fn snap_to_bin(freq: f32, sr: u32, n: usize) -> f32 {
    if n == 0 || sr == 0 || !(freq > 0.0) {
        return freq;
    }
    let bin = (freq as f64 * n as f64 / sr as f64).round();
    (bin * sr as f64 / n as f64) as f32
}

/// Frequency of the strongest bin within [lo, hi] Hz. Shared with `crate::script`.
pub(crate) fn peak_freq(sig: &[f32], sr: u32, lo: f32, hi: f32) -> f32 {
    let r = spectrum(sig, sr);
    let mut best = 0.0f32;
    let mut best_f = 0.0f32;
    for (i, &m) in r.magnitudes.iter().enumerate() {
        let f = r.frequencies[i];
        if f >= lo && f <= hi && m > best {
            best = m;
            best_f = f;
        }
    }
    best_f
}

/// Ratio → dB, floored at -200 dB. Shared with `crate::script`.
pub(crate) fn db(x: f64) -> f64 {
    if x > 0.0 {
        (20.0 * x.log10()).max(-200.0)
    } else {
        -200.0
    }
}

fn fmt(x: f64) -> String {
    if !x.is_finite() {
        return "-\u{221e}".into();
    }
    format!("{x:.6}")
}

fn value(v: &str) -> Value {
    json!({ "SessionId": SESSION_ID, "Value": v })
}

fn left_right(l: f64, r: f64) -> Value {
    json!({ "SessionId": SESSION_ID, "Left": fmt(l), "Right": fmt(r) })
}

/// base64 of a little-endian `f64[]` (samples widened from f32), like QA40x.
fn b64_f64(samples: &[f32]) -> String {
    let mut bytes = Vec::with_capacity(samples.len() * 8);
    for &s in samples {
        bytes.extend_from_slice(&(s as f64).to_le_bytes());
    }
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn num(s: &str) -> Result<f32, RestError> {
    s.parse::<f32>()
        .map_err(|_| (400, format!("expected a number, got '{s}'")))
}

/// Minimal percent-decoding (`+` → space, `%XX` → byte) for path segments.
fn urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                if let Ok(v) = u8::from_str_radix(hex, 16) {
                    out.push(v);
                    i += 3;
                } else {
                    out.push(b'%');
                    i += 1;
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn state_with_tone() -> Arc<RestState> {
        // A synthetic 1 kHz / -6 dBFS tone as the "last acquisition" (no device I/O).
        let sr = 48000u32;
        let n = 32768usize;
        let tone: Vec<f32> = (0..n)
            .map(|i| 0.5 * (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / sr as f32).sin())
            .collect();
        let st = Arc::new(RestState::new(Arc::new(Mutex::new(QA40xDevice::new()))));
        *st.last.lock().await = Some(AudioData {
            left_channel: tone.clone(),
            right_channel: tone,
            sample_rate: sr,
        });
        st
    }

    #[tokio::test]
    async fn peak_hz_finds_the_tone() {
        let st = state_with_tone().await;
        let v = dispatch("/PeakHz/20/20000", &st).await.unwrap();
        let left: f32 = v["Left"].as_str().unwrap().parse().unwrap();
        assert!((left - 1000.0).abs() < 5.0, "peak at {left} Hz");
    }

    #[tokio::test]
    async fn rms_dbv_of_a_minus6_dbfs_tone() {
        let st = state_with_tone().await;
        let v = dispatch("/RmsDbv/20/20000", &st).await.unwrap();
        let left: f64 = v["Left"].as_str().unwrap().parse().unwrap();
        // 0.5-peak sine → RMS 0.3536 → -9.03 dBFS; +0 offset (input 6 dBV default).
        assert!((left - (-9.03)).abs() < 0.3, "rms {left} dBV");
    }

    #[test]
    fn snap_to_bin_matches_the_official_generator_grid() {
        // 48 kHz / 32768 samples: 1 kHz snaps to bin 683 = 1000.4883 Hz — the
        // exact frequency the official app plays (measured in the A/B bench
        // spectra, where its fundamental sits dead-center on bin 683).
        let f = snap_to_bin(1000.0, 48000, 32768);
        assert!((f - 1000.4883).abs() < 1e-3, "snapped to {f}");
        // Degenerate inputs pass through untouched.
        assert_eq!(snap_to_bin(0.0, 48000, 32768), 0.0);
        assert_eq!(snap_to_bin(1000.0, 0, 32768), 1000.0);
    }

    #[tokio::test]
    async fn rms_dbv_rejects_dc_and_out_of_band_energy() {
        // DC + a 22.5 kHz tone (both bin-centered, both outside 20 Hz–20 kHz):
        // the band readout must stay at the numerical floor. The old
        // time-domain RMS read their full energy (−33 dBFS here) — the same
        // failure that put the hardware noise floor 31 dB above the official
        // app's (issue #7).
        let sr = 48000u32;
        let n = 32768usize;
        // f64-phase generation (like the acquisition path) — a naive f32
        // unwrapped phase would add ~−80 dB of its own sideband noise.
        let sig: Vec<f32> = SignalGenerator::sine(22500.0, 0.01, sr, n)
            .into_iter()
            .map(|s| s + 0.02)
            .collect();
        let st = Arc::new(RestState::new(Arc::new(Mutex::new(QA40xDevice::new()))));
        *st.last.lock().await = Some(AudioData {
            left_channel: sig.clone(),
            right_channel: sig,
            sample_rate: sr,
        });
        let v = dispatch("/RmsDbv/20/20000", &st).await.unwrap();
        let left: f64 = v["Left"].as_str().unwrap().parse().unwrap();
        assert!(left < -100.0, "in-band RMS {left} dBV — DC/out-of-band leaked in");
    }

    #[tokio::test]
    async fn coherent_tone_has_no_thdn_leakage_floor() {
        // A bin-centered (coherent) tone — what the snapped generator now
        // plays — must not manufacture a THD+N floor out of window skirts:
        // the non-coherent 1000.0 Hz equivalent reads ≈ −86 dB from Hann
        // leakage alone (the A/B divergence), the coherent one is clean.
        let sr = 48000u32;
        let n = 32768usize;
        let f = snap_to_bin(1000.0, sr, n);
        let tone = SignalGenerator::sine(f, 0.5, sr, n);
        let st = Arc::new(RestState::new(Arc::new(Mutex::new(QA40xDevice::new()))));
        *st.last.lock().await = Some(AudioData {
            left_channel: tone.clone(),
            right_channel: tone,
            sample_rate: sr,
        });
        let v = dispatch("/ThdnDb/1000/20/20000", &st).await.unwrap();
        let left: f64 = v["Left"].as_str().unwrap().parse().unwrap();
        assert!(left < -100.0, "THD+N of a pure coherent tone reads {left} dB");
    }

    #[tokio::test]
    async fn data_time_is_base64_f64() {
        let st = state_with_tone().await;
        let v = dispatch("/Data/Time/Input", &st).await.unwrap();
        assert_eq!(v["Length"].as_str().unwrap(), "32768");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(v["Left"].as_str().unwrap())
            .unwrap();
        assert_eq!(bytes.len(), 32768 * 8, "float64 little-endian");
    }

    #[test]
    fn dbv_to_dac_amp_is_a_level_difference_to_the_range() {
        // −10 dBV on the +8 dBV range: 18 dB below full scale.
        assert!((dbv_to_dac_amp(-10.0, 8) - 0.12589254).abs() < 1e-6);
        // Full scale exactly at the range's dBV.
        assert!((dbv_to_dac_amp(18.0, 18) - 1.0).abs() < 1e-6);
    }

    #[tokio::test]
    async fn audiogen_honors_the_gen_designator() {
        let st = state_with_tone().await;
        dispatch("/Settings/AudioGen/Gen1/On/1000/-10", &st).await.unwrap();
        dispatch("/Settings/AudioGen/Gen2/On/2000/-20", &st).await.unwrap();
        let gens = st.gens.lock().await.clone();
        assert!(gens[0].on && gens[0].freq == 1000.0 && gens[0].amp_dbv == -10.0);
        assert!(gens[1].on && gens[1].freq == 2000.0 && gens[1].amp_dbv == -20.0);
        // Gen2 no longer overwrites Gen1 (the pre-#20 single-slot behavior).
        dispatch("/Settings/AudioGen/gen2/Off/500/-30", &st).await.unwrap();
        let gens = st.gens.lock().await.clone();
        assert!(gens[0].on && gens[0].freq == 1000.0, "Gen1 must be untouched");
        assert!(!gens[1].on && gens[1].freq == 500.0);
    }

    #[tokio::test]
    async fn audiogen_rejects_what_the_official_parser_rejects() {
        // Probed on the official app 1.22 (issue #20): unknown designator,
        // unknown state, and amplitudes outside [−120, +18] dBV all get 400.
        let st = state_with_tone().await;
        for path in [
            "/Settings/AudioGen/Gen3/On/1000/-10",
            "/Settings/AudioGen/Gen1/Enabled/1000/-10",
            "/Settings/AudioGen/Gen1/On/1000/19",
            "/Settings/AudioGen/Gen1/On/1000/-121",
            "/Settings/AudioGen/Gen1/On/0/-10",
        ] {
            assert_eq!(dispatch(path, &st).await.unwrap_err().0, 400, "{path}");
        }
        // In-range settings (including the accepted extra numeric designator)
        // still pass.
        dispatch("/Settings/AudioGen/1/On/1000/18", &st).await.unwrap();
        dispatch("/Settings/AudioGen/Gen1/Off/1000/-120", &st).await.unwrap();
    }

    #[tokio::test]
    async fn acquisition_honors_dbv_on_the_virtual_device() {
        // End-to-end against the embedded virtual QA403 (the bench's demo
        // target): a −10 dBV request must auto-fit the +8 dBV output range
        // (the device powers up on −12 dBV) and read back ≈ −10 dBV.
        let device = Arc::new(Mutex::new(QA40xDevice::new()));
        device.lock().await.connect_virtual().await.expect("virtual connect");
        let st = Arc::new(RestState::new(device.clone()));
        dispatch("/Settings/AudioGen/Gen1/On/1000/-10", &st).await.unwrap();
        dispatch("/Acquisition", &st).await.unwrap();
        assert_eq!(
            device.lock().await.get_config().await.output_gain.as_dbv(),
            8,
            "output range must auto-fit the requested level"
        );
        let v = dispatch("/RmsDbv/900/1100", &st).await.unwrap();
        let left: f64 = v["Left"].as_str().unwrap().parse().unwrap();
        // 0.15 dB: tight enough to catch a dropped DAC trim (issue #8 was a
        // +0.36 dB miss), loose enough for the sim's latency lead-in bias.
        assert!((left - (-10.0)).abs() < 0.15, "read {left} dBV for a -10 dBV request");
        let right: f64 = v["Right"].as_str().unwrap().parse().unwrap();
        assert!((right - (-10.0)).abs() < 0.15, "read {right} dBV for a -10 dBV request");

        // The range fit follows the CONFIGURED level even with the generator
        // off (On/Off only gates the tone) — a gen-off noise floor on the
        // power-up −12 dBV range read ~4 dB high on hardware.
        dispatch("/Settings/AudioGen/Gen1/Off/1000/17", &st).await.unwrap();
        dispatch("/Acquisition", &st).await.unwrap();
        assert_eq!(device.lock().await.get_config().await.output_gain.as_dbv(), 18);
    }

    #[tokio::test]
    async fn unknown_endpoint_is_404() {
        let st = state_with_tone().await;
        assert_eq!(dispatch("/Nope/x", &st).await.unwrap_err().0, 404);
    }

    #[tokio::test]
    async fn measurement_needs_an_acquisition_first() {
        let st = Arc::new(RestState::new(Arc::new(Mutex::new(QA40xDevice::new()))));
        assert_eq!(dispatch("/ThdDb/1000/20000", &st).await.unwrap_err().0, 409);
    }

    #[test]
    fn urldecode_handles_plus_and_percent() {
        assert_eq!(urldecode("a+b%2Fc"), "a b/c");
    }

    #[test]
    fn bearer_token_parses_the_header() {
        let head = "GET /Status/Version HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer s3cret\r\n\r\n";
        assert_eq!(bearer_token(head), Some("s3cret"));
        assert_eq!(bearer_token("GET / HTTP/1.1\r\nHost: x\r\n\r\n"), None);
        // Header names are case-insensitive.
        let head = "GET / HTTP/1.1\r\nauthorization: Bearer t\r\n\r\n";
        assert_eq!(bearer_token(head), Some("t"));
    }

    #[tokio::test]
    async fn exposed_server_requires_bearer_token() {
        let mut ctl = RestControl::new(Arc::new(Mutex::new(QA40xDevice::new())));
        ctl.port = 0; // ephemeral — don't fight over 9402 with a running app
        let status = ctl.set_exposed(true).await.expect("bind");
        let token = status.token.expect("exposed ⇒ token");

        async fn get(port: u16, auth: Option<&str>) -> String {
            let mut sock = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            let auth_line = auth
                .map(|t| format!("Authorization: Bearer {t}\r\n"))
                .unwrap_or_default();
            let req = format!("GET / HTTP/1.1\r\nHost: x\r\n{auth_line}\r\n");
            sock.write_all(req.as_bytes()).await.unwrap();
            let mut out = Vec::new();
            sock.read_to_end(&mut out).await.unwrap();
            String::from_utf8_lossy(&out).into_owned()
        }

        let denied = get(status.port, None).await;
        assert!(denied.starts_with("HTTP/1.1 401"), "got: {denied}");
        assert!(denied.contains("WWW-Authenticate: Bearer"), "got: {denied}");

        let wrong = get(status.port, Some("not-the-token")).await;
        assert!(wrong.starts_with("HTTP/1.1 401"), "got: {wrong}");

        let ok = get(status.port, Some(&token)).await;
        assert!(ok.starts_with("HTTP/1.1 200"), "got: {ok}");
        // No CORS wildcard by default.
        assert!(!ok.contains("Access-Control-Allow-Origin"), "got: {ok}");

        // Back to localhost: no token required any more.
        let status = ctl.set_exposed(false).await.expect("rebind");
        assert!(status.token.is_none());
        let ok = get(status.port, None).await;
        assert!(ok.starts_with("HTTP/1.1 200"), "got: {ok}");
    }

    #[tokio::test]
    async fn fixed_token_is_stable_across_rebinds() {
        let mut ctl = RestControl::new(Arc::new(Mutex::new(QA40xDevice::new())));
        ctl.port = 0;

        // Without a fixed token, each exposure mints a fresh credential.
        let a = ctl.set_exposed(true).await.unwrap().token.unwrap();
        ctl.set_exposed(false).await.unwrap();
        let b = ctl.set_exposed(true).await.unwrap().token.unwrap();
        assert_ne!(a, b, "random tokens must rotate per bind");

        // A fixed token applies immediately (hot rebind while exposed)…
        let st = ctl.set_token(Some("pinned-secret".into())).await.unwrap();
        assert_eq!(st.token.as_deref(), Some("pinned-secret"));
        assert!(st.exposed && st.running);

        // …and survives disable/enable cycles.
        ctl.set_exposed(false).await.unwrap();
        let st = ctl.set_exposed(true).await.unwrap();
        assert_eq!(st.token.as_deref(), Some("pinned-secret"));

        // Clearing it (blank counts as clear) goes back to per-bind random.
        let st = ctl.set_token(Some("   ".into())).await.unwrap();
        let tok = st.token.unwrap();
        assert_ne!(tok, "pinned-secret");
        ctl.set_exposed(false).await.unwrap();
        let again = ctl.set_exposed(true).await.unwrap().token.unwrap();
        assert_ne!(tok, again, "cleared fixed token ⇒ rotation resumes");
    }

    #[test]
    fn authorization_rules() {
        let with = "GET / HTTP/1.1\r\nAuthorization: Bearer good\r\n\r\n";
        let without = "GET / HTTP/1.1\r\nHost: x\r\n\r\n";
        // Localhost (no token required): everything passes.
        assert!(authorized(with, None));
        assert!(authorized(without, None));
        // Exposed (token required): exact match only.
        assert!(authorized(with, Some("good")));
        assert!(!authorized(with, Some("other")));
        assert!(!authorized(without, Some("good")));
    }
}

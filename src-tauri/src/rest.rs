//! QA40x-compatible REST automation server (dashboard task #21).
//!
//! A minimal HTTP/1.1 server (tokio, no framework) that mirrors the official
//! QuantAsylum QA40x REST API (as shipped with the official app), so scripts
//! written for the QA40x work against us. Measurements reuse the
//! already-validated DSP in [`crate::audio`].
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
use crate::utils::SignalGenerator;

const SESSION_ID: &str = "qa40x-rs";

/// A measurement error mapped to an HTTP status + message.
type RestError = (u16, String);
type RestResult = Result<Value, RestError>;

/// The generator settings the REST client configures (via `/Settings/AudioGen`)
/// and that `/Acquisition` plays.
#[derive(Clone)]
struct GenConfig {
    on: bool,
    freq: f32,     // Hz
    amp_dbfs: f32, // dBFS (relative to DAC full scale)
}
impl Default for GenConfig {
    fn default() -> Self {
        Self { on: true, freq: 1000.0, amp_dbfs: -6.0 }
    }
}

/// Shared state for the REST server: the device, the generator config, the
/// capture size, and the last acquired buffer that measurements read from.
pub struct RestState {
    device: Arc<Mutex<QA40xDevice>>,
    gen: Mutex<GenConfig>,
    buffer_size: Mutex<usize>,
    last: Mutex<Option<AudioData>>,
}

impl RestState {
    pub fn new(device: Arc<Mutex<QA40xDevice>>) -> Self {
        Self {
            device,
            gen: Mutex::new(GenConfig::default()),
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
        ["RmsDbv", lo, hi] => level_dbv(state, num(lo)?, num(hi)?, |a| a.rms).await,
        ["PeakDbv", lo, hi] => level_dbv(state, num(lo)?, num(hi)?, |a| a.peak).await,
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
    let g = state.gen.lock().await.clone();
    let n = (*state.buffer_size.lock().await).max(1024);
    let dev = state.device.lock().await;
    let sr = dev.get_config().await.sample_rate.as_hz();
    let tone = if g.on {
        let amp = 10f32.powf(g.amp_dbfs.clamp(-120.0, 0.0) / 20.0);
        SignalGenerator::sine(g.freq, amp, sr, n)
    } else {
        vec![0.0f32; n]
    };
    let silence = vec![0.0f32; n];
    let cap = dev
        .generate_and_capture(&tone, &silence)
        .await
        .map_err(|e| (500, format!("acquisition failed: {e}")))?;
    drop(dev);
    *state.last.lock().await = Some(cap);
    Ok(json!({ "SessionId": SESSION_ID, "Value": "True" }))
}

async fn settings(rest: &[&str], state: &RestState) -> RestResult {
    match rest {
        ["Default"] => {
            *state.gen.lock().await = GenConfig::default();
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
        // Generator: /Settings/AudioGen/{Gen}/{On|Off}/{Hz}/{Amplitude(dBFS)}
        ["AudioGen", _gen, on, hz, amp] => {
            let mut g = state.gen.lock().await;
            g.on = on.eq_ignore_ascii_case("on") || *on == "1";
            g.freq = num(hz)?;
            g.amp_dbfs = num(amp)?;
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

/// Level (RMS/Peak) in dBV: dBFS + the current input-range calibration offset.
async fn level_dbv(
    state: &RestState,
    lo: f32,
    hi: f32,
    pick: impl Fn(&crate::audio::AnalysisResult) -> f32,
) -> RestResult {
    let cap = last(state).await?;
    let fund = peak_freq(&cap.left_channel, cap.sample_rate, lo, hi);
    let (off_l, _) = state.device.lock().await.input_dbv_offset(Channel::Left).await;
    let (off_r, _) = state.device.lock().await.input_dbv_offset(Channel::Right).await;
    let l = db(pick(&analyze_channel(&cap.left_channel, cap.sample_rate, fund)) as f64) + off_l as f64;
    let r = db(pick(&analyze_channel(&cap.right_channel, cap.sample_rate, fund)) as f64) + off_r as f64;
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
    let (ml, freqs) = spectrum(&cap.left_channel, cap.sample_rate);
    let (mr, _) = spectrum(&cap.right_channel, cap.sample_rate);
    let dx = if freqs.len() > 1 { (freqs[1] - freqs[0]) as f64 } else { 0.0 };
    Ok(json!({
        "SessionId": SESSION_ID,
        "Length": ml.len().to_string(),
        "Dx": fmt(dx),
        "Left": b64_f64(&ml),
        "Right": b64_f64(&mr),
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
    let (mags, freqs) = spectrum(sig, sr);
    AudioAnalyzer::analyze(sig, &mags, &freqs, fund)
}

/// Hann-windowed magnitude spectrum. Shared with `crate::measurement` (the
/// auto-level probe's band-RMS fraction).
pub(crate) fn spectrum(sig: &[f32], sr: u32) -> (Vec<f32>, Vec<f32>) {
    let mut fft = FftProcessor::new();
    let r = fft.process_real_windowed(sig, sr, WindowFunction::Hann);
    (r.magnitudes, r.frequencies)
}

/// Frequency of the strongest bin within [lo, hi] Hz. Shared with `crate::script`.
pub(crate) fn peak_freq(sig: &[f32], sr: u32, lo: f32, hi: f32) -> f32 {
    let (mags, freqs) = spectrum(sig, sr);
    let mut best = 0.0f32;
    let mut best_f = 0.0f32;
    for (i, &m) in mags.iter().enumerate() {
        let f = freqs[i];
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

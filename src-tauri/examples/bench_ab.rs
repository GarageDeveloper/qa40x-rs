//! bench_ab — comparative A/B loopback bench: qa40x-rs (this repo, on the
//! macOS host) vs the official QuantAsylum QA40x application (in a Parallels
//! Windows VM), with the same QA402 hardware switched between the two.
//!
//! Both servers speak the QA40x REST scheme on port 9402, so one HTTP client
//! runs the identical measurement battery against each target:
//!
//!   host phase  → in-process REST server (like `rest_hw`) + QA402 over native USB
//!   VM phase    → `prlsrvctl usb set` assigns the QA402 to the VM, `prlctl`
//!                 boots it and launches QA40x.exe, then the battery runs
//!                 against http://<vm-ip>:9402
//!
//! The battery is the classic audiophile loopback checklist (L+ OUT → L+ IN,
//! R+ OUT → R+ IN): noise floor, absolute level & interchannel balance at
//! 1 kHz, THD/THD+N/SNR at 1 kHz, THD at 100 Hz and 6 kHz, stepped-tone
//! frequency response 20 Hz–20 kHz, amplitude linearity in 10 dB steps, plus
//! a saved 1 kHz spectrum snapshot for offline diffing.
//!
//! Both targets take the generator amplitude in dBV with an auto-fitted
//! output range (issue #20 aligned qa40x-rs on the official semantics), so a
//! single --amp drives both — which also A/B-validates that endpoint.
//!
//! Run (hardware + VM):  cargo run --example bench_ab
//! Harness self-test:    cargo run --example bench_ab -- --demo --skip-vm
//! See doc/bench-ab.md for prerequisites and the full methodology.

use std::fmt::Write as _;
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tauri_app_lib::qa40x::QA40xDevice;
use tauri_app_lib::rest::RestControl;
use tokio::sync::Mutex;

type R<T> = Result<T, String>;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

struct Cli {
    rounds: u32,
    vm_name: String,
    usb_name: String,
    qa40x_exe: String,
    vm_url: Option<String>,
    amp_dbv: f64,
    sample_rate: u32,
    buffer_size: u32,
    /// Analysis windows to force on BOTH targets (official designators), one
    /// full battery per window — the issue #14 diagnostic matrix. The official
    /// app cannot be asked what window it uses (no settings readback in its
    /// REST API), but it CAN be told: /Settings/Windowing/{name}.
    windows: Vec<String>,
    /// Acquisitions averaged (in linear power) for the THD @100 Hz row, whose
    /// official reading moves run-to-run (near-noise-floor harmonics).
    thd_avg: u32,
    out_dir: String,
    demo: bool,
    skip_vm: bool,
    skip_host: bool,
    keep_vm: bool,
    no_prompt: bool,
    vm_timeout_s: u64,
    /// Offline mode: saved spectrum snapshots to run the inference + THD
    /// probe on (no hardware, no VM). Repeatable.
    probe_files: Vec<String>,
    /// Asked tone frequency for --probe files (the inference searches ±25 %
    /// around it).
    probe_freq: f64,
}

impl Default for Cli {
    fn default() -> Self {
        Self {
            rounds: 1,
            vm_name: "Windows 11".into(),
            usb_name: "QA402 Audio Analyzer".into(),
            qa40x_exe: r"C:\Program Files (x86)\QuantAsylum\QA40x\QA40x.exe".into(),
            vm_url: None,
            amp_dbv: -10.0,
            sample_rate: 48000,
            buffer_size: 32768,
            // Rectangle is deliberately NOT in the default matrix: with real
            // signals it magnifies unsnapped spurious lines (mains hum) into
            // an elevated near-carrier floor, where the two apps' readout
            // styles (our ±6-bin lobe integration vs the official peak-bin)
            // diverge by design — a leakage diagnostic, not a comparable
            // measurement. Ask for it explicitly via --windows.
            windows: vec!["FlatTop".into(), "Hann".into()],
            thd_avg: 4,
            out_dir: "target/bench-ab".into(),
            demo: false,
            skip_vm: false,
            skip_host: false,
            keep_vm: false,
            no_prompt: false,
            vm_timeout_s: 240,
            probe_files: Vec::new(),
            probe_freq: 1000.0,
        }
    }
}

fn parse_cli() -> R<Cli> {
    let mut cli = Cli::default();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        let mut val = |name: &str| -> R<String> {
            args.next().ok_or_else(|| format!("{name} needs a value"))
        };
        match a.as_str() {
            "--rounds" => {
                cli.rounds = val("--rounds")?
                    .parse()
                    .map_err(|e| format!("--rounds: {e}"))?
            }
            "--vm-name" => cli.vm_name = val("--vm-name")?,
            "--usb-name" => cli.usb_name = val("--usb-name")?,
            "--qa40x-exe" => cli.qa40x_exe = val("--qa40x-exe")?,
            "--vm-url" => cli.vm_url = Some(val("--vm-url")?),
            "--amp" => {
                cli.amp_dbv = val("--amp")?
                    .parse()
                    .map_err(|e| format!("--amp: {e}"))?
            }
            "--sample-rate" => {
                cli.sample_rate = val("--sample-rate")?
                    .parse()
                    .map_err(|e| format!("--sample-rate: {e}"))?
            }
            "--buffer-size" => {
                cli.buffer_size = val("--buffer-size")?
                    .parse()
                    .map_err(|e| format!("--buffer-size: {e}"))?
            }
            "--windows" => {
                cli.windows = val("--windows")?
                    .split(',')
                    .map(|w| {
                        canon_window(w.trim())
                            .map(str::to_string)
                            .ok_or_else(|| format!("--windows: unknown window {w:?}"))
                    })
                    .collect::<R<Vec<_>>>()?;
                if cli.windows.is_empty() {
                    return Err("--windows needs at least one window".into());
                }
            }
            "--thd-avg" => {
                cli.thd_avg = val("--thd-avg")?
                    .parse::<u32>()
                    .map_err(|e| format!("--thd-avg: {e}"))?
                    .max(1)
            }
            "--out" => cli.out_dir = val("--out")?,
            "--vm-timeout" => {
                cli.vm_timeout_s = val("--vm-timeout")?
                    .parse()
                    .map_err(|e| format!("--vm-timeout: {e}"))?
            }
            "--probe" => cli.probe_files.push(val("--probe")?),
            "--probe-freq" => {
                cli.probe_freq = val("--probe-freq")?
                    .parse()
                    .map_err(|e| format!("--probe-freq: {e}"))?
            }
            "--demo" => cli.demo = true,
            "--skip-vm" => cli.skip_vm = true,
            "--skip-host" => cli.skip_host = true,
            "--keep-vm" => cli.keep_vm = true,
            "--no-prompt" => cli.no_prompt = true,
            "--help" | "-h" => {
                print_help();
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument: {other} (try --help)")),
        }
    }
    if cli.skip_host && cli.skip_vm {
        return Err("--skip-host and --skip-vm together leave nothing to do".into());
    }
    Ok(cli)
}

fn print_help() {
    println!(
        "bench_ab — A/B loopback bench: qa40x-rs (host) vs official QA40x (Parallels VM)

USAGE: cargo run --example bench_ab -- [OPTIONS]

  --rounds N         host+VM alternations to run (default 1)
  --vm-name NAME     Parallels VM name (default \"Windows 11\")
  --usb-name NAME    Parallels USB device name (default \"QA402 Audio Analyzer\")
  --qa40x-exe PATH   QA40x.exe path in the guest (default C:\\Program Files (x86)\\QuantAsylum\\QA40x\\QA40x.exe)
  --vm-url URL       override the VM REST base URL (default http://<vm-ip>:9402)
  --amp DBV          generator amplitude for both targets, in dBV (default -10)
  --sample-rate HZ   sample rate for both targets (default 48000)
  --buffer-size N    acquisition buffer for both targets (default 32768)
  --windows LIST     comma-separated analysis windows forced on BOTH targets via
                     /Settings/Windowing, one battery per window
                     (Rectangle|Bartlett|Hamming|Hann|FlatTop; default FlatTop,Hann —
                     Rectangle magnifies unsnapped spurs into readout-style divergence,
                     diagnostic only)
  --thd-avg N        acquisitions averaged for the THD @100 Hz row (default 4)
  --probe FILE       offline: infer window/coherence + run the THD-method probe
                     on a saved spectrum snapshot, then exit (repeatable)
  --probe-freq HZ    asked tone frequency for --probe files (default 1000)
  --out DIR          report directory (default target/bench-ab)
  --vm-timeout S     seconds to wait for the VM REST server (default 240)
  --demo             host phase uses the embedded virtual QA403 (harness self-test only)
  --skip-vm          host phase only
  --skip-host        VM phase only
  --keep-vm          leave the VM running (and the QA402 assigned to it) when done
  --no-prompt        never wait for operator input; fail instead"
    );
}

// ---------------------------------------------------------------------------
// REST client (speaks the official QA40x verb set; qa40x-rs is verb-agnostic)
// ---------------------------------------------------------------------------

struct RestClient {
    base: String,
    http: reqwest::Client,
    /// Host header override. The official app's HTTP.sys registration only
    /// accepts `localhost:9402` and only from loopback, so the bench reaches
    /// it through an in-guest netsh portproxy (host:9403 → loopback:9402)
    /// while still presenting the localhost Host header.
    host_header: Option<String>,
}

impl RestClient {
    fn new(base: &str) -> Self {
        Self::with_host_header(base, None)
    }

    fn with_host_header(base: &str, host_header: Option<String>) -> Self {
        Self {
            base: base.trim_end_matches('/').to_string(),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(60))
                .build()
                .expect("reqwest client"),
            host_header,
        }
    }

    async fn call(&self, method: reqwest::Method, path: &str) -> R<Value> {
        let url = format!("{}{}", self.base, path);
        let mut req = self.http.request(method.clone(), &url);
        if let Some(h) = &self.host_header {
            req = req.header("Host", h);
        }
        if method != reqwest::Method::GET {
            // HTTP.sys (official app) rejects body-less PUT/POST with 411:
            // an explicit Content-Length: 0 is required (reqwest sends none
            // for an empty body).
            req = req.header(reqwest::header::CONTENT_LENGTH, "0").body("");
        }
        let resp = req
            .send()
            .await
            .map_err(|e| format!("{method} {url}: {e}"))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("{method} {url}: {e}"))?;
        if !status.is_success() {
            return Err(format!("{method} {url}: HTTP {status} — {text}"));
        }
        serde_json::from_str(&text).map_err(|e| format!("{method} {url}: bad JSON ({e}): {text}"))
    }

    async fn get(&self, path: &str) -> R<Value> {
        self.call(reqwest::Method::GET, path).await
    }

    async fn put(&self, path: &str) -> R<Value> {
        self.call(reqwest::Method::PUT, path).await
    }

    async fn post(&self, path: &str) -> R<Value> {
        self.call(reqwest::Method::POST, path).await
    }

    /// One generate-and-capture. The official app is asynchronous
    /// (POST /Acquisition then poll /AcquisitionBusy); qa40x-rs completes the
    /// acquisition synchronously and reports Busy=False, so the same polling
    /// loop works for both.
    async fn acquire(&self) -> R<()> {
        self.post("/Acquisition").await?;
        for _ in 0..600 {
            let v = self.get("/AcquisitionBusy").await?;
            if !truthy(&v, "Value")? {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        Err(format!("{}: acquisition still busy after 60 s", self.base))
    }

    /// Left/Right pair from a tone-measurement endpoint.
    async fn lr(&self, path: &str) -> R<(f64, f64)> {
        let v = self.get(path).await?;
        Ok((field_f64(&v, "Left")?, field_f64(&v, "Right")?))
    }
}

/// Numeric field that may arrive as a JSON number (qa40x-rs) or as a string
/// (the official app serializes most values as strings — and with a comma
/// decimal separator when the guest runs a French locale).
fn field_f64(v: &Value, key: &str) -> R<f64> {
    let f = &v[key];
    if let Some(n) = f.as_f64() {
        return Ok(n);
    }
    if let Some(s) = f.as_str() {
        return s
            .trim()
            .replace(',', ".")
            .parse()
            .map_err(|e| format!("field {key}={s:?}: {e}"));
    }
    Err(format!("field {key} missing in {v}"))
}

/// Boolean field that may arrive as a bool, or as "True"/"False" strings.
fn truthy(v: &Value, key: &str) -> R<bool> {
    let f = &v[key];
    if let Some(b) = f.as_bool() {
        return Ok(b);
    }
    if let Some(s) = f.as_str() {
        return Ok(s.eq_ignore_ascii_case("true"));
    }
    Err(format!("field {key} missing in {v}"))
}

// ---------------------------------------------------------------------------
// Measurement battery
// ---------------------------------------------------------------------------

/// Stepped-tone frequency-response points, log-spaced 20 Hz → 20 kHz.
const FR_FREQS: [f64; 12] = [
    20.0, 30.0, 50.0, 100.0, 200.0, 500.0, 1000.0, 2000.0, 5000.0, 10000.0, 15000.0, 20000.0,
];

/// Amplitude offsets (dB, relative to the target's base amplitude) for the
/// linearity staircase. Consecutive steps must track by exactly 10 dB.
const LIN_OFFSETS: [f64; 4] = [-30.0, -20.0, -10.0, 0.0];

#[derive(Debug, Clone, Serialize)]
struct FrPoint {
    freq: f64,
    left_dbv: f64,
    right_dbv: f64,
    /// Deviation from this trace's own 1 kHz level (dB) — the audiophile view.
    left_dev_db: f64,
    right_dev_db: f64,
}

#[derive(Debug, Clone, Serialize)]
struct LinPoint {
    amp: f64,
    left_dbv: f64,
    right_dbv: f64,
}

#[derive(Debug, Clone, Serialize)]
struct BatteryResult {
    target: String,
    base_url: String,
    version: String,
    /// Generator amplitude in dBV (the unit both targets take since #20).
    amp_dbv: f64,
    /// Analysis window this battery asked for on /Settings/Windowing
    /// (official designator), and whether the target accepted the PUT — an
    /// older official app without the endpoint stays on its own default.
    window: String,
    windowing_applied: bool,
    noise_floor_dbv: (f64, f64),
    level_1k_dbv: (f64, f64),
    thd_1k_db: (f64, f64),
    thd_1k_pct: (f64, f64),
    thdn_1k_db: (f64, f64),
    snr_1k_db: (f64, f64),
    /// Linear-power mean of `thd_100_runs` (the official value moves
    /// run-to-run — near-noise-floor harmonics).
    thd_100_db: (f64, f64),
    /// Every individual THD @100 Hz acquisition (dB), to make the jitter
    /// visible instead of surprising.
    thd_100_runs: Vec<(f64, f64)>,
    thd_6k_db: (f64, f64),
    fr: Vec<FrPoint>,
    linearity: Vec<LinPoint>,
    elapsed_s: f64,
}

impl BatteryResult {
    fn balance_1k_db(&self) -> f64 {
        self.level_1k_dbv.0 - self.level_1k_dbv.1
    }

    /// Worst absolute FR deviation from the 1 kHz reference, per channel.
    fn fr_worst_dev_db(&self) -> (f64, f64) {
        let l = self
            .fr
            .iter()
            .map(|p| p.left_dev_db.abs())
            .fold(0.0, f64::max);
        let r = self
            .fr
            .iter()
            .map(|p| p.right_dev_db.abs())
            .fold(0.0, f64::max);
        (l, r)
    }

    /// Worst deviation of a linearity step from the ideal 10 dB (left channel).
    fn lin_worst_step_err_db(&self) -> f64 {
        self.linearity
            .windows(2)
            .map(|w| ((w[1].left_dbv - w[0].left_dbv) - 10.0).abs())
            .fold(0.0, f64::max)
    }
}

/// Canonical official designator for a window name, as `/Settings/Windowing`
/// spells them (vendor client Qa402.cs), or None if unknown.
fn canon_window(name: &str) -> Option<&'static str> {
    match name.to_ascii_lowercase().as_str() {
        "rectangle" | "rectangular" | "rect" => Some("Rectangle"),
        "bartlett" => Some("Bartlett"),
        "hamming" => Some("Hamming"),
        "hann" => Some("Hann"),
        "flattop" | "flat-top" => Some("FlatTop"),
        _ => None,
    }
}

fn gen_path(on: bool, freq: f64, amp: f64) -> String {
    // Gen1/Gen2 designators are honored identically on both targets; the
    // amplitude is dBV on both (issue #20).
    let state = if on { "On" } else { "Off" };
    format!("/Settings/AudioGen/Gen1/{state}/{freq}/{amp}")
}

async fn run_battery(
    client: &RestClient,
    target: &str,
    amp_dbv: f64,
    window: &str,
    cli: &Cli,
    spectrum_prefix: &str,
) -> R<BatteryResult> {
    let t0 = std::time::Instant::now();
    println!("[{target}] battery start ({}, window {window})", client.base);

    let version = client
        .get("/Status/Version")
        .await
        .ok()
        .and_then(|v| field_str(&v, "Value"))
        .unwrap_or_else(|| "?".into());

    // Common setup: defaults, rate, buffer, ±6 dBV input range on both sides.
    client.put("/Settings/Default").await?;
    client
        .put(&format!("/Settings/SampleRate/{}", cli.sample_rate))
        .await?;
    client
        .put(&format!("/Settings/BufferSize/{}", cli.buffer_size))
        .await?;
    client.put("/Settings/Input/Max/6").await?;
    // Force the analysis window on this target too — the official app cannot
    // be asked what it measures through (no settings readback), so equal
    // situations are made, not assumed. Non-fatal: an official build without
    // the endpoint keeps its own default, and the report says so.
    let windowing_applied = match client.put(&format!("/Settings/Windowing/{window}")).await {
        Ok(_) => true,
        Err(e) => {
            println!("[{target}] /Settings/Windowing/{window} not accepted ({e}) — target keeps its default window");
            false
        }
    };

    // 1) Noise floor, generator off.
    client.put(&gen_path(false, 1000.0, amp_dbv)).await?;
    client.acquire().await?;
    let noise_floor_dbv = client.lr("/RmsDbv/20/20000").await?;
    println!(
        "[{target}] noise floor  L {:7.2} dBV  R {:7.2} dBV",
        noise_floor_dbv.0, noise_floor_dbv.1
    );

    // 2+3) 1 kHz tone: absolute level, balance, THD, THD+N, SNR — one capture.
    client.put(&gen_path(true, 1000.0, amp_dbv)).await?;
    client.acquire().await?;
    let level_1k_dbv = client.lr("/RmsDbv/20/20000").await?;
    let thd_1k_db = client.lr("/ThdDb/1000/20000").await?;
    let thd_1k_pct = client.lr("/ThdPct/1000/20000").await?;
    let thdn_1k_db = client.lr("/ThdnDb/1000/20/20000").await?;
    let snr_1k_db = client.lr("/SnrDb/1000/20/20000").await?;
    println!(
        "[{target}] 1 kHz  level L {:.2} dBV  THD {:.1} dB  THD+N {:.1} dB  SNR {:.1} dB",
        level_1k_dbv.0, thd_1k_db.0, thdn_1k_db.0, snr_1k_db.0
    );

    // Spectrum snapshot of the 1 kHz capture, saved verbatim for offline diff.
    save_spectrum(client, target, &format!("{spectrum_prefix}-spectrum.json")).await;

    // 4) THD at the band edges: 100 Hz and 6 kHz (harmonics up to 20 kHz).
    //    The 100 Hz row is averaged over --thd-avg acquisitions in linear
    //    power: its official reading moves run-to-run (harmonics at the noise
    //    floor), and the per-acquisition values quantify that jitter. The
    //    first capture's spectrum is saved for the offline THD-method probe.
    client.put(&gen_path(true, 100.0, amp_dbv)).await?;
    let mut thd_100_runs = Vec::new();
    for i in 0..cli.thd_avg {
        client.acquire().await?;
        if i == 0 {
            save_spectrum(client, target, &format!("{spectrum_prefix}-spectrum-100.json")).await;
        }
        thd_100_runs.push(client.lr("/ThdDb/100/20000").await?);
    }
    let thd_100_db = (
        mean_db_power(thd_100_runs.iter().map(|r| r.0)),
        mean_db_power(thd_100_runs.iter().map(|r| r.1)),
    );
    client.put(&gen_path(true, 6000.0, amp_dbv)).await?;
    client.acquire().await?;
    let thd_6k_db = client.lr("/ThdDb/6000/20000").await?;
    let spread = thd_spread_db(&thd_100_runs);
    println!(
        "[{target}] THD  100 Hz {:.1} dB (n={}, spread {:.1} dB)   6 kHz {:.1} dB",
        thd_100_db.0,
        thd_100_runs.len(),
        spread,
        thd_6k_db.0
    );

    // 5) Stepped-tone frequency response. RMS is integrated over a narrow
    //    relative band around each tone so the readout tracks the tone, not
    //    the wideband noise.
    let mut fr_raw = Vec::new();
    for f in FR_FREQS {
        client.put(&gen_path(true, f, amp_dbv)).await?;
        client.acquire().await?;
        // Integer band bounds: the official parser rejects fractional Hz.
        let lo = (f * 0.8).max(10.0).round() as i64;
        let hi = (f * 1.25).min(23000.0).round() as i64;
        let (l, r) = client.lr(&format!("/RmsDbv/{lo}/{hi}")).await?;
        fr_raw.push((f, l, r));
    }
    let (ref_l, ref_r) = fr_raw
        .iter()
        .find(|(f, _, _)| *f == 1000.0)
        .map(|(_, l, r)| (*l, *r))
        .ok_or("FR sweep missing the 1 kHz reference point")?;
    let fr: Vec<FrPoint> = fr_raw
        .into_iter()
        .map(|(freq, left_dbv, right_dbv)| FrPoint {
            freq,
            left_dbv,
            right_dbv,
            left_dev_db: left_dbv - ref_l,
            right_dev_db: right_dbv - ref_r,
        })
        .collect();
    let (wl, wr) = {
        let l = fr.iter().map(|p| p.left_dev_db.abs()).fold(0.0, f64::max);
        let r = fr.iter().map(|p| p.right_dev_db.abs()).fold(0.0, f64::max);
        (l, r)
    };
    println!("[{target}] FR 20 Hz–20 kHz  worst dev L {wl:.3} dB  R {wr:.3} dB");

    // 6) Amplitude linearity: 1 kHz staircase in 10 dB steps.
    let mut linearity = Vec::new();
    for off in LIN_OFFSETS {
        let amp = amp_dbv + off;
        client.put(&gen_path(true, 1000.0, amp)).await?;
        client.acquire().await?;
        let (l, r) = client.lr("/RmsDbv/900/1100").await?;
        linearity.push(LinPoint {
            amp,
            left_dbv: l,
            right_dbv: r,
        });
    }

    // Leave the generator off so nothing keeps playing between phases.
    client.put(&gen_path(false, 1000.0, amp_dbv)).await?;

    let res = BatteryResult {
        target: target.into(),
        base_url: client.base.clone(),
        version,
        amp_dbv,
        window: window.into(),
        windowing_applied,
        noise_floor_dbv,
        level_1k_dbv,
        thd_1k_db,
        thd_1k_pct,
        thdn_1k_db,
        snr_1k_db,
        thd_100_db,
        thd_100_runs,
        thd_6k_db,
        fr,
        linearity,
        elapsed_s: t0.elapsed().as_secs_f64(),
    };
    println!(
        "[{target}] battery done in {:.0} s (lin worst step err {:.3} dB)",
        res.elapsed_s,
        res.lin_worst_step_err_db()
    );
    Ok(res)
}

/// Fetch and save a `/Data/Frequency/Input` snapshot; non-fatal on failure.
async fn save_spectrum(client: &RestClient, target: &str, path: &str) {
    match client.get("/Data/Frequency/Input").await {
        Ok(spec) => {
            if let Err(e) = std::fs::write(path, spec.to_string()) {
                println!("[{target}] write {path}: {e}");
            }
        }
        Err(e) => println!("[{target}] spectrum snapshot unavailable: {e}"),
    }
}

/// Mean of dB values in the linear-POWER domain (THD dB is 10·log10 of a
/// power ratio), back in dB.
fn mean_db_power(vals: impl Iterator<Item = f64>) -> f64 {
    let (mut sum, mut n) = (0.0f64, 0usize);
    for v in vals {
        sum += 10f64.powf(v / 10.0);
        n += 1;
    }
    if n == 0 {
        return f64::NAN;
    }
    10.0 * (sum / n as f64).log10()
}

/// Max−min of the left-channel THD acquisitions (dB).
fn thd_spread_db(runs: &[(f64, f64)]) -> f64 {
    let min = runs.iter().map(|r| r.0).fold(f64::INFINITY, f64::min);
    let max = runs.iter().map(|r| r.0).fold(f64::NEG_INFINITY, f64::max);
    if runs.is_empty() { 0.0 } else { max - min }
}

fn field_str(v: &Value, key: &str) -> Option<String> {
    v[key]
        .as_str()
        .map(|s| s.to_string())
        .or_else(|| v[key].is_number().then(|| v[key].to_string()))
}

// ---------------------------------------------------------------------------
// Parallels orchestration
// ---------------------------------------------------------------------------

fn sh(program: &str, args: &[&str]) -> R<String> {
    let out = Command::new(program)
        .args(args)
        .output()
        .map_err(|e| format!("{program} {args:?}: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "{program} {args:?} failed ({}): {stderr}{stdout}",
            out.status
        ));
    }
    Ok(stdout)
}

/// `prlctl list` row for the VM, from the JSON listing.
fn vm_info(vm_name: &str) -> R<Value> {
    let raw = sh("prlctl", &["list", "-a", "-f", "-j"])?;
    let list: Value = serde_json::from_str(&raw).map_err(|e| format!("prlctl list JSON: {e}"))?;
    list.as_array()
        .and_then(|a| a.iter().find(|v| v["name"] == vm_name).cloned())
        .ok_or_else(|| format!("VM {vm_name:?} not found in `prlctl list -a`"))
}

fn vm_status(vm_name: &str) -> R<String> {
    Ok(vm_info(vm_name)?["status"]
        .as_str()
        .unwrap_or("?")
        .to_string())
}

/// Assign the QA402 to the VM (auto-connects on VM start) / release it.
fn usb_assign(usb_name: &str, vm_uuid: &str) -> R<()> {
    sh("prlsrvctl", &["usb", "set", usb_name, vm_uuid]).map(|_| ())
}

fn usb_release(usb_name: &str) -> R<()> {
    sh("prlsrvctl", &["usb", "del", usb_name]).map(|_| ())
}

fn vm_start(vm_name: &str) -> R<()> {
    // Parallels pauses idle VMs by default, which would freeze the guest (and
    // its REST server) between bench phases — turn that off for this VM.
    let _ = sh("prlctl", &["set", vm_name, "--pause-idle", "off"]);
    match vm_status(vm_name)?.as_str() {
        "running" => Ok(()),
        "paused" => sh("prlctl", &["resume", vm_name]).map(|_| ()),
        _ => sh("prlctl", &["start", vm_name]).map(|_| ()),
    }
}

fn vm_stop(vm_name: &str) -> R<()> {
    if vm_status(vm_name)? != "running" {
        return Ok(());
    }
    // Graceful ACPI shutdown; hard-kill only if the guest ignores it.
    let _ = sh("prlctl", &["stop", vm_name]);
    for _ in 0..60 {
        if vm_status(vm_name)? == "stopped" {
            return Ok(());
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    println!("[vm] graceful shutdown timed out — killing");
    sh("prlctl", &["stop", vm_name, "--kill"]).map(|_| ())
}

/// Wait for a routable IPv4 on the guest. Parallels often reports the
/// link-local IPv6 first — and sometimes an APIPA 169.254.x.x IPv4 before the
/// DHCP lease lands (seen live: the bench locked onto the dead link-local
/// address and polled it until timeout while the real 10.211.55.x came up
/// seconds later). Neither can reach the REST relay: keep waiting for a
/// routable address.
fn vm_wait_ip(vm_name: &str, timeout: Duration) -> R<String> {
    let t0 = std::time::Instant::now();
    while t0.elapsed() < timeout {
        let ip = vm_info(vm_name)?["ip_configured"]
            .as_str()
            .unwrap_or("-")
            .to_string();
        if ip.contains('.') && !ip.contains(':') && !ip.starts_with("169.254.") {
            return Ok(ip);
        }
        std::thread::sleep(Duration::from_secs(3));
    }
    Err(format!("VM {vm_name:?} got no routable IPv4 within {timeout:?}"))
}

/// Run a PowerShell script in the guest through `prlctl exec`, base64-encoded
/// so nothing gets mangled by the host shell / cmd quoting rules.
fn guest_ps(vm_name: &str, script: &str) -> R<String> {
    use base64::Engine as _;
    let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let enc = base64::engine::general_purpose::STANDARD.encode(utf16);
    sh(
        "prlctl",
        &[
            "exec",
            vm_name,
            "powershell",
            "-NoProfile",
            "-EncodedCommand",
            &enc,
        ],
    )
}

/// The user logged into the guest console (needed to launch a GUI app in the
/// interactive session — `prlctl exec` itself runs as SYSTEM).
fn guest_console_user(vm_name: &str) -> R<String> {
    let out = guest_ps(vm_name, "(Get-CimInstance Win32_ComputerSystem).UserName")?;
    out.lines()
        .filter_map(|l| l.trim().rsplit('\\').next())
        .find(|s| !s.is_empty() && !s.starts_with('#') && !s.starts_with('<'))
        .map(str::to_string)
        .ok_or_else(|| format!("no interactive user logged into {vm_name:?}"))
}

/// Launch QA40x.exe in the interactive guest session. `cmd /c start` from the
/// SYSTEM context silently fails for GUI apps, so this registers and fires a
/// scheduled task bound to the console user's interactive token (no password
/// needed with LogonType Interactive).
fn guest_launch(vm_name: &str, exe: &str) -> R<()> {
    let probe = guest_ps(vm_name, &format!("Test-Path '{exe}'"))?;
    if !probe.contains("True") {
        return Err(format!("{exe} not found in the guest (pass --qa40x-exe)"));
    }
    let user = guest_console_user(vm_name)?;
    let script = format!(
        "Register-ScheduledTask -TaskName qa40x-bench \
           -Action (New-ScheduledTaskAction -Execute '{exe}') \
           -Principal (New-ScheduledTaskPrincipal -UserId '{user}' -LogonType Interactive) \
           -Force | Out-Null; \
         Start-ScheduledTask -TaskName qa40x-bench"
    );
    guest_ps(vm_name, &script).map(|_| ())
}

fn guest_kill(vm_name: &str, exe: &str) {
    let basename = exe.rsplit('\\').next().unwrap_or(exe);
    let _ = sh(
        "prlctl",
        &["exec", vm_name, "taskkill", "/IM", basename, "/F"],
    );
}

/// Expose the official app's localhost-only REST server to the host.
///
/// The app registers `http://localhost:9402/` with HTTP.sys, which rejects any
/// other Host header (400) and refuses non-loopback sources for localhost
/// (403). A netsh portproxy on 9403 relays host traffic to loopback:9402; the
/// client keeps sending `Host: localhost:9402`. Idempotent.
fn guest_setup_rest_relay(vm_name: &str) -> R<()> {
    let script = "netsh interface portproxy delete v4tov4 listenport=9403 listenaddress=0.0.0.0 | Out-Null; \
                  netsh interface portproxy add v4tov4 listenport=9403 listenaddress=0.0.0.0 connectport=9402 connectaddress=127.0.0.1; \
                  netsh advfirewall firewall delete rule name=qa40x-rest-9403 | Out-Null; \
                  netsh advfirewall firewall add rule name=qa40x-rest-9403 dir=in action=allow protocol=TCP localport=9403"
        .to_string();
    guest_ps(vm_name, &script).map(|_| ())
}

/// Parallels-level USB replug: suspend + resume the VM. On resume Parallels
/// reattaches passthrough USB devices from scratch, which reliably triggers
/// the official app's hot-plug detection (the app keeps running throughout).
/// This is the scripted equivalent of detaching/reattaching the analyzer in
/// the Parallels Devices ▸ USB menu.
fn vm_replug_usb(vm_name: &str) -> R<()> {
    sh("prlctl", &["suspend", vm_name])?;
    std::thread::sleep(Duration::from_secs(2));
    sh("prlctl", &["resume", vm_name]).map(|_| ())
}

/// Force Windows to re-enumerate the QA402. After the host releases the
/// analyzer mid-session, the guest sees it but the official app cannot claim
/// it until it goes through a fresh PnP cycle — the scripted equivalent of
/// unplugging and replugging the cable (or toggling File ▸ Device in the app).
fn guest_reenumerate_qa402(vm_name: &str) -> R<()> {
    let script = r#"$d = Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -like "*VID_16C0*" };
        if ($d) {
            Disable-PnpDevice -InstanceId $d.InstanceId -Confirm:$false;
            Start-Sleep 3;
            Enable-PnpDevice -InstanceId $d.InstanceId -Confirm:$false;
            Start-Sleep 5;
        } else { Write-Output "no VID_16C0 device present" }"#;
    guest_ps(vm_name, script).map(|_| ())
}

fn prompt(msg: &str, no_prompt: bool) -> R<()> {
    if no_prompt {
        return Err(format!(
            "operator step required but --no-prompt is set: {msg}"
        ));
    }
    println!("\n>>> {msg}\n>>> press Enter to continue…");
    let mut line = String::new();
    std::io::stdin()
        .read_line(&mut line)
        .map_err(|e| format!("stdin: {e}"))?;
    Ok(())
}

/// Wait for a QA40x-compatible REST server, launching the official app once
/// the VM answers pings but the port is still closed.
async fn vm_wait_rest(client: &RestClient, cli: &Cli) -> R<()> {
    let t0 = std::time::Instant::now();
    let mut launched = false;
    let timeout = Duration::from_secs(cli.vm_timeout_s);
    while t0.elapsed() < timeout {
        if client.get("/Status/Version").await.is_ok() {
            return Ok(());
        }
        if !launched {
            println!("[vm] REST not up yet — launching {}", cli.qa40x_exe);
            match guest_launch(&cli.vm_name, &cli.qa40x_exe) {
                Ok(()) => launched = true,
                Err(e) => println!("[vm] guest launch failed ({e}) — will retry"),
            }
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
    Err(format!(
        "no REST server at {} after {} s.\n\
         Hints: is the official QA40x app installed at {:?}? Is a user logged\n\
         into the guest console (needed to launch a GUI app)? Pass --vm-url if\n\
         the address differs.",
        client.base, cli.vm_timeout_s, cli.qa40x_exe
    ))
}

/// Wait until the official app reports the QA402 as connected. If it stays
/// disconnected, force a guest-side USB re-enumeration and restart the app —
/// after the host releases the device, the app cannot claim it again until
/// the analyzer goes through a fresh PnP cycle.
async fn vm_wait_device(client: &RestClient, cli: &Cli) -> R<bool> {
    let mut replugged = false;
    let mut reenumerated = false;
    let mut consecutive = 0u32;
    for i in 0..50 {
        if let Ok(v) = client.get("/Status/Connection").await {
            if truthy(&v, "Value").unwrap_or(false) {
                // Right after boot the app can report a transient True and
                // then drop the device; require it to hold for a few polls.
                consecutive += 1;
                if consecutive >= 3 {
                    return Ok(true);
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
        }
        consecutive = 0;
        if i >= 5 && !replugged {
            replugged = true;
            println!("[vm] app does not see the QA402 — Parallels-level USB replug (suspend/resume)");
            if let Err(e) = vm_replug_usb(&cli.vm_name) {
                println!("[vm] suspend/resume failed: {e}");
            }
        } else if i >= 20 && !reenumerated {
            reenumerated = true;
            println!("[vm] still not connected — guest PnP re-enumeration and app restart");
            if let Err(e) = guest_reenumerate_qa402(&cli.vm_name) {
                println!("[vm] re-enumeration failed: {e}");
            }
            guest_kill(&cli.vm_name, &cli.qa40x_exe);
            tokio::time::sleep(Duration::from_secs(3)).await;
            if let Err(e) = guest_launch(&cli.vm_name, &cli.qa40x_exe) {
                println!("[vm] app relaunch failed: {e}");
            }
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
    Ok(false)
}

// ---------------------------------------------------------------------------
// Official-parametrization inference & THD-method probe (issue #14)
//
// The official REST API has no settings readback, so the bench cannot ASK the
// app what generator frequency or analysis window it used — but the saved
// /Data/Frequency/Input snapshots show both: the peak bin is the actually-
// played frequency, and the near-bin ratios of a coherent tone are the
// window's own DFT coefficients. Recomputing THD from the same snapshot with
// each candidate method then identifies how the official /ThdDb integrates.
// ---------------------------------------------------------------------------

/// A decoded `/Data/Frequency/Input` snapshot: bin width + linear magnitudes.
struct SpectrumData {
    dx: f64,
    left: Vec<f64>,
    right: Vec<f64>,
}

fn decode_spectrum_file(path: &str) -> R<SpectrumData> {
    use base64::Engine as _;
    let raw = std::fs::read_to_string(path).map_err(|e| format!("read {path}: {e}"))?;
    let v: Value = serde_json::from_str(&raw).map_err(|e| format!("{path}: bad JSON: {e}"))?;
    let dx = field_f64(&v, "Dx")?;
    if !(dx > 0.0) {
        return Err(format!("{path}: bad Dx {dx}"));
    }
    let dec = |key: &str| -> R<Vec<f64>> {
        let s = v[key]
            .as_str()
            .ok_or_else(|| format!("{path}: field {key} missing"))?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(s)
            .map_err(|e| format!("{path}: {key}: {e}"))?;
        Ok(bytes
            .chunks_exact(8)
            .map(|c| f64::from_le_bytes(c.try_into().unwrap()))
            .collect())
    };
    Ok(SpectrumData { dx, left: dec("Left")?, right: dec("Right")? })
}

/// Ratios below this are indistinguishable from the noise floor for signature
/// matching (a −10 dBV tone sits ~90 dB above the loopback floor; the deepest
/// ratio we trust is well inside that).
const SIG_FLOOR_DB: f64 = -60.0;

/// `|X[k0±m]|/|X[k0]|` (dB, m = 1..4) of a COHERENT tone under each window the
/// official app offers — the cosine-sum coefficients `a_m/(2·a0)`, and
/// `sinc²(m/2)` for the triangular Bartlett. Zero entries clamp to the floor.
const WINDOW_SIGNATURES: [(&str, [f64; 4]); 5] = [
    ("Rectangle", [SIG_FLOOR_DB, SIG_FLOOR_DB, SIG_FLOOR_DB, SIG_FLOOR_DB]),
    ("Bartlett", [-7.84, SIG_FLOOR_DB, -13.47, SIG_FLOOR_DB]),
    ("Hamming", [-7.41, SIG_FLOOR_DB, SIG_FLOOR_DB, SIG_FLOOR_DB]),
    ("Hann", [-6.02, SIG_FLOOR_DB, SIG_FLOOR_DB, SIG_FLOOR_DB]),
    ("FlatTop", [-0.30, -3.83, -14.25, -35.86]),
];

#[derive(Debug, Clone, Serialize)]
struct WindowInference {
    /// Peak-bin frequency near the asked tone — the actually-played frequency.
    f0_hz: f64,
    peak_bin: usize,
    /// Bin-snapped frequency the asked tone lands on if the generator rounds
    /// to the FFT grid ("Round to eliminate leakage" in the official app).
    snapped_hz: f64,
    /// |X[k−1]| vs |X[k+1]| imbalance (dB): ≈0 for a coherent tone.
    asymmetry_db: f64,
    coherent: bool,
    /// Measured |X[k±m]|/|X[k]| (dB, two-side power mean), m = 1..4.
    side_ratios_db: [f64; 4],
    /// Best-matching window signature and its RMS error (dB).
    window: String,
    fit_err_db: f64,
}

fn infer_window(mags: &[f64], dx: f64, asked_hz: f64) -> Option<WindowInference> {
    let n = mags.len();
    let lo = (((asked_hz * 0.75) / dx).floor() as usize).max(5);
    let hi = ((((asked_hz * 1.25) / dx).ceil() as usize).min(n.saturating_sub(5))).max(lo);
    let k = (lo..=hi).max_by(|&a, &b| mags[a].partial_cmp(&mags[b]).unwrap())?;
    let peak = mags[k];
    if !(peak > 0.0) {
        return None;
    }
    let db = |x: f64| {
        if x > 0.0 {
            (20.0 * x.log10()).max(-200.0)
        } else {
            -200.0
        }
    };
    let asymmetry_db = (db(mags[k - 1]) - db(mags[k + 1])).abs();
    let mut side_ratios_db = [0.0f64; 4];
    for m in 1..=4usize {
        let p = (mags[k - m].powi(2) + mags[k + m].powi(2)) / 2.0;
        side_ratios_db[m - 1] = (10.0 * (p / peak.powi(2)).log10()).max(SIG_FLOOR_DB);
    }
    let (window, fit_err_db) = WINDOW_SIGNATURES
        .iter()
        .map(|(name, sig)| {
            let err = (0..4)
                .map(|i| (side_ratios_db[i] - sig[i]).powi(2))
                .sum::<f64>()
                .sqrt()
                / 2.0;
            (name.to_string(), err)
        })
        .min_by(|a, b| a.1.partial_cmp(&b.1).unwrap())?;
    Some(WindowInference {
        f0_hz: k as f64 * dx,
        peak_bin: k,
        snapped_hz: (asked_hz / dx).round() * dx,
        asymmetry_db,
        // A coherent tone has a symmetric lobe; under Rectangle its side bins
        // are noise, so a deeply-buried first side bin also counts.
        coherent: asymmetry_db < 1.0 || side_ratios_db[0] <= -40.0,
        side_ratios_db,
        window,
        fit_err_db,
    })
}

#[derive(Debug, Clone, Serialize)]
struct ThdProbe {
    method: String,
    left_db: f64,
    right_db: f64,
}

/// Recompute THD from a saved spectrum with each candidate method — lobe
/// integration vs peak-bin readout × 10-harmonics vs harmonics-to-20 kHz.
/// The method whose value matches the target's reported /ThdDb identifies its
/// implementation (qa40x-rs today: lobe±6 × 10 harmonics).
fn thd_probe(spec: &SpectrumData, asked_hz: f64) -> Vec<ThdProbe> {
    let mut out = Vec::new();
    for (integrate, int_name) in [(true, "lobe±6"), (false, "peak-bin")] {
        for (to20k, harm_name) in [(false, "10 harmonics"), (true, "harmonics→20 kHz")] {
            out.push(ThdProbe {
                method: format!("{int_name} × {harm_name}"),
                left_db: thd_one(&spec.left, spec.dx, asked_hz, integrate, to20k),
                right_db: thd_one(&spec.right, spec.dx, asked_hz, integrate, to20k),
            });
        }
    }
    out
}

fn thd_one(mags: &[f64], dx: f64, asked_hz: f64, integrate: bool, to20k: bool) -> f64 {
    const LOBE: usize = 6;
    let n = mags.len();
    if n < 2 * LOBE + 2 {
        return f64::NAN;
    }
    // Refine to the strongest bin within ±LOBE of a target, like the REST path.
    let refine = |center_hz: f64| -> usize {
        let c = ((center_hz / dx).round() as usize).clamp(1, n - 1);
        let lo = c.saturating_sub(LOBE).max(1);
        let hi = (c + LOBE).min(n - 1);
        (lo..=hi)
            .max_by(|&a, &b| mags[a].partial_cmp(&mags[b]).unwrap())
            .unwrap()
    };
    let power_at = |center_hz: f64| -> f64 {
        let k = refine(center_hz);
        if integrate {
            let plo = k.saturating_sub(LOBE).max(1);
            let phi = (k + LOBE).min(n - 1);
            mags[plo..=phi].iter().map(|&m| m * m).sum()
        } else {
            mags[k] * mags[k]
        }
    };
    let f0 = refine(asked_hz) as f64 * dx;
    let fund = power_at(f0);
    if !(fund > 0.0) {
        return f64::NAN;
    }
    let nyquist = (n as f64 - 1.0) * dx;
    let max_h = if to20k { (20000.0 / f0).floor() as usize } else { 10 };
    let mut harm = 0.0f64;
    for h in 2..=max_h {
        let fh = f0 * h as f64;
        if fh >= nyquist || fh > 20000.0 {
            break;
        }
        harm += power_at(fh);
    }
    10.0 * (harm / fund).log10()
}

/// Per-target diagnostic of one window pass, from its saved spectra.
#[derive(Debug, Serialize)]
struct PassDiag {
    round: u32,
    target: String,
    /// Window the battery asked this target to use.
    window_set: String,
    inference_1k: Option<WindowInference>,
    inference_100: Option<WindowInference>,
    probe_100: Vec<ThdProbe>,
    reported_thd_100_db: (f64, f64),
}

fn diagnose_pass(round: u32, prefix: &str, res: &BatteryResult) -> PassDiag {
    let load = |suffix: &str, asked_hz: f64| -> (Option<WindowInference>, Option<SpectrumData>) {
        match decode_spectrum_file(&format!("{prefix}{suffix}")) {
            Ok(s) => (infer_window(&s.left, s.dx, asked_hz), Some(s)),
            Err(e) => {
                println!("[diag] {e}");
                (None, None)
            }
        }
    };
    let (inference_1k, _) = load("-spectrum.json", 1000.0);
    let (inference_100, spec_100) = load("-spectrum-100.json", 100.0);
    PassDiag {
        round,
        target: res.target.clone(),
        window_set: res.window.clone(),
        inference_1k,
        inference_100,
        probe_100: spec_100.map(|s| thd_probe(&s, 100.0)).unwrap_or_default(),
        reported_thd_100_db: res.thd_100_db,
    }
}

// ---------------------------------------------------------------------------
// Comparison & report
// ---------------------------------------------------------------------------

/// One window's A/B pair within a round (host and VM measured through the
/// same forced analysis window).
#[derive(Debug, Serialize)]
struct WindowPass {
    window: String,
    host: Option<BatteryResult>,
    vm: Option<BatteryResult>,
}

#[derive(Debug, Serialize)]
struct CompareRow {
    metric: String,
    host: f64,
    vm: f64,
    delta: f64,
    tolerance: f64,
    pass: bool,
}

fn row(metric: &str, host: f64, vm: f64, tolerance: f64) -> CompareRow {
    let delta = host - vm;
    CompareRow {
        metric: metric.into(),
        host,
        vm,
        delta,
        tolerance,
        pass: delta.abs() <= tolerance,
    }
}

/// A/B tolerances, chosen for a passive loopback: absolute-level agreement is
/// dominated by each side's calibration (±0.5 dB is already suspicious on the
/// same hardware); distortion/noise readouts differ mostly through windowing
/// and integration choices, so they get a few dB of slack.
fn compare(host: &BatteryResult, vm: &BatteryResult) -> Vec<CompareRow> {
    let mut rows = vec![
        row(
            "Level @1 kHz L (dBV)",
            host.level_1k_dbv.0,
            vm.level_1k_dbv.0,
            0.5,
        ),
        row(
            "Level @1 kHz R (dBV)",
            host.level_1k_dbv.1,
            vm.level_1k_dbv.1,
            0.5,
        ),
        row(
            "Balance L−R @1 kHz (dB)",
            host.balance_1k_db(),
            vm.balance_1k_db(),
            0.2,
        ),
        row(
            "Noise floor L (dBV)",
            host.noise_floor_dbv.0,
            vm.noise_floor_dbv.0,
            3.0,
        ),
        row(
            "Noise floor R (dBV)",
            host.noise_floor_dbv.1,
            vm.noise_floor_dbv.1,
            3.0,
        ),
        row("THD @1 kHz L (dB)", host.thd_1k_db.0, vm.thd_1k_db.0, 3.0),
        row("THD @1 kHz R (dB)", host.thd_1k_db.1, vm.thd_1k_db.1, 3.0),
        row(
            "THD+N @1 kHz L (dB)",
            host.thdn_1k_db.0,
            vm.thdn_1k_db.0,
            2.0,
        ),
        row("SNR @1 kHz L (dB)", host.snr_1k_db.0, vm.snr_1k_db.0, 3.0),
        row(
            "THD @100 Hz L (dB)",
            host.thd_100_db.0,
            vm.thd_100_db.0,
            3.0,
        ),
        row("THD @6 kHz L (dB)", host.thd_6k_db.0, vm.thd_6k_db.0, 3.0),
    ];
    // FR flatness: each side's deviation-from-1kHz must agree point by point.
    for (hp, vp) in host.fr.iter().zip(vm.fr.iter()) {
        rows.push(row(
            &format!("FR dev @{} Hz L (dB)", hp.freq),
            hp.left_dev_db,
            vp.left_dev_db,
            0.2,
        ));
    }
    rows.push(row(
        "Linearity worst 10 dB-step error (dB)",
        host.lin_worst_step_err_db(),
        vm.lin_worst_step_err_db(),
        0.1,
    ));
    rows
}

fn render_markdown(cli: &Cli, rounds: &[Vec<WindowPass>], diags: &[PassDiag], ts: u64) -> String {
    let mut md = String::new();
    let _ = writeln!(
        md,
        "# QA402 A/B loopback bench — qa40x-rs vs official QA40x\n"
    );
    let _ = writeln!(
        md,
        "- run id: `{ts}`\n- sample rate: {} Hz, buffer: {} samples, input range: ±6 dBV",
        cli.sample_rate, cli.buffer_size
    );
    let _ = writeln!(
        md,
        "- stimulus: {} dBV on both targets (auto-fitted output range)",
        cli.amp_dbv
    );
    let _ = writeln!(
        md,
        "- analysis windows forced on both targets: {} (one battery each); THD @100 Hz averaged over {} acquisitions\n",
        cli.windows.join(", "),
        cli.thd_avg
    );
    for (i, passes) in rounds.iter().enumerate() {
        let _ = writeln!(md, "## Round {}\n", i + 1);
        for p in passes {
            let _ = writeln!(md, "### Window {}\n", p.window);
            for r in [&p.host, &p.vm].into_iter().flatten() {
                let _ = writeln!(
                    md,
                    "- **{}** ({}) — fw/app version {}, battery {:.0} s{}",
                    r.target,
                    r.base_url,
                    r.version,
                    r.elapsed_s,
                    if r.windowing_applied {
                        String::new()
                    } else {
                        format!(" — ⚠ /Settings/Windowing/{} NOT accepted, target kept its default window", r.window)
                    }
                );
                if r.thd_100_runs.len() > 1 {
                    let runs = r
                        .thd_100_runs
                        .iter()
                        .map(|x| format!("{:.1}", x.0))
                        .collect::<Vec<_>>()
                        .join(", ");
                    let _ = writeln!(
                        md,
                        "  - THD @100 Hz acquisitions L (dB): [{runs}] — spread {:.1} dB",
                        thd_spread_db(&r.thd_100_runs)
                    );
                }
            }
            let _ = writeln!(md);
            if let (Some(h), Some(v)) = (&p.host, &p.vm) {
                let rows = compare(h, v);
                let _ = writeln!(
                    md,
                    "| metric | qa40x-rs (host) | official (VM) | Δ | tol | verdict |"
                );
                let _ = writeln!(md, "|---|---:|---:|---:|---:|:--:|");
                for r in &rows {
                    let _ = writeln!(
                        md,
                        "| {} | {:.3} | {:.3} | {:+.3} | {:.2} | {} |",
                        r.metric,
                        r.host,
                        r.vm,
                        r.delta,
                        r.tolerance,
                        if r.pass { "✅" } else { "❌" }
                    );
                }
                let fails = rows.iter().filter(|r| !r.pass).count();
                let _ = writeln!(
                    md,
                    "\n**Round {} / window {}: {}/{} metrics within tolerance.**\n",
                    i + 1,
                    p.window,
                    rows.len() - fails,
                    rows.len()
                );
            } else {
                for (r, name) in [(&p.host, "host"), (&p.vm, "VM")] {
                    if let Some(r) = r {
                        let _ = writeln!(md, "#### {} ({name} only)\n", r.target);
                        let _ = writeln!(md, "| metric | L | R |");
                        let _ = writeln!(md, "|---|---:|---:|");
                        let _ = writeln!(
                            md,
                            "| Noise floor (dBV) | {:.2} | {:.2} |",
                            r.noise_floor_dbv.0, r.noise_floor_dbv.1
                        );
                        let _ = writeln!(
                            md,
                            "| Level @1 kHz (dBV) | {:.2} | {:.2} |",
                            r.level_1k_dbv.0, r.level_1k_dbv.1
                        );
                        let _ = writeln!(
                            md,
                            "| THD @1 kHz (dB) | {:.1} | {:.1} |",
                            r.thd_1k_db.0, r.thd_1k_db.1
                        );
                        let _ = writeln!(
                            md,
                            "| THD @100 Hz (dB) | {:.1} | {:.1} |",
                            r.thd_100_db.0, r.thd_100_db.1
                        );
                        let _ = writeln!(
                            md,
                            "| THD+N @1 kHz (dB) | {:.1} | {:.1} |",
                            r.thdn_1k_db.0, r.thdn_1k_db.1
                        );
                        let _ = writeln!(
                            md,
                            "| SNR @1 kHz (dB) | {:.1} | {:.1} |",
                            r.snr_1k_db.0, r.snr_1k_db.1
                        );
                        let (wl, wr) = r.fr_worst_dev_db();
                        let _ =
                            writeln!(md, "| FR worst dev re 1 kHz (dB) | {:.3} | {:.3} |", wl, wr);
                        let _ = writeln!(
                            md,
                            "| Linearity worst step err (dB) | {:.3} | — |",
                            r.lin_worst_step_err_db()
                        );
                        let _ = writeln!(md);
                    }
                }
            }
        }
    }
    render_diagnostics(&mut md, diags);
    // Repeatability across rounds (host side, first window), if more than one.
    let host_levels: Vec<f64> = rounds
        .iter()
        .filter_map(|passes| passes.first()?.host.as_ref().map(|h| h.level_1k_dbv.0))
        .collect();
    if host_levels.len() > 1 {
        let min = host_levels.iter().cloned().fold(f64::INFINITY, f64::min);
        let max = host_levels
            .iter()
            .cloned()
            .fold(f64::NEG_INFINITY, f64::max);
        let _ = writeln!(
            md,
            "## Repeatability\n\nqa40x-rs 1 kHz level spread across {} rounds: {:.3} dB\n",
            host_levels.len(),
            max - min
        );
    }
    md
}

/// The issue #14 diagnostic section: what each target's saved spectra say
/// about its ACTUAL parametrization (played frequency, coherence, window),
/// and which THD method reproduces its reported /ThdDb/100/20000.
fn render_diagnostics(md: &mut String, diags: &[PassDiag]) {
    if diags.is_empty() {
        return;
    }
    let _ = writeln!(md, "## Inferred parametrization & THD-method probe\n");
    let _ = writeln!(
        md,
        "The official REST API has no settings readback: each target's effective\n\
         parametrization is inferred from its own saved spectra (peak bin = played\n\
         frequency; near-bin ratios of a coherent tone = the window's DFT\n\
         coefficients), and its THD @100 Hz is recomputed from the same snapshot\n\
         with each candidate method — the matching one identifies the implementation.\n"
    );
    for d in diags {
        let _ = writeln!(
            md,
            "### r{} · {} · window set: {}\n",
            d.round, d.target, d.window_set
        );
        for (inf, label) in [(&d.inference_1k, "1 kHz"), (&d.inference_100, "100 Hz")] {
            match inf {
                Some(i) => {
                    let matches_set = i.window.eq_ignore_ascii_case(&d.window_set);
                    let _ = writeln!(
                        md,
                        "- {label}: plays {:.4} Hz (bin {}, snap-to-grid predicts {:.4} Hz), {}, window reads **{}** (fit err {:.1} dB){}",
                        i.f0_hz,
                        i.peak_bin,
                        i.snapped_hz,
                        if i.coherent {
                            format!("coherent (lobe asymmetry {:.2} dB)", i.asymmetry_db)
                        } else {
                            format!("NOT coherent (lobe asymmetry {:.2} dB)", i.asymmetry_db)
                        },
                        i.window,
                        i.fit_err_db,
                        if matches_set {
                            ""
                        } else {
                            " — ⚠ DIFFERS from the window this battery set: equivalence unverified"
                        }
                    );
                }
                None => {
                    let _ = writeln!(md, "- {label}: no spectrum snapshot — inference skipped");
                }
            }
        }
        if !d.probe_100.is_empty() {
            let _ = writeln!(
                md,
                "\n| THD @100 Hz method (recomputed from this target's spectrum) | L (dB) | R (dB) |"
            );
            let _ = writeln!(md, "|---|---:|---:|");
            for p in &d.probe_100 {
                let _ = writeln!(md, "| {} | {:.2} | {:.2} |", p.method, p.left_db, p.right_db);
            }
            let _ = writeln!(
                md,
                "| **reported by /ThdDb/100/20000 (averaged)** | **{:.2}** | **{:.2}** |",
                d.reported_thd_100_db.0, d.reported_thd_100_db.1
            );
            let _ = writeln!(md);
        }
    }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn")).init();
    let cli = match parse_cli() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(2);
        }
    };
    if let Err(e) = run(&cli).await {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

/// Offline diagnostic on saved spectrum files: window/coherence inference and
/// the THD-method probe, no hardware involved.
fn run_probe(cli: &Cli) -> R<()> {
    for path in &cli.probe_files {
        println!("== {path} (asked tone {} Hz) ==", cli.probe_freq);
        let spec = decode_spectrum_file(path)?;
        match infer_window(&spec.left, spec.dx, cli.probe_freq) {
            Some(i) => println!(
                "  plays {:.4} Hz (bin {}, snap-to-grid predicts {:.4} Hz)\n  \
                 {} (lobe asymmetry {:.2} dB)\n  \
                 window reads {} (fit err {:.1} dB; side ratios {:?} dB)",
                i.f0_hz,
                i.peak_bin,
                i.snapped_hz,
                if i.coherent { "coherent" } else { "NOT coherent" },
                i.asymmetry_db,
                i.window,
                i.fit_err_db,
                i.side_ratios_db.map(|r| (r * 100.0).round() / 100.0),
            ),
            None => println!("  no tone found near {} Hz", cli.probe_freq),
        }
        for p in thd_probe(&spec, cli.probe_freq) {
            println!("  THD[{}]  L {:.2} dB  R {:.2} dB", p.method, p.left_db, p.right_db);
        }
    }
    Ok(())
}

async fn run(cli: &Cli) -> R<()> {
    if !cli.probe_files.is_empty() {
        return run_probe(cli);
    }
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    std::fs::create_dir_all(&cli.out_dir).map_err(|e| format!("mkdir {}: {e}", cli.out_dir))?;

    if !cli.demo && !cli.skip_host {
        // Informational: a missing loopback shows up immediately as a
        // noise-only 1 kHz level, so under --no-prompt we warn instead of
        // blocking on stdin.
        if cli.no_prompt {
            println!(
                ">>> assuming loopback wiring is in place (L+ OUT → L+ IN, R+ OUT → R+ IN)"
            );
        } else {
            prompt(
                "Loopback wiring check: L+ OUT → L+ IN and R+ OUT → R+ IN on the QA402,\n\
                 and neither the qa40x-rs GUI nor any other client is holding the device.",
                cli.no_prompt,
            )?;
        }
    }

    // The in-process REST server and device handle live for the whole run;
    // the device is claimed/released around each host phase so the VM can
    // take the USB interface in between.
    let device = Arc::new(Mutex::new(QA40xDevice::new()));
    let mut rest = RestControl::new(device.clone());
    let status = rest.set_exposed(false).await.map_err(|e| {
        format!("REST bind failed: {e} — is the qa40x-rs app (or another bench) running?")
    })?;
    let host_url = format!("http://{}:{}", status.host, status.port);
    println!("[host] qa40x-rs REST server on {host_url}");

    let vm_uuid = if cli.skip_vm {
        String::new()
    } else {
        let info = vm_info(&cli.vm_name)?;
        info["uuid"].as_str().ok_or("VM uuid missing")?.to_string()
    };

    let mut rounds: Vec<Vec<WindowPass>> = Vec::new();
    let mut diags: Vec<PassDiag> = Vec::new();
    let host_prefix =
        |round: u32, w: &str| format!("{}/{}-host-r{}-{}", cli.out_dir, ts, round, w.to_lowercase());
    let vm_prefix =
        |round: u32, w: &str| format!("{}/{}-vm-r{}-{}", cli.out_dir, ts, round, w.to_lowercase());

    for round in 1..=cli.rounds {
        println!("\n=== Round {round}/{} ===", cli.rounds);

        // -- Host phase -----------------------------------------------------
        let host_res = if cli.skip_host {
            None
        } else {
            // If a previous round (or a previous bench run) left the QA402
            // assigned to the VM, take it back — the device only returns to
            // the host when the VM stops.
            if !cli.skip_vm && round > 1 {
                vm_stop(&cli.vm_name)?;
                usb_release(&cli.usb_name)?;
                // Give macOS a moment to re-enumerate the device.
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
            {
                let dev = device.lock().await;
                if cli.demo {
                    println!("[host] DEMO mode — embedded virtual QA403 (harness self-test, not a hardware measurement)");
                    dev.connect_virtual()
                        .await
                        .map_err(|e| format!("virtual connect: {e}"))?;
                } else if let Err(first) = dev.connect().await {
                    if cli.skip_vm || vm_status(&cli.vm_name)? != "running" {
                        return Err(format!(
                            "QA402 connect failed: {first} — is it attached to the Mac (not the VM)?"
                        ));
                    }
                    println!("[host] QA402 unavailable ({first}) — reclaiming it from the running VM");
                    vm_stop(&cli.vm_name)?;
                    usb_release(&cli.usb_name)?;
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    dev.connect()
                        .await
                        .map_err(|e| format!("QA402 connect failed even after stopping the VM: {e}"))?;
                }
                if let Some(meta) = dev.device_meta().await {
                    println!(
                        "[host] {} serial {} fw {}",
                        meta.product, meta.serial, meta.firmware_version
                    );
                }
            }
            let client = RestClient::new(&host_url);
            let mut batteries = Vec::new();
            for w in &cli.windows {
                batteries
                    .push(run_battery(&client, "qa40x-rs", cli.amp_dbv, w, cli, &host_prefix(round, w)).await?);
            }
            device
                .lock()
                .await
                .disconnect()
                .await
                .map_err(|e| format!("disconnect: {e}"))?;
            Some(batteries)
        };

        // -- VM phase -------------------------------------------------------
        let vm_res = if cli.skip_vm {
            None
        } else {
            println!(
                "[vm] assigning {:?} to VM and booting {:?}",
                cli.usb_name, cli.vm_name
            );
            usb_assign(&cli.usb_name, &vm_uuid)?;
            vm_start(&cli.vm_name)?;
            let base = match &cli.vm_url {
                Some(u) => u.clone(),
                None => {
                    let ip = vm_wait_ip(&cli.vm_name, Duration::from_secs(180))?;
                    // 9403 is the in-guest portproxy in front of the app's
                    // localhost-only 9402 (see guest_setup_rest_relay).
                    format!("http://{ip}:9403")
                }
            };
            println!("[vm] VM up, targeting {base} (relay to localhost:9402)");
            if let Err(e) = guest_setup_rest_relay(&cli.vm_name) {
                println!("[vm] REST relay setup failed ({e}) — continuing, it may already be in place");
            }
            let client = RestClient::with_host_header(&base, Some("localhost:9402".into()));
            vm_wait_rest(&client, cli).await?;
            // The app must also see the analyzer over USB.
            if !vm_wait_device(&client, cli).await? {
                prompt(
                    "The official app does not report the QA402 as connected.\n\
                     Check the Parallels Devices ▸ USB menu and attach the analyzer to the VM,\n\
                     or toggle File ▸ Device in the app.",
                    cli.no_prompt,
                )?;
            }
            let mut batteries = Vec::new();
            let mut retried = false;
            let mut win_iter = cli.windows.iter();
            let mut current = win_iter.next();
            while let Some(w) = current {
                match run_battery(&client, "QA40x official", cli.amp_dbv, w, cli, &vm_prefix(round, w))
                    .await
                {
                    Ok(res) => {
                        batteries.push(res);
                        current = win_iter.next();
                    }
                    Err(e) if !retried => {
                        // Typical failure mode: the app dropped the analyzer
                        // mid-battery (fresh-boot USB flakiness). One
                        // Parallels-level replug, then a single retry.
                        retried = true;
                        println!("[vm] battery failed ({e}) — USB replug (suspend/resume) and one retry");
                        if let Err(e) = vm_replug_usb(&cli.vm_name) {
                            println!("[vm] suspend/resume failed: {e}");
                        }
                        vm_wait_rest(&client, cli).await?;
                        if !vm_wait_device(&client, cli).await? {
                            return Err("official app still does not see the QA402 after replug".into());
                        }
                    }
                    Err(e) => return Err(e),
                }
            }
            let res = batteries;
            if !cli.keep_vm {
                guest_kill(&cli.vm_name, &cli.qa40x_exe);
                vm_stop(&cli.vm_name)?;
                usb_release(&cli.usb_name)?;
                println!("[vm] VM stopped, QA402 released back to the host");
            }
            Some(res)
        };

        // Zip both phases into per-window passes, and run the offline
        // diagnostic (window inference + THD-method probe) on the spectra
        // each battery saved.
        let mut passes = Vec::new();
        for (i, w) in cli.windows.iter().enumerate() {
            let host = host_res.as_ref().and_then(|v| v.get(i).cloned());
            let vm = vm_res.as_ref().and_then(|v| v.get(i).cloned());
            if let Some(r) = &host {
                diags.push(diagnose_pass(round, &host_prefix(round, w), r));
            }
            if let Some(r) = &vm {
                diags.push(diagnose_pass(round, &vm_prefix(round, w), r));
            }
            passes.push(WindowPass { window: w.clone(), host, vm });
        }
        rounds.push(passes);
    }

    // -- Report -------------------------------------------------------------
    let json_path = format!("{}/{}-bench.json", cli.out_dir, ts);
    let md_path = format!("{}/{}-bench.md", cli.out_dir, ts);
    let payload = json!({
        "run_id": ts,
        "sample_rate": cli.sample_rate,
        "buffer_size": cli.buffer_size,
        "amp_dbv": cli.amp_dbv,
        "windows": cli.windows,
        "thd_avg": cli.thd_avg,
        "demo": cli.demo,
        "rounds": rounds,
        "comparison": rounds
            .iter()
            .map(|passes| {
                passes
                    .iter()
                    .filter_map(|p| {
                        Some(json!({
                            "window": p.window,
                            "rows": compare(p.host.as_ref()?, p.vm.as_ref()?),
                        }))
                    })
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>(),
        "diagnostics": diags,
    });
    std::fs::write(&json_path, serde_json::to_string_pretty(&payload).unwrap())
        .map_err(|e| format!("write {json_path}: {e}"))?;
    let md = render_markdown(cli, &rounds, &diags, ts);
    std::fs::write(&md_path, &md).map_err(|e| format!("write {md_path}: {e}"))?;

    println!("\n{md}");
    println!("[done] report: {md_path}\n[done] raw:    {json_path}");

    // Overall exit code reflects the A/B verdict so CI-ish callers can gate on it.
    let any_fail = rounds
        .iter()
        .flatten()
        .filter_map(|p| Some(compare(p.host.as_ref()?, p.vm.as_ref()?)))
        .flatten()
        .any(|r| !r.pass);
    if any_fail {
        return Err("some metrics exceeded their A/B tolerance — see report".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake(target: &str, level: f64) -> BatteryResult {
        BatteryResult {
            target: target.into(),
            base_url: "http://test".into(),
            version: "1.0".into(),
            amp_dbv: -10.0,
            window: "FlatTop".into(),
            windowing_applied: true,
            noise_floor_dbv: (-110.0, -110.5),
            level_1k_dbv: (level, level - 0.05),
            thd_1k_db: (-105.0, -104.0),
            thd_1k_pct: (0.0005, 0.0006),
            thdn_1k_db: (-98.0, -97.5),
            snr_1k_db: (100.0, 99.5),
            thd_100_db: (-100.0, -99.0),
            thd_100_runs: vec![(-100.0, -99.0)],
            thd_6k_db: (-95.0, -94.0),
            fr: FR_FREQS
                .iter()
                .map(|&f| FrPoint {
                    freq: f,
                    left_dbv: level,
                    right_dbv: level,
                    left_dev_db: 0.01,
                    right_dev_db: 0.01,
                })
                .collect(),
            linearity: vec![
                LinPoint {
                    amp: -40.0,
                    left_dbv: level - 30.0,
                    right_dbv: level - 30.0,
                },
                LinPoint {
                    amp: -30.0,
                    left_dbv: level - 20.0,
                    right_dbv: level - 20.0,
                },
                LinPoint {
                    amp: -20.0,
                    left_dbv: level - 10.02,
                    right_dbv: level - 10.0,
                },
                LinPoint {
                    amp: -10.0,
                    left_dbv: level,
                    right_dbv: level,
                },
            ],
            elapsed_s: 1.0,
        }
    }

    #[test]
    fn identical_results_pass_all_tolerances() {
        let h = fake("a", -10.0);
        let v = fake("b", -10.0);
        assert!(compare(&h, &v).iter().all(|r| r.pass));
    }

    #[test]
    fn level_mismatch_fails_the_level_rows_only() {
        let h = fake("a", -10.0);
        let v = fake("b", -8.0); // 2 dB apart — beyond the 0.5 dB level tolerance
        let rows = compare(&h, &v);
        assert!(
            !rows
                .iter()
                .find(|r| r.metric.starts_with("Level @1 kHz L"))
                .unwrap()
                .pass
        );
        assert!(
            rows.iter()
                .find(|r| r.metric.starts_with("THD @1 kHz L"))
                .unwrap()
                .pass
        );
    }

    #[test]
    fn flexible_json_field_parsing() {
        let v = json!({ "Left": -10.5, "Right": "-11.25", "Value": "False" });
        assert_eq!(field_f64(&v, "Left").unwrap(), -10.5);
        assert_eq!(field_f64(&v, "Right").unwrap(), -11.25);
        assert!(!truthy(&v, "Value").unwrap());
    }

    #[test]
    fn linearity_step_error_uses_worst_step() {
        let b = fake("a", -10.0);
        assert!((b.lin_worst_step_err_db() - 0.02).abs() < 1e-9);
    }
}

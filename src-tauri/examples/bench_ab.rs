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
//! Known API divergence handled here: the generator amplitude is dBFS in
//! qa40x-rs but dBV in the official app, so each target gets its own
//! amplitude (defaults: -18 dBFS ≡ -10 dBV with the +8 dBV output range).
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
use tauri_app_lib::qa40x::{OutputGain, QA40xDevice};
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
    host_amp_dbfs: f64,
    vm_amp_dbv: f64,
    sample_rate: u32,
    buffer_size: u32,
    out_dir: String,
    demo: bool,
    skip_vm: bool,
    skip_host: bool,
    keep_vm: bool,
    no_prompt: bool,
    vm_timeout_s: u64,
}

impl Default for Cli {
    fn default() -> Self {
        Self {
            rounds: 1,
            vm_name: "Windows 11".into(),
            usb_name: "QA402 Audio Analyzer".into(),
            qa40x_exe: r"C:\Program Files\QuantAsylum\QA40x\QA40x.exe".into(),
            vm_url: None,
            host_amp_dbfs: -18.0,
            vm_amp_dbv: -10.0,
            sample_rate: 48000,
            buffer_size: 32768,
            out_dir: "target/bench-ab".into(),
            demo: false,
            skip_vm: false,
            skip_host: false,
            keep_vm: false,
            no_prompt: false,
            vm_timeout_s: 240,
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
            "--host-amp" => {
                cli.host_amp_dbfs = val("--host-amp")?
                    .parse()
                    .map_err(|e| format!("--host-amp: {e}"))?
            }
            "--vm-amp" => {
                cli.vm_amp_dbv = val("--vm-amp")?
                    .parse()
                    .map_err(|e| format!("--vm-amp: {e}"))?
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
            "--out" => cli.out_dir = val("--out")?,
            "--vm-timeout" => {
                cli.vm_timeout_s = val("--vm-timeout")?
                    .parse()
                    .map_err(|e| format!("--vm-timeout: {e}"))?
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
  --qa40x-exe PATH   QA40x.exe path in the guest (default C:\\Program Files\\QuantAsylum\\QA40x\\QA40x.exe)
  --vm-url URL       override the VM REST base URL (default http://<vm-ip>:9402)
  --host-amp DBFS    generator amplitude for qa40x-rs, in dBFS (default -18)
  --vm-amp DBV       generator amplitude for the official app, in dBV (default -10)
  --sample-rate HZ   sample rate for both targets (default 48000)
  --buffer-size N    acquisition buffer for both targets (default 32768)
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
}

impl RestClient {
    fn new(base: &str) -> Self {
        Self {
            base: base.trim_end_matches('/').to_string(),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(60))
                .build()
                .expect("reqwest client"),
        }
    }

    async fn call(&self, method: reqwest::Method, path: &str) -> R<Value> {
        let url = format!("{}{}", self.base, path);
        let resp = self
            .http
            .request(method.clone(), &url)
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
/// (the official app serializes most values as strings).
fn field_f64(v: &Value, key: &str) -> R<f64> {
    let f = &v[key];
    if let Some(n) = f.as_f64() {
        return Ok(n);
    }
    if let Some(s) = f.as_str() {
        return s
            .trim()
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
    /// Generator amplitude in the target's native unit (dBFS or dBV).
    amp_native: f64,
    noise_floor_dbv: (f64, f64),
    level_1k_dbv: (f64, f64),
    thd_1k_db: (f64, f64),
    thd_1k_pct: (f64, f64),
    thdn_1k_db: (f64, f64),
    snr_1k_db: (f64, f64),
    thd_100_db: (f64, f64),
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

fn gen_path(on: bool, freq: f64, amp: f64) -> String {
    let state = if on { "On" } else { "Off" };
    format!("/Settings/AudioGen/1/{state}/{freq}/{amp}")
}

async fn run_battery(
    client: &RestClient,
    target: &str,
    amp_native: f64,
    cli: &Cli,
    spectrum_out: &str,
) -> R<BatteryResult> {
    let t0 = std::time::Instant::now();
    println!("[{target}] battery start ({})", client.base);

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

    // 1) Noise floor, generator off.
    client.put(&gen_path(false, 1000.0, amp_native)).await?;
    client.acquire().await?;
    let noise_floor_dbv = client.lr("/RmsDbv/20/20000").await?;
    println!(
        "[{target}] noise floor  L {:7.2} dBV  R {:7.2} dBV",
        noise_floor_dbv.0, noise_floor_dbv.1
    );

    // 2+3) 1 kHz tone: absolute level, balance, THD, THD+N, SNR — one capture.
    client.put(&gen_path(true, 1000.0, amp_native)).await?;
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
    match client.get("/Data/Frequency/Input").await {
        Ok(spec) => std::fs::write(spectrum_out, spec.to_string())
            .map_err(|e| format!("write {spectrum_out}: {e}"))?,
        Err(e) => println!("[{target}] spectrum snapshot unavailable: {e}"),
    }

    // 4) THD at the band edges: 100 Hz and 6 kHz (harmonics up to 20 kHz).
    client.put(&gen_path(true, 100.0, amp_native)).await?;
    client.acquire().await?;
    let thd_100_db = client.lr("/ThdDb/100/20000").await?;
    client.put(&gen_path(true, 6000.0, amp_native)).await?;
    client.acquire().await?;
    let thd_6k_db = client.lr("/ThdDb/6000/20000").await?;
    println!(
        "[{target}] THD  100 Hz {:.1} dB   6 kHz {:.1} dB",
        thd_100_db.0, thd_6k_db.0
    );

    // 5) Stepped-tone frequency response. RMS is integrated over a narrow
    //    relative band around each tone so the readout tracks the tone, not
    //    the wideband noise.
    let mut fr_raw = Vec::new();
    for f in FR_FREQS {
        client.put(&gen_path(true, f, amp_native)).await?;
        client.acquire().await?;
        let lo = (f * 0.8).max(10.0);
        let hi = (f * 1.25).min(23000.0);
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
        let amp = amp_native + off;
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
    client.put(&gen_path(false, 1000.0, amp_native)).await?;

    let res = BatteryResult {
        target: target.into(),
        base_url: client.base.clone(),
        version,
        amp_native,
        noise_floor_dbv,
        level_1k_dbv,
        thd_1k_db,
        thd_1k_pct,
        thdn_1k_db,
        snr_1k_db,
        thd_100_db,
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
    match vm_status(vm_name)?.as_str() {
        "running" => Ok(()),
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

fn vm_wait_ip(vm_name: &str, timeout: Duration) -> R<String> {
    let t0 = std::time::Instant::now();
    while t0.elapsed() < timeout {
        let ip = vm_info(vm_name)?["ip_configured"]
            .as_str()
            .unwrap_or("-")
            .to_string();
        if ip != "-" && !ip.is_empty() {
            return Ok(ip);
        }
        std::thread::sleep(Duration::from_secs(3));
    }
    Err(format!("VM {vm_name:?} got no IP within {timeout:?}"))
}

/// Launch QA40x.exe in the interactive guest session (fire-and-forget).
fn guest_launch(vm_name: &str, exe: &str) -> R<()> {
    sh(
        "prlctl",
        &["exec", vm_name, "--nowait", "cmd", "/c", "start", "", exe],
    )
    .map(|_| ())
}

fn guest_kill(vm_name: &str, exe: &str) {
    let basename = exe.rsplit('\\').next().unwrap_or(exe);
    let _ = sh(
        "prlctl",
        &["exec", vm_name, "taskkill", "/IM", basename, "/F"],
    );
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
         Hints: is the official QA40x app installed at {:?}?\n\
         If its REST server only listens on localhost inside the guest, forward it once:\n\
           prlctl exec {:?} netsh interface portproxy add v4tov4 listenport=9402 listenaddress=0.0.0.0 connectport=9402 connectaddress=127.0.0.1\n\
           prlctl exec {:?} netsh advfirewall firewall add rule name=qa40x-rest dir=in action=allow protocol=TCP localport=9402\n\
         Or pass --vm-url if the address differs.",
        client.base, cli.vm_timeout_s, cli.qa40x_exe, cli.vm_name, cli.vm_name
    ))
}

// ---------------------------------------------------------------------------
// Comparison & report
// ---------------------------------------------------------------------------

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

fn render_markdown(
    cli: &Cli,
    rounds: &[(Option<BatteryResult>, Option<BatteryResult>)],
    ts: u64,
) -> String {
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
        "- stimulus: {} dBFS (qa40x-rs, +8 dBV full-scale) vs {} dBV (official) — nominally identical\n",
        cli.host_amp_dbfs, cli.vm_amp_dbv
    );
    for (i, (host, vm)) in rounds.iter().enumerate() {
        let _ = writeln!(md, "## Round {}\n", i + 1);
        for r in [host, vm].into_iter().flatten() {
            let _ = writeln!(
                md,
                "- **{}** ({}) — fw/app version {}, battery {:.0} s",
                r.target, r.base_url, r.version, r.elapsed_s
            );
        }
        let _ = writeln!(md);
        if let (Some(h), Some(v)) = (host, vm) {
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
                "\n**Round {}: {}/{} metrics within tolerance.**\n",
                i + 1,
                rows.len() - fails,
                rows.len()
            );
        } else {
            for (r, name) in [(host, "host"), (vm, "VM")] {
                if let Some(r) = r {
                    let _ = writeln!(md, "### {} ({name} only)\n", r.target);
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
                        "| THD+N @1 kHz (dB) | {:.1} | {:.1} |",
                        r.thdn_1k_db.0, r.thdn_1k_db.1
                    );
                    let _ = writeln!(
                        md,
                        "| SNR @1 kHz (dB) | {:.1} | {:.1} |",
                        r.snr_1k_db.0, r.snr_1k_db.1
                    );
                    let (wl, wr) = r.fr_worst_dev_db();
                    let _ = writeln!(md, "| FR worst dev re 1 kHz (dB) | {:.3} | {:.3} |", wl, wr);
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
    // Repeatability across rounds (host side), if we have more than one.
    let host_levels: Vec<f64> = rounds
        .iter()
        .filter_map(|(h, _)| h.as_ref().map(|h| h.level_1k_dbv.0))
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

async fn run(cli: &Cli) -> R<()> {
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

    let mut rounds: Vec<(Option<BatteryResult>, Option<BatteryResult>)> = Vec::new();

    for round in 1..=cli.rounds {
        println!("\n=== Round {round}/{} ===", cli.rounds);

        // -- Host phase -----------------------------------------------------
        let host_res = if cli.skip_host {
            None
        } else {
            // If a previous round left the QA402 assigned to the VM, take it back.
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
                } else {
                    dev.connect().await.map_err(|e| {
                        format!(
                            "QA402 connect failed: {e} — is it attached to the Mac (not the VM)?"
                        )
                    })?;
                }
                if let Some(meta) = dev.device_meta().await {
                    println!(
                        "[host] {} serial {} fw {}",
                        meta.product, meta.serial, meta.firmware_version
                    );
                }
                // The REST API has no output-range endpoint and the hardware
                // powers up on the -12 dBV range; pin +8 dBV full-scale so
                // --host-amp dBFS maps to dBV as documented (-18 dBFS ≡ -10 dBV).
                dev.set_output_gain(OutputGain::Gain8dBV)
                    .await
                    .map_err(|e| format!("set output gain: {e}"))?;
            }
            let client = RestClient::new(&host_url);
            let spectrum = format!("{}/{}-host-r{}-spectrum.json", cli.out_dir, ts, round);
            let res = run_battery(&client, "qa40x-rs", cli.host_amp_dbfs, cli, &spectrum).await?;
            device
                .lock()
                .await
                .disconnect()
                .await
                .map_err(|e| format!("disconnect: {e}"))?;
            Some(res)
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
                    format!("http://{ip}:9402")
                }
            };
            println!("[vm] VM up, targeting {base}");
            let client = RestClient::new(&base);
            vm_wait_rest(&client, cli).await?;
            // The app must also see the analyzer over USB.
            let mut connected = false;
            for _ in 0..30 {
                if let Ok(v) = client.get("/Status/Connection").await {
                    if truthy(&v, "Value").unwrap_or(false) {
                        connected = true;
                        break;
                    }
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            if !connected {
                prompt(
                    "The official app does not report the QA402 as connected.\n\
                     Check the Parallels Devices ▸ USB menu and attach the analyzer to the VM.",
                    cli.no_prompt,
                )?;
            }
            let spectrum = format!("{}/{}-vm-r{}-spectrum.json", cli.out_dir, ts, round);
            let res =
                run_battery(&client, "QA40x official", cli.vm_amp_dbv, cli, &spectrum).await?;
            if !cli.keep_vm {
                guest_kill(&cli.vm_name, &cli.qa40x_exe);
                vm_stop(&cli.vm_name)?;
                usb_release(&cli.usb_name)?;
                println!("[vm] VM stopped, QA402 released back to the host");
            }
            Some(res)
        };

        rounds.push((host_res, vm_res));
    }

    // -- Report -------------------------------------------------------------
    let json_path = format!("{}/{}-bench.json", cli.out_dir, ts);
    let md_path = format!("{}/{}-bench.md", cli.out_dir, ts);
    let payload = json!({
        "run_id": ts,
        "sample_rate": cli.sample_rate,
        "buffer_size": cli.buffer_size,
        "host_amp_dbfs": cli.host_amp_dbfs,
        "vm_amp_dbv": cli.vm_amp_dbv,
        "demo": cli.demo,
        "rounds": rounds
            .iter()
            .map(|(h, v)| json!({ "host": h, "vm": v }))
            .collect::<Vec<_>>(),
        "comparison": rounds
            .iter()
            .filter_map(|(h, v)| Some(compare(h.as_ref()?, v.as_ref()?)))
            .collect::<Vec<_>>(),
    });
    std::fs::write(&json_path, serde_json::to_string_pretty(&payload).unwrap())
        .map_err(|e| format!("write {json_path}: {e}"))?;
    let md = render_markdown(cli, &rounds, ts);
    std::fs::write(&md_path, &md).map_err(|e| format!("write {md_path}: {e}"))?;

    println!("\n{md}");
    println!("[done] report: {md_path}\n[done] raw:    {json_path}");

    // Overall exit code reflects the A/B verdict so CI-ish callers can gate on it.
    let any_fail = rounds
        .iter()
        .filter_map(|(h, v)| Some(compare(h.as_ref()?, v.as_ref()?)))
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
            amp_native: -18.0,
            noise_floor_dbv: (-110.0, -110.5),
            level_1k_dbv: (level, level - 0.05),
            thd_1k_db: (-105.0, -104.0),
            thd_1k_pct: (0.0005, 0.0006),
            thdn_1k_db: (-98.0, -97.5),
            snr_1k_db: (100.0, 99.5),
            thd_100_db: (-100.0, -99.0),
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
                    amp: -48.0,
                    left_dbv: level - 30.0,
                    right_dbv: level - 30.0,
                },
                LinPoint {
                    amp: -38.0,
                    left_dbv: level - 20.0,
                    right_dbv: level - 20.0,
                },
                LinPoint {
                    amp: -28.0,
                    left_dbv: level - 10.02,
                    right_dbv: level - 10.0,
                },
                LinPoint {
                    amp: -18.0,
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

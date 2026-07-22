# A/B loopback bench — qa40x-rs vs the official QA40x application

`cargo run --example bench_ab` runs the **same REST-driven measurement battery**
against qa40x-rs (on the macOS host) and the official QuantAsylum QA40x
application (in a Parallels Windows VM), with the same QA402 analyzer switched
between the two. Both servers speak the QA40x REST scheme on port 9402, so one
client exercises both and the report diffs every metric against an A/B
tolerance.

This is a high-level QA gate: it validates qa40x-rs's *measurement chain*
(generator scaling, calibration, FFT/windowing, THD/THD+N/SNR math) against the
vendor reference on real hardware, not just against unit-test fixtures.

## Physical setup

Passive loopback, the audiophile reference config:

- **L+ OUT → L+ IN** and **R+ OUT → R+ IN** (BNC/RCA, unbalanced, shortest leads)
- Nothing else on the connectors; let the analyzer warm up a few minutes for
  stable distortion residuals.

## Prerequisites

- QA402 on USB, visible to Parallels as `QA402 Audio Analyzer`
  (`prlsrvctl usb list`).
- A Parallels VM (default name `Windows 11`) with **Parallels Tools** installed,
  a user logged into the guest console (a GUI app can only start in an
  interactive session), and the official **QA40x** app at
  `C:\Program Files (x86)\QuantAsylum\QA40x\QA40x.exe` (override with
  `--qa40x-exe`).
- The qa40x-rs GUI must **not** be running (single USB claim, and the bench
  binds the same 9402 port).

No manual REST forwarding is needed: the official app registers
`http://localhost:9402/` with Windows HTTP.sys, which rejects any other Host
header (400) and refuses non-loopback sources for `localhost` (403). The bench
automatically installs a netsh portproxy in the guest (`9403 →
loopback:9402`, plus a firewall rule) and keeps sending
`Host: localhost:9402` through it.

## What it does

Per round (`--rounds N` alternates N times, assessing repeatability):

1. **Host phase** — claims the QA402 over native USB, starts the in-process
   qa40x-rs REST server (same code path as the GUI), runs the battery against
   `http://127.0.0.1:9402`, then releases the device.
2. **VM phase** — `prlsrvctl usb set` assigns the QA402 to the VM,
   `prlctl start` boots it (a paused VM is resumed, and idle auto-pause is
   turned off for the VM), the REST relay is installed, and QA40x.exe is
   launched through a scheduled task bound to the console user's interactive
   token (`prlctl exec` runs as SYSTEM, from which `cmd /c start` cannot open
   a GUI app). The battery then runs against `http://<vm-ip>:9403`.
   Afterwards the app is closed, the VM is shut down and the analyzer returns
   to the host (`--keep-vm` skips that).

   If the app reports the analyzer as disconnected — typical right after the
   host releases it — the bench forces a guest-side PnP disable/enable of the
   QA402 and restarts the app: the scripted equivalent of unplugging and
   replugging the cable.

### The battery (per target)

48 kHz, 32768-sample buffer (≈1.46 Hz bins), ±6 dBV input range, −10 dBV
stimulus (`--amp`, dBV on both targets):

| # | Measurement | Endpoint(s) |
|---|---|---|
| 1 | Noise floor 20 Hz–20 kHz, generator off | `RmsDbv` |
| 2 | Absolute level & L/R balance @ 1 kHz | `RmsDbv` |
| 3 | THD, THD+N, SNR @ 1 kHz | `ThdDb`, `ThdPct`, `ThdnDb`, `SnrDb` |
| 4 | THD @ 100 Hz and 6 kHz | `ThdDb` |
| 5 | Frequency response, 12 stepped tones 20 Hz–20 kHz, deviation re 1 kHz | `RmsDbv` (narrow band) |
| 6 | Amplitude linearity, 1 kHz staircase in 10 dB steps | `RmsDbv` |
| 7 | 1 kHz spectrum snapshot saved for offline diffing | `Data/Frequency/Input` |

### A/B tolerances

| Metric | Tolerance | Rationale |
|---|---|---|
| Level @ 1 kHz | 0.5 dB | absolute calibration agreement |
| L−R balance | 0.2 dB | same analyzer, same cables |
| FR deviation per point | 0.2 dB | flatness must match point by point |
| Linearity step error | 0.1 dB | DAC/ADC tracking |
| THD / SNR | 3 dB | windowing & integration choices differ |
| THD+N | 2 dB | idem, slightly tighter |
| Noise floor | 3 dB | bandwidth/weighting details |

The process exits non-zero if any metric exceeds its tolerance, so the bench
can gate a release checklist.

## Known API divergences

Since issue #20 the `AudioGen` surface is drop-in compatible: the amplitude
is **dBV** on both targets, honored by auto-fitting the output range to the
requested level exactly like the official app (which has no output-range
endpoint — probed on app 1.22: levels 0…+18 dBV read back within 0.03 dB,
amplitudes outside **[−120, +18] dBV** get a 400 on both). The range follows
the *configured* level even with the generator off — On/Off only gates the
tone; measured on hardware, a gen-off noise floor on the power-up −12 dBV
range reads ~4 dB above the official app's. The
`Gen1`/`Gen2` designators address two independent generator slots on both.
A single `--amp` (dBV) therefore drives both targets — which A/B-validates
this endpoint's semantics for free.

> **Breaking change for pre-#20 qa40x-rs REST scripts**: through v0.2.2 the
> qa40x-rs amplitude was interpreted as dBFS relative to the *current* output
> range's full scale; such scripts must now send dBV (on the +8 dBV range,
> old dBFS + 8). The Gen designator segment was also ignored back then;
> unknown designators or states now get a 400 like the official parser.

Remaining divergences are all of the *accepting-more-than-official* kind
(identical meaning for everything the official parser accepts):

- **HTTP verbs**: the client uses the official verbs (PUT settings, POST
  acquisition, GET readouts); qa40x-rs routes on path only, so both accept them.
- **Async acquisition**: qa40x-rs acquires synchronously and always reports
  `AcquisitionBusy=False`; the client's poll loop works unchanged on both.
- **Value shapes**: both serialize values as JSON strings, but the official
  app uses the host locale's decimal separator (comma on a French guest)
  where qa40x-rs always emits `.`; the client parses both.
- **HTTP.sys quirks**: body-less PUT/POST get an explicit `Content-Length: 0`
  (411 otherwise), and the Host header is pinned to `localhost:9402` through
  the relay (see above).
- **Numeric strictness**: the official parser takes integer Hz and integer dB
  only (fractional values get a 400) and `Gen1`/`Gen2`/`On`/`Off` exactly;
  qa40x-rs additionally accepts fractional values, case variants and bare
  `1`/`2` designators, with the same meaning.
- **Generator default**: after `/Settings/Default` the official app leaves
  the generator off; qa40x-rs keeps its historical Gen1-on default (1 kHz,
  −10 dBV). Scripts should set `AudioGen` explicitly (the bench does).

## Verified baseline (2026-07-22 — QA402 fw 60 vs official app 1.220)

Latest reference run (id `1784707944`, 48 kHz, 32768-sample buffer, ±6 dBV
input, single −10 dBV stimulus on both targets, passive loopback on both
channels), after the issue #20 fix (dBV amplitudes with auto-fitted output
range — the bench no longer compensates anything, so this run also validates
the `AudioGen` endpoint semantics on hardware).
**23/24 metrics within tolerance.** This table is the parity baseline the
README links to; re-run the bench and replace it when the numbers move.

| metric | qa40x-rs (host) | official (VM) | Δ | tol | verdict |
|---|---:|---:|---:|---:|:--:|
| Level @1 kHz L (dBV) | -9.657 | -10.034 | +0.378 | 0.50 | ✅ |
| Level @1 kHz R (dBV) | -9.593 | -10.026 | +0.433 | 0.50 | ✅ |
| Balance L−R @1 kHz (dB) | -0.063 | -0.008 | -0.056 | 0.20 | ✅ |
| Noise floor L (dBV) | -107.280 | -107.644 | +0.364 | 3.00 | ✅ |
| Noise floor R (dBV) | -107.563 | -106.414 | -1.149 | 3.00 | ✅ |
| THD @1 kHz L (dB) | -110.750 | -110.674 | -0.076 | 3.00 | ✅ |
| THD @1 kHz R (dB) | -108.542 | -108.299 | -0.243 | 3.00 | ✅ |
| THD+N @1 kHz L (dB) | -97.549 | -97.594 | +0.045 | 2.00 | ✅ |
| SNR @1 kHz L (dB) | 97.762 | 98.364 | -0.602 | 3.00 | ✅ |
| THD @100 Hz L (dB) | -107.074 | -103.464 | -3.610 | 3.00 | ❌ |
| THD @6 kHz L (dB) | -111.261 | -111.274 | +0.013 | 3.00 | ✅ |
| FR dev @20 Hz L (dB) | -0.014 | -0.015 | +0.001 | 0.20 | ✅ |
| FR dev @30 Hz L (dB) | -0.007 | -0.008 | +0.001 | 0.20 | ✅ |
| FR dev @50 Hz L (dB) | -0.003 | -0.003 | +0.000 | 0.20 | ✅ |
| FR dev @100 Hz L (dB) | -0.000 | -0.001 | +0.000 | 0.20 | ✅ |
| FR dev @200 Hz L (dB) | 0.001 | -0.000 | +0.001 | 0.20 | ✅ |
| FR dev @500 Hz L (dB) | 0.001 | 0.000 | +0.000 | 0.20 | ✅ |
| FR dev @1000 Hz L (dB) | 0.000 | 0.000 | +0.000 | 0.20 | ✅ |
| FR dev @2000 Hz L (dB) | -0.002 | -0.002 | +0.000 | 0.20 | ✅ |
| FR dev @5000 Hz L (dB) | -0.016 | -0.016 | +0.000 | 0.20 | ✅ |
| FR dev @10000 Hz L (dB) | -0.065 | -0.065 | +0.000 | 0.20 | ✅ |
| FR dev @15000 Hz L (dB) | -0.146 | -0.146 | +0.000 | 0.20 | ✅ |
| FR dev @20000 Hz L (dB) | -0.258 | -0.258 | +0.000 | 0.20 | ✅ |
| Linearity worst 10 dB-step error (dB) | 0.000 | 0.001 | -0.001 | 0.10 | ✅ |

Reading: every FR point agrees to ≤ 0.001 dB, THD+N to 0.045 dB, and the
noise floors to ≤ 1.15 dB. The one remaining failure, THD @ 100 Hz, is
qa40x-rs reading *lower* (cleaner) than the official app by 3.61 dB for a
3 dB tolerance: the official app measures through a 5-term flat-top window
whose wide lobes integrate more of the near-floor energy around each low
harmonic than our narrow Hann lobes. Offering the official app's analysis
parameters (window, coherent generator toggle) is tracked as issue #14.

## Findings from the first hardware run (2026-07-21, QA402 fw 60 vs app 1.220)

Frequency-response deviation, linearity and THD @ 1 kHz agree to within
0.03 dB / 0.001 dB / 0.9 dB — the acquisition chains track each other
remarkably well. Three real divergences surfaced:

1. **Right channel silent on qa40x-rs** *(fixed on this branch)*: the REST
   `acquisition()` drove the tone on the left output only, while the official
   Gen1 drives both outputs. It now routes the stimulus with
   `route_stimulus(&tone, Route::Both)`; verified in loopback (R at
   −9.61 dBV, THD R −107.6 dB, FR R matching the official trace).
2. **Integrated noise** *(fixed on this branch — issue #7)*: qa40x-rs
   `RmsDbv` with the generator off read ≈ −76 dBV (20 Hz–20 kHz) where the
   official app reads ≈ −108 dBV on the same wiring; THD+N and SNR differed
   by ≈ 12 dB in the same direction. Bin-by-bin comparison of the two saved
   spectra proved the acquisition itself was equally quiet (per-bin floors
   within 0.4 dB) and isolated three causes, all in the readout math:
   the official app snaps its generator onto the FFT bin grid (its 1 kHz
   plays at 1000.4883 Hz = bin 683 — its lobe is perfectly symmetric, and a
   simulated coherent flat-top tone reproduces it to 0.06 dB), so it has no
   window-skirt leakage where our non-coherent tone's Hann skirts dominated
   the THD+N residual; our `RmsDbv` returned the full-band time-domain RMS
   (DC and out-of-band noise included) instead of integrating the spectrum
   over the requested band; and broadband integrals of an
   amplitude-corrected spectrum must be divided by the window's ENBW (the
   official app does — its reported noise sits exactly 5.76 dB, the
   flat-top ENBW, below the raw power sum of its own spectrum). Fixed by
   snapping the REST generator (`snap_to_bin`), integrating `RmsDbv` over
   [lo, hi] with the new ENBW-corrected `band_rms_from_spectrum`, and
   exposing `enbw_bins` on `FftResult`. Verified: THD+N Δ 0.004 dB, noise
   floor Δ ≤ 1.7 dB vs the official app on hardware.
3. **Absolute level**: −9.67 dBV vs −10.04 dBV for the nominally identical
   stimulus (output-range mapping / calibration difference of ≈ 0.36 dB).

## Usage

```bash
# Full A/B run, one round
cargo run --example bench_ab

# Three alternations for repeatability stats
cargo run --example bench_ab -- --rounds 3

# Harness self-test without hardware or VM (embedded virtual QA403)
cargo run --example bench_ab -- --demo --skip-vm

# Host-only / VM-only halves
cargo run --example bench_ab -- --skip-vm
cargo run --example bench_ab -- --skip-host --vm-url http://10.211.55.3:9402
```

Reports land in `target/bench-ab/`: a Markdown comparison table
(`<ts>-bench.md`), the raw JSON (`<ts>-bench.json`) and the saved spectra
(`<ts>-{host,vm}-r<N>-spectrum.json`). `--help` lists all options.

## Caveats

- USB switching relies on Parallels' permanent-assignment mechanism
  (`prlsrvctl usb set/del`) plus a VM boot/shutdown per round — reliable but
  slow (~1–2 min per alternation). If the guest misses the device, the bench
  prompts you to attach it via the Parallels **Devices ▸ USB** menu.
- `prlctl exec` needs Parallels Tools; if the app can't be launched that way,
  start QA40x manually in the VM window — the bench keeps polling until
  `--vm-timeout` expires.
- Demo mode measures the embedded simulator, not hardware; it only validates
  the harness itself.

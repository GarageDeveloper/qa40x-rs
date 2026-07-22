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
| 4 | THD @ 100 Hz (averaged over `--thd-avg` acquisitions, spread reported) and 6 kHz | `ThdDb` |
| 5 | Frequency response, 12 stepped tones 20 Hz–20 kHz, deviation re 1 kHz | `RmsDbv` (narrow band) |
| 6 | Amplitude linearity, 1 kHz staircase in 10 dB steps | `RmsDbv` |
| 7 | 1 kHz and 100 Hz spectrum snapshots saved for offline diffing & the probe below | `Data/Frequency/Input` |

### Window matrix & parametrization probe (issue #14)

The official REST API has **no settings readback**, so the bench can never ask
the official app what analysis window it measures through — but it can *tell*
it: `/Settings/Windowing/{Rectangle|Bartlett|Hamming|Hann|FlatTop}` exists in
the official API (visible in the vendor's `QA402_REST_TEST` client, absent
from the wiki), and qa40x-rs implements the same endpoint (flat-top default,
like the official app at startup). The bench therefore runs the whole battery
once per window in `--windows` (default `FlatTop,Hann,Rectangle`), forcing
the **same window on both targets** for each pass — equal situations are
made, not assumed.

Each battery's saved spectra then feed an offline diagnostic, reported under
*Inferred parametrization & THD-method probe*:

- **window inference** — the near-bin ratios of a coherent tone are the
  window's own DFT coefficients (flat-top: −0.3/−3.8/−14.3/−35.9 dB at
  ±1..4 bins; Hann: −6.02 dB at ±1), so each spectrum names the window the
  target *actually* applied; a mismatch with the window the battery set is
  flagged loudly;
- **generator inference** — the peak bin is the actually-played frequency
  (bin-snapped or not), and lobe symmetry says whether the tone was coherent;
- **THD-method probe** — THD @100 Hz is recomputed from the target's own
  spectrum four ways ({lobe±6 integration, peak-bin} × {10 harmonics,
  harmonics→20 kHz}); the method matching the target's reported
  `/ThdDb/100/20000` identifies its implementation (qa40x-rs today:
  lobe±6 × 10 harmonics — the second `/ThdDb` parameter is currently
  ignored, one of the issue #14 candidate mechanisms).

`--probe FILE [--probe-freq HZ]` runs the same inference + probe offline on
any saved snapshot, without hardware.

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

Latest reference run (id `1784724835`, 48 kHz, 32768-sample buffer, ±6 dBV
input, single −10 dBV stimulus on both targets, passive loopback on both
channels), after the issue #20 fix (dBV amplitudes), the issue #8 fix
(factory DAC trims applied to generation) and the issue #14 fixes (the
`/ThdDb` harmonic ceiling honored, the one-shot capture un-gated by the
coherent wrap). Both targets forced to the same analysis window:
**24/24 metrics within tolerance under FlatTop** (the window both apps
default to) **and 24/24 under Hann** — the first fully green A/B. This
table (the FlatTop pass) is the parity baseline the README links to;
re-run the bench and replace it when the numbers move.

| metric | qa40x-rs (host) | official (VM) | Δ | tol | verdict |
|---|---:|---:|---:|---:|:--:|
| Level @1 kHz L (dBV) | -10.022 | -10.036 | +0.014 | 0.50 | ✅ |
| Level @1 kHz R (dBV) | -10.013 | -10.027 | +0.014 | 0.50 | ✅ |
| Balance L−R @1 kHz (dB) | -0.009 | -0.009 | +0.000 | 0.20 | ✅ |
| Noise floor L (dBV) | -107.282 | -108.360 | +1.078 | 3.00 | ✅ |
| Noise floor R (dBV) | -107.036 | -108.435 | +1.399 | 3.00 | ✅ |
| THD @1 kHz L (dB) | -110.037 | -110.758 | +0.721 | 3.00 | ✅ |
| THD @1 kHz R (dB) | -107.669 | -108.220 | +0.550 | 3.00 | ✅ |
| THD+N @1 kHz L (dB) | -97.330 | -97.656 | +0.325 | 2.00 | ✅ |
| SNR @1 kHz L (dB) | 97.509 | 98.465 | -0.957 | 3.00 | ✅ |
| THD @100 Hz L (dB) | -102.848 | -103.703 | +0.855 | 3.00 | ✅ |
| THD @6 kHz L (dB) | -111.744 | -110.562 | -1.182 | 3.00 | ✅ |
| FR dev @20 Hz L (dB) | -0.015 | -0.015 | +0.000 | 0.20 | ✅ |
| FR dev @30 Hz L (dB) | -0.008 | -0.008 | -0.000 | 0.20 | ✅ |
| FR dev @50 Hz L (dB) | -0.003 | -0.003 | -0.000 | 0.20 | ✅ |
| FR dev @100 Hz L (dB) | -0.001 | -0.000 | -0.000 | 0.20 | ✅ |
| FR dev @200 Hz L (dB) | 0.000 | 0.000 | -0.000 | 0.20 | ✅ |
| FR dev @500 Hz L (dB) | 0.000 | 0.001 | -0.000 | 0.20 | ✅ |
| FR dev @1000 Hz L (dB) | 0.000 | 0.000 | +0.000 | 0.20 | ✅ |
| FR dev @2000 Hz L (dB) | -0.002 | -0.002 | +0.000 | 0.20 | ✅ |
| FR dev @5000 Hz L (dB) | -0.016 | -0.016 | +0.000 | 0.20 | ✅ |
| FR dev @10000 Hz L (dB) | -0.065 | -0.065 | +0.000 | 0.20 | ✅ |
| FR dev @15000 Hz L (dB) | -0.146 | -0.146 | +0.000 | 0.20 | ✅ |
| FR dev @20000 Hz L (dB) | -0.258 | -0.258 | -0.000 | 0.20 | ✅ |
| Linearity worst 10 dB-step error (dB) | 0.000 | 0.001 | -0.000 | 0.10 | ✅ |

Reading: absolute level agrees to **0.014 dB** on both channels, every FR
point to ≤ 0.001 dB, the noise floors to ≤ 1.4 dB — and THD @ 100 Hz, the
last historical failure, now agrees to **+0.86 dB** (with a 0.3–0.4 dB
per-acquisition spread on each side, quantified by the 4-acquisition
averaging).

### How the THD @ 100 Hz gap was actually closed (issue #14 post-mortem)

The earlier baselines blamed the official flat-top window's wide lobes; the
window-matrix run (id `1784723144`, same window forced on both targets, THD
recomputed from each target's own spectra with four candidate methods)
disproved that and identified two real mechanisms, both on our side:

1. **The `/ThdDb` harmonic ceiling was ignored** — qa40x-rs hardcoded
   10 harmonics where the official app integrates every harmonic up to the
   endpoint's max parameter (the probe matches its reported values with the
   harmonics→20 kHz family, sharpest under Rectangle where its reading
   equals the peak-bin×→20 kHz recomputation to 0.3 dB). At 100 Hz the
   ceiling admits ~190 extra near-floor harmonics: this was the historical
   −3.6…−5.2 dB "we read cleaner" bias, and the near-floor sum is also why
   the official value moved run-to-run.
2. **The one-shot capture was gated** — the capture returns shifted by the
   USB round-trip latency, so the analyzed window held L zeros plus a
   truncated tone; the gate's sinc skirts read as junk around the carrier.
   Hann at 1 kHz hid it (which is why the old Hann-only baselines looked
   clean); flat-top at 100 Hz exposed it (+11 dB), Rectangle
   catastrophically (−36 dB THD). Since every REST stimulus is bin-snapped
   (periodic over the buffer), prepending the buffer's own tail turns the
   played stream into a periodic continuation and the analyzed window into
   pure steady state.

Residual, deliberate divergence: our THD integrates each harmonic's whole
±6-bin lobe where the official app reads a narrow peak — equivalent for
tones and quiet floors (both 24/24 passes above), but divergent under
**Rectangle**, which leaks every unsnapped spur (mains hum is not on the
FFT grid) into an elevated near-carrier floor that 200 integrated lobes
amplify (Δ ≈ +19 dB @100 Hz on otherwise near-identical spectra). Rectangle
is therefore excluded from the default matrix — a leakage diagnostic, not a
comparable measurement — and the official app itself occasionally glitches
an acquisition under it (seen: −38.6 dB outliers), which the per-acquisition
spread now makes visible instead of surprising.

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
   Root-caused as issue #8 and fixed: the factory DAC trims (−0.363 dB L /
   −0.419 dB R on this unit's +8 dBV range — exactly the measured Δs) were
   applied when interpreting levels but not when generating them; the dBV
   generation paths now pre-compensate the per-channel trim, and the Δ
   dropped to +0.014 dB (run `1784710709`).

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

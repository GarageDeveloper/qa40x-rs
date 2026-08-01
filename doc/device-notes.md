# QA402 / QA403 device notes

Field notes gathered while building qa40x-rs: the device's control protocol,
its timing quirks, and how the app keeps its measurement levels honest. This
is **interoperability documentation** — a description of behaviour and the
reasoning behind the app's choices, not vendor documentation.

The information here comes from two sources: the **public QuantAsylum
references** (the [PyQa40x](https://github.com/QuantAsylum/PyQa40x) and
[QA40x_BareMetal](https://github.com/QuantAsylum/QA40x_BareMetal) projects and
the QA40x user manual), and our **own observations of the USB traffic** while
the device is in use, cross-referenced against those references.

> **Unofficial.** Not affiliated with, authorized, or endorsed by QuantAsylum.
> "QA402", "QA403" and "QuantAsylum" are trademarks of their respective owners.
> Everything here describes behaviour observed on hardware for the sole purpose
> of interoperating with the device. Register semantics beyond the transport
> framing are **inferred from behaviour** — treat anything marked *(inferred)*
> or *(unknown)* as a lead to verify, not a settled fact. No vendor firmware or
> other proprietary material is included or described here.

---

## 1. Control transport — the register bus

The device is controlled through a simple register bus over a bulk USB
endpoint. Every control exchange is one of two fixed-size transfers:

| Direction | Payload | Format |
|---|---|---|
| Host → device (OUT) | 5 bytes | `[reg: 1][value: 4, big-endian]` |
| Device → host (IN)  | 4 bytes | `[value: 4, big-endian]` |

- **Write**: send the bare register address + 4-byte value. No reply.
- **Read**: send the address with its high bit set (`reg | 0x80`) and a zero
  value, then read the 4-byte reply. (e.g. `0x80` reads register `0x00`.)

The unit exposes **three bulk endpoint pairs**: the register bus
(`0x01`/`0x81`), the acquisition stream (`0x02`/`0x82`) and the front-panel
I2S stream (`0x03`/`0x83`, see §10). Only the control bus is described in
this section.

## 2. Register map

Addresses and decodings the app relies on. "R/W" is how the app uses the
register, not necessarily the full hardware capability.

| Reg | Name | R/W | Meaning |
|---|---|---|---|
| `0x00` | LINK / keepalive | R/W | Write a 32-bit pattern, read it back unchanged. Used as a comm test and as a periodic keepalive (see §3). |
| `0x05` | INPUT_GAIN | W | Input range index 0–7 → 0/6/12/18/24/30/36/42 dBV. Also selects the input attenuator (see §5). |
| `0x06` | OUTPUT_GAIN | W | Output range index (mechanical relay, see §6). |
| `0x08` | STREAM_CTRL | W | Start/stop an acquisition (see §4). |
| `0x09` | SAMPLE_RATE | W | Sample-rate **index**, not Hz (e.g. index 0 = 48 kHz, 2 = 192 kHz). |
| `0x0A` | I2S_CTRL | W | Front-panel I2S stream start/stop: `1` starts, `0` stops (see §10). The `= 0` every host writes at connect is simply "I2S off". |
| `0x0B` | I2S_WIDTH | W | Front-panel I2S frame width: `0x00` = 16-bit, `0x40` = 32-bit (see §10). |
| `0x0D` | PAGE_SELECT | W | Selects what sequential reads walk through: `0x10 + 2*page` = flash page (page 0 = calibration, see §7), `1` = firmware trace buffer (see §11). Each write resets the read pointer. |
| `0x0F` | BOOTLOADER_ENTRY | W | Two-value unlock that resets the unit into its DFU bootloader for firmware update. **Device-mutating**; never written except during an explicit, confirmed flash. |
| `0x10` | FIRMWARE_VERSION | R | Firmware build number as a u32 (e.g. `60`). |
| `0x11` | TELEM_USB_VOLTAGE | R | USB rail voltage, millivolts. |
| `0x12` | TELEM_USB_CURRENT | R | USB current, milliamps. |
| `0x13` | TELEM_ISO_CURRENT | R | Isolated-rail current, milliamps. |
| `0x14` | TRACE_READ | R | Firmware trace buffer readout, 4 bytes per read (see §11). |
| `0x15` | TRACE_LEN | R | Byte length of the firmware trace buffer (`0x418` observed) — **not** telemetry, despite sitting in the telemetry range (see §11). |
| `0x16` | TELEM_TEMPERATURE | R | Temperature in deci-°C (value ÷ 10 = °C). |
| `0x19` | CALIBRATION | R | Calibration data, read as fixed-size pages (see §7). |
| `0x1B` | CAPABILITY | R | Constant capability/feature word: `0x40000040` on a real QA402, and the vendor app's device-info screen shows the same expected value for a QA403. Bit meaning *(unknown)*. |
| `0x1C` | CAPABILITY2 | R | Second constant word, differing per model: `0x02A35B03` on a real QA402. The vendor app's device-info screen expects `0x7F31BD30` for a QA403 *(inferred)*. |
| `0x1D` | SERIAL_NUMBER | R | Unit serial packed as a u32; matches the USB serial string. |
| `0x1E` | STREAM_STATUS | R | Probed by the vendor app between a stream stop and restart. Semantics beyond that use are not settled. *(inferred)* |

Telemetry decodings (mV / mA / deci-°C) were validated on hardware.

## 3. Connect sequence and the keepalive

On connect the device expects, in order: one or more keepalive/comm-test
round-trips on `0x00`, a stream stop (`STREAM_CTRL = 0`), an I2S stop
(`I2S_CTRL = 0`, see §10), a calibration read burst, and a defined input
range + sample rate.

While connected, the reference behaviour is a **continuous ~1 s poll loop**:
write a pattern to `0x00`, read it back, then read the four telemetry
registers. This steady traffic is what holds the device's **LINK LED** lit.

qa40x-rs runs this keepalive (rate-limited to ~1 Hz) around AND inside its
acquisitions — the stream pump interleaves the cycle with an active stream at
~1 Hz, matching the official app's in-measurement keepalive (issue #54) — so
live runs, sweeps, long single captures and the generator all hold the LINK
LED, and it caches the telemetry for the UI rather than issuing USB reads
from the frontend.

**Input range at connect.** The reference behaviour is to force a **defined
safe input range (42 dBV, index 7)** on *every* connect — initial and
reconnect alike — rather than restoring the last-used range. 42 dBV is maximum
input headroom: it can't be damaged by an unexpectedly hot signal. A physical
unplug powers the unit off, so on reconnect it reboots and the range is
re-forced.

## 4. Streaming control (`0x08`)

Register `0x08` starts and stops an acquisition. The app uses the two values
documented by the public PyQa40x reference
([`stream.py`](https://github.com/QuantAsylum/PyQa40x/blob/main/src/PyQa40x/stream.py)):

| Value | Meaning |
|---|---|
| `0x05` | start streaming |
| `0x00` | stop streaming |

Only these two values are written. Register I/O and stream I/O coexist on the
bus: the ~1 s keepalive keeps running inside an active stream window without
disturbing it.

## 5. Input range and the attenuator — no separate register

Stepping the input range writes **only `0x05`**. There is no separate
attenuator or relay register anywhere on the bus. The hardware engages its
analogue input attenuator on its own for the upper ranges (**≥ 24 dBV**), so
the attenuator state is a pure function of the input range — the app *derives*
the attenuator annunciator from register 5 and never tries to read or write it
directly.

The input ranges therefore split into two groups: attenuator-out (0–18 dBV)
and attenuator-in (24–42 dBV). Crossing between the groups is the mechanically
expensive transition (see §6).

## 6. Range switching is mechanical — it must settle

The input-range (`0x05`) and output-range (`0x06`) registers do not scale
anything in software: they drive **mechanical relays** in the analogue
front-end and output stage. A relay takes real time to close and stop
bouncing. Writing the register and acquiring immediately would measure a
contact mid-flight — the first capture after a range change would be quietly
wrong, which is worse than an obvious failure.

Observed settle times (working values):

| Event | Settle |
|---|---|
| input-range write (`0x05`) | **~0.25 s** |
| output-range write (`0x06`) | **~0.5 s** |
| crossing the input-range attenuator boundary | **~1.2 s** |

The recommended implementation is a **deadline, not a blocking sleep at the
write site**: each relay write stamps a "not before T" time and the
acquisition path waits on the latest outstanding deadline. Several range
changes in one config-apply then cost a single settle, not the sum, and the
wait is paid by the acquirer (which is allowed to wait) rather than the setter.

Two supporting rules:

- **Never chatter the relays.** Range writes are idempotent (skip the write
  when the range is already correct), and range selection needs hysteresis so
  a signal sitting exactly on a boundary can't oscillate frame after frame.
- **Prefer an intermediate step** across the attenuator boundary rather than a
  direct jump, since that is the expensive transition.

## 7. Calibration readout

Calibration is read as fixed-size pages: a `PAGE_SELECT = 0x10` write
followed by a burst of `0x19` reads (512-byte pages). The data is framed as
fixed-size records with a recurring 16-bit sentinel and a small incrementing
counter.

`PAGE_SELECT` is a true selector, not a fixed token: `0x10 + 2*page` selects
flash page 0..=3, page 0 being the factory calibration page — pages 1..=3
read as all zeros on a real unit — and every write resets the read pointer,
so a page can be re-read from the top. (Observed via the vendor app's
device-info screen, which dumps all four pages.)

*Open:* the byte order of the `0x19` payload (the app reads it little-endian
while the record framing scans more naturally big-endian) is not settled.
*(inferred)*

## 8. Output level management

Measurement software rarely fails at the FFT — it fails at the bookkeeping
around it. A level arrives in one unit, is averaged as if it were another, and
is compared against a full-scale that quietly moved when a relay clicked. The
app is built on a few rules to keep that from happening.

### One canonical unit: Vrms everywhere inside

The app touches many amplitude units — Vrms, Vpk, dBV, dBu, dBFS, dBr, watts.
All the dB units are the same voltage over a different reference:

```
dBV  = 20·log10(V / 1 Vrms)
dBu  = 20·log10(V / 0.7746 Vrms)
dBFS = 20·log10(V / V_fullscale)      # V_fullscale moves with the selected range
dBr  = 20·log10(V / V_reference)      # user-set
```

Two of those references are not constants: `V_fullscale` depends on the
currently selected converter range, and `V_reference` is user-set. So the core
stores exactly one thing — **linear RMS volts** — and projects to any display
unit only at the UI edge. This avoids the classic trap:

```
−6 dBV + −6 dBV, in phase:      0.5012 + 0.5012 Vrms   = 1.0024 Vrms → +0.02 dBV
−6 dBV + −6 dBV, uncorrelated:  √(0.5012² + 0.5012²)   = 0.7088 Vrms → −2.99 dBV
```

Adding the dB numbers (−12 dBV) is meaningless; the right answer depends on
coherence, which only linear arithmetic captures. Watts are a display
projection too (`P = V²/R` needs a user-declared load), never a stored value.

### Phase is part of the level

For a multitone, the **relative phases** of the components decide the crest
factor of the sum, and crest factor is headroom. N equal tones summed with all
phases at zero have a crest factor of `10·log10(N) + 3 dB` — for N = 10 that is
13 dB, ten dB worse than a single sine. The whole multitone must then be set
10 dB lower to avoid clipping the DAC, and those 10 dB come straight out of
SNR. Schroeder phasing spreads the energy in time and brings the crest factor
back near a sine's — same spectrum, same RMS, ~10 dB more usable level. This is
why a tone's phase is a first-class parameter, not a cosmetic detail.

### Limits are a device capability, not a constant

The app drives more than one model (the QA403 supports a 384 kHz rate the QA402
does not), so limits live in a per-model capability set filled in at connect —
sample rates, measurement band, and the output span. The output ceiling is
derived from the four output ranges the device exposes (−12 / −2 / +8 / **+18
dBV** single-ended, matching QuantAsylum's published spec), not a constant baked
into logic — code asks the capability set; it never hard-codes the number. (The
+24 dBV QuantAsylum also quotes is the *balanced* output; the app works in the
single-ended +18 dBV terms of the output-range register.) The floor (≈ −120 dBV)
is a practical probe bound, not a spec'd minimum. The principle is the same one
that makes USB descriptors work: query capabilities, don't assume them.

On the input side, the capability set also carries the **maximum safe AC input**
— QuantAsylum specs **+32 dBV ≈ 40 Vrms** for both models. Note this is *not*
the +42 dBV top input range: that range is a full-scale sensitivity setting, not
a voltage rating. The app can't enforce what a user physically connects; the
value is there so the UI can warn.

### Enumeration and capabilities on the wire (issue #25 lot D)

The GUI's device bar is fed by `list_devices`: the registry unions every
source's enumeration (USB bus scan + the built-in virtual source) into flat
`DeviceEntry` records, each carrying the full capability set — so the range
and rate menus come from the same per-model tables the backend drives the
registers with, not from frontend constants. The capability record is built
**from the model tables at enumerate time**: the capability registers
0x1B/0x1C the official app reads at connect are still NOT consulted (a real
QA403's 0x1B word is unverified, and moving the 384 kHz gate onto a register
read would be a measurement-semantics change — see `src-tauri/src/device/`).
What only an open can know (firmware build from 0x10, whether the factory
calibration page was readable) is filled into the open unit's entry only.
Enumeration is a bus *scan* (an OS device listing), not a claim — it opens
nothing and does no device I/O, so it cannot perturb an acquisition. The GUI
still gates its 2 s re-enumeration on being idle (no stream, no generator,
no GUI program) as a matter of not adding work during a run; backend-owned
sessions (REST, scripts) are invisible to that gate and are safe for the
same no-I/O reason.

### Fit the output range to the mix peak, and latch clips

When several sources are summed into one DAC buffer, clipping is a property of
the **sum**, not of any single source — two legal −6 dBFS tones in phase peak
above full scale. The output range must therefore be chosen from the **peak of
the summed buffer**, computed each frame, with a small (~1 dB) margin for
overshoot — never from one source's declared level.

A clip can be very short (a few samples at 48 kHz is tens of µs) while the UI
redraws every ~16 ms, so a clip indicator wired to "is this buffer clipping?"
would blink for at most one frame or miss it entirely. The fix is the one
hardware peak meters use: **latch** the clip flag and hold the indicator lit
for ~100 ms. And the policy behind it: **never silently rescale the user's
mix** — report the clip and keep generating what was asked; auto-ducking would
make the on-screen levels a lie.

### The factory DAC trim is part of the dBV→digital conversion

The ideal range model ("+8 dBV full scale = digital 1.0") is only as true as
the unit's analog gain. The factory calibration page (§7) stores a per-range,
per-channel DAC trim, and it works in the volts→digital direction: the actual
output is `volts = digital · √2 · 10^((outFS − trim_dB)/20)` peak. Interpreting
levels (placing a stimulus trace on a dBV axis, the FR offset) *divides* the
trim back out — but **producing** a dBV-denominated stimulus must *multiply*
the ideal digital amplitude by `10^(trim_dB/20)` per channel, or the connector
level sits a constant few tenths of a dB off (issue #8: +0.36 dB L / +0.42 dB R
on the bench unit — exactly its +8 dBV-range trims, which the official app
applies and we did not). All three dBV-denominated generation paths apply the
trims (`QA40xDevice::dac_trims`): the REST acquisition, the output-only
generator, and the live stream loop. dBFS-denominated stimuli (the dashboard
generator, internal probes) stay untrimmed — dBFS is a digital-domain unit.

### Probe before you drive

Some tests specify the level at the **DUT's output** ("THD at 1 W into 8 Ω"),
which depends on the DUT's unknown gain. The safe procedure is to measure the
gain first at a level too low to hurt anything — drive ~40 dB below target,
measure the actual peak, compute `gain = measured / probe`, then
`drive = target / gain` — and to **refuse rather than clamp** if the required
drive exceeds the output limit (clamping would silently measure at some other
power than the one named in the test). A measured level of zero/NaN/∞ means
"gain could not be determined" — an error that stops the test, not "0 dB".

## 9. Firmware update mechanism

The firmware update path was worked out by watching the USB traffic during an
update and is reproduced (host and device side) in our
[virtual-qa40x-rs](https://github.com/GarageDeveloper/virtual-qa40x-rs)
emulator. In outline:

1. **Enter the bootloader.** The host writes a two-value unlock to register
   `0x0F`:

   ```
   W 0x0F = 0xDEADBEEF      unlock
   W 0x0F = 0xCAFEBABE      commit → reset into the bootloader
   ```

   The two-value guard means a stray single write can't drop the unit into
   update mode. On the second write the analyzer **detaches**.

2. **Re-enumerate as the bootloader.** The same bus position re-appears as an
   **NXP KBOOT HID bootloader** (USB id `1fc9:0022`) — i.e. the MCU is an NXP
   part with a ROM bootloader that the device resets into.

3. **Receive the firmware.** The bootloader takes the firmware as a **single
   NXP KBOOT `ReceiveSbFile` transfer over USB-HID**: one command announces the
   image length, then the image is streamed in as fixed-size HID data reports,
   and the bootloader replies with a success status. The image is an NXP
   **Secure Binary (SB2.1)** container — signed, so its authenticity can be
   verified before flashing — which internally carries the erase / program /
   jump steps. A successful flash boots back into the analyzer firmware.

qa40x-rs **never bundles or ships QuantAsylum firmware**: the flash feature
points at an installer the user already legally owns, verifies the image's
provenance (known-hash registry) and signature, requires explicit
confirmation, and only then performs the sequence above. See the
[firmware section of the README](../README.md#firmware-flashing--read-this-first).

## 10. Front-panel I2S generation

The front panel's I2S expansion port has its own stream, on the third bulk
endpoint pair (`0x03` OUT / `0x83` IN). The whole protocol, observed on a
real QA402 driven by the vendor app:

1. Write `I2S_WIDTH` (`0x0B`): `0x00` for 16-bit frames, `0x40` for 32-bit.
2. Pause briefly (the vendor app waits ~100 ms).
3. Write `I2S_CTRL` (`0x0A`) `= 1` to start.
4. Stream interleaved stereo sample blocks on bulk EP `0x03`. The device
   paces its acceptance at the I2S rate — one completion per 2048-frame block
   every ~42.7 ms (48 kHz) — which is what flow-controls the host's writer.
   Block size tracks the frame width: 16 KiB in 32-bit mode, 8 KiB in 16-bit
   (2048 frames × 8 or × 4 bytes). The vendor app keeps a two-buffer
   ping-pong in flight and streams silence when no generator is active.
5. Write `I2S_CTRL = 0` to stop.

The I2S stream runs **concurrently** with the acquisition stream: an
acquisition can start and stop repeatedly while I2S keeps playing. EP `0x83`
is exposed by the device but was never observed carrying data.

Because the endpoints are independent, a host (or an emulator) must not
serialize them: register operations — the ~1 Hz keepalive in particular —
have to keep completing normally while the paced I2S stream is running.

### How the official app exposes it (for reference)

Verified against the vendor's public documentation and observed behavior
(QA40x User Manual rev 1.20 §front-panel connector; forum thread "QA403
I2S Input / Output"; our USB captures):

- ONE per-device I2S toggle that **mirrors the Generator 1/2 signals** onto
  the port — it is an *additional* output, not a switch away from the
  analog DAC: nothing in the app mutes or reroutes the analog path while
  I2S runs (both streams were captured flowing concurrently), and the port
  keeps playing between acquisitions.
- Fixed level mapping: **0 dBV maps to 0 dBFS**, levels above 0 dBV clip
  (the app shows a clip warning, shared with its PC-mirroring output).
- A "Front Panel I2S Settings" dialog offers Bit Depth 16/32 (changeable
  only while the port is stopped) and a Sample Rate selector listing
  "48 kSPS (locked)" / 96 / 192 — but the rate CHOICE is not applied:
  only the bit depth is persisted, and the generation loop forces 48 kSPS
  regardless. The 96/192 entries are UI prepared for a future capability
  (the manual confirms other rates are not supported today). Generation
  is only active while Gen1 or Gen2 is active.
- REST (mono-device API): `PUT /Settings/I2sGen/{On|Off}` and
  `PUT /Settings/I2sGen/Width/{16|32}` (width refused while running).
- Hardware facts from the same sources: the expansion port also carries
  FP_I2S_BCLK (32×/64× Fs), FP_I2S_MCLK (24.576 MHz) and an FP_PWR
  ~3.2 V / 10–20 mA rail for isolators; the I2S *input* direction is not
  supported by the official software.

### Deliberate divergence in qa40x-rs (issue #71, decision 2026-08-01)

qa40x-rs generalizes the feature instead of mirroring Gen1/Gen2:

- the I2S port is a **routing target per source** (each routing cell
  carries an independent I2S L/R dimension beside Line out L/R), so ANY
  mix of sources — not just one or two sines — can drive the port, and a
  source can play to Line out and/or I2S;
- the port's digital full scale is an **adjustable reference level**
  (default 0 dBV — at the default the level mapping is byte-identical to
  the official app's);
- the `/Settings/I2sGen` REST parity endpoints are a recorded follow-up
  (they would drive the default device's engine directly, independent of
  the GUI routing model).

The wire protocol driven is identical either way; only the "what plays on
the port" model is richer here.

qa40x-rs drives the port with a per-device I2S engine (`device::i2s`):

- **48 kHz pinned**: the vendor app always generates I2S at 48 kHz
  regardless of the acquisition rate, so the I2S mix is rendered by its own
  mixer instance at 48 kHz — never resampled from an acquisition-rate
  buffer. A 1 s loop buffer is pre-encoded to wire bytes and sliced into
  2048-frame blocks with wraparound.
- **Own endpoint cell**: EP `0x03` is deliberately NOT part of the claimed
  endpoint set the capture pump locks for a whole acquisition — it lives in
  its own cell, and the writer (two blocks in flight, one completed / one
  refilled per device-paced completion) locks only that cell. This is what
  keeps the acquisition, the keepalive and the I2S stream concurrent, as
  required above (pinned by an integration test against the `vqa40x-core`
  EP3 sink).
- **Levels**: the port is purely digital, so full scale needs a reference —
  a source at the port's *reference level* (dBV, default 0) lands at digital
  full scale, same clamp-and-report-never-rescale contract as the analog
  ranges, and NO factory DAC trims (nothing analog to pre-compensate).
- **Registers only at start/stop**: a re-mix while running swaps the loop
  buffer without touching 0x0A/0x0B, so the downstream receiver's clock
  never glitches. Every connect writes `I2S_CTRL = 0` (the vendor's init),
  which is the engine's port-comes-up-off contract.

## 11. Flash pages and the firmware trace buffer

`PAGE_SELECT` (`0x0D`) arms sequential readout of two kinds of content:

- **Flash pages** — `0x10 + 2*page` for pages 0..=3, read via `0x19`
  (512 bytes each, see §7). Page 0 is the factory calibration page; pages
  1..=3 read as zeros on a real unit.
- **Firmware trace buffer** — `PAGE_SELECT = 1`, then `TRACE_LEN` (`0x15`)
  answers its byte length (`0x418` observed) and `TRACE_READ` (`0x14`) serves
  it 4 bytes per read. A healthy unit's trace reads all zeros. This is what
  the vendor app's "Query Hardware for Firmware State" button walks through.

## 12. Open questions

- **`0x1B` / `0x1C`** — the constant words read as capability/feature values:
  bit meaning unknown, and the QA403's `0x1C` value is not yet confirmed on
  hardware.
- **Calibration** — byte order of the `0x19` payload; the record layout
  inside a page.
- **EP `0x83`** — the I2S IN endpoint: exposed but never seen carrying data;
  purpose unknown.
- **I2S sample layout** — every observed EP `0x03` block is silence, so the
  channel order is unvalidated; the host assumes the acquisition path's
  right-first wire order (`qa40x::i2s::I2S_WIRE_SWAP`, one flippable
  constant). Validation recipe: enable I2S, route a tone to ONE channel,
  scope the port.
- **I2S digital level mapping** — whether the port applies any gain/format
  processing between the EP `0x03` samples and the pins; the host's
  reference-level convention (a source at the reference plays 0 dBFS peak)
  needs a hardware check with a known receiver.
- **I2S clock vs register 0x09** — the vendor app only ever generates I2S
  at 48 kHz, its settings dialog shows the port rate as "48 kSPS
  (locked)", and the user manual states other rates are not currently
  supported — so 48 kHz-only is confirmed as the OFFICIAL behavior; only
  whether the hardware could follow register 0x09 remains unobserved (the
  vqa40x sink pins it at 48 kHz).
- **Range settle times** — the values in §6 are working figures; the exact
  relay settle and the boundary-crossing cost deserve a dedicated measurement.
- **Low output ranges** — whether relay clicking observed at the lower output
  ranges is a settle-discipline artefact or intrinsic hardware behaviour is
  still open; it currently keeps auto-ranging restricted to the middle output
  ranges, costing some DAC resolution at low levels.

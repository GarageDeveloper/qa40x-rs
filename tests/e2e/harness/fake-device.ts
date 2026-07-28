/**
 * The fake QA40x backend the e2e harness runs the frontend against.
 *
 * It implements the `invoke` command surface the app needs to boot, connect,
 * define signal sources, play the mix and render frames — and NOTHING beyond
 * that. It is a stand-in, not a simulator: where it cannot be honest it
 * throws a loud error (unknown commands, script execution, measurement
 * programs other than the THD sweep and wow & flutter — see FakeUnit's
 * thdSweep and wowFlutter for why those exist and what may be asserted
 * against them) instead of quietly inventing behaviour a test could then
 * "verify". See tests/e2e/README.md for the full list of what is and is not
 * simulated.
 *
 * Split (issue #25 lot E4): `FakeDevice` owns the bench-wide surfaces — the
 * command table, the enumeration model, the REST mirror, the export seam,
 * storage — while everything a single open unit owns (connection, config
 * registers, mixer, the v2 stream loop, trigger latches, measurement stats,
 * the program gate) lives on `FakeUnit` (fake-unit.ts).
 *
 * Level model (kept honest, because level bookkeeping is where UI bugs hide):
 * - mixer slots render in the frontend's "level-volts" (sine peak 1.0 ≙
 *   0 dBV RMS), mirroring src-tauri/src/sources.rs: `amplitude` is an RMS
 *   target for every waveform;
 * - the capture maps DAC digital → volts → ADC digital through the two range
 *   registers (see frames.ts), so captured levels move correctly when either
 *   range moves;
 * - the dBFS→dBV offsets mirror the backend's converter models: input
 *   `range − 6` + the factory ADC trim measured on real hardware (frames.ts
 *   inputDbvOffsetDb — at range 18 dBV the total is +20.81 dB, the #51 probe
 *   value), output `range + 3.01` (digital-RMS referenced, like the spectra
 *   in dsp.ts). A played tone therefore reads back at its true dBV on both
 *   Input and Output traces, and a replayed RECORDED fixture displays the
 *   absolute level that was actually driven when it was captured.
 */

import { analyzeAudio, analyzeSpectrum, processFft } from "./dsp";
import { inputDbvOffsetDb, syntheticLoopbackProvider, type FrameProvider } from "./frames";
import {
  FakeUnit,
  type Args,
  type ChannelLike,
  type MixSlotDesc,
  type MixSlotError,
  type StreamConfigWire,
} from "./fake-unit";

/* ---- mirrors of the frontend/backend wire types ---------------------- */

/** Mirrors `DeviceEntry`/`DeviceList` (src-tauri/src/device/wire.rs, issue
 * #25 lot D) — the device bar's enumeration feed. */
interface DeviceEntryWire {
  id: string;
  source_id: string;
  source_kind: "Usb" | "Virtual";
  source_label: string;
  model: string;
  serial: string;
  serial_synthetic: boolean;
  product: string;
  firmware_version: number | null;
  is_virtual: boolean;
  capabilities: {
    model_name: string;
    input_channels: number;
    output_channels: number;
    sample_rates_hz: number[];
    input_ranges_dbv: number[];
    output_ranges_dbv: number[];
    min_output_vrms: number;
    max_output_vrms: number;
    max_input_vrms: number;
    min_measurement_hz: number;
    max_measurement_hz: number;
    calibration: "Unknown" | { FactoryEeprom: { page_bytes: number } };
    supports_flash: boolean;
    is_virtual: boolean;
  };
  open: boolean;
  slot: number | null;
}

interface DeviceListWire {
  devices: DeviceEntryWire[];
  open: string[];
}

/* ---- the device ------------------------------------------------------ */

export class FakeDevice {
  /** Wired by boot.ts to the mock's `plugin:event|emit` path. */
  emitter: (event: string, payload?: unknown) => void = () => {};

  private present = true;
  /** How many physical units the bus offers (lot D picker specs poke it via
   * setUnits; presence off hides them all, like a real unplug). */
  private unitCount = 1;
  /** Every `connect_device` deviceId argument, in call order (null = the
   * arg-less legacy call) — what the picker specs assert against. */
  connectDeviceIds: (string | null)[] = [];
  /* REST server mirror — the fake never runs one, but the App drawer's
   * exposure/token state must round-trip like the real backend's. */
  private restExposed = false;
  private fixedRestToken: string | null = null;

  private restStatus() {
    return {
      running: false,
      host: this.restExposed ? "0.0.0.0" : "127.0.0.1",
      port: 9402,
      exposed: this.restExposed,
      token: this.restExposed ? (this.fixedRestToken ?? "e2e-generated-token") : null,
    };
  }

  /* -- Export seam (issue #30), public for spec assertions -------------- */
  /** Overrides the answered save path; null (default) derives it from the
   * app's own suggested filename, under /e2e/. */
  savePath: string | null = null;
  /** Arm to make the next save dialog answer null (user cancelled). */
  cancelSaveDialog = false;
  /** Every file the app asked `export_write_file` to persist. */
  exports: { path: string; contentsBase64: string }[] = [];
  /** Every clipboard image handed to `export_copy_image` (dimensions +
   * payload size — the pixel values themselves don't matter to specs). */
  copiedImages: { width: number; height: number; byteLength: number }[] = [];
  private storage = new Map<string, unknown[]>(); // key: kind (projects, …)

  /** Slot 0's unit — every per-device surface delegates here. */
  private unit: FakeUnit;

  constructor(provider: FrameProvider = syntheticLoopbackProvider()) {
    this.unit = new FakeUnit(provider);
  }

  /** Swap the capture provider (e.g. for recorded fixtures) mid-session. */
  setProvider(p: FrameProvider): void {
    this.unit.setProvider(p);
  }

  /** Simulate an unplug/replug from a test. */
  setPresent(present: boolean): void {
    this.present = present;
    if (!present && this.unit.connected) {
      this.unit.connected = false;
      this.unit.openId = null;
      this.emitter("device-disconnected");
    }
  }

  /** How many physical units the bus offers (lot D picker specs). */
  setUnits(n: number): void {
    this.unitCount = n;
  }

  /* -- the enumeration model (mirrors DeviceRegistry::list) ------------- */

  private physicalIds(): string[] {
    if (!this.present) return [];
    return Array.from({ length: this.unitCount }, (_, i) => `usb/E2E-FAKE-000${i + 1}`);
  }

  private static readonly VIRTUAL_ID = "virtual/E2E-VIRT-0001";

  private deviceEntry(id: string, open: boolean): DeviceEntryWire {
    const virtual = id.startsWith("virtual/");
    const serial = id.split("/")[1];
    // Real register-map tables (caps.rs pins them): the virtual unit is the
    // QA403 of the demo backend (384 kHz), physical fakes are QA402s.
    const rates = virtual ? [48000, 96000, 192000, 384000] : [48000, 96000, 192000];
    return {
      id,
      source_id: virtual ? "virtual" : "usb",
      source_kind: virtual ? "Virtual" : "Usb",
      source_label: virtual ? "Built-in virtual" : "USB",
      model: virtual ? "QA403" : "QA402",
      serial,
      serial_synthetic: false,
      product: `${virtual ? "QA403" : "QA402"} Audio Analyzer (e2e fake)`,
      firmware_version: open ? 991 : null,
      is_virtual: virtual,
      capabilities: {
        model_name: virtual ? "QA403" : "QA402",
        input_channels: 2,
        output_channels: 2,
        sample_rates_hz: rates,
        input_ranges_dbv: [0, 6, 12, 18, 24, 30, 36, 42],
        output_ranges_dbv: [-12, -2, 8, 18],
        min_output_vrms: 1e-6,
        max_output_vrms: 7.943,
        max_input_vrms: 89.13,
        min_measurement_hz: 5,
        max_measurement_hz: rates[rates.length - 1] / 2,
        calibration: open ? { FactoryEeprom: { page_bytes: 512 } } : "Unknown",
        supports_flash: false,
        is_virtual: virtual,
      },
      open,
      // Registry rule: an open unit carries its runtime slot; the fake is
      // single-open (lot E4 makes this per-unit), so slot 0.
      slot: open ? 0 : null,
    };
  }

  private deviceList(): DeviceListWire {
    const ids = [...this.physicalIds(), FakeDevice.VIRTUAL_ID];
    const open = this.unit.connected && this.unit.openId !== null ? [this.unit.openId] : [];
    // An open unit that stopped enumerating stays listed (registry rule).
    if (open.length && !ids.includes(open[0])) ids.push(open[0]);
    return {
      devices: ids.map((id) => this.deviceEntry(id, open.includes(id))),
      open,
    };
  }

  /** Arm the program gate: the next measurement-program command (e.g. a THD
   * sweep) stays in flight until releasePrograms(). Lets a test assert what
   * the UI looks like WHILE a program owns the device. */
  holdPrograms(): void {
    this.unit.holdPrograms();
  }

  /** Release a held program command (no-op when none is armed). */
  releasePrograms(): void {
    this.unit.releasePrograms();
  }

  /* eslint-disable-next-line complexity -- a command table, one arm each */
  handle(cmd: string, a: Args): unknown {
    const u = this.unit;
    switch (cmd) {
      /* -- presence / connection -- */
      case "is_device_present":
        return this.present && this.unitCount > 0;
      case "is_hardware_present":
        // The bus device, never the virtual one — mirrors the backend.
        return this.present && this.unitCount > 0;
      case "is_device_connected":
        return u.connected;
      case "connect_device": {
        const wanted = (a.deviceId as string | undefined) ?? null;
        this.connectDeviceIds.push(wanted);
        // The two-id rule: connect accepts any ENUMERATED unit's id.
        if (wanted !== null && !this.deviceList().devices.some((d) => d.id === wanted)) {
          throw new Error(`Failed to connect: Not found (fake): ${wanted}`);
        }
        if (wanted !== null && wanted.startsWith("virtual/")) {
          u.connected = true;
          u.config.input_gain = 42;
          u.virtualDevice = true;
          u.openId = wanted;
          return "Connected to the virtual QA40x (e2e fake device)";
        }
        const first = this.physicalIds()[0];
        if (!this.present || first === undefined)
          throw new Error("No QA40x on the bus (fake)");
        u.connected = true;
        u.config.input_gain = 42; // connect forces the safe input range
        u.virtualDevice = false;
        u.openId = wanted ?? first;
        return "Connected to QA402 (e2e fake device)";
      }
      case "connect_virtual_device":
        // Demo mode: attaches regardless of bus presence — the virtual
        // device lives in-process, exactly like the backend's simulator.
        u.connected = true;
        u.config.input_gain = 42;
        u.virtualDevice = true;
        u.openId = FakeDevice.VIRTUAL_ID;
        return "Connected to the virtual QA40x (demo mode, e2e fake)";
      case "list_devices":
        return this.deviceList();
      case "disconnect_device":
        u.connected = false;
        u.virtualDevice = false;
        u.openId = null;
        // Mirror the backend: the stream loop and the gap-free generator are
        // stopped BEFORE the device closes (clean Stopped, never an Error).
        u.stopStream(true);
        u.generatorRunning = false;
        return "Disconnected (e2e fake device)";
      case "get_device_info": {
        // Identity follows the OPEN unit (lot D review #6): a spec pinning
        // "the bar names the unit you picked" must fail against a fake
        // reporting the wrong unit. The virtual unit is the QA403 of the
        // real demo backend.
        const model = u.virtualDevice ? "QA403" : "QA402";
        const rates = u.virtualDevice
          ? [48000, 96000, 192000, 384000]
          : [48000, 96000, 192000];
        return {
          model,
          firmware_version: 991,
          serial: u.openId?.split("/")[1] ?? "E2E-FAKE-0001",
          is_virtual: u.virtualDevice,
          product: `${model} Audio Analyzer (e2e fake)`,
          sample_rates: rates,
          supports_flash: false,
          capabilities: {
            min_output_vrms: 1e-6,
            max_output_vrms: 7.943,
            min_measurement_hz: 5,
            max_measurement_hz: rates[rates.length - 1] / 2,
            sample_rate: rates[rates.length - 1],
          },
        };
      }

      /* -- config registers -- */
      case "get_device_config":
      case "read_device_config":
        return { ...u.config };
      case "set_input_gain":
        u.config.input_gain = a.gainDbv as number;
        return `Input range set to ${a.gainDbv} dBV (fake)`;
      case "set_output_gain":
        u.config.output_gain = a.gainDbv as number;
        return `Output range set to ${a.gainDbv} dBV (fake)`;
      case "set_sample_rate":
        u.config.sample_rate = a.rateHz as number;
        return `Sample rate set to ${a.rateHz} Hz (fake)`;

      /* -- converter dBFS→dBV offsets (see header for the model) -- */
      case "get_input_dbv_offset":
        // Base range formula + the modeled factory ADC trim (see frames.ts
        // ADC_CAL_DB): the same offset the synthetic capture uses, and the
        // one that makes REAL recorded fixtures display their true absolute
        // dBV (a −12 dBV recorded sine reads ≈ −12 dBV, not 8.8 dB low).
        return { offset_db: inputDbvOffsetDb(u.config.input_gain), calibrated: true };
      case "get_output_dbv_offset":
        return {
          offset_db: u.config.output_gain + 20 * Math.log10(Math.SQRT2),
          calibrated: true,
        };

      /* -- telemetry / status -- */
      case "keepalive":
        u.lastTelemetry = {
          usb_voltage_v: 5.02,
          usb_current_ma: 331,
          iso_current_ma: 118,
          temperature_c: 33.4,
        };
        return u.lastTelemetry;
      case "last_telemetry":
        return u.lastTelemetry;
      case "rest_status":
        return this.restStatus();
      case "rest_set_exposed":
        this.restExposed = a.exposed as boolean;
        return this.restStatus();
      case "rest_set_token":
        this.fixedRestToken = (a.token as string | null) || null;
        return this.restStatus();

      /* -- data export (issue #30) -- */
      case "plugin:dialog|save": {
        // The dialog plugin's save() lands here through mockIPC like any
        // command — the fake IS the "user": it answers a path (derived from
        // the app's own suggested name unless a spec pinned one) or null
        // (cancelled) when `cancelSaveDialog` is armed.
        if (this.cancelSaveDialog) return null;
        const opts = (a.options ?? {}) as { defaultPath?: string };
        return this.savePath ?? `/e2e/${opts.defaultPath ?? "export.bin"}`;
      }
      case "export_write_file":
        this.exports.push({
          path: a.path as string,
          contentsBase64: a.contentsBase64 as string,
        });
        return null;
      case "export_copy_image": {
        // The app ships PNG bytes (the backend decodes for the clipboard) —
        // the fake verifies the magic and reads the true dimensions from
        // the IHDR chunk (bytes 16..24), so specs assert a REAL image.
        const png = atob(a.pngBase64 as string);
        if (png.slice(1, 4) !== "PNG") {
          throw new Error("export_copy_image: payload is not a PNG");
        }
        const be32 = (o: number): number =>
          ((png.charCodeAt(o) << 24) |
            (png.charCodeAt(o + 1) << 16) |
            (png.charCodeAt(o + 2) << 8) |
            png.charCodeAt(o + 3)) >>> 0;
        this.copiedImages.push({
          width: be32(16),
          height: be32(20),
          byteLength: png.length,
        });
        return null;
      }

      /* -- the mixer (Traces V2 Phase F wire) -- */
      case "mixer_set_slots": {
        const slots = a.slots as MixSlotDesc[];
        const errors: MixSlotError[] = [];
        u.slots = slots.filter((s) => {
          if (s.source.kind === "script") {
            errors.push({ id: s.id, error: "the e2e fake backend does not execute Rhai scripts" });
            return false;
          }
          return true;
        });
        return errors;
      }
      case "mixer_render":
        return u.renderMix(
          a.sampleRate as number,
          a.bufferSize as number,
          Boolean(a.withSlots)
        );

      /* -- streaming -- */
      case "generate_and_capture": {
        u.assertConnected(cmd);
        const left = a.left as number[];
        const right = a.right as number[];
        const cap = u.provider.capture(left, right, {
          sampleRate: u.config.sample_rate,
          outputRangeDbv: u.config.output_gain,
          inputRangeDbv: u.config.input_gain,
        });
        return {
          left_channel: cap.left,
          right_channel: cap.right,
          sample_rate: u.config.sample_rate,
        };
      }
      case "acquire_data": {
        u.assertConnected(cmd);
        const n = a.numSamples as number;
        const silence = new Array<number>(n).fill(0);
        const cap = u.provider.capture(silence, silence, {
          sampleRate: u.config.sample_rate,
          outputRangeDbv: u.config.output_gain,
          inputRangeDbv: u.config.input_gain,
        });
        return { left_channel: cap.left, right_channel: cap.right, sample_rate: u.config.sample_rate };
      }
      /* -- the v2 backend run loop (rewrite-v2 B-2 wire) -- */
      case "stream_start": {
        u.assertConnected(cmd);
        // Take-over semantics (mirrors StreamControl::start): a running
        // loop is stopped — its channel gets its Stopped — then the new
        // one starts. "Play right after Stop" must always start.
        if (u.streamTimer !== null) u.stopStream(true);
        u.applyStreamConfig(a.config as StreamConfigWire);
        u.streamChannel = a.onFrame as ChannelLike;
        u.streamSeq = 0;
        // A fresh loop = fresh trigger latches (mirrors `TriggerStates`
        // being a LOCAL of `run_stream_loop`, not shared across restarts —
        // only `stream_update` on an already-running loop must NOT reset).
        u.triggerArmedEpoch = {};
        u.triggerFired = {};
        u.measureStats = {};
        // ~8 fps: fast enough for the specs, slow enough to stay honest
        // about per-frame work in a browser context.
        u.streamTimer = setInterval(() => u.streamFrame(), 120);
        return null;
      }
      case "stream_update":
        u.applyStreamConfig(a.config as StreamConfigWire);
        return null;
      case "stream_stop":
        u.stopStream(true);
        return null;
      case "stream_status":
        return u.streamTimer !== null;
      case "stream_reset_averaging":
        // The fake has no averaging accumulator — accepting the command is
        // the contract (the real backend empties its analyzers).
        return null;
      case "stream_reset_measure_stats":
        // Mirrors the real backend's stats_reset consume: every endpoint's
        // sliding windows drop, the next frame starts the new history.
        u.measureStats = {};
        return null;
      case "sweep_stop":
        // The fake's THD sweep is instantaneous — accepting the command is
        // its whole contract. Wow & flutter's held capture, if any, is
        // actually cancelled (see FakeUnit's `wowFlutterCancel`).
        u.cancelWowFlutter();
        return null;

      /* -- output-only mode (rewrite-v2 M2): gap-free DAC, no capture ---- */
      case "output_only_start": {
        u.assertConnected(cmd);
        const slots = a.slots as MixSlotDesc[];
        if (slots.length === 0)
          throw new Error("output-only: no signal source is playing (fake)");
        // One DAC owner at a time — the real backend stops the stream loop
        // (its Stopped message reaches the frontend) and any prior generator.
        u.stopStream(true);
        const errors: MixSlotError[] = [];
        u.slots = slots.filter((s) => {
          if (s.source.kind === "script") {
            errors.push({ id: s.id, error: "the e2e fake backend does not execute Rhai scripts" });
            return false;
          }
          return true;
        });
        // Mirror the backend: render, fit the range to the summed peak (a
        // fresh margined {+8,+18} pick — no hysteresis to carry on a start),
        // scale + report clip, loop the buffer. 0.1 s captures the periodic
        // mix's peak; the real path renders 1 s for seamless repetition.
        const mix = u.renderMix(u.config.sample_rate, 4800, false);
        const sigmaPeakDbv = mix.peak > 0 ? 20 * Math.log10(mix.peak) : null;
        if (sigmaPeakDbv !== null) {
          u.config.output_gain = sigmaPeakDbv + 1 <= 8 ? 8 : 18;
        }
        const clipped = mix.peak * Math.pow(10, -u.config.output_gain / 20) > 1;
        u.generatorRunning = true;
        return {
          sigma_peak_dbv: sigmaPeakDbv,
          clipped,
          fitted_output_range_dbv: u.config.output_gain,
          errors,
        };
      }

      case "start_generator":
        u.assertConnected(cmd);
        u.generatorRunning = true;
        return "Generator started (fake gap-free loop)";
      case "stop_generator":
        u.generatorRunning = false;
        return "Generator stopped";
      case "is_generator_running":
        return u.generatorRunning;
      case "generate_sine": {
        const n = a.numSamples as number;
        const amp = a.amplitude as number;
        const w = (2 * Math.PI * (a.frequency as number)) / (a.sampleRate as number);
        return Array.from({ length: n }, (_, i) => amp * Math.sin(w * i));
      }

      /* -- analysis (pure CPU in the real backend too) -- */
      case "analyze_spectrum":
        // `window` and `accumulate` (averaging) are accepted and ignored:
        // one Hann window, no averaging. Documented in the README.
        return analyzeSpectrum(a.signal as number[], a.sampleRate as number);
      case "process_fft":
        return processFft(a.signal as number[], a.sampleRate as number);
      case "set_spectrum_averaging":
        return null;
      case "analyze_audio":
        return analyzeAudio(
          a.signal as number[],
          a.magnitudes as number[],
          a.frequencies as number[],
          a.fundamentalFreq as number
        );
      case "analyze_audio_averaged": {
        const signal = a.signal as number[];
        const fft = processFft(signal, u.config.sample_rate);
        return analyzeAudio(signal, fft.magnitudes, fft.frequencies, a.fundamentalFreq as number);
      }

      /* -- measurement programs (device-owning; see FakeUnit.thdSweep) -- */
      case "measure_thd_vs_frequency":
        u.assertConnected(cmd);
        return u.thdSweep(a);
      case "measure_thd_vs_level":
        u.assertConnected(cmd);
        return u.thdLevelSweep(a);
      case "measure_wow_flutter":
        u.assertConnected(cmd);
        return u.wowFlutter(a);

      /* -- scripts: honestly refused, not silently faked -- */
      case "script_run":
        setTimeout(() => {
          this.emitter("script-log", {
            line: "[e2e fake] the fake backend does not execute Rhai scripts",
            error: true,
          });
          this.emitter("script-state", {
            running: false,
            error: "scripts are not simulated by the e2e fake backend",
          });
        }, 0);
        return null;
      case "script_stop":
        return null;
      case "transform_frame":
        // Identity: Rhai transform steps pass their frame through unchanged.
        return a.frame;
      case "apply_transform_chain":
        // Identity: the fake does no DSP — the chain returns its input frames
        // unchanged (assert transform PLUMBING against this, never values).
        return { td: a.td ?? undefined, fd: a.fd ?? undefined };
      case "measure_frames": {
        // Mirror measurements::levels::analyze_buffer + spectral::peak_bin.
        const td = a.td as { samples?: number[] } | null;
        const fd = a.fd as { freqs?: number[]; mag_db?: number[] } | null;
        let tdM: { rms: number; peak: number; dc_offset: number } | undefined;
        if (td?.samples) {
          const s = td.samples;
          const n = s.length || 1;
          tdM = {
            rms: Math.sqrt(s.reduce((acc, v) => acc + v * v, 0) / n),
            peak: s.reduce((m, v) => Math.max(m, Math.abs(v)), 0),
            dc_offset: s.reduce((acc, v) => acc + v, 0) / n,
          };
        }
        let fdM: { index: number; freq: number; mag_db: number } | undefined;
        if (fd?.mag_db && fd.mag_db.length > 0) {
          let mi = -1;
          for (let i = 0; i < fd.mag_db.length; i++) {
            if (Number.isFinite(fd.mag_db[i]) && (mi < 0 || fd.mag_db[i] > fd.mag_db[mi])) mi = i;
          }
          if (mi >= 0) fdM = { index: mi, freq: fd.freqs?.[mi] ?? 0, mag_db: fd.mag_db[mi] };
        }
        return { td: tdM, fd: fdM };
      }

      case "summarize_frequency_response": {
        // Mirror measurements::spectral::summarize_response.
        const f = a.frequencies as number[];
        const m = a.magnitudesDb as number[];
        const finite = m.filter((v) => Number.isFinite(v));
        const ripple = finite.length ? Math.max(...finite) - Math.min(...finite) : null;
        let cutoff: number | null = null;
        if (f.length >= 2 && f.length === m.length) {
          let refIdx = 0;
          let best = Infinity;
          for (let i = 0; i < f.length; i++) {
            const dist = Math.abs(Math.log10(f[i] > 0 ? f[i] : 1) - 3);
            if (Number.isFinite(m[i]) && dist < best) { best = dist; refIdx = i; }
          }
          if (Number.isFinite(m[refIdx])) {
            for (let i = refIdx; i < f.length; i++) {
              if (Number.isFinite(m[i]) && m[i] >= m[refIdx] - 3) cutoff = f[i];
              else if (m[i] < m[refIdx] - 3) break;
            }
          }
        }
        return { ripple_db: ripple, minus_3db_hz: cutoff };
      }

      /* -- storage (in-memory, per page load) -- */
      case "storage_list_projects":
        return this.store("projects");
      case "storage_create_project": {
        const p = { id: `p-${Date.now()}`, name: a.name, description: a.description, created: a.now };
        this.store("projects").push(p);
        return p;
      }
      case "storage_list_measurements":
      case "storage_list_test_plans":
      case "storage_list_sessions":
        return [];

      default:
        // A loud, named failure beats a silently-undefined invoke result: if
        // the app grows a new startup command, the harness must learn it.
        throw new Error(`e2e fake device: unimplemented command "${cmd}"`);
    }
  }

  private store(kind: string): unknown[] {
    let s = this.storage.get(kind);
    if (!s) {
      s = [];
      this.storage.set(kind, s);
    }
    return s;
  }
}

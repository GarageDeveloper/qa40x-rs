/**
 * The fake QA40x backend the e2e harness runs the frontend against.
 *
 * It implements the `invoke` command surface the app needs to boot, connect,
 * define signal sources, play the mix and render frames — and NOTHING beyond
 * that. It is a stand-in, not a simulator: where it cannot be honest it
 * throws a loud error (unknown commands, script execution, measurement
 * programs other than the THD sweep — see thdSweep for why that one exists
 * and what may be asserted against it) instead of quietly inventing behaviour
 * a test could then "verify". See tests/e2e/README.md for the full list of
 * what is and is not simulated.
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

/* ---- mirrors of the frontend/backend wire types ---------------------- */

type MixRoute = "left" | "right" | "both" | "off";

interface MixTone {
  enabled: boolean;
  frequency_hz: number;
  amplitude_vrms: number;
  phase_degrees: number;
}

type MixSlotSource =
  | {
      kind: "waveform";
      waveform: "sine" | "square" | "triangle" | "sawtooth";
      frequency_hz: number;
      amplitude: number;
    }
  | { kind: "tones"; tones: MixTone[] }
  | { kind: "multitone"; amplitude: number }
  | { kind: "noise"; amplitude: number }
  | { kind: "chirp"; amplitude: number }
  | { kind: "script"; source: string };

interface MixSlotDesc {
  id: string;
  source: MixSlotSource;
  route: MixRoute;
  enabled: boolean;
}

interface MixSlotError {
  id: string;
  error: string;
}

/* ---- v2 stream wire (mirrors src-tauri/src/stream.rs) ----------------- */

interface StreamConfigWire {
  buffer_size: number;
  slots: MixSlotDesc[];
  window: "hann" | "rect" | "flattop";
  averaging: { coherent: boolean; count: number };
  spectra: { input_l: boolean; input_r: boolean; output_l: boolean; output_r: boolean };
  output_range_dbv: number | null;
}

/** Under mockIPC invoke args are not serialized: the live Tauri `Channel`
 * object arrives intact and the fake pushes with `onmessage` (the mechanism
 * proven by src/ipc/channel-mock.test.ts, the M0 spike). */
interface ChannelLike {
  onmessage: (msg: unknown) => void;
}

type Args = Record<string, unknown>;

/* ---- signal-source rendering (level-volts; sources.rs stand-in) ------ */

/** One slot's contribution. All waveforms hit the RMS target `A` (in volts):
 * level-volts = physical/√2, so a sine peaks at A, a square at A/√2, a
 * triangle/sawtooth at A·√3/√2, noise has lv-RMS A/√2. */
function renderSlot(src: MixSlotSource, sampleRate: number, n: number): number[] {
  const out = new Array<number>(n).fill(0);
  const w = (hz: number): number => (2 * Math.PI * hz) / sampleRate;
  switch (src.kind) {
    case "waveform": {
      const a = src.amplitude;
      const ph = w(src.frequency_hz);
      for (let i = 0; i < n; i++) {
        const s = Math.sin(ph * i);
        if (src.waveform === "sine") out[i] = a * s;
        else if (src.waveform === "square") out[i] = (a / Math.SQRT2) * Math.sign(s || 1);
        else {
          const t = ((src.frequency_hz * i) / sampleRate) % 1;
          const shape = src.waveform === "triangle" ? 1 - 4 * Math.abs(t - 0.5) : 2 * t - 1;
          out[i] = ((a * Math.sqrt(3)) / Math.SQRT2) * shape;
        }
      }
      return out;
    }
    case "tones": {
      for (const tone of src.tones) {
        if (!tone.enabled) continue;
        const ph = w(tone.frequency_hz);
        const phi = (tone.phase_degrees * Math.PI) / 180;
        for (let i = 0; i < n; i++) out[i] += tone.amplitude_vrms * Math.sin(ph * i + phi);
      }
      return out;
    }
    case "multitone": {
      // Invented stand-in: 8 log-spaced tones, Schroeder-ish phases, total
      // RMS = amplitude. The real backend's multitone differs; replaced by
      // recorded fixtures in the suite task.
      const tones = 8;
      const a = src.amplitude / Math.sqrt(tones);
      for (let k = 0; k < tones; k++) {
        const hz = 100 * Math.pow(100, k / (tones - 1)); // 100 Hz … 10 kHz
        const ph = w(hz);
        const phi = (Math.PI * k * (k + 1)) / tones;
        for (let i = 0; i < n; i++) out[i] += a * Math.sin(ph * i + phi);
      }
      return out;
    }
    case "noise": {
      const peak = (src.amplitude / Math.SQRT2) * Math.sqrt(3); // uniform, RMS = A/√2 lv
      for (let i = 0; i < n; i++) out[i] = (Math.random() * 2 - 1) * peak;
      return out;
    }
    case "chirp": {
      // Log sweep across the frame, 20 Hz → 20 kHz, sine-referenced level.
      const f0 = 20;
      const f1 = Math.min(20000, sampleRate / 2.5);
      const k = Math.log(f1 / f0);
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const phase = ((2 * Math.PI * f0 * (n / sampleRate)) / k) * (Math.exp(k * t) - 1);
        out[i] = src.amplitude * Math.sin(phase);
      }
      return out;
    }
    case "script":
      // Guarded in mixer_set_slots; render silence if one slips through.
      return out;
  }
}

/** The mixer.rs output-range policy: smallest of {+8, +18} dBV containing
 * peak + 1 dB margin; down-moves wait for 1 dB of clearance (hysteresis). */
function fitOutputRange(peakDbv: number, current: number): number {
  const pick = (dbv: number): number => (dbv + 1 <= 8 ? 8 : 18);
  const target = pick(peakDbv);
  if (target >= current) return target;
  return pick(peakDbv + 1) < current ? target : current;
}

/* ---- the device ------------------------------------------------------ */

export class FakeDevice {
  /** Wired by boot.ts to the mock's `plugin:event|emit` path. */
  emitter: (event: string, payload?: unknown) => void = () => {};

  private connected = false;
  private present = true;
  private generatorRunning = false;
  // Mirrors the real backend: `last_telemetry` does NO USB I/O and returns
  // null until a keepalive has run. A fake that always returned data here
  // hid a v2 bug (no keepalive → forever-empty telemetry on hardware).
  private lastTelemetry: Record<string, number> | null = null;
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
  private config = { input_gain: 42, output_gain: 8, sample_rate: 48000 };
  private slots: MixSlotDesc[] = [];
  private storage = new Map<string, unknown[]>(); // key: kind (projects, …)
  /** While armed (holdPrograms), measurement-program commands do not resolve
   * until releasePrograms() — so a test can OBSERVE the app in its
   * program-is-running state instead of racing a timer. */
  private programGate: Promise<void> | null = null;
  private programGateRelease: (() => void) | null = null;
  /* v2 stream loop (stream_start/update/stop) */
  private streamTimer: ReturnType<typeof setInterval> | null = null;
  private streamConfig: StreamConfigWire | null = null;
  private streamChannel: ChannelLike | null = null;
  private streamSeq = 0;
  /** Named per-slot errors of the current stream config (script refusals) —
   * carried on every frame, like the real backend's set_slots errors. */
  private streamSlotErrors: MixSlotError[] = [];

  constructor(private provider: FrameProvider = syntheticLoopbackProvider()) {}

  /** Swap the capture provider (e.g. for recorded fixtures) mid-session. */
  setProvider(p: FrameProvider): void {
    this.provider = p;
  }

  /** Simulate an unplug/replug from a test. */
  setPresent(present: boolean): void {
    this.present = present;
    if (!present && this.connected) {
      this.connected = false;
      this.emitter("device-disconnected");
    }
  }

  /** Arm the program gate: the next measurement-program command (e.g. a THD
   * sweep) stays in flight until releasePrograms(). Lets a test assert what
   * the UI looks like WHILE a program owns the device. */
  holdPrograms(): void {
    if (this.programGate) return;
    this.programGate = new Promise((resolve) => {
      this.programGateRelease = resolve;
    });
  }

  /** Release a held program command (no-op when none is armed). */
  releasePrograms(): void {
    this.programGateRelease?.();
    this.programGate = null;
    this.programGateRelease = null;
  }

  /* eslint-disable-next-line complexity -- a command table, one arm each */
  handle(cmd: string, a: Args): unknown {
    switch (cmd) {
      /* -- presence / connection -- */
      case "is_device_present":
        return this.present;
      case "is_device_connected":
        return this.connected;
      case "connect_device":
        if (!this.present) throw new Error("No QA40x on the bus (fake)");
        this.connected = true;
        this.config.input_gain = 42; // connect forces the safe input range
        return "Connected to QA402 (e2e fake device)";
      case "disconnect_device":
        this.connected = false;
        // Mirror the backend: the stream loop and the gap-free generator are
        // stopped BEFORE the device closes (clean Stopped, never an Error).
        this.stopStream(true);
        this.generatorRunning = false;
        return "Disconnected (e2e fake device)";
      case "get_device_info":
        return {
          model: "QA402",
          firmware_version: 991,
          serial: "E2E-FAKE-0001",
          product: "QA402 Audio Analyzer (e2e fake)",
          sample_rates: [48000, 96000, 192000],
          supports_flash: false,
          capabilities: {
            min_output_vrms: 1e-6,
            max_output_vrms: 7.943,
            min_measurement_hz: 5,
            max_measurement_hz: 96000,
            sample_rate: 192000,
          },
        };

      /* -- config registers -- */
      case "get_device_config":
      case "read_device_config":
        return { ...this.config };
      case "set_input_gain":
        this.config.input_gain = a.gainDbv as number;
        return `Input range set to ${a.gainDbv} dBV (fake)`;
      case "set_output_gain":
        this.config.output_gain = a.gainDbv as number;
        return `Output range set to ${a.gainDbv} dBV (fake)`;
      case "set_sample_rate":
        this.config.sample_rate = a.rateHz as number;
        return `Sample rate set to ${a.rateHz} Hz (fake)`;

      /* -- converter dBFS→dBV offsets (see header for the model) -- */
      case "get_input_dbv_offset":
        // Base range formula + the modeled factory ADC trim (see frames.ts
        // ADC_CAL_DB): the same offset the synthetic capture uses, and the
        // one that makes REAL recorded fixtures display their true absolute
        // dBV (a −12 dBV recorded sine reads ≈ −12 dBV, not 8.8 dB low).
        return { offset_db: inputDbvOffsetDb(this.config.input_gain), calibrated: true };
      case "get_output_dbv_offset":
        return {
          offset_db: this.config.output_gain + 20 * Math.log10(Math.SQRT2),
          calibrated: true,
        };

      /* -- telemetry / status -- */
      case "keepalive":
        this.lastTelemetry = {
          usb_voltage_v: 5.02,
          usb_current_ma: 331,
          iso_current_ma: 118,
          temperature_c: 33.4,
        };
        return this.lastTelemetry;
      case "last_telemetry":
        return this.lastTelemetry;
      case "rest_status":
        return this.restStatus();
      case "rest_set_exposed":
        this.restExposed = a.exposed as boolean;
        return this.restStatus();
      case "rest_set_token":
        this.fixedRestToken = (a.token as string | null) || null;
        return this.restStatus();

      /* -- the mixer (Traces V2 Phase F wire) -- */
      case "mixer_set_slots": {
        const slots = a.slots as MixSlotDesc[];
        const errors: MixSlotError[] = [];
        this.slots = slots.filter((s) => {
          if (s.source.kind === "script") {
            errors.push({ id: s.id, error: "the e2e fake backend does not execute Rhai scripts" });
            return false;
          }
          return true;
        });
        return errors;
      }
      case "mixer_render":
        return this.renderMix(
          a.sampleRate as number,
          a.bufferSize as number,
          Boolean(a.withSlots)
        );

      /* -- streaming -- */
      case "generate_and_capture": {
        this.assertConnected(cmd);
        const left = a.left as number[];
        const right = a.right as number[];
        const cap = this.provider.capture(left, right, {
          sampleRate: this.config.sample_rate,
          outputRangeDbv: this.config.output_gain,
          inputRangeDbv: this.config.input_gain,
        });
        return {
          left_channel: cap.left,
          right_channel: cap.right,
          sample_rate: this.config.sample_rate,
        };
      }
      case "acquire_data": {
        this.assertConnected(cmd);
        const n = a.numSamples as number;
        const silence = new Array<number>(n).fill(0);
        const cap = this.provider.capture(silence, silence, {
          sampleRate: this.config.sample_rate,
          outputRangeDbv: this.config.output_gain,
          inputRangeDbv: this.config.input_gain,
        });
        return { left_channel: cap.left, right_channel: cap.right, sample_rate: this.config.sample_rate };
      }
      /* -- the v2 backend run loop (rewrite-v2 B-2 wire) -- */
      case "stream_start": {
        this.assertConnected(cmd);
        // Take-over semantics (mirrors StreamControl::start): a running
        // loop is stopped — its channel gets its Stopped — then the new
        // one starts. "Play right after Stop" must always start.
        if (this.streamTimer !== null) this.stopStream(true);
        this.applyStreamConfig(a.config as StreamConfigWire);
        this.streamChannel = a.onFrame as ChannelLike;
        this.streamSeq = 0;
        // ~8 fps: fast enough for the specs, slow enough to stay honest
        // about per-frame work in a browser context.
        this.streamTimer = setInterval(() => this.streamFrame(), 120);
        return null;
      }
      case "stream_update":
        this.applyStreamConfig(a.config as StreamConfigWire);
        return null;
      case "stream_stop":
        this.stopStream(true);
        return null;
      case "stream_status":
        return this.streamTimer !== null;
      case "stream_reset_averaging":
        // The fake has no averaging accumulator — accepting the command is
        // the contract (the real backend empties its analyzers).
        return null;
      case "sweep_stop":
        // The fake's sweeps are instantaneous — accepting the command is the
        // contract (the real backend aborts its batched capture).
        return null;

      /* -- output-only mode (rewrite-v2 M2): gap-free DAC, no capture ---- */
      case "output_only_start": {
        this.assertConnected(cmd);
        const slots = a.slots as MixSlotDesc[];
        if (slots.length === 0)
          throw new Error("output-only: no signal source is playing (fake)");
        // One DAC owner at a time — the real backend stops the stream loop
        // (its Stopped message reaches the frontend) and any prior generator.
        this.stopStream(true);
        const errors: MixSlotError[] = [];
        this.slots = slots.filter((s) => {
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
        const mix = this.renderMix(this.config.sample_rate, 4800, false);
        const sigmaPeakDbv = mix.peak > 0 ? 20 * Math.log10(mix.peak) : null;
        if (sigmaPeakDbv !== null) {
          this.config.output_gain = sigmaPeakDbv + 1 <= 8 ? 8 : 18;
        }
        const clipped = mix.peak * Math.pow(10, -this.config.output_gain / 20) > 1;
        this.generatorRunning = true;
        return {
          sigma_peak_dbv: sigmaPeakDbv,
          clipped,
          fitted_output_range_dbv: this.config.output_gain,
          errors,
        };
      }

      case "start_generator":
        this.assertConnected(cmd);
        this.generatorRunning = true;
        return "Generator started (fake gap-free loop)";
      case "stop_generator":
        this.generatorRunning = false;
        return "Generator stopped";
      case "is_generator_running":
        return this.generatorRunning;
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
        const fft = processFft(signal, this.config.sample_rate);
        return analyzeAudio(signal, fft.magnitudes, fft.frequencies, a.fundamentalFreq as number);
      }

      /* -- measurement programs (device-owning; see thdSweep) -- */
      case "measure_thd_vs_frequency":
        this.assertConnected(cmd);
        return this.thdSweep(a);

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

  private assertConnected(cmd: string): void {
    if (!this.connected) throw new Error(`Device not connected (fake, cmd=${cmd})`);
  }

  /**
   * A THD-vs-frequency sweep — the one measurement PROGRAM the fake serves,
   * because the device-lock invariants (a running program suspends the mixer,
   * names itself on the greyed transports, resumes the mix afterwards) need a
   * program that actually runs. The RESULT is a stub: log-spaced points at the
   * fake loopback's ideal floor — tests must assert the lock semantics around
   * this call, never these numbers. While `holdPrograms()` is armed the
   * promise stays pending so a test can look at the locked UI.
   */
  private async thdSweep(a: Args): Promise<unknown> {
    if (this.programGate) await this.programGate;
    const n = Math.max(2, a.numPoints as number);
    const start = a.startFreq as number;
    const end = a.endFreq as number;
    const level = a.amplitudeDbfs as number;
    const points = Array.from({ length: n }, (_, i) => {
      const frequency = start * Math.pow(end / start, i / (n - 1));
      return {
        frequency,
        level_dbfs: level,
        thd_percent: 1e-4,
        thd_db: -120,
        thd_n_percent: 3e-4,
        thd_n_db: -110,
        fundamental_dbfs: level,
      };
    });
    return { swept: "frequency", points };
  }

  private store(kind: string): unknown[] {
    let s = this.storage.get(kind);
    if (!s) {
      s = [];
      this.storage.set(kind, s);
    }
    return s;
  }

  /** Adopt a stream config: slot set (same script filter as
   * mixer_set_slots — refused scripts become NAMED per-slot errors, the
   * plumbing the real backend uses for a failed compile) + everything the
   * per-frame tick reads. */
  private applyStreamConfig(cfg: StreamConfigWire): void {
    this.streamConfig = cfg;
    this.streamSlotErrors = [];
    this.slots = cfg.slots.filter((s) => {
      if (s.source.kind === "script") {
        this.streamSlotErrors.push({
          id: s.id,
          error: "the e2e fake backend does not execute Rhai scripts",
        });
        return false;
      }
      return true;
    });
  }

  private stopStream(sendStopped: boolean): void {
    if (this.streamTimer !== null) {
      clearInterval(this.streamTimer);
      this.streamTimer = null;
    }
    if (sendStopped) this.streamChannel?.onmessage({ type: "stopped" });
    this.streamChannel = null;
  }

  /**
   * One v2 stream frame, mirroring the backend loop's order: render the mix
   * (level-volts) → fit the output range to the summed peak ({+8,+18} with
   * +1 dB margin, 1 dB down-hysteresis — the mixer.rs policy) → scale to
   * DAC full scale (clamp + report, never rescale) → capture through the
   * PROVIDER seam (synthetic or recorded fixtures — unchanged) → windowed
   * FFTs for the requested channels → push the frame with the
   * per-converter offsets of THIS frame's register state.
   *
   * Simplifications, documented: one Hann window whatever `window` says, no
   * averaging (same stance as analyze_spectrum above), and clip flags are
   * per-frame booleans instead of a 100 ms latch (at ~8 fps every frame
   * outlives the hold). Assert LEVEL/STRUCTURE invariants against this,
   * never smoothing behaviour.
   */
  private streamFrame(): void {
    const cfg = this.streamConfig;
    const ch = this.streamChannel;
    if (!cfg || !ch) return;
    if (!this.connected) {
      ch.onmessage({ type: "error", message: "Device not connected (fake)" });
      this.stopStream(true);
      return;
    }
    const n = cfg.buffer_size;
    const sr = this.config.sample_rate;
    const tone = cfg.slots.length > 0;

    // ---- mix + range fit + scale (tone mode only; monitor leaves reg 6) --
    let left = new Array<number>(n).fill(0);
    let right = new Array<number>(n).fill(0);
    let sigmaPeakDbv: number | null = null;
    let clipOutput = false;
    if (tone) {
      const mix = this.renderMix(sr, n, false);
      left = mix.left;
      right = mix.right;
      if (mix.peak > 0) sigmaPeakDbv = 20 * Math.log10(mix.peak);
      if (cfg.output_range_dbv !== null) {
        this.config.output_gain = cfg.output_range_dbv;
      } else if (sigmaPeakDbv !== null) {
        this.config.output_gain = fitOutputRange(sigmaPeakDbv, this.config.output_gain);
      }
      const scale = Math.pow(10, -this.config.output_gain / 20);
      for (const chan of [left, right]) {
        for (let i = 0; i < n; i++) {
          const v = chan[i] * scale;
          chan[i] = Math.max(-1, Math.min(1, v));
          if (v > 1 || v < -1) clipOutput = true;
        }
      }
    }

    // ---- capture through the provider seam (fixtures replay here) -------
    const cap = this.provider.capture(left, right, {
      sampleRate: sr,
      outputRangeDbv: this.config.output_gain,
      inputRangeDbv: this.config.input_gain,
    });
    let inputPeak = 0;
    for (const chan of [cap.left, cap.right]) {
      for (const v of chan) inputPeak = Math.max(inputPeak, Math.abs(v));
    }
    // Mirror the backend's tri-state judgment (clip ≥ −0.1 dBFS, near ≥ −1).
    const clipInput =
      inputPeak >= Math.pow(10, -0.1 / 20)
        ? "clip"
        : inputPeak >= Math.pow(10, -1 / 20)
          ? "near"
          : "none";

    // ---- requested spectra (shared bins) ---------------------------------
    let frequencies: number[] = [];
    const fdOf = (signal: number[]): number[] => {
      const spec = analyzeSpectrum(signal, sr);
      if (frequencies.length === 0) frequencies = spec.frequencies;
      return spec.magnitudes_db;
    };
    const spectra = {
      frequencies: [] as number[],
      input_l: cfg.spectra.input_l ? fdOf(cap.left) : null,
      input_r: cfg.spectra.input_r ? fdOf(cap.right) : null,
      output_l: tone && cfg.spectra.output_l ? fdOf(left) : null,
      output_r: tone && cfg.spectra.output_r ? fdOf(right) : null,
    };
    spectra.frequencies = frequencies;

    // Harmonic metrics per requested input channel — mirrors the backend
    // stream: linear magnitudes from the dB spectrum, fundamental = loudest
    // bin ≥ 20 Hz, `None` when the spectrum wasn't requested.
    const metricsOf = (signal: number[], magsDb: number[] | null) => {
      if (!magsDb || magsDb.length === 0) return null;
      const linear = magsDb.map((db) => Math.pow(10, db / 20));
      let fi = -1;
      for (let i = 0; i < linear.length; i++) {
        if (frequencies[i] >= 20 && (fi < 0 || linear[i] > linear[fi])) fi = i;
      }
      if (fi < 0) return null;
      return analyzeAudio(signal, linear, frequencies, frequencies[fi]);
    };
    // Harmonic series located on the emitted spectrum — mirrors the backend's
    // harmonics_from_spectrum (±3% / ±3-bin peak window around n×f0, 10 max).
    const harmonicsOf = (magsDb: number[] | null) => {
      if (!magsDb || magsDb.length < 2 || frequencies.length < 2) return null;
      const linear = magsDb.map((db) => Math.pow(10, db / 20));
      const binHz = frequencies[1] - frequencies[0];
      if (!(binHz > 0)) return null;
      const peakIn = (center: number): [number, number] => {
        const half = Math.max(center * 0.03, binHz * 3);
        const lo = Math.max(1, Math.floor((center - half) / binHz));
        const hi = Math.min(linear.length - 1, Math.ceil((center + half) / binHz));
        let bi = lo;
        for (let i = lo; i <= hi; i++) if (linear[i] > linear[bi]) bi = i;
        return [frequencies[bi], linear[bi]];
      };
      let fi = -1;
      for (let i = 0; i < linear.length; i++) {
        if (frequencies[i] >= 20 && (fi < 0 || linear[i] > linear[fi])) fi = i;
      }
      if (fi < 0) return null;
      const [f0, m0raw] = peakIn(frequencies[fi]);
      const m0 = Math.max(m0raw, 1e-12);
      const fEnd = frequencies[frequencies.length - 1];
      const marks = [];
      for (let n = 1; n <= 10; n++) {
        const target = f0 * n;
        if (target >= fEnd) break;
        const [freq, mag] = peakIn(target);
        marks.push({
          n,
          frequency: freq,
          magnitude_db: 20 * Math.log10(Math.max(mag, 1e-12)),
          magnitude_dbc: 20 * Math.log10(Math.max(mag, 1e-12) / m0),
        });
      }
      return marks;
    };
    const metrics = {
      input_l: metricsOf(cap.left, spectra.input_l),
      input_r: metricsOf(cap.right, spectra.input_r),
      harmonics_l: harmonicsOf(spectra.input_l),
      harmonics_r: harmonicsOf(spectra.input_r),
    };

    this.streamSeq += 1;
    ch.onmessage({
      type: "frame",
      seq: this.streamSeq,
      captured: { left_channel: cap.left, right_channel: cap.right, sample_rate: sr },
      stimulus: tone ? { left, right } : null,
      spectra,
      metrics,
      mix: {
        sigma_peak_dbv: sigmaPeakDbv,
        clip_input: clipInput,
        clip_output: clipOutput,
        fitted_output_range_dbv: this.config.output_gain,
      },
      offsets: {
        input_l: inputDbvOffsetDb(this.config.input_gain),
        input_r: inputDbvOffsetDb(this.config.input_gain),
        output_l: this.config.output_gain + 20 * Math.log10(Math.SQRT2),
        output_r: this.config.output_gain + 20 * Math.log10(Math.SQRT2),
        calibrated: true,
      },
      stats: { frames: this.streamSeq, fps: 8, frame_ms: 120 },
      errors: this.streamSlotErrors,
    });
  }

  /** Sum every enabled slot per its route; peak of the sum in level-volts. */
  private renderMix(
    sampleRate: number,
    bufferSize: number,
    withSlots: boolean
  ): {
    left: number[];
    right: number[];
    peak: number;
    errors: MixSlotError[];
    slots?: { id: string; left: number[]; right: number[] }[];
  } {
    const left = new Array<number>(bufferSize).fill(0);
    const right = new Array<number>(bufferSize).fill(0);
    const perSlot: { id: string; left: number[]; right: number[] }[] = [];
    for (const slot of this.slots) {
      if (!slot.enabled || slot.route === "off") {
        if (withSlots)
          perSlot.push({
            id: slot.id,
            left: new Array<number>(bufferSize).fill(0),
            right: new Array<number>(bufferSize).fill(0),
          });
        continue;
      }
      const buf = renderSlot(slot.source, sampleRate, bufferSize);
      const toL = slot.route === "left" || slot.route === "both";
      const toR = slot.route === "right" || slot.route === "both";
      for (let i = 0; i < bufferSize; i++) {
        if (toL) left[i] += buf[i];
        if (toR) right[i] += buf[i];
      }
      if (withSlots)
        perSlot.push({
          id: slot.id,
          left: toL ? buf : new Array<number>(bufferSize).fill(0),
          right: toR ? buf.slice() : new Array<number>(bufferSize).fill(0),
        });
    }
    let peak = 0;
    for (let i = 0; i < bufferSize; i++) {
      const m = Math.max(Math.abs(left[i]), Math.abs(right[i]));
      if (m > peak) peak = m;
    }
    const out: ReturnType<FakeDevice["renderMix"]> = { left, right, peak, errors: [] };
    if (withSlots) out.slots = perSlot;
    return out;
  }
}

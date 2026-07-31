/**
 * One fake QA40x UNIT — the per-device half of the e2e fake backend.
 *
 * `FakeDevice` (fake-device.ts) keeps the bench-wide surfaces: the command
 * table, the enumeration model, the REST mirror, the export seam and
 * storage. Everything a single open unit owns — its connection, config
 * registers, mixer slot set, v2 stream loop, trigger latches, measurement
 * stats and program gate — lives here, so lot E4's multi-device specs can
 * run several units side by side while every single-device path stays
 * byte-identical.
 *
 * The level model and the honesty rules are documented in fake-device.ts's
 * header; the rendering/trigger/measure code here is that same code, moved
 * verbatim.
 */

import {
  analyzeAudio,
  analyzeSpectrum,
  autoHysteresis,
  findEdge,
  measureScope,
  SlidingStats,
} from "./dsp";
import { inputDbvOffsetDb, type FrameProvider } from "./frames";

/* ---- mirrors of the frontend/backend wire types ---------------------- */

export type MixRoute = "left" | "right" | "both" | "off";

export interface MixTone {
  enabled: boolean;
  frequency_hz: number;
  amplitude_vrms: number;
  phase_degrees: number;
}

export type MixSlotSource =
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

export interface MixSlotDesc {
  id: string;
  source: MixSlotSource;
  route: MixRoute;
  enabled: boolean;
}

export interface MixSlotError {
  id: string;
  error: string;
}

/* ---- v2 stream wire (mirrors src-tauri/src/stream.rs) ----------------- */

/** Mirrors `TriggerConfig` (stream.rs) — level/hysteresis in level-volts of
 * the endpoint's own converter, converted per-frame to FS just like the
 * real backend's `evaluate_trigger`. */
export interface TriggerConfigWire {
  mode: "auto" | "normal" | "single";
  edge: "rising" | "falling";
  level_v: number;
  hysteresis_v: number | null;
  pre_samples: number;
  arm_epoch: number;
}

/** Mirrors `TriggerRequest` — the `SpectraRequest` pattern, one optional
 * config per hw endpoint. */
export interface TriggerRequestWire {
  input_l: TriggerConfigWire | null;
  input_r: TriggerConfigWire | null;
  output_l: TriggerConfigWire | null;
  output_r: TriggerConfigWire | null;
}

/** Mirrors `MeasureRequest` (stream.rs, lot B) — which endpoints get the
 * scope measurement suite. Optional on the wire like the backend's
 * `#[serde(default)]`: an older config without it means all-off. */
export interface MeasureRequestWire {
  input_l: boolean;
  input_r: boolean;
  output_l: boolean;
  output_r: boolean;
}

export interface StreamConfigWire {
  buffer_size: number;
  slots: MixSlotDesc[];
  window: "hann" | "rect" | "flattop";
  averaging: { coherent: boolean; count: number };
  spectra: { input_l: boolean; input_r: boolean; output_l: boolean; output_r: boolean };
  output_range_dbv: number | null;
  triggers: TriggerRequestWire;
  measures?: MeasureRequestWire;
}

/** Under mockIPC invoke args are not serialized: the live Tauri `Channel`
 * object arrives intact and the fake pushes with `onmessage` (the mechanism
 * proven by src/ipc/channel-mock.test.ts, the M0 spike). */
export interface ChannelLike {
  onmessage: (msg: unknown) => void;
}

export type Args = Record<string, unknown>;

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

/* ---- one unit -------------------------------------------------------- */

export class FakeUnit {
  connected = false;
  /** True when the session was opened via connect_virtual_device (demo mode). */
  virtualDevice = false;
  /** The unit currently open, as a `"<source>/<unit-key>"` id. */
  openId: string | null = null;
  generatorRunning = false;
  // Mirrors the real backend: `last_telemetry` does NO USB I/O and returns
  // null until a keepalive has run. A fake that always returned data here
  // hid a v2 bug (no keepalive → forever-empty telemetry on hardware).
  lastTelemetry: Record<string, number> | null = null;
  config = { input_gain: 42, output_gain: 8, sample_rate: 48000 };
  slots: MixSlotDesc[] = [];
  /** While armed (holdPrograms), measurement-program commands do not resolve
   * until releasePrograms() — so a test can OBSERVE the app in its
   * program-is-running state instead of racing a timer. */
  private programGate: Promise<void> | null = null;
  private programGateRelease: (() => void) | null = null;
  /** Armed while a `wowFlutter()` call is in flight: `sweep_stop` rejects it
   * with "cancelled" — the fake's model of the real backend's cancellable
   * capture (issue #28 review point 7). Unlike the THD sweep (an
   * intentional instantaneous stub, see `thdSweep`), wow & flutter's Stop
   * button is meant to actually abort a held capture, so its fake honors
   * that instead of only being a lock-observation gate. */
  private wowFlutterCancel: (() => void) | null = null;
  /* v2 stream loop (stream_start/update/stop) */
  streamTimer: ReturnType<typeof setInterval> | null = null;
  streamConfig: StreamConfigWire | null = null;
  streamChannel: ChannelLike | null = null;
  streamSeq = 0;
  /** Named per-slot errors of the current stream config (script refusals) —
   * carried on every frame, like the real backend's set_slots errors. */
  streamSlotErrors: MixSlotError[] = [];
  /** Per-endpoint SINGLE latch — mirrors stream.rs's `TriggerStates` /
   * `EndpointTrigger`: one armed-epoch + fired flag PER ENDPOINT ("input_l"
   * etc.), never a single shared latch (multi-endpoint discipline, issue
   * #25's e2e twin). */
  triggerArmedEpoch: Record<string, number> = {};
  triggerFired: Record<string, boolean> = {};
  /** Per-endpoint, per-measure sliding stats (lot B) — mirrors stream.rs's
   * `MeasureStates`: one bank PER ENDPOINT, dropped when the endpoint
   * leaves the request (a re-enable restarts the history). */
  measureStats: Record<string, Record<string, SlidingStats>> = {};

  constructor(public provider: FrameProvider) {}

  /** Swap the capture provider (e.g. for recorded fixtures) mid-session. */
  setProvider(p: FrameProvider): void {
    this.provider = p;
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

  /** Cancel a held wow & flutter capture (the `sweep_stop` arm). */
  cancelWowFlutter(): void {
    this.wowFlutterCancel?.();
  }

  assertConnected(cmd: string): void {
    if (!this.connected) throw new Error(`Device not connected (fake, cmd=${cmd})`);
  }

  /* -- front-panel I2S port (issue #71) -------------------------------- */

  /** Mirrors the backend `I2sEngine`'s observable contract: idempotent
   * apply (enable / rebuild / disable), the port streams silence while
   * enabled with nothing routed, script slots become NAMED per-slot
   * refusals, a re-apply while running never resets the block counter. */
  i2s = {
    enabled: false,
    running: false,
    widthBits: 32,
    referenceDbv: 0,
    sigmaPeakDbv: null as number | null,
    clipped: false,
    errors: [] as MixSlotError[],
    blocks: 0,
    lastError: null as string | null,
  };
  private i2sTimer: ReturnType<typeof setInterval> | null = null;

  i2sApply(a: Args): unknown {
    const enabled = a.enabled as boolean;
    if (!enabled) {
      this.stopI2s();
      this.i2s.enabled = false;
      this.i2s.sigmaPeakDbv = null;
      this.i2s.clipped = false;
      this.i2s.errors = [];
      return this.i2sStatusWire();
    }
    this.assertConnected("i2s_apply");
    const slots = (a.slots as MixSlotDesc[] | undefined) ?? [];
    const errors: MixSlotError[] = [];
    const kept = slots.filter((s) => {
      if (s.source.kind === "script") {
        errors.push({ id: s.id, error: "the e2e fake backend does not execute Rhai scripts" });
        return false;
      }
      return true;
    });
    // Σ peak from a 48 kHz render of the I2S slot set (0.1 s catches a
    // periodic mix's crest — the output_only_start fake's recipe), scaled
    // against the reference for the clip verdict.
    const mix = this.renderMix(48000, 4800, false, kept);
    const referenceDbv = a.referenceDbv as number;
    const sigma = mix.peak > 0 ? 20 * Math.log10(mix.peak) : null;
    this.i2s.enabled = true;
    this.i2s.widthBits = (a.widthBits as number | undefined) ?? 32;
    this.i2s.referenceDbv = referenceDbv;
    this.i2s.sigmaPeakDbv = sigma;
    this.i2s.clipped = mix.peak * Math.pow(10, -referenceDbv / 20) > 1;
    this.i2s.errors = errors;
    this.i2s.lastError = null;
    if (!this.i2s.running) {
      this.i2s.running = true;
      this.i2s.blocks = 0;
      // Device-paced blocks: 2048 frames every ~42.7 ms at 48 kHz.
      this.i2sTimer = setInterval(() => {
        this.i2s.blocks += 1;
      }, 43);
    }
    return this.i2sStatusWire();
  }

  i2sStatusWire(): unknown {
    return {
      supported: true,
      enabled: this.i2s.enabled,
      running: this.i2s.running,
      width_bits: this.i2s.widthBits,
      reference_dbv: this.i2s.referenceDbv,
      sigma_peak_dbv: this.i2s.sigmaPeakDbv,
      clipped: this.i2s.clipped,
      errors: this.i2s.errors,
      blocks_written: this.i2s.blocks,
      last_error: this.i2s.lastError,
    };
  }

  /** Stop the paced writer (disable / disconnect — the real engine's
   * teardown paths). */
  stopI2s(): void {
    if (this.i2sTimer !== null) {
      clearInterval(this.i2sTimer);
      this.i2sTimer = null;
    }
    this.i2s.running = false;
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
  async thdSweep(a: Args): Promise<unknown> {
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

  /**
   * A THD-vs-level sweep (issue #27): the sibling program, swept axis
   * flipped — linear dBFS steps at a fixed tone. Same stub-numbers-only
   * discipline as thdSweep: tests assert the lock/plumbing, never these
   * values.
   */
  async thdLevelSweep(a: Args): Promise<unknown> {
    if (this.programGate) await this.programGate;
    const n = Math.max(2, a.numPoints as number);
    const start = a.startLevelDbfs as number;
    const end = a.endLevelDbfs as number;
    const freq = a.frequencyHz as number;
    const points = Array.from({ length: n }, (_, i) => {
      const level_dbfs = start + (end - start) * (i / (n - 1));
      return {
        frequency: freq,
        level_dbfs,
        thd_percent: 1e-4,
        thd_db: -120,
        thd_n_percent: 3e-4,
        thd_n_db: -110,
        fundamental_dbfs: level_dbfs,
      };
    });
    return { swept: "level", points };
  }

  /**
   * Wow & flutter (issue #28) — like `thdSweep`, a STUB result: the fake
   * does not run the heterodyne/phase-diff FM demodulation the real
   * backend does (pinned by the Rust unit tests in
   * `src-tauri/src/audio/wow_flutter.rs`, e.g. `recovers_known_wow`).
   * Instead it synthesizes the RESULT that SAME test's signal — a tone
   * FM-modulated by a known 4 Hz / 0.15 %-peak wow — would produce, using
   * the SAME decimation/window/cap constants as the real
   * `deviation_spectrum` (1000 Hz demod rate, power-of-two FFT window,
   * 200 Hz cap) so the axis, resolution and peak-vs-RMS relationship the
   * dialog renders are physically consistent, not just "a plausible
   * shape". `deviation_series` is populated too — the real backend always
   * returns one. Tests must assert the PLUMBING (fields populate, the
   * spectrum peaks near 4 Hz, the device-lock semantics), never these
   * exact numbers.
   *
   * Gated by the same `programGate` as `thdSweep` so
   * `holdPrograms()`/`releasePrograms()` covers it — but UNLIKE the THD
   * stub (deliberately instantaneous, Stop is only a lock-observation
   * no-op there), a held wow & flutter call is actually cancellable: Stop
   * (`sweep_stop`) rejects it, mirroring the real backend's cancellable
   * capture (issue #28 review point 7).
   */
  async wowFlutter(a: Args): Promise<unknown> {
    if (this.programGate) {
      const gate = this.programGate;
      await new Promise<void>((resolve, reject) => {
        // EXACT match to the real backend's cancel message (issue #28
        // second-pass review finding #2 — the frontend now matches this
        // string exactly, not by substring, so it must not drift).
        this.wowFlutterCancel = () => reject(new Error("wow & flutter measurement cancelled"));
        gate.then(resolve);
      }).finally(() => {
        this.wowFlutterCancel = null;
      });
    }
    const referenceFreq = (a.referenceFreq as number) || 3150;
    const durationSecs = Math.min(15, Math.max(1, (a.durationSecs as number) || 4));
    const wowRateHz = 4;
    const depth = 0.0015; // 0.15% peak fractional deviation — recovers_known_wow's signal
    const unweightedRms = (depth / Math.SQRT2) * 100;
    // The DIN/IEC weighting curve peaks at 4 Hz, so a pure 4 Hz wow reads
    // close to (not exactly) its unweighted RMS — the RBJ approximation
    // isn't unity gain at the peak.
    const weightedRms = unweightedRms * 0.92;
    const demodRate = 1000; // mirrors the real backend's target_rate/demod_rate

    // Deviation series: a 4 Hz sine at `depth`, decimated like the real
    // backend (a 50 ms settling skip, then one sample per demod period).
    const skip = Math.round(demodRate * 0.05);
    const seriesLen = Math.max(0, Math.round(durationSecs * demodRate) - skip);
    const deviationSeries = Array.from({ length: seriesLen }, (_, i) => {
      const t = (skip + i) / demodRate;
      return depth * 100 * Math.sin(2 * Math.PI * wowRateHz * t);
    });

    // Deviation spectrum: the SAME power-of-two window + 200 Hz cap as the
    // real `deviation_spectrum`, so bin resolution matches (e.g. ~0.49 Hz
    // at a 4 s capture) — fine enough that the 4 Hz peak actually lands
    // near a sampled bin, unlike the old fixed 7.8 Hz-spaced stub.
    let fftLen = 1;
    while (fftLen * 2 <= deviationSeries.length) fftLen *= 2;
    const maxRate = 200;
    const rateHz: number[] = [];
    const spectrumPercent: number[] = [];
    if (fftLen >= 64) {
      const binHz = demodRate / fftLen;
      // Amplitude spectrum peak ties directly to the reported RMS
      // (RMS = amplitude/√2 for a single tone) — not an independent guess.
      const peakAmplitude = unweightedRms * Math.SQRT2;
      const sigma = 1.0; // Hz — narrow enough that 4 Hz is clearly the tallest bin
      for (let f = 0; f <= maxRate; f += binHz) {
        rateHz.push(f);
        spectrumPercent.push(peakAmplitude * Math.exp(-((f - wowRateHz) ** 2) / (2 * sigma * sigma)));
      }
    }

    return {
      reference_freq: referenceFreq,
      weighted_rms_percent: weightedRms,
      unweighted_rms_percent: unweightedRms,
      peak_weighted_percent: weightedRms * Math.SQRT2,
      static_offset_hz: 0,
      demod_rate: demodRate,
      deviation_series: deviationSeries,
      rate_hz: rateHz,
      spectrum_percent: spectrumPercent,
    };
  }

  /** Adopt a stream config: slot set (same script filter as
   * mixer_set_slots — refused scripts become NAMED per-slot errors, the
   * plumbing the real backend uses for a failed compile) + everything the
   * per-frame tick reads. */
  applyStreamConfig(cfg: StreamConfigWire): void {
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

  stopStream(sendStopped: boolean): void {
    if (this.streamTimer !== null) {
      clearInterval(this.streamTimer);
      this.streamTimer = null;
    }
    if (sendStopped) this.streamChannel?.onmessage({ type: "stopped" });
    this.streamChannel = null;
  }

  /** One endpoint's trigger alignment this frame — mirrors stream.rs's
   * `evaluate_trigger`: level/hysteresis volts -> this frame's FS domain via
   * the SAME offset the frame's own trace uses (the twin of the offsets
   * object below), ANY change in `arm_epoch` re-arms a SINGLE latch — not
   * only an increase (a workspace load resets `arm_epoch` to 0 in the
   * frontend while this fake's own latch may already sit higher — issue #26
   * review #2) — and a fired SINGLE returns `stopped` without scanning.
   * READS `samples` only — this never influences spectra/metrics
   * (module-doc parity). */
  private evaluateTrigger(
    endpoint: string,
    cfg: TriggerConfigWire,
    samples: number[],
    offsetDb: number
  ): { state: "triggered" | "auto" | "waiting" | "stopped"; index: number; frac: number; level_fs: number; hysteresis_fs: number } {
    const toFs = Math.pow(10, -offsetDb / 20);
    const levelFs = cfg.level_v * toFs;
    const hysteresisFs =
      cfg.hysteresis_v !== null ? cfg.hysteresis_v * toFs : autoHysteresis(samples, 0.02, 1e-4);

    const armedEpoch = this.triggerArmedEpoch[endpoint] ?? 0;
    if (cfg.arm_epoch !== armedEpoch) {
      this.triggerArmedEpoch[endpoint] = cfg.arm_epoch;
      this.triggerFired[endpoint] = false;
    }

    if (cfg.mode === "single" && this.triggerFired[endpoint]) {
      return { state: "stopped", index: 0, frac: 0, level_fs: levelFs, hysteresis_fs: hysteresisFs };
    }

    const hit = findEdge(samples, levelFs, hysteresisFs, cfg.edge, cfg.pre_samples);
    if (hit) {
      if (cfg.mode === "single") this.triggerFired[endpoint] = true;
      return {
        state: "triggered",
        index: hit.index,
        frac: hit.frac,
        level_fs: levelFs,
        hysteresis_fs: hysteresisFs,
      };
    }
    return {
      state: cfg.mode === "auto" ? "auto" : "waiting",
      index: cfg.pre_samples,
      frac: 0,
      level_fs: levelFs,
      hysteresis_fs: hysteresisFs,
    };
  }

  /** One endpoint's measurement suite this frame — mirrors stream.rs's
   * `MeasureStates::ingest` + `EndpointMeasureStats`: measure, feed each
   * metric's sliding window, report value + stats. `samples === null`
   * (unrequested, or an output in monitor mode) drops the endpoint's bank
   * and reports null, so a re-enable restarts the statistics. */
  private measureEndpoint(
    endpoint: string,
    samples: number[] | null,
    sampleRate: number
  ): Record<string, unknown> | null {
    if (!samples) {
      delete this.measureStats[endpoint];
      return null;
    }
    const MEASURE_STATS_WINDOW = 100;
    const bank = (this.measureStats[endpoint] ??= {});
    const v = measureScope(samples, sampleRate);
    const stat = (key: string, value: number | null): unknown =>
      (bank[key] ??= new SlidingStats(MEASURE_STATS_WINDOW)).stat(value);
    return {
      vpp: stat("vpp", v.vpp),
      vmean: stat("vmean", v.vmean),
      rms_ac: stat("rms_ac", v.rms_ac),
      freq_hz: stat("freq_hz", v.freq_hz),
      rise_s: stat("rise_s", v.rise_s),
      fall_s: stat("fall_s", v.fall_s),
      duty: stat("duty", v.duty),
    };
  }

  /**
   * One v2 stream frame, mirroring the backend loop's order: render the mix
   * (level-volts) → fit the output range to the summed peak ({+8,+18} with
   * +1 dB margin, 1 dB down-hysteresis — the mixer.rs policy) → scale to
   * DAC full scale (clamp + report, never rescale) → capture through the
   * PROVIDER seam (synthetic or recorded fixtures — unchanged) → windowed
   * FFTs for the requested channels → scans the requested endpoints'
   * trigger alignment (reads the emitted buffers only, never gates the
   * spectra/metrics above — the stream.rs module-doc rule) → push the
   * frame with the per-converter offsets of THIS frame's register state.
   *
   * Simplifications, documented: one Hann window whatever `window` says, no
   * averaging (same stance as analyze_spectrum above), and clip flags are
   * per-frame booleans instead of a 100 ms latch (at ~8 fps every frame
   * outlives the hold). Assert LEVEL/STRUCTURE invariants against this,
   * never smoothing behaviour.
   */
  streamFrame(): void {
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

    // ---- trigger alignment (reads cap.left/right and the stimulus only —
    // never gates spectra/metrics above, mirrors the stream.rs module doc) --
    const offsetInputDb = inputDbvOffsetDb(this.config.input_gain);
    const offsetOutputDb = this.config.output_gain + 20 * Math.log10(Math.SQRT2);
    const trig = cfg.triggers;
    const trigger = {
      input_l: trig.input_l ? this.evaluateTrigger("input_l", trig.input_l, cap.left, offsetInputDb) : null,
      input_r: trig.input_r ? this.evaluateTrigger("input_r", trig.input_r, cap.right, offsetInputDb) : null,
      output_l:
        tone && trig.output_l ? this.evaluateTrigger("output_l", trig.output_l, left, offsetOutputDb) : null,
      output_r:
        tone && trig.output_r ? this.evaluateTrigger("output_r", trig.output_r, right, offsetOutputDb) : null,
    };

    // ---- scope measurement suite (lot B — same read-only, non-gating
    // contract as the trigger scan above) -------------------------------
    const meas = cfg.measures ?? { input_l: false, input_r: false, output_l: false, output_r: false };
    const measures = {
      input_l: this.measureEndpoint("input_l", meas.input_l ? cap.left : null, sr),
      input_r: this.measureEndpoint("input_r", meas.input_r ? cap.right : null, sr),
      output_l: this.measureEndpoint("output_l", meas.output_l && tone ? left : null, sr),
      output_r: this.measureEndpoint("output_r", meas.output_r && tone ? right : null, sr),
    };

    this.streamSeq += 1;
    ch.onmessage({
      type: "frame",
      seq: this.streamSeq,
      // Issue #25 lot C: every frame carries its device identity — the
      // registry stamps the payload with the OPEN unit's id, and so does
      // each fake unit (lot E4 — the old fixed `virtual/E2E-FAKE-0001`
      // stamp predates per-unit stream state and tripped the F5 mismatch
      // warning on every run).
      device_id: this.openId,
      captured: { left_channel: cap.left, right_channel: cap.right, sample_rate: sr },
      stimulus: tone ? { left, right } : null,
      spectra,
      metrics,
      trigger,
      measures,
      mix: {
        sigma_peak_dbv: sigmaPeakDbv,
        clip_input: clipInput,
        clip_output: clipOutput,
        fitted_output_range_dbv: this.config.output_gain,
      },
      offsets: {
        input_l: offsetInputDb,
        input_r: offsetInputDb,
        output_l: offsetOutputDb,
        output_r: offsetOutputDb,
        calibrated: true,
      },
      stats: { frames: this.streamSeq, fps: 8, frame_ms: 120 },
      errors: this.streamSlotErrors,
    });
  }

  /** Sum every enabled slot per its route; peak of the sum in level-volts. */
  renderMix(
    sampleRate: number,
    bufferSize: number,
    withSlots: boolean,
    slotsOverride?: MixSlotDesc[]
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
    for (const slot of slotsOverride ?? this.slots) {
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
    const out: ReturnType<FakeUnit["renderMix"]> = { left, right, peak, errors: [] };
    if (withSlots) out.slots = perSlot;
    return out;
  }
}

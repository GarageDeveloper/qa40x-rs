/**
 * Stream actions: start/stop the backend run loop, keep its config in sync
 * with the store, and ingest pushed frames (cache first, THEN one store
 * update — plan §3.1/§3.2). This file replaces the whole v1 LiveRunner
 * orchestration: the loop, the range fit and the clip latch live backend.
 */
import type { MixerSlotDesc, StreamConfig } from "../../gen";
import type { Ipc } from "../../ipc/ipc";
import { startStream, type DecodedFrame } from "../../ipc/stream";
import { putFrames } from "../../data/frames";
import type { Store } from "../store";
import type { AppState, SourceMeta, TraceMeta } from "../state";
import { HW_TRACE_IDS } from "../state";
import { fdShownTraceIds } from "../selectors/layout";
import { toast } from "./ui";

/** Snap a sine to the nearest FFT bin (v1 behavior: a bin-exact tone keeps
 * the windowed FFT clean; the ask stays the user's, only the mix snaps). */
export function snapToBin(freqHz: number, numSamples: number, sampleRate: number): number {
  const bin = Math.max(1, Math.round((freqHz * numSamples) / sampleRate));
  return (bin * sampleRate) / numSamples;
}

/** A level in dBV as a linear level-volts amplitude (0 dBV ≙ 1.0). */
export function levelToAmplitude(levelDbv: number): number {
  return Math.pow(10, levelDbv / 20);
}

/**
 * Map one source to its mixer slot (the mixSlotsFromTraces port — mixer.ts was
 * removed at the cutover; these rules are its slot-building half):
 * - a plain sine keeps the classic waveform slot — the bit-identical path the
 *   hardware level measurement was pinned on;
 * - a sine with enabled extra tones becomes a phased tone list: the primary
 *   {frequency, level} tone at phase 0 plus each enabled extra, every
 *   frequency bin-snapped, dBV → Vrms at this boundary;
 * - square / triangle / sawtooth are waveform slots (extra tones are a sine
 *   affair — they never reroute another waveform);
 * - multitone / noise / chirp carry only their level;
 * - a script carries its source text (the backend compiles per slot and
 *   reports failures as named errors).
 */
export function slotFromSource(
  src: SourceMeta,
  snap: (hz: number) => number
): MixerSlotDesc {
  let source: MixerSlotDesc["source"];
  switch (src.kind) {
    case "sine":
    case "square":
    case "triangle":
    case "sawtooth": {
      const amplitude = levelToAmplitude(src.levelDbv);
      const extra = src.kind === "sine" ? src.extraTones.filter((t) => t.enabled) : [];
      source =
        extra.length > 0
          ? {
              kind: "tones",
              tones: [
                {
                  enabled: true,
                  frequency_hz: snap(src.frequencyHz),
                  amplitude_vrms: amplitude,
                  phase_degrees: 0,
                },
                ...extra.map((t) => ({
                  enabled: true,
                  frequency_hz: snap(t.frequencyHz),
                  amplitude_vrms: levelToAmplitude(t.levelDbv),
                  phase_degrees: t.phaseDeg,
                })),
              ],
            }
          : {
              kind: "waveform",
              waveform: src.kind,
              frequency_hz: snap(src.frequencyHz),
              amplitude,
            };
      break;
    }
    case "multitone":
    case "noise":
    case "chirp":
      source = { kind: src.kind, amplitude: levelToAmplitude(src.levelDbv) };
      break;
    case "script":
      source = { kind: "script", source: src.source };
      break;
  }
  return { id: src.id, source, route: src.route, enabled: true };
}

/** The frequency the mixer actually plays for an asked `hz`: clamped to
 * [1 Hz, 0.98·Nyquist], then bin-snapped unless the coherent-generator
 * toggle is off (issue #14 — "Round to eliminate leakage" in the official
 * app). The sources panel shows this value next to the ask when it differs. */
export function playedFrequencyHz(s: AppState, hz: number): number {
  const sampleRate = s.device.config?.sample_rate ?? 48000;
  const clamped = Math.min(Math.max(hz, 1), (sampleRate / 2) * 0.98);
  return s.acquisition.coherentGen
    ? snapToBin(clamped, s.acquisition.fftSize, sampleRate)
    : clamped;
}

/** The slot declarations for the currently playing sources. */
export function slotsFromSources(s: AppState): MixerSlotDesc[] {
  const snap = (hz: number): number => playedFrequencyHz(s, hz);
  return s.sources.order
    .map((id) => s.sources.byId[id])
    .filter((src): src is SourceMeta => !!src && src.playing)
    .map((src) => slotFromSource(src, snap));
}

/** The stream config is a pure projection of the state tree. The spectra
 * request is the display budget: an FFT is computed only for hardware
 * endpoints some displayed spectrum tile shows (#52). */
export function buildStreamConfig(s: AppState): StreamConfig {
  const { mode, count } = s.acquisition.averaging;
  const fdShown = fdShownTraceIds(s);
  return {
    buffer_size: s.acquisition.fftSize,
    slots: slotsFromSources(s),
    window: s.acquisition.window,
    averaging: {
      coherent: mode === "coherent",
      count: mode === "off" ? 1 : Math.max(1, count),
    },
    spectra: {
      input_l: fdShown.has(HW_TRACE_IDS.inputL),
      input_r: fdShown.has(HW_TRACE_IDS.inputR),
      output_l: fdShown.has(HW_TRACE_IDS.outputL),
      output_r: fdShown.has(HW_TRACE_IDS.outputR),
    },
    // M1: always auto-fit to the summed peak (a fixed-range UI lands with
    // the full output-range readout parity).
    output_range_dbv: null,
  };
}

/** Monotonic ingest stamp. NOT the wire seq: a restarted backend loop
 * counts from 1 again, and the frames cache stale-drop would then silently
 * discard EVERY frame of the new run while the stats kept ticking — charts
 * frozen after stop→play (M3 review bug). Channel delivery is FIFO, so a
 * local counter is the correct freshness order. */
let ingestSeq = 0;

/**
 * Ingest one pushed frame: write the frames cache FIRST, then bump seqs and
 * mirror the run/mix/offsets state in ONE store update. Charts pull the
 * arrays from the cache inside their select callbacks.
 */
function ingestFrame(store: Store<AppState>, frame: DecodedFrame): void {
  const seq = ++ingestSeq;
  const off = frame.offsets;
  // Each endpoint buffers its OWN converter's offset — ADC for inputs, DAC
  // for outputs (the #48/#50/#51/#58/#60 class: four values, never one).
  const written: Array<{ id: string; offsetDb: number; hasTd: boolean; hasFd: boolean }> = [];
  const put = (
    id: string,
    offsetDb: number,
    td: DecodedFrame["input"]["l"] | undefined,
    fd: DecodedFrame["fd"]["inputL"],
    metrics?: DecodedFrame["metrics"]["inputL"],
    harmonics?: DecodedFrame["metrics"]["harmonicsL"]
  ): void => {
    if (!td && !fd) return; // e.g. Output endpoints in monitor mode
    if (
      putFrames(id, seq, {
        td,
        fd: fd ?? undefined,
        metrics: metrics ?? undefined,
        harmonics: harmonics ?? undefined,
      })
    ) {
      written.push({ id, offsetDb, hasTd: !!td, hasFd: !!fd });
    }
  };
  put(
    HW_TRACE_IDS.inputL,
    off.input_l,
    frame.input.l,
    frame.fd.inputL,
    frame.metrics.inputL,
    frame.metrics.harmonicsL
  );
  put(
    HW_TRACE_IDS.inputR,
    off.input_r,
    frame.input.r,
    frame.fd.inputR,
    frame.metrics.inputR,
    frame.metrics.harmonicsR
  );
  put(HW_TRACE_IDS.outputL, off.output_l, frame.output?.l, frame.fd.outputL);
  put(HW_TRACE_IDS.outputR, off.output_r, frame.output?.r, frame.fd.outputR);

  store.update("stream/frame", (s) => {
    const byId = { ...s.traces.byId };
    for (const w of written) {
      const t = byId[w.id];
      if (!t) continue;
      const domains: TraceMeta["domains"] = [];
      if (w.hasTd) domains.push("td");
      if (w.hasFd) domains.push("fd");
      byId[w.id] = { ...t, seq, offsetDb: w.offsetDb, domains };
    }
    return {
      ...s,
      traces: { ...s.traces, byId },
      run: {
        ...s.run,
        // Transport state belongs to start/stop and the Stopped event — a
        // draining frame arriving after an (optimistic) stop must not flip
        // the button back to "Stop".
        stats: {
          fps: frame.stats.fps,
          frameMs: frame.stats.frame_ms,
          frames: frame.stats.frames,
        },
        sigmaPeakDbv: frame.mix.sigma_peak_dbv,
        clip: { input: frame.mix.clip_input, output: frame.mix.clip_output },
        fittedOutputRangeDbv: frame.mix.fitted_output_range_dbv,
        slotErrors: frame.errors,
      },
      device: {
        ...s.device,
        // The frame is the truth for offsets AND the fitted output range —
        // the loop may have moved reg 6 since the last config read.
        offsets: frame.offsets,
        config: s.device.config
          ? { ...s.device.config, output_gain: frame.mix.fitted_output_range_dbv }
          : s.device.config,
      },
    };
  });
}

/** The in-flight stop, so a start issued right after a stop is SEQUENCED
 * behind it (Tauri commands run concurrently — without this, the backend
 * could serve the start first and the late stop would kill the new loop). */
let stopInFlight: Promise<void> | null = null;

/** Stream generation: bumped per start, so a superseded channel's late
 * Stopped/Error (backend take-over stops the OLD loop) can never flip the
 * transport of the CURRENT one. */
let streamGen = 0;

export async function startRun(
  store: Store<AppState>,
  ipc: Ipc,
  opts: {
    /**
     * The USER transport (Run button / Space): when nothing plays, Run
     * starts the bench's sources too — a first Run must never show a
     * confusing empty capture while a ready sine sits paused (maintainer,
     * M5 review; the v1 "Run all" semantic). Programmatic starts (play
     * auto-start, program resume) never set this: source playing flags
     * are user INTENT there and stay untouched.
     */
    playAllIfIdle?: boolean;
  } = {}
): Promise<void> {
  if (stopInFlight) await stopInFlight; // user intent order: stop, THEN start
  let s = store.get();
  if (s.run.streaming || s.device.status !== "connected") return;
  // A measurement program owns the device exclusively (M4): its completion
  // resumes the stream itself; nothing else may start one meanwhile.
  if (s.run.programLock !== null) return;
  if (
    opts.playAllIfIdle &&
    s.sources.order.length > 0 &&
    !s.sources.order.some((id) => s.sources.byId[id]?.playing)
  ) {
    store.update("stream/run-plays-sources", (st) => ({
      ...st,
      sources: {
        ...st.sources,
        byId: Object.fromEntries(
          Object.entries(st.sources.byId).map(([id, src]) => [
            id,
            { ...src, playing: true },
          ])
        ),
      },
    }));
    s = store.get();
  }
  if (s.run.outputOnly || s.run.generatorRunning) {
    // Run is an explicit ask for capture: it takes the DAC back (stream_start
    // stops the gap-free generator backend-side) and ends the session mode —
    // a lingering "output only" flag would silently rebuild the generator on
    // the next source edit and kill this very stream.
    store.update("stream/leave-output-only", (st) => ({
      ...st,
      run: { ...st.run, outputOnly: false, generatorRunning: false },
    }));
  }
  const gen = ++streamGen;
  try {
    await startStream(ipc, buildStreamConfig(s), {
      onFrame: (frame) => {
        if (gen === streamGen) ingestFrame(store, frame);
      },
      onError: (message) => {
        if (gen === streamGen) toast(store, "error", `Stream: ${message}`);
      },
      onStopped: () => {
        if (gen !== streamGen) return; // a superseded loop's goodbye
        store.update("stream/stopped", (st) => ({
          ...st,
          run: { ...st.run, streaming: false },
        }));
      },
    });
    store.update("stream/started", (st) => ({
      ...st,
      run: { ...st.run, streaming: true },
    }));
  } catch (e) {
    toast(store, "error", `Run failed: ${e}`);
  }
}

export function stopRun(store: Store<AppState>, ipc: Ipc): Promise<void> {
  if (stopInFlight) return stopInFlight; // one stop in flight is enough
  // Optimistic: the transport reflects the user's intent IMMEDIATELY (the
  // backend drains its last frame for up to a second — the M3 "had to press
  // Stop twice" report). `stopping` disables the transport button until the
  // backend acknowledged; a programmatic start (play) queues behind it.
  store.update("stream/stop-requested", (s) => ({
    ...s,
    run: { ...s.run, streaming: false, stopping: true },
  }));
  stopInFlight = (async () => {
    try {
      await ipc.call("stream_stop", {});
    } catch (e) {
      toast(store, "error", `Stop failed: ${e}`);
    } finally {
      stopInFlight = null;
      store.update("stream/stop-acknowledged", (s) => ({
        ...s,
        run: { ...s.run, stopping: false },
      }));
    }
  })();
  return stopInFlight;
}

/**
 * Push the current config to a running stream (no-op otherwise). Actions
 * that change acquisition / sources / trace visibility call this LAST.
 */
export function syncStream(store: Store<AppState>, ipc: Ipc): void {
  if (!store.get().run.streaming) return;
  void ipc
    .call("stream_update", { config: buildStreamConfig(store.get()) })
    .catch((e) => toast(store, "error", `Stream update: ${e}`));
}

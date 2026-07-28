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
import { putTriggerSnapshot } from "../../data/triggered";
import type { Store } from "../store";
import type {
  AppState,
  CaptureProvenance,
  RunState,
  SessionKey,
  SourceMeta,
  TraceMeta,
} from "../state";
import { captureBenchSignature, hwTraceIds } from "../state";
import { fdShownTraceIds } from "../selectors/layout";
import { measureRequest } from "../selectors/measures";
import {
  isRoutable,
  session,
  sessionArgs,
  sessionKeys,
  updateDevice,
  updateRun,
} from "../selectors/session";
import { triggerRequest } from "../selectors/trigger";
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
 * app). The sources panel shows this value next to the ask when it differs.
 *
 * `sessionKey` names the device whose CONVERTER the tone is for (default:
 * the focused session — the panel's readout and every E2 transport). The
 * bin grid and the Nyquist clamp are properties of THAT device's sample
 * rate, never the focused one's (E2 review #1: a slot-1 start snapped
 * against the focused device's rate would play a non-coherent tone —
 * ~12 dB pessimistic THD+N, the #14 failure mode — or ask a slower
 * converter for a tone above its own Nyquist). */
export function playedFrequencyHz(
  s: AppState,
  hz: number,
  sessionKey?: SessionKey
): number {
  const key = sessionKey ?? s.devices.focus;
  const sampleRate = session(s, key)?.device.config?.sample_rate ?? 48000;
  const clamped = Math.min(Math.max(hz, 1), (sampleRate / 2) * 0.98);
  return s.acquisition.coherentGen
    ? snapToBin(clamped, s.acquisition.fftSize, sampleRate)
    : clamped;
}

/** The slot declarations for the currently playing sources, snapped to
 * `sessionKey`'s converter grid (default: the focused session's). */
export function slotsFromSources(s: AppState, sessionKey?: SessionKey): MixerSlotDesc[] {
  const snap = (hz: number): number => playedFrequencyHz(s, hz, sessionKey);
  return s.sources.order
    .map((id) => s.sources.byId[id])
    .filter((src): src is SourceMeta => !!src && src.playing)
    .map((src) => slotFromSource(src, snap));
}

/** The stream config is a pure projection of the state tree. The spectra
 * request is the display budget: an FFT is computed only for hardware
 * endpoints some displayed spectrum tile shows (#52). `sessionKey` keys
 * the sample-rate-dependent parts (bin snapping — see playedFrequencyHz)
 * and, since lot E3, the endpoint projections: spectra/triggers/measures
 * read through the session slot's own trace ids (wire shapes byte-identical
 * — the slot dimension lives outside them, one config per device).
 * Acquisition and the display budget stay bench-global by design.
 *
 * `slots` (the DAC program) is emitted for the FOCUSED session only
 * (Raphaël decision 1, 2026-07-28: sources = focused device; added devices
 * capture in monitor mode — an empty slot set). Per-device source routing
 * is lot F. */
export function buildStreamConfig(s: AppState, sessionKey?: SessionKey): StreamConfig {
  const key = sessionKey ?? s.devices.focus;
  const slot = session(s, key)?.slot ?? 0;
  const ids = hwTraceIds(slot);
  const { mode, count } = s.acquisition.averaging;
  const fdShown = fdShownTraceIds(s);
  return {
    buffer_size: s.acquisition.fftSize,
    slots: key === s.devices.focus ? slotsFromSources(s, key) : [],
    window: s.acquisition.window,
    averaging: {
      coherent: mode === "coherent",
      count: mode === "off" ? 1 : Math.max(1, count),
    },
    spectra: {
      input_l: fdShown.has(ids.inputL),
      input_r: fdShown.has(ids.inputR),
      output_l: fdShown.has(ids.outputL),
      output_r: fdShown.has(ids.outputR),
    },
    // M1: always auto-fit to the summed peak (a fixed-range UI lands with
    // the full output-range readout parity).
    output_range_dbv: null,
    triggers: triggerRequest(s, slot),
    measures: measureRequest(s, slot),
  };
}

/**
 * The capture snapshot a frame ingested under state `s` stamps on its
 * endpoint traces (issue #40) — frame-side truth preferred (its OWN sample
 * rate and per-converter offsets; the fitted output range the loop actually
 * used), config-side for the rest. Memoized on the bench signature: at
 * 25 fps this must not allocate 4 objects per frame — the SAME frozen
 * object rides every frame until the bench actually moves (a vitest test
 * pins the identity). One shared snapshot for all four endpoints is correct
 * by construction: they come from the ONE capture of one device.
 *
 * Config-projection caveat: fft/window/averaging come from the acquisition
 * state, so the one in-flight frame captured under a JUST-changed setting
 * carries the new stamp — same one-frame window the offsets model closed
 * frame-side; acceptable for provenance, not worth a wire field yet.
 *
 * Memoized PER SESSION (lot E2): two devices capturing concurrently are two
 * different benches — session A's frozen object must never be served to
 * session B's traces. Still content-addressed within a session.
 */
const lastCaptureBySession = new Map<
  SessionKey,
  { sig: string; cap: CaptureProvenance }
>();
export function frameCaptureProvenance(
  s: AppState,
  key: SessionKey,
  frame: DecodedFrame
): CaptureProvenance {
  // Strictly THIS session's device — never another session's (review #12:
  // borrowing the focused bench's identity would stamp the wrong
  // model/serial on the frame). ingestFrame guarantees the session exists;
  // a direct call with a bad key gets an honest null-device snapshot.
  const device = session(s, key)?.device;
  const info = device?.info ?? null;
  const next: CaptureProvenance = {
    device: info
      ? {
          model: info.model,
          serial: info.serial,
          firmware: info.firmware_version,
          isVirtual: info.is_virtual,
        }
      : null,
    sampleRateHz: frame.sampleRate,
    inputRangeDbv: device?.config?.input_gain ?? null,
    outputRangeDbv: frame.mix.fitted_output_range_dbv,
    offsets: frame.offsets,
    fftSize: s.acquisition.fftSize,
    window: s.acquisition.window,
    averaging: { ...s.acquisition.averaging },
    capturedAt: null,
  };
  const sig = captureBenchSignature(next);
  const memo = lastCaptureBySession.get(key);
  if (memo && sig === memo.sig) return memo.cap;
  // Children frozen too: the store's dev-mode deepFreeze stops at an
  // already-frozen object, so a shallow freeze here would leave
  // `capture.device`/`capture.averaging` mutable behind the guard.
  Object.freeze(next.device);
  Object.freeze(next.averaging);
  Object.freeze(next.offsets);
  const cap = Object.freeze(next);
  lastCaptureBySession.set(key, { sig, cap });
  return cap;
}

/** Monotonic ingest stamp. NOT the wire seq: a restarted backend loop
 * counts from 1 again, and the frames cache stale-drop would then silently
 * discard EVERY frame of the new run while the stats kept ticking — charts
 * frozen after stop→play (M3 review bug). Channel delivery is FIFO, so a
 * local counter is the correct freshness order. */
let ingestSeq = 0;

/** F5 (issue #25 lot E2): a frame whose stamp disagrees with its session's
 * adopted id is a DEVELOPER signal, never a drop and never a toast — the
 * e2e fake stamps `virtual/E2E-FAKE-0001`, an id it never enumerates, so
 * binding on the stamp would drop every frame of every e2e run. Warned at
 * most once per (session, stamp, adopted) triple: at 25 fps an unthrottled
 * console.warn floods the dev console and every e2e trace. */
const warnedFrameMismatches = new Set<string>();
function warnFrameDeviceMismatch(
  key: SessionKey,
  frameId: string,
  sessionId: string
): void {
  const sig = `${key}|${frameId}|${sessionId}`;
  if (warnedFrameMismatches.has(sig)) return;
  warnedFrameMismatches.add(sig);
  console.warn(
    `[qa40x] frame stamped ${frameId} arrived on session ${key} holding ` +
      `${sessionId} — ingested anyway (the channel, not the stamp, is the ` +
      `binding); investigate the routing if this is not the e2e fake`
  );
}

/**
 * Ingest one pushed frame into `key`'s session: write the frames cache
 * FIRST, then bump seqs and mirror the run/mix/offsets state in ONE store
 * update. Charts pull the arrays from the cache inside their select
 * callbacks. The binding is the CHANNEL's own session key, captured at
 * `startRun` time — `frame.deviceId` is only asserted (F5 above), never
 * routed on. Exported for tests only — production callers go through
 * `startRun`'s `onFrame`.
 */
export function ingestFrame(
  store: Store<AppState>,
  key: SessionKey,
  frame: DecodedFrame
): void {
  const sess = session(store.get(), key);
  // A torn-down session's late frame: nothing to ingest into (the keyed
  // store writes below would no-op, but the cache writes would not).
  if (!sess) return;
  if (frame.deviceId && sess.deviceId && frame.deviceId !== sess.deviceId) {
    warnFrameDeviceMismatch(key, frame.deviceId, sess.deviceId);
  }
  // THIS session's endpoint traces (issue #25 lot E3): the frames cache,
  // the trigger-snapshot cache and traces.byId all key on these ids, so
  // two sessions streaming concurrently land on disjoint traces — slot 0
  // keeps hw-in-left & co verbatim.
  const ids = hwTraceIds(sess.slot);
  const seq = ++ingestSeq;
  const off = frame.offsets;
  // One snapshot for the whole frame (issue #40), computed BEFORE the cache
  // writes so the trigger latch below can bake it — the update callback
  // reuses it (same state, cache-first rule intact).
  const capture = frameCaptureProvenance(store.get(), key, frame);
  // Each endpoint buffers its OWN converter's offset — ADC for inputs, DAC
  // for outputs (the #48/#50/#51/#58/#60 class: four values, never one).
  const written: Array<{ id: string; offsetDb: number; hasTd: boolean; hasFd: boolean }> = [];
  const put = (
    id: string,
    offsetDb: number,
    td: DecodedFrame["input"]["l"] | undefined,
    fd: DecodedFrame["fd"]["inputL"],
    metrics?: DecodedFrame["metrics"]["inputL"],
    harmonics?: DecodedFrame["metrics"]["harmonicsL"],
    scope?: DecodedFrame["measures"]["inputL"]
  ): void => {
    if (!td && !fd) return; // e.g. Output endpoints in monitor mode
    if (
      putFrames(id, seq, {
        td,
        fd: fd ?? undefined,
        metrics: metrics ?? undefined,
        harmonics: harmonics ?? undefined,
        scope: scope ?? undefined,
      })
    ) {
      written.push({ id, offsetDb, hasTd: !!td, hasFd: !!fd });
    }
  };
  put(
    ids.inputL,
    off.input_l,
    frame.input.l,
    frame.fd.inputL,
    frame.metrics.inputL,
    frame.metrics.harmonicsL,
    frame.measures.inputL
  );
  put(
    ids.inputR,
    off.input_r,
    frame.input.r,
    frame.fd.inputR,
    frame.metrics.inputR,
    frame.metrics.harmonicsR,
    frame.measures.inputR
  );
  put(
    ids.outputL,
    off.output_l,
    frame.output?.l,
    frame.fd.outputL,
    undefined,
    undefined,
    frame.measures.outputL
  );
  put(
    ids.outputR,
    off.output_r,
    frame.output?.r,
    frame.fd.outputR,
    undefined,
    undefined,
    frame.measures.outputR
  );

  // Trigger snapshot latching (plan §3.3): the 4 hw channels share ONE
  // capture buffer, so whichever endpoint's alignment fired, its index/frac
  // slices all of them consistently — the snapshot carries every channel,
  // keyed by the endpoint that latched it. `waiting`/`stopped` write nothing
  // (the previous snapshot, if any, keeps holding NORMAL/SINGLE's picture).
  const snapSamples: Record<string, Float64Array> = {
    [ids.inputL]: frame.input.l.samples,
    [ids.inputR]: frame.input.r.samples,
  };
  if (frame.output) {
    snapSamples[ids.outputL] = frame.output.l.samples;
    snapSamples[ids.outputR] = frame.output.r.samples;
  }
  const snapOffsets: Record<string, number | null> = {
    [ids.inputL]: off.input_l,
    [ids.inputR]: off.input_r,
    [ids.outputL]: off.output_l,
    [ids.outputR]: off.output_r,
  };
  const runTriggers: RunState["triggers"] = {};
  const endpoints: [string, DecodedFrame["trigger"]["inputL"]][] = [
    [ids.inputL, frame.trigger.inputL],
    [ids.inputR, frame.trigger.inputR],
    [ids.outputL, frame.trigger.outputL],
    [ids.outputR, frame.trigger.outputR],
  ];
  // A `stopped` report may come from the in-flight frame captured under the
  // PRE-re-arm config — any other state proves the current config's scan
  // ran, and settles a pending Arm (RunState.trigArmPending).
  const armSettled: string[] = [];
  for (const [id, align] of endpoints) {
    if (!align) continue;
    runTriggers[id] = { state: align.state, index: align.index, frac: align.frac };
    if (align.state !== "stopped") armSettled.push(id);
    if (align.state === "triggered" || align.state === "auto") {
      putTriggerSnapshot(id, {
        seq,
        state: align.state,
        index: align.index,
        frac: align.frac,
        sampleRate: frame.sampleRate,
        samples: snapSamples,
        offsetDb: snapOffsets,
        capture,
      });
    }
  }

  store.update("stream/frame", (s) => {
    const byId = { ...s.traces.byId };
    for (const w of written) {
      const t = byId[w.id];
      if (!t) continue;
      const domains: TraceMeta["domains"] = [];
      if (w.hasTd) domains.push("td");
      if (w.hasFd) domains.push("fd");
      byId[w.id] = { ...t, seq, offsetDb: w.offsetDb, domains, capture };
    }
    const withTraces = { ...s, traces: { ...s.traces, byId } };
    return updateDevice(
      updateRun(withTraces, key, (r) => ({
        ...r,
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
        // Wholesale replace (not merge): an endpoint the current config no
        // longer triggers must not keep showing a stale state.
        triggers: runTriggers,
        trigArmPending: armSettled.length
          ? Object.fromEntries(
              Object.entries(r.trigArmPending).filter(([k]) => !armSettled.includes(k))
            )
          : r.trigArmPending,
      })),
      key,
      (d) => ({
        ...d,
        // The frame is the truth for offsets AND the fitted output range —
        // the loop may have moved reg 6 since the last config read.
        offsets: frame.offsets,
        config: d.config
          ? { ...d.config, output_gain: frame.mix.fitted_output_range_dbv }
          : d.config,
      })
    );
  });
}

/** The in-flight stop PER SESSION, so a start issued right after a stop is
 * SEQUENCED behind it (Tauri commands run concurrently — without this, the
 * backend could serve the start first and the late stop would kill the new
 * loop) — while session B's start is never parked behind session A's stop. */
const stopInFlight = new Map<SessionKey, Promise<void>>();

/** Stream generation PER SESSION: bumped per start, so a superseded
 * channel's late Stopped/Error (backend take-over stops the OLD loop) can
 * never flip the transport of the CURRENT one — nor another session's. */
const streamGen = new Map<SessionKey, number>();

/** TESTS ONLY: clear the per-session module maps between suites. The
 * capture memo is content-addressed so cross-test reuse is safe by
 * construction (a pinned property), but the gen/stop maps hold real
 * promises/counters a previous test's session may have left behind. */
export function __resetSessionGlobals(): void {
  stopInFlight.clear();
  streamGen.clear();
  lastCaptureBySession.clear();
  warnedFrameMismatches.clear();
}

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
    /** The session to start (default: the focused one — every UI transport
     * is focus-bound per decision 2; E4's group headers pass explicit keys). */
    sessionKey?: SessionKey;
  } = {}
): Promise<void> {
  const key = opts.sessionKey ?? store.get().devices.focus;
  const pendingStop = stopInFlight.get(key);
  if (pendingStop) await pendingStop; // user intent order: stop, THEN start
  let s = store.get();
  let sess = session(s, key);
  if (!sess) return;
  // An unadopted slot ≥ 1 must never touch the wire: its arg-less command
  // would drive the DEFAULT runtime — the other device (review #2).
  if (!isRoutable(s, key)) return;
  if (sess.run.streaming || sess.device.status !== "connected") return;
  // A measurement program owns the device exclusively (M4): its completion
  // resumes the stream itself; nothing else may start one meanwhile.
  if (sess.run.programLock !== null) return;
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
    sess = session(s, key)!; // re-read past our own update (hygiene)
  }
  if (sess.run.outputOnly || sess.run.generatorRunning) {
    // Run is an explicit ask for capture: it takes the DAC back (stream_start
    // stops the gap-free generator backend-side) and ends the session mode —
    // a lingering "output only" flag would silently rebuild the generator on
    // the next source edit and kill this very stream.
    store.update("stream/leave-output-only", (st) =>
      updateRun(st, key, (r) => ({ ...r, outputOnly: false, generatorRunning: false }))
    );
  }
  const gen = (streamGen.get(key) ?? 0) + 1;
  streamGen.set(key, gen);
  try {
    // The channel IS the device-scoped object: `onFrame` closes over `key`,
    // so every message of this loop lands in this session — the frame's own
    // deviceId stamp is only asserted (F5, ingestFrame).
    await startStream(
      ipc,
      buildStreamConfig(s, key),
      {
        onFrame: (frame) => {
          if (gen === streamGen.get(key)) ingestFrame(store, key, frame);
        },
        onError: (message) => {
          if (gen === streamGen.get(key)) toast(store, "error", `Stream: ${message}`);
        },
        onStopped: () => {
          if (gen !== streamGen.get(key)) return; // a superseded loop's goodbye
          store.update("stream/stopped", (st) =>
            updateRun(st, key, (r) => ({ ...r, streaming: false }))
          );
        },
      },
      sessionArgs(s, key)
    );
    store.update("stream/started", (st) =>
      updateRun(st, key, (r) => ({ ...r, streaming: true }))
    );
  } catch (e) {
    toast(store, "error", `Run failed: ${e}`);
  }
}

export function stopRun(
  store: Store<AppState>,
  ipc: Ipc,
  sessionKey?: SessionKey
): Promise<void> {
  const key = sessionKey ?? store.get().devices.focus;
  // No session, or an unadopted slot ≥ 1 (review #2/#3): the arg-less
  // stream_stop would kill the DEFAULT runtime's live capture while this
  // key's transport shows nothing — refuse to touch the wire.
  if (!session(store.get(), key) || !isRoutable(store.get(), key)) {
    return Promise.resolve();
  }
  const pending = stopInFlight.get(key);
  if (pending) return pending; // one stop in flight per session is enough
  // Optimistic: the transport reflects the user's intent IMMEDIATELY (the
  // backend drains its last frame for up to a second — the M3 "had to press
  // Stop twice" report). `stopping` disables the transport button until the
  // backend acknowledged; a programmatic start (play) queues behind it.
  store.update("stream/stop-requested", (s) =>
    updateRun(s, key, (r) => ({ ...r, streaming: false, stopping: true }))
  );
  const stop = (async () => {
    try {
      await ipc.call("stream_stop", sessionArgs(store.get(), key));
    } catch (e) {
      // F8 (issue #25 lot E2): a stop racing a disconnect on a ROUTED
      // session rejects with the registry's `Unknown device: <id>` — the
      // unit is gone, so the stop's goal is already met; toasting an error
      // over a plain unplug would gaslight the user. Substring match, not
      // equality: command wrappers prefix their own context (the E1
      // bookkeeping's warning about pinning bare registry strings).
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.toLowerCase().includes("unknown device")) {
        toast(store, "error", `Stop failed: ${e}`);
      }
    } finally {
      stopInFlight.delete(key);
      store.update("stream/stop-acknowledged", (s) =>
        updateRun(s, key, (r) => ({ ...r, stopping: false }))
      );
    }
  })();
  stopInFlight.set(key, stop);
  return stop;
}

/**
 * Push the current config to a running stream (no-op otherwise). Actions
 * that change acquisition / sources / trace visibility call this LAST.
 */
export function syncStream(
  store: Store<AppState>,
  ipc: Ipc,
  sessionKey?: SessionKey
): void {
  const s = store.get();
  const key = sessionKey ?? s.devices.focus;
  if (!session(s, key)?.run.streaming) return;
  if (!isRoutable(s, key)) return; // never retarget the default runtime (review #2)
  void ipc
    .call("stream_update", {
      config: buildStreamConfig(store.get(), key),
      ...sessionArgs(s, key),
    })
    .catch((e) => {
      // Same F8 rationale as stopRun: the loop this update targets died
      // with its device — nothing to sync, nothing to report.
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.toLowerCase().includes("unknown device")) {
        toast(store, "error", `Stream update: ${e}`);
      }
    });
}

/**
 * Push the current config to EVERY session's running stream (lot E3):
 * bench-global mutators — acquisition, trigger settings, trace pool,
 * layout, workspace load — reshape every device's config, not just the
 * focused one's. Each per-session sync no-ops when that session is not
 * streaming and refuses an unroutable slot ≥ 1 (syncStream's own gates).
 * Focus-bound mutators (sources, transport, output-only) keep calling
 * `syncStream` directly — decision D3: sources ride the focused device.
 * Dormant with one session: exactly one syncStream, as before.
 */
export function syncAllStreams(store: Store<AppState>, ipc: Ipc): void {
  for (const key of sessionKeys(store.get())) syncStream(store, ipc, key);
}

/**
 * Measurement-program actions (M4) — THE program lock, taken symmetrically
 * (the v1 suspendMixerForProgram policy, restated for the backend loop):
 *
 * A measurement program (sweep / measurement script) owns ITS DEVICE
 * exclusively — the one REAL hardware constraint (a single USB stream per
 * unit). Since lot F4 (issue #25) the lock is PER DEVICE: a program binds
 * to one session at entry (`programSessionKey` — its `deviceSlot` pin, or
 * the focus), and programs on different devices run concurrently, each
 * with its own progress row. Two deliberate limits remain bench-global:
 * SCRIPT programs (the backend `ScriptControl` is a single engine — one
 * `running` flag, an arg-less `script_stop`, un-keyed `script-*` events;
 * per-device scripts arrive with the Rhai device work, F5/F6) and the
 * workspace-load / idle-enumeration gates (`anyProgramLock` — a load
 * replaces every program's result trace, whichever device runs it).
 *
 * POLICY, deliberate: starting a program STOPS whichever loop owns that
 * device's DAC (the capture stream, or the gap-free output-only generator)
 * and waits for the backend to acknowledge (`stream_stop` returns only
 * once the loop has fully exited — never splice register I/O into a
 * capture). The sources' `playing` flags are USER INTENT and stay
 * untouched: while the lock is held that session's transports are disabled
 * WITH THE PROGRAM'S NAME (legible, never silently inert), and completion
 * resumes exactly the session that ran before — a one-shot measurement
 * never costs the user their mix.
 */
import { listen } from "@tauri-apps/api/event";
import type { Frame, SweepCurve } from "../../gen";
import type { Ipc } from "../../ipc/ipc";
import type { Domain } from "../../core/model";
import { classifyScriptRole, DEFAULT_MEASURE_SCRIPT } from "../../core/scriptrole";
import {
  getFrames,
  putFrames,
  wireToFd,
  wireToSweep,
  wireToTd,
  type DecodedSweep,
} from "../../data/frames";
import { clearMeasures } from "../../data/measures";
import { scriptRunLog } from "../../panels/programs/runlog";
import type { Store } from "../store";
import type {
  AppState,
  CaptureProvenance,
  ProgramMeta,
  SweepProgramParams,
  TraceMeta,
  WowFlutterProgramResult,
} from "../state";
import { DEFAULT_SWEEP_PARAMS, nextTraceColor } from "../state";
import type { SessionKey } from "../sessionkey";
import {
  isRoutable,
  session,
  sessionArgs,
  updateRun,
} from "../selectors/session";
import {
  programBlockReason,
  programForDeviceId,
  programSessionKey,
  runningPrograms,
} from "../selectors/programs";
import { sourcesForSession } from "../selectors/sources";
import { removeTraceEverywhere } from "./traces";
import { startRun, stopRun, syncAllStreams } from "./stream";
import { syncI2s } from "./i2s";
import { syncOutputOnly } from "./outputonly";
import { armSessionForSources } from "./sources";
import { toast } from "./ui";

/* ------------------------------------------------------------------ */
/* Definitions                                                         */
/* ------------------------------------------------------------------ */

let nextProgId = 1;

/** "FR" / "W&F" / "Sweep" — the short noun a sweep program's toasts and
 * cancellation messages use, generalized over `measurement`. */
function sweepKindLabel(p: SweepProgramParams): string {
  if (p.measurement === "fr") return "FR";
  if (p.measurement === "wowflutter") return "W&F";
  return "Sweep";
}

/** Auto-label for a sweep program, from its params (the e2e specs pin this
 * exact shape — "Sweep 20–20000 Hz"). A THD level-axis sweep (issue #27)
 * labels its OWN swept range instead — "Sweep -60–0 dBFS"; wow & flutter
 * labels its reference tone — "W&F 3150 Hz". */
export function sweepLabel(params: SweepProgramParams): string {
  if (params.measurement === "fr") return `FR ${params.startHz}–${params.endHz} Hz`;
  if (params.measurement === "wowflutter") return `W&F ${params.wowReferenceHz} Hz`;
  if (params.axis === "level") return `Sweep ${params.startDbfs}–${params.endDbfs} dBFS`;
  return `Sweep ${params.startHz}–${params.endHz} Hz`;
}

/** Add a program (+ its result trace under the same id); returns the id. */
export function addProgram(
  store: Store<AppState>,
  kind: "thd" | "fr" | "wowflutter" | "script"
): string {
  const s = store.get();
  let id = `prog-${nextProgId++}`;
  while (s.programs.byId[id] || s.traces.byId[id]) id = `prog-${nextProgId++}`;

  const program: ProgramMeta =
    kind === "script"
      ? {
          id,
          kind: "script",
          run: "idle",
          progress: null,
          startedAtMs: null,
          deviceSlot: null,
          runKey: null,
          source: DEFAULT_MEASURE_SCRIPT,
          role: "source",
        }
      : {
          id,
          kind: "sweep",
          run: "idle",
          progress: null,
          startedAtMs: null,
          deviceSlot: null,
          runKey: null,
          params: {
            ...DEFAULT_SWEEP_PARAMS,
            measurement: kind,
            // A 1 s capture (the shared default, fine for FR's chirp) barely
            // covers 4 cycles of a 4 Hz wow — 4 s gives a meaningfully
            // averaged reading (the original one-shot dialog's own default).
            ...(kind === "wowflutter" ? { durationS: 4 } : {}),
          },
          // Always present from creation (like `startedAtMs` above), even
          // for thd/fr where it's never meaningful — NOT left `undefined`,
          // which `persist.ts`'s migrate() would then add as `null` on the
          // very first load and break the save→load digest round-trip.
          wowResult: null,
        };
  const label =
    program.kind === "sweep" ? sweepLabel(program.params) : `Script ${nextProgId - 1}`;
  const trace: TraceMeta = {
    id,
    label,
    color: nextTraceColor(s),
    source: { kind: "program" },
    domains: [],
    seq: 0,
    offsetDb: null,
    capture: null,
  };
  store.update("programs/add", (st) => ({
    ...st,
    programs: {
      order: [...st.programs.order, id],
      byId: { ...st.programs.byId, [id]: program },
    },
    traces: {
      order: [...st.traces.order, id],
      byId: { ...st.traces.byId, [id]: trace },
    },
  }));
  return id;
}

/** Remove an idle program and its result trace everywhere. */
export function removeProgram(store: Store<AppState>, ipc: Ipc, id: string): void {
  const prog = store.get().programs.byId[id];
  if (!prog || prog.run === "running") return; // stop it first
  store.update("programs/remove", (s) => {
    const byId = { ...s.programs.byId };
    delete byId[id];
    return {
      ...s,
      programs: { order: s.programs.order.filter((p) => p !== id), byId },
    };
  });
  removeTraceEverywhere(store, id);
  syncAllStreams(store, ipc); // its tile memberships left the fd budget
}

function patchProgram(
  store: Store<AppState>,
  action: string,
  id: string,
  fn: (p: ProgramMeta) => ProgramMeta
): void {
  store.update(action, (s) => {
    const p = s.programs.byId[id];
    if (!p) return s;
    return { ...s, programs: { ...s.programs, byId: { ...s.programs.byId, [id]: fn(p) } } };
  });
}

function setTraceLabel(store: Store<AppState>, id: string, label: string): void {
  store.update("programs/label", (s) => {
    const t = s.traces.byId[id];
    if (!t || t.label === label) return s;
    return {
      ...s,
      traces: { ...s.traces, byId: { ...s.traces.byId, [id]: { ...t, label } } },
    };
  });
}

/** Reconfigure a sweep program; the label follows the params until the user
 * renames it by hand (a name left at the old auto-label stays auto).
 *
 * Converting INTO wow & flutter (issue #28 second-pass review finding #8)
 * from THD/FR carries over whatever `durationS` those measurements had —
 * their shared default is 1 s, which barely covers 4 cycles of a 4 Hz wow.
 * Bump it to 4 s on the conversion itself, same as a fresh wowflutter
 * program gets from `addProgram` — but only if the user hasn't already
 * dialed in something longer (never overwrite an explicit choice). */
export function configureSweepProgram(
  store: Store<AppState>,
  id: string,
  cfg: { label: string; params: SweepProgramParams }
): void {
  const prog = store.get().programs.byId[id];
  if (prog?.kind !== "sweep") return;
  const oldAuto = sweepLabel(prog.params);
  const convertingToWowFlutter =
    cfg.params.measurement === "wowflutter" && prog.params.measurement !== "wowflutter";
  const params: SweepProgramParams =
    convertingToWowFlutter && cfg.params.durationS < 2
      ? { ...cfg.params, durationS: 4 }
      : { ...cfg.params };
  patchProgram(store, "programs/configure-sweep", id, (p) =>
    p.kind === "sweep" ? { ...p, params } : p
  );
  const custom = cfg.label.trim();
  setTraceLabel(
    store,
    id,
    custom === "" || custom === oldAuto ? sweepLabel(params) : custom
  );
}

/** Pin a program to a device SLOT — null follows the focus (the ⚙ dialogs'
 * Device row, issue #25 lot F4). Refused while running: the live run's
 * binding is `runKey`, captured at entry, and must not be re-aimed under
 * it. */
export function setProgramDeviceSlot(
  store: Store<AppState>,
  id: string,
  slot: number | null
): void {
  const prog = store.get().programs.byId[id];
  if (!prog || prog.run === "running") return;
  patchProgram(store, "programs/device-slot", id, (p) => ({ ...p, deviceSlot: slot }));
}

/** Reconfigure a script program (source + name); the role tracks the text. */
export function configureScriptProgram(
  store: Store<AppState>,
  id: string,
  cfg: { label: string; source: string }
): void {
  const prog = store.get().programs.byId[id];
  if (prog?.kind !== "script") return;
  patchProgram(store, "programs/configure-script", id, (p) =>
    p.kind === "script"
      ? { ...p, source: cfg.source, role: classifyScriptRole(cfg.source) }
      : p
  );
  if (cfg.label.trim()) setTraceLabel(store, id, cfg.label.trim());
}

/** Why the transports are locked right now, or null. Names the running
 * program so panels grey their controls with a reason (v1 Phase H).
 * `key` scopes the question to one SESSION (issue #25 lot F3 — a program
 * on A must not grey a source pinned to B); defaults to the focused one,
 * so every historical caller reads unchanged. F4's per-device program rows
 * inherit this helper (the F1 bookkeeping). */
export function programLockReason(s: AppState, key?: SessionKey): string | null {
  const id = session(s, key ?? s.devices.focus)?.run.programLock ?? null;
  if (id === null) return null;
  const label = s.traces.byId[id]?.label ?? "program";
  return `measurement "${label}" is running`;
}

/* ------------------------------------------------------------------ */
/* Running                                                             */
/* ------------------------------------------------------------------ */

/** Freshness counter for program results (program traces only — the stream
 * ingest has its own; stamps are compared per trace id, never across). */
let progSeq = 0;

const sweepCancel = new Set<string>();

/** `sessionArgs` re-read FRESH at each wire call, refusing a key that lost
 * its routing identity mid-run (adversarial review MUST-FIX #1): a slot ≥ 1
 * session evicted between a program's passes (unplug, group ✕ on another
 * surface, an enumeration clearing the adopted id) would otherwise reduce
 * to `{}` — and the NEXT invoke would silently drive the DEFAULT runtime's
 * converter (a both-channels THD sweep landing Left from device B and
 * Right from device A in one trace, stimulus included). The throw lands in
 * runProgram's catch → "Program failed: …" and the finally cleans up. */
function routedArgs(store: Store<AppState>, key: SessionKey): { deviceId?: string } {
  const s = store.get();
  if (!isRoutable(s, key) || !session(s, key)) {
    throw new Error("the device this program runs on is no longer available");
  }
  return sessionArgs(s, key);
}

/** The in-flight script run: trace id, the session it runs against
 * (progressively landed frames must stamp THAT session's identity, wherever
 * the focus has moved meanwhile), and the `script-state` resolver. ONE
 * record per run, never three parallel globals (issue #25 lot F4, the F1
 * review's eviction-window finding: a second script started while the first
 * run's session was evicted overwrote the globals piecemeal and script #1's
 * runProgram never resolved — now a second start refuses, and the `finally`
 * only clears its OWN record). */
interface ActiveScript {
  id: string;
  key: SessionKey;
  done: ((error: string | null) => void) | null;
}
let activeScript: ActiveScript | null = null;

/** The capture snapshot a program result lands with (issue #40): device
 * identity, the instant, and — for a sweep — the params that produced the
 * curve. EVERYTHING else stays null, deliberately (review finding #4): a
 * program run writes registers behind the frontend's back (`apply_config`,
 * `auto_level`, the Rhai `set_*` verbs — "Nothing is restored"), so the
 * UI-cached rate/ranges/offsets describe the bench BEFORE the run, not the
 * one that produced the curve; and it captures with its own fft/window,
 * not the live stream's settings. Unknown, never guessed — the frame-side
 * truths (`trace_sample_rate_hz`) keep coming from the frame. */
function programCapture(
  s: AppState,
  key: SessionKey,
  capturedAt: string,
  params?: SweepProgramParams
): CaptureProvenance {
  // The PROGRAM's session, never the focused one (Raphaël's lot-F1
  // validation found programs running under a moved focus): a curve
  // captured on device B must carry B's identity even if the user focused
  // A meanwhile — the four-offsets bug class, in provenance form.
  const info = session(s, key)?.device.info ?? null;
  return {
    device: info
      ? {
          model: info.model,
          serial: info.serial,
          firmware: info.firmware_version,
          isVirtual: info.is_virtual,
        }
      : null,
    sampleRateHz: null,
    inputRangeDbv: null,
    outputRangeDbv: null,
    offsets: null,
    fftSize: null,
    window: null,
    averaging: null,
    capturedAt,
    ...(params ? { programParams: { ...params } } : {}),
  };
}

/** Land program frames: cache first, then seq/domains in one update. */
function landProgramFrames(
  store: Store<AppState>,
  id: string,
  frames: {
    td?: ReturnType<typeof wireToTd>;
    fd?: ReturnType<typeof wireToFd>;
    sweep?: DecodedSweep;
  },
  key: SessionKey,
  params?: SweepProgramParams
): void {
  const seq = ++progSeq;
  if (!putFrames(id, seq, frames)) return;
  clearMeasures(id);
  const domains: Domain[] = [];
  if (frames.td) domains.push("td");
  if (frames.fd) domains.push("fd");
  if (frames.sweep) domains.push("sweep");
  // Built OUTSIDE the reducer (clock impurity stays out of store.update).
  // `key` is REQUIRED — the old focus fallback let a late script frame
  // stamp the focused device's identity onto another device's curve (lot
  // F4, closing the F1 residual).
  const capture = programCapture(store.get(), key, new Date().toISOString(), params);
  store.update("programs/land", (s) => {
    const t = s.traces.byId[id];
    if (!t) return s;
    return {
      ...s,
      traces: { ...s.traces, byId: { ...s.traces.byId, [id]: { ...t, seq, domains, capture } } },
    };
  });
}

/** Run a THD-vs-freq/level, FR, or wow & flutter "sweep" through the
 * existing backend programs. Wow & flutter (issue #28 second pass) isn't
 * swept in the usual sense — one capture, one deviation spectrum — but its
 * result is exactly a curve (modulation rate Hz vs % deviation), so it
 * lands through the SAME sweep-frame path as THD/FR: freezable, comparable,
 * persisted, no bespoke rendering. */
async function runSweep(
  store: Store<AppState>,
  ipc: Ipc,
  id: string,
  key: SessionKey
): Promise<void> {
  const prog = store.get().programs.byId[id];
  if (prog?.kind !== "sweep") return;
  const p = prog.params;
  const label = store.get().traces.byId[id]?.label ?? id;
  const wantL = p.channel === "left" || p.channel === "both";
  const wantR = p.channel === "right" || p.channel === "both";
  toast(store, "info", `${sweepKindLabel(p)} "${label}" started…`);

  let freqs: number[] = [];
  const curves: SweepCurve[] = [];
  // The x/y-axis units landed on the FRAME (issue #27 review finding #1,
  // issue #28 second-pass review finding #5), read from the backend's OWN
  // account — never from the requested params, which can go stale (axis
  // changed in the dialog without a re-run) or vanish entirely (frozen ❄ /
  // program deleted) while the frame outlives them. "rateHz" (finding #3)
  // is wow & flutter's OWN x-axis, distinct from stimulus "Hz".
  let xUnit: "Hz" | "dBFS" | "rateHz" = "Hz";
  let yUnit: "dB" | "%" = "dB";
  // Wow & flutter's scalar readout (weighted/unweighted %, peak, static
  // offset) — not a point on the curve, landed on the program itself
  // alongside the frame (review point 4).
  let wowResult: WowFlutterProgramResult | null = null;

  if (p.measurement === "fr") {
    const traces = await ipc.call("measure_frequency_response_multi", {
      startFreq: p.startHz,
      endFreq: p.endHz,
      driveLeft: wantL,
      driveRight: wantR,
      wantLeft: wantL,
      wantRight: wantR,
      durationSecs: p.durationS,
      amplitudeDbfs: p.levelDbfs,
      ...routedArgs(store, key),
    });
    if (traces.length === 0) throw new Error("no frequency-response trace returned");
    freqs = traces[0].data.frequencies;
    for (const tr of traces) {
      curves.push({
        label: tr.channel,
        values: tr.data.magnitudes_db,
        phase_deg: tr.data.phases,
      });
    }
  } else if (p.measurement === "wowflutter") {
    const outCh: "Left" | "Right" = p.wowOutputChannel === "right" ? "Right" : "Left";
    const inCh: "Left" | "Right" = p.wowInputChannel === "right" ? "Right" : "Left";
    const res = await ipc.call("measure_wow_flutter", {
      referenceFreq: p.wowReferenceHz,
      durationSecs: p.durationS,
      outputChannel: outCh,
      inputChannel: inCh,
      generate: p.wowGenerate,
      ...routedArgs(store, key),
    });
    // "rateHz", not "Hz": a DIFFERENT quantity (modulation rate, not
    // stimulus frequency) with its own axis floor (findings #3/#7) — never
    // shares an axis with an actual frequency sweep sharing a tile.
    xUnit = "rateHz";
    yUnit = "%";
    // Drop the DC (0 Hz) bin: it's a real backend sample, but 0 has no
    // place on a log axis — the same reason the old standalone dialog's
    // own plot skipped it.
    const pts = res.rate_hz
      .map((hz, i) => ({ hz, pct: res.spectrum_percent[i] ?? 0 }))
      .filter((pt) => pt.hz > 0);
    freqs = pts.map((pt) => pt.hz);
    curves.push({ label: inCh, values: pts.map((pt) => pt.pct), phase_deg: null });
    wowResult = {
      weightedPercent: res.weighted_rms_percent,
      unweightedPercent: res.unweighted_rms_percent,
      peakPercent: res.peak_weighted_percent,
      staticOffsetHz: res.static_offset_hz,
      referenceFreqUsed: res.reference_freq,
    };
  } else {
    // THD is single-channel; run once per requested channel.
    const chans: ("Left" | "Right")[] =
      p.channel === "both" ? ["Left", "Right"] : [wantR ? "Right" : "Left"];
    for (const ch of chans) {
      if (sweepCancel.has(id)) break;
      const res =
        p.axis === "level"
          ? await ipc.call("measure_thd_vs_level", {
              startLevelDbfs: p.startDbfs,
              endLevelDbfs: p.endDbfs,
              numPoints: p.points,
              frequencyHz: p.toneHz,
              outputChannel: ch,
              inputChannel: ch,
              ...routedArgs(store, key),
            })
          : await ipc.call("measure_thd_vs_frequency", {
              startFreq: p.startHz,
              endFreq: p.endHz,
              numPoints: p.points,
              amplitudeDbfs: p.levelDbfs,
              outputChannel: ch,
              inputChannel: ch,
              ...routedArgs(store, key),
            });
      // The sweep frame's x-axis is generic (freqs field, any swept
      // quantity) — level_dbfs for a level-axis sweep, frequency otherwise.
      // `res.swept` is the backend's OWN account of what it actually swept,
      // not the request — the authoritative source for both the field pick
      // and the unit landed on the frame.
      xUnit = res.swept === "level" ? "dBFS" : "Hz";
      yUnit = p.metric === "thd_percent" ? "%" : "dB";
      freqs = res.points.map((pt) => (res.swept === "level" ? pt.level_dbfs : pt.frequency));
      curves.push({
        label: ch,
        values: res.points.map((pt) =>
          p.metric === "thd_percent"
            ? pt.thd_percent
            : p.metric === "thdn_db"
              ? pt.thd_n_db
              : pt.thd_db
        ),
        phase_deg: null,
      });
    }
  }

  if (sweepCancel.has(id)) {
    toast(store, "info", `${sweepKindLabel(p)} "${label}" stopped.`);
    return;
  }
  const sweep = wireToSweep({ domain: "sweep", freqs, curves } as Frame, xUnit, yUnit);
  if (sweep) landProgramFrames(store, id, { sweep }, key, p);
  if (wowResult) {
    const result = wowResult;
    patchProgram(store, "programs/wow-result", id, (prog2) =>
      prog2.kind === "sweep" ? { ...prog2, wowResult: result } : prog2
    );
  }
  toast(
    store,
    "success",
    `${sweepKindLabel(p)} "${label}" done (${freqs.length} points).`
  );
}

/** Run a measurement/plot script in the backend engine (one at a time).
 * Emitted frames land progressively via `script-frame`; completion arrives
 * as `script-state` — armed BEFORE the start so a fast script can't finish
 * unobserved. */
async function runScript(
  store: Store<AppState>,
  ipc: Ipc,
  id: string,
  key: SessionKey
): Promise<void> {
  const prog = store.get().programs.byId[id];
  if (prog?.kind !== "script") return;
  const label = store.get().traces.byId[id]?.label ?? id;
  if (activeScript !== null) {
    // Defensive backstop only — runProgram's script gate refuses first
    // (programBlockReason). A second start must NEVER clobber the in-flight
    // run's record: the throw lands in runProgram's catch as a legible
    // failure while script #1 keeps its resolver.
    throw new Error("a script is already running — one script at a time");
  }
  const run: ActiveScript = { id, key, done: null };
  activeScript = run;
  scriptRunLog.append(
    `— "${label}" started ${new Date().toLocaleTimeString()} —`,
    false,
    true
  );
  try {
    const done = new Promise<string | null>((resolve) => {
      run.done = resolve;
    });
    await ipc.call("script_run", {
      source: prog.source,
      role: prog.role,
      ...routedArgs(store, key),
    });
    const error = await done;
    if (error !== null) {
      // A user-initiated Stop surfaces as a termination, not a failure.
      if (error.includes("stopped by user")) toast(store, "info", `Script "${label}" stopped.`);
      else toast(store, "error", `Script "${label}" failed: ${error}`);
    } else {
      toast(store, "success", `Script "${label}" done.`);
    }
  } finally {
    // Only OUR record — a concurrent start refused above, so this can only
    // be `run` or null, but the guard keeps the invariant explicit.
    if (activeScript === run) activeScript = null;
  }
}

/**
 * Start a program under its device's exclusive lock: stop that DAC's
 * current owner, run, then bring the session back exactly as it was.
 */
export async function runProgram(store: Store<AppState>, ipc: Ipc, id: string): Promise<void> {
  const s = store.get();
  const prog = s.programs.byId[id];
  if (!prog || prog.run === "running") return;
  // THE program's session, captured ONCE at entry (Raphaël's lot-F1
  // validation: launching under one focus and finishing under another
  // stranded the lock on the wrong session forever — every keyed read,
  // update and wire call below uses THIS key, wherever the focus moves).
  // Lot F4: the key is the program's OWN resolution — its `deviceSlot` pin,
  // or the focus (`programSessionKey`; `runKey` is null here, the program
  // isn't running) — and the refusal is PER DEVICE (plus the bench-global
  // script gate), so programs on different devices run concurrently.
  const key = programSessionKey(s, prog);
  if (programBlockReason(s, prog) !== null) {
    const deviceBusy = (session(s, key)?.run.programLock ?? null) !== null;
    // The device-busy wording is pinned (programs.test.ts, device-lock.pw.ts)
    // — the historical single-device toast, byte-identical.
    toast(
      store,
      "info",
      deviceBusy
        ? "Another measurement is running — try again once it finishes."
        : "A script is already running — one script at a time."
    );
    return;
  }
  const sess = session(s, key);
  if (sess?.device.status !== "connected") {
    toast(store, "error", "Connect the device first — a program drives the hardware.");
    return;
  }
  if (!isRoutable(s, key)) {
    // Connected but the registry id is not adopted yet (the one-enumeration
    // window) — a different situation than "not connected", said as such
    // (review note #6).
    toast(store, "error", "Device id not adopted yet — retry in a moment.");
    return;
  }
  if (prog.kind === "script" && !prog.source.trim()) {
    toast(store, "error", "The script is empty — edit it via the program's ⚙ first.");
    return;
  }

  const wasStreaming = sess.run.streaming;
  const wasOutputOnly = sess.run.outputOnly && sess.run.generatorRunning;
  // Whether a PLAYING source already resolved audibly onto this session at
  // entry (review MUST-FIX, this lot): the release fan-out below must only
  // deliver routings that APPEARED during the run — an idle session under
  // an already-playing routed source is the user's deliberate Stop, and
  // completion must not undo it (the "resumes exactly what ran" policy).
  const hadAudibleSources = sourcesForSession(s, key).some((r) => r.route !== "off");
  sweepCancel.delete(id);
  store.update("programs/start", (st) =>
    updateRun(
      {
        ...st,
        programs: {
          ...st.programs,
          byId: {
            ...st.programs.byId,
            [id]: {
              ...st.programs.byId[id],
              run: "running",
              progress: null,
              startedAtMs: performance.now(),
              // The run's binding, readable from STATE (tile overlay,
              // progress router, stopProgram) — a follows-focus program
              // keeps it wherever the focus moves (lot F4).
              runKey: key,
            },
          },
        },
      },
      key,
      (r) => ({ ...r, programLock: id })
    )
  );

  try {
    // Hand the device over deterministically: the generator loop first,
    // then the stream loop — `stream_stop` returns only once it fully
    // exited (single-stream hard rule; the device wedges otherwise).
    if (wasOutputOnly) {
      await ipc.call("stop_generator", routedArgs(store, key));
      store.update("programs/generator-stopped", (st) =>
        updateRun(st, key, (r) => ({ ...r, generatorRunning: false }))
      );
    }
    if (wasStreaming || sess.run.stopping) await stopRun(store, ipc, key);

    if (prog.kind === "sweep") await runSweep(store, ipc, id, key);
    else await runScript(store, ipc, id, key);
  } catch (e) {
    // A mid-capture ⏹ rejects the backend command with EXACTLY "sweep
    // cancelled" (THD/FR) or "wow & flutter measurement cancelled" — that's
    // the user's stop, not a failure. A loose substring match here is
    // unsafe (issue #28 second-pass review finding #2): a genuine USB
    // disconnect mid-capture surfaces as e.g. "wow & flutter measurement
    // failed: USB transfer error: transfer was cancelled" (nusb's
    // `TransferError::Cancelled`, wrapped by the backend's generic error
    // path) — that message CONTAINS "cancelled" too, but is a real failure,
    // not a user-initiated stop, and must toast as an error.
    const msg = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
    const isUserCancel = msg === "sweep cancelled" || msg === "wow & flutter measurement cancelled";
    const kindLabel = prog.kind === "sweep" ? sweepKindLabel(prog.params) : "Program";
    if (isUserCancel) toast(store, "info", `${kindLabel} stopped.`);
    else if (msg.includes("A measurement program is already running on this device"))
      // The backend's per-device gate (lot F1) — only reachable around the
      // frontend's own bench-global refusal (a REST/Rhai session holding
      // the device). ERROR kind, not info (review note #4): a mid-run
      // refusal discards the passes already captured (a both-channels
      // sweep's completed Left), and an auto-dismissing toast would hide
      // that loss.
      toast(
        store,
        "error",
        "Program aborted: a measurement is already running on this device — try again once it finishes."
      );
    else toast(store, "error", `Program failed: ${e}`);
  } finally {
    sweepCancel.delete(id);
    store.update("programs/finish", (st) =>
      updateRun(
        {
          ...st,
          programs: {
            ...st.programs,
            byId: {
              ...st.programs.byId,
              ...(st.programs.byId[id]
                ? {
                    [id]: {
                      ...st.programs.byId[id],
                      run: "idle" as const,
                      progress: null,
                      startedAtMs: null,
                      runKey: null,
                    },
                  }
                : {}),
            },
          },
        },
        key,
        (r) => ({ ...r, programLock: null })
      )
    );
    // Resume the session that ran before — the playing flags were never
    // touched, so the same mix comes back (or nothing, if nothing ran).
    // Both resumes are KEYED to the program's session (review note #3: a
    // focus-bound resume after a mid-run focus move would either arm the
    // generator on a different device or strand this one "mode on, DAC
    // silent"); `sync`'s own gates handle an evicted session.
    if (wasOutputOnly) syncOutputOnly(store, ipc, key);
    else if (wasStreaming) void startRun(store, ipc, { sessionKey: key });
    // A session IDLE at program start used to STAY idle whatever happened
    // during the run (the F3 lock-note residual: a routing edit noted
    // "applies when it finishes" was never auto-applied). Gated on the
    // entry snapshot (review MUST-FIX): only a routing that APPEARED
    // during the run arms — an idle session that already had a playing
    // source routed is the user's deliberate Stop, and restarting the DAC
    // into the DUT on program completion would undo it. The arm re-checks
    // every gate itself (connected, no lock, not streaming/output-only).
    // Recorded limit (review note #8): a session in output-only MODE with
    // its generator idle at entry is not armed either way — the arm
    // deliberately never touches output-only sessions.
    else if (!hadAudibleSources) armSessionForSources(store, ipc, key);
    // The I2S port's deferred edits land now too (issue #71 review #3):
    // syncI2s was gated on the program lock for the whole run, so a
    // routing/reference change made mid-run left the port clocking the OLD
    // mix — the row's "applies when it finishes" note must be true for
    // this dimension as well. Unconditional: sync's own gates no-op an
    // off-and-idle port.
    syncI2s(store, ipc, key);
  }
}

/**
 * Expected run time of a sweep, for the panel's acquisition estimate — the
 * backend gives no progress DURING the batched capture (see the
 * thd-sweep-progress note below). THD mirrors run_thd_batch's segment size
 * (N_FFT 32768 + 2×GUARD 2048 samples per point, one pass per channel); FR
 * is its chirp duration. The trailing seconds cover stream startup +
 * analysis. Null = no estimate (scripts run arbitrary code).
 */
export function sweepEstimateSeconds(
  prog: ProgramMeta,
  sampleRate: number
): number | null {
  if (prog.kind !== "sweep") return null;
  const p = prog.params;
  const chans = p.channel === "both" ? 2 : 1;
  if (p.measurement === "fr") return p.durationS + 2;
  if (p.measurement === "wowflutter") {
    // The backend clamps the capture to [1, 15] s regardless of what's
    // asked (`measure_wow_flutter`'s `duration_secs.clamp(1.0, 15.0)`,
    // issue #28 second-pass review finding #4) — an unclamped estimate off
    // a dialog value outside that range would run the progress percentage
    // far past (or well short of) the ACTUAL capture length.
    return Math.min(15, Math.max(1, p.durationS)) + 2;
  }
  const segment = 32768 + 2 * 2048;
  return (chans * p.points * segment) / Math.max(1, sampleRate) + 2;
}

/**
 * The one progress phrase for a RUNNING program — shared by the Programs
 * panel row and the tile overlay so both surfaces always agree: real
 * per-point counts when the backend has them ("12/30"), else a time-based
 * estimate of the one-stream batched capture, else a plain "running…".
 */
export function programProgressText(
  prog: ProgramMeta,
  sampleRate: number,
  nowMs: number
): string {
  if (prog.progress) return `running ${prog.progress}`;
  const est = sweepEstimateSeconds(prog, sampleRate);
  if (est === null || prog.startedAtMs === null) return "running…";
  const pct = Math.min(95, Math.round(((nowMs - prog.startedAtMs) / 1000 / est) * 100));
  return `acquiring… ${pct}%`;
}

/** Stop a running program: a sweep cancels between passes (the backend
 * command itself runs its pass to completion); a script is cancelled at its
 * next operation. */
export function stopProgram(store: Store<AppState>, ipc: Ipc, id: string): void {
  const prog = store.get().programs.byId[id];
  if (!prog || prog.run !== "running") return;
  if (prog.kind === "sweep") {
    // Both halves of the stop: the flag the front checks between passes AND
    // the backend cancel that aborts the in-flight batched capture between
    // USB blocks (maintainer report: ⏹ used to let the whole batch finish).
    // Routed by the program's OWN run binding (`runKey`, lot F4 — with N
    // concurrent programs a lock-holder scan could land on the wrong
    // session; the binding names this run's device, wherever the focus is
    // now). NO arg-less fallback (adversarial review MUST-FIX #2): a
    // binding whose session was evicted mid-run resolves to no live session
    // — an arg-less sweep_stop would trip the DEFAULT runtime's cancel and
    // abort whatever unrelated sweep runs there; the frontend `sweepCancel`
    // flag alone already ends this program's pass loop, and the orphaned
    // invoke dies with its device.
    const s = store.get();
    const key = prog.runKey !== null && session(s, prog.runKey) ? prog.runKey : undefined;
    sweepCancel.add(id);
    // isRoutable guards the sessionArgs THROW (lot F2): stopProgram runs
    // synchronously in a click handler, and a lock-holding session whose
    // adopted id a stale enumeration just cleared must degrade to the
    // frontend flag alone (which already ends the pass loop) — not a dead
    // ⏹ button.
    if (key && isRoutable(s, key)) {
      void ipc.call("sweep_stop", sessionArgs(s, key)).catch(() => {});
    }
    toast(store, "info", "Stopping…");
  } else {
    void ipc.call("script_stop", {}).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* Backend events (script log / frames / completion, sweep progress)   */
/* ------------------------------------------------------------------ */

/** Merge one emitted script frame into the active program trace: the frame
 * lands in its domain slot; other domains are untouched, so progressive
 * multi-domain runs accumulate (v1 applyScriptFrame). A frame with NO
 * active run is DROPPED (lot F4, closing the F1 residual): a late
 * `script-frame` arriving after the run's `finally` used to stamp the
 * FOCUSED session's identity onto the curve — the four-offsets bug class,
 * in provenance form. */
function landScriptFrame(store: Store<AppState>, frame: Frame): void {
  if (!activeScript) return;
  const { id, key } = activeScript;
  const existing = getFrames(id);
  landProgramFrames(
    store,
    id,
    {
      td: frame.domain === "td" ? wireToTd(frame) : existing?.td,
      fd: frame.domain === "fd" ? wireToFd(frame) : existing?.fd,
      sweep: frame.domain === "sweep" ? wireToSweep(frame) : existing?.sweep,
    },
    key
  );
}

/** Mount the backend event listeners (called once from app.ts). */
export function initProgramEvents(store: Store<AppState>): void {
  void listen<{ line: string; error: boolean }>("script-log", (e) => {
    scriptRunLog.append(e.payload.line, e.payload.error);
  });
  void listen<{ running: boolean; error: string | null }>("script-state", (e) => {
    if (!e.payload.running) activeScript?.done?.(e.payload.error ?? null);
  });
  void listen<Frame>("script-frame", (e) => {
    landScriptFrame(store, e.payload);
  });
  void listen<{ done: number; total: number; device_id?: string | null }>(
    "thd-sweep-progress",
    (e) => {
    // The batched sweep captures ALL points in ONE stream (the anti-relay-
    // click design): `done: 0` fires before that long capture and `1..N`
    // only during the fast analysis at the end. Showing "0/30" for the
    // whole capture reads as stuck — drop it; the panel shows a time
    // estimate until real per-point counts arrive.
    if (e.payload.done === 0) return;
    const s = store.get();
    // Routed by the payload's device id onto the running program BOUND to
    // that unit (lot F4 — with N concurrent programs, "the one lock" no
    // longer exists; lot F1 landed the `device_id` field as forward wiring
    // for exactly this). A sweep driven OUTSIDE the UI (REST/Rhai) on a
    // device the UI isn't sweeping matches no program and is dropped
    // (review note #8). The F1 acceptance rule carries over narrowed to
    // the unambiguous case: no payload id (old backend / e2e fake), or an
    // id matching no binding while the LONE running program's session has
    // no adopted id (nothing to discriminate by) ⇒ that one program;
    // ambiguity drops the event rather than risk the wrong row.
    const evId = e.payload.device_id;
    const running = runningPrograms(s);
    let target = typeof evId === "string" ? programForDeviceId(s, evId) : null;
    if (!target && running.length === 1) {
      const holderId =
        session(s, programSessionKey(s, running[0]))?.deviceId ?? null;
      if (typeof evId !== "string" || holderId === null) target = running[0];
    }
    if (!target) return;
    patchProgram(store, "programs/progress", target.id, (p) => ({
      ...p,
      progress: `${e.payload.done}/${e.payload.total}`,
    }));
  });
}

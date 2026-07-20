/**
 * Measurement-program actions (M4) — THE program lock, taken symmetrically
 * (the v1 suspendMixerForProgram policy, restated for the backend loop):
 *
 * A measurement program (sweep / measurement script) owns the device
 * exclusively — the one REAL hardware constraint (a single USB stream).
 * POLICY, deliberate: starting a program STOPS whichever loop owns the DAC
 * (the capture stream, or the gap-free output-only generator) and waits for
 * the backend to acknowledge (`stream_stop` returns only once the loop has
 * fully exited — never splice register I/O into a capture). The sources'
 * `playing` flags are USER INTENT and stay untouched: while the lock is
 * held every transport is disabled WITH THE PROGRAM'S NAME (legible, never
 * silently inert), and completion resumes exactly the session that ran
 * before — a one-shot measurement never costs the user their mix.
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
  ProgramMeta,
  SweepProgramParams,
  TraceMeta,
} from "../state";
import { DEFAULT_SWEEP_PARAMS, nextTraceColor } from "../state";
import { removeTraceEverywhere } from "./traces";
import { startRun, stopRun, syncStream } from "./stream";
import { syncOutputOnly } from "./outputonly";
import { toast } from "./ui";

/* ------------------------------------------------------------------ */
/* Definitions                                                         */
/* ------------------------------------------------------------------ */

let nextProgId = 1;

/** Auto-label for a sweep program, from its params (the e2e specs pin this
 * exact shape — "Sweep 20–20000 Hz"). */
export function sweepLabel(params: SweepProgramParams): string {
  return `${params.measurement === "fr" ? "FR" : "Sweep"} ${params.startHz}–${params.endHz} Hz`;
}

/** Add a program (+ its result trace under the same id); returns the id. */
export function addProgram(
  store: Store<AppState>,
  kind: "thd" | "fr" | "script"
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
          source: DEFAULT_MEASURE_SCRIPT,
          role: "source",
        }
      : {
          id,
          kind: "sweep",
          run: "idle",
          progress: null,
          startedAtMs: null,
          params: { ...DEFAULT_SWEEP_PARAMS, measurement: kind },
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
  syncStream(store, ipc); // its tile memberships left the fd budget
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
 * renames it by hand (a name left at the old auto-label stays auto). */
export function configureSweepProgram(
  store: Store<AppState>,
  id: string,
  cfg: { label: string; params: SweepProgramParams }
): void {
  const prog = store.get().programs.byId[id];
  if (prog?.kind !== "sweep") return;
  const oldAuto = sweepLabel(prog.params);
  patchProgram(store, "programs/configure-sweep", id, (p) =>
    p.kind === "sweep" ? { ...p, params: { ...cfg.params } } : p
  );
  const custom = cfg.label.trim();
  setTraceLabel(
    store,
    id,
    custom === "" || custom === oldAuto ? sweepLabel(cfg.params) : custom
  );
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
 * program so panels grey their controls with a reason (v1 Phase H). */
export function programLockReason(s: AppState): string | null {
  const id = s.run.programLock;
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

/** The in-flight script run's resolver (`script-state` event) + trace id. */
let scriptDone: ((error: string | null) => void) | null = null;
let activeScriptId: string | null = null;

/** Land program frames: cache first, then seq/domains in one update. */
function landProgramFrames(
  store: Store<AppState>,
  id: string,
  frames: {
    td?: ReturnType<typeof wireToTd>;
    fd?: ReturnType<typeof wireToFd>;
    sweep?: DecodedSweep;
  }
): void {
  const seq = ++progSeq;
  if (!putFrames(id, seq, frames)) return;
  clearMeasures(id);
  const domains: Domain[] = [];
  if (frames.td) domains.push("td");
  if (frames.fd) domains.push("fd");
  if (frames.sweep) domains.push("sweep");
  store.update("programs/land", (s) => {
    const t = s.traces.byId[id];
    if (!t) return s;
    return {
      ...s,
      traces: { ...s.traces, byId: { ...s.traces.byId, [id]: { ...t, seq, domains } } },
    };
  });
}

/** Run a THD-vs-freq / FR sweep through the existing backend programs. */
async function runSweep(store: Store<AppState>, ipc: Ipc, id: string): Promise<void> {
  const prog = store.get().programs.byId[id];
  if (prog?.kind !== "sweep") return;
  const p = prog.params;
  const label = store.get().traces.byId[id]?.label ?? id;
  const wantL = p.channel === "left" || p.channel === "both";
  const wantR = p.channel === "right" || p.channel === "both";
  toast(store, "info", `${p.measurement === "fr" ? "FR" : "Sweep"} "${label}" started…`);

  let freqs: number[] = [];
  const curves: SweepCurve[] = [];
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
  } else {
    // THD is single-channel; run once per requested channel.
    const chans: ("Left" | "Right")[] =
      p.channel === "both" ? ["Left", "Right"] : [wantR ? "Right" : "Left"];
    for (const ch of chans) {
      if (sweepCancel.has(id)) break;
      const res = await ipc.call("measure_thd_vs_frequency", {
        startFreq: p.startHz,
        endFreq: p.endHz,
        numPoints: p.points,
        amplitudeDbfs: p.levelDbfs,
        outputChannel: ch,
        inputChannel: ch,
      });
      freqs = res.points.map((pt) => pt.frequency);
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
    toast(store, "info", `Sweep "${label}" stopped.`);
    return;
  }
  const sweep = wireToSweep({ domain: "sweep", freqs, curves } as Frame);
  if (sweep) landProgramFrames(store, id, { sweep });
  toast(
    store,
    "success",
    `${p.measurement === "fr" ? "FR" : "Sweep"} "${label}" done (${freqs.length} points).`
  );
}

/** Run a measurement/plot script in the backend engine (one at a time).
 * Emitted frames land progressively via `script-frame`; completion arrives
 * as `script-state` — armed BEFORE the start so a fast script can't finish
 * unobserved. */
async function runScript(store: Store<AppState>, ipc: Ipc, id: string): Promise<void> {
  const prog = store.get().programs.byId[id];
  if (prog?.kind !== "script") return;
  const label = store.get().traces.byId[id]?.label ?? id;
  activeScriptId = id;
  scriptRunLog.append(
    `— "${label}" started ${new Date().toLocaleTimeString()} —`,
    false,
    true
  );
  try {
    const done = new Promise<string | null>((resolve) => {
      scriptDone = resolve;
    });
    await ipc.call("script_run", { source: prog.source, role: prog.role });
    const error = await done;
    if (error !== null) {
      // A user-initiated Stop surfaces as a termination, not a failure.
      if (error.includes("stopped by user")) toast(store, "info", `Script "${label}" stopped.`);
      else toast(store, "error", `Script "${label}" failed: ${error}`);
    } else {
      toast(store, "success", `Script "${label}" done.`);
    }
  } finally {
    scriptDone = null;
    activeScriptId = null;
  }
}

/**
 * Start a program under the exclusive lock: stop the DAC's current owner,
 * run, then bring the session back exactly as it was.
 */
export async function runProgram(store: Store<AppState>, ipc: Ipc, id: string): Promise<void> {
  const s = store.get();
  const prog = s.programs.byId[id];
  if (!prog || prog.run === "running") return;
  if (s.run.programLock !== null) {
    toast(store, "info", "Another measurement is running — try again once it finishes.");
    return;
  }
  if (s.device.status !== "connected") {
    toast(store, "error", "Connect the device first — a program drives the hardware.");
    return;
  }
  if (prog.kind === "script" && !prog.source.trim()) {
    toast(store, "error", "The script is empty — edit it via the program's ⚙ first.");
    return;
  }

  const wasStreaming = s.run.streaming;
  const wasOutputOnly = s.run.outputOnly && s.run.generatorRunning;
  sweepCancel.delete(id);
  store.update("programs/start", (st) => ({
    ...st,
    run: { ...st.run, programLock: id },
    programs: {
      ...st.programs,
      byId: {
        ...st.programs.byId,
        [id]: {
          ...st.programs.byId[id],
          run: "running",
          progress: null,
          startedAtMs: performance.now(),
        },
      },
    },
  }));

  try {
    // Hand the device over deterministically: the generator loop first,
    // then the stream loop — `stream_stop` returns only once it fully
    // exited (single-stream hard rule; the device wedges otherwise).
    if (wasOutputOnly) {
      await ipc.call("stop_generator", {});
      store.update("programs/generator-stopped", (st) => ({
        ...st,
        run: { ...st.run, generatorRunning: false },
      }));
    }
    if (wasStreaming || s.run.stopping) await stopRun(store, ipc);

    if (prog.kind === "sweep") await runSweep(store, ipc, id);
    else await runScript(store, ipc, id);
  } catch (e) {
    // A mid-capture ⏹ rejects the backend command with "sweep cancelled" —
    // that's the user's stop, not a failure.
    if (String(e).includes("sweep cancelled")) toast(store, "info", "Sweep stopped.");
    else toast(store, "error", `Program failed: ${e}`);
  } finally {
    sweepCancel.delete(id);
    store.update("programs/finish", (st) => ({
      ...st,
      run: { ...st.run, programLock: null },
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
                },
              }
            : {}),
        },
      },
    }));
    // Resume the session that ran before — the playing flags were never
    // touched, so the same mix comes back (or nothing, if nothing ran).
    if (wasOutputOnly) syncOutputOnly(store, ipc);
    else if (wasStreaming) void startRun(store, ipc);
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
    sweepCancel.add(id);
    void ipc.call("sweep_stop", {}).catch(() => {});
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
 * multi-domain runs accumulate (v1 applyScriptFrame). */
function landScriptFrame(store: Store<AppState>, frame: Frame): void {
  const id = activeScriptId;
  if (!id) return;
  const existing = getFrames(id);
  landProgramFrames(store, id, {
    td: frame.domain === "td" ? wireToTd(frame) : existing?.td,
    fd: frame.domain === "fd" ? wireToFd(frame) : existing?.fd,
    sweep: frame.domain === "sweep" ? wireToSweep(frame) : existing?.sweep,
  });
}

/** Mount the backend event listeners (called once from app.ts). */
export function initProgramEvents(store: Store<AppState>): void {
  void listen<{ line: string; error: boolean }>("script-log", (e) => {
    scriptRunLog.append(e.payload.line, e.payload.error);
  });
  void listen<{ running: boolean; error: string | null }>("script-state", (e) => {
    if (!e.payload.running) scriptDone?.(e.payload.error ?? null);
  });
  void listen<Frame>("script-frame", (e) => {
    landScriptFrame(store, e.payload);
  });
  void listen<{ done: number; total: number }>("thd-sweep-progress", (e) => {
    // The batched sweep captures ALL points in ONE stream (the anti-relay-
    // click design): `done: 0` fires before that long capture and `1..N`
    // only during the fast analysis at the end. Showing "0/30" for the
    // whole capture reads as stuck — drop it; the panel shows a time
    // estimate until real per-point counts arrive.
    if (e.payload.done === 0) return;
    const s = store.get();
    const id = s.run.programLock;
    if (!id || s.programs.byId[id]?.run !== "running") return;
    patchProgram(store, "programs/progress", id, (p) => ({
      ...p,
      progress: `${e.payload.done}/${e.payload.total}`,
    }));
  });
}

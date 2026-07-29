/**
 * Workspace persistence (M5) — WS v5.
 *
 * The document IS the serializable subset of AppState (plan §3.1): sources /
 * traces / programs / layout / acquisition + the workspace name and collapsed
 * panels. Frame data lives outside the store (data/frames.ts) and only the
 * frozen ❄ memory traces carry theirs in the document (`refFrames`) — live
 * endpoints re-acquire, transforms recompute, program results re-run.
 *
 * Versioning: v1→v4 are the LEGACY frontend's blobs (src/dashboard/store.ts);
 * their upgrade chain is ported here verbatim, then `importV4()` maps the v4
 * shape (graphs/series/trace-defs) onto the v2 state shape. v5 is the native
 * document. `migrate()` accepts any of them.
 *
 * Storage moved to IndexedDB (issue #44 lot 1, wsstore.ts) — this module
 * keeps only the DOCUMENT logic (snapshot / migrate / frame codecs) plus
 * the LEGACY v1-frontend localStorage keys, still read-only: the old page
 * owns those blobs and v2 never writes or deletes them. The old v2
 * localStorage keys (`qa40x-v2-ws-*`) are imported into IndexedDB once at
 * first open, then removed (wsstore.ts).
 */
import type { Frame, TransformStep, UserWeightingCurve } from "../gen";
import { classifyScriptRole } from "../core/scriptrole";
import { getFrames, wireToFd, wireToSweep, wireToTd, type TraceFrames } from "../data/frames";
import { measureByKey } from "../core/measure";
import { sanitizeUserCurve } from "../core/weightingcurve";
import type { FdUnit, TdUnit, TraceId } from "../core/model";
import type {
  AcquisitionState,
  AppState,
  CaptureProvenance,
  ExtraTone,
  LayoutPattern,
  LayoutState,
  ProgramMeta,
  ProgramsState,
  SourceMeta,
  SourcesState,
  SweepProgramParams,
  TileConfig,
  TraceMeta,
  TracesState,
  TriggerSettings,
} from "./state";
import {
  defaultTile,
  DEFAULT_SWEEP_PARAMS,
  HW_TRACE_IDS,
  hwSlotOfTraceId,
  initialState,
  initialTraces,
  nextTraceColor,
  patternTileCount,
} from "./state";

export const WS_VERSION = 5;

/** The legacy (v1 frontend) keys — read-only from here. */
const LEGACY_CURRENT_KEY = "qa40x-dash-current";
const LEGACY_SAVED_PREFIX = "qa40x-dash-ws:";

/* ------------------------------------------------------------------ */
/* Document shape                                                      */
/* ------------------------------------------------------------------ */

/** A memory trace's persisted frames — the wire `Frame` shapes (plain
 * arrays), exactly what the frames cache decodes from. */
export interface PersistedFrames {
  td?: Frame;
  fd?: Frame;
  sweep?: Frame;
  /** The sweep's x-axis unit (issue #27 review finding #1; "rateHz" added
   * issue #28 second pass) — travels WITH the frame (`DecodedSweep.xUnit`),
   * not re-derived from the program on load (a frozen ❄ memory trace has
   * none, and program params can go stale). Absent for pre-#27 docs —
   * `docToFrames` leaves it undefined and chartvm.ts's `sweepXUnit` falls
   * back to "Hz". */
  sweepXUnit?: "Hz" | "dBFS" | "rateHz";
  /** The sweep's y-axis unit (issue #28 second pass review finding #5) —
   * travels WITH the frame for the same reason as `sweepXUnit`: a frozen ❄
   * wow & flutter trace must still read "%" after a reload, not fall back
   * to "dB" because its originating program is gone. Absent for docs
   * predating this field — `sweepUnitLabel` falls back to the program. */
  sweepYUnit?: "dB" | "%";
}

export interface WorkspaceDoc {
  version: typeof WS_VERSION;
  name: string;
  collapsed: string[];
  acquisition: AcquisitionState;
  sources: SourcesState;
  traces: TracesState;
  programs: ProgramsState;
  layout: LayoutState;
  /** Frozen ❄ memory-trace data, keyed by trace id. */
  refFrames: Record<TraceId, PersistedFrames>;
  /** Per-endpoint trigger settings (Lot A, issue #26), keyed by the
   * endpoint's slot-scoped trace id (lot E3: `hw-in-left` & co for slot 0,
   * `hw-in-left@1` & co beyond — so the doc persists the SLOT, never a
   * device id). `armEpoch` is normalized to 0 on save/load — a SINGLE arm
   * is a live-session gesture, never a saved-bench fact. */
  triggers: Record<TraceId, TriggerSettings>;
  /** The bench's loaded user weighting curve (issue #29), or null if none
   * was ever imported. `userWeightingCurveName` is display-only. */
  userWeightingCurve: UserWeightingCurve | null;
  userWeightingCurveName: string | null;
}

function framesToDoc(f: TraceFrames): PersistedFrames {
  const out: PersistedFrames = {};
  if (f.td) {
    out.td = {
      domain: "td",
      sample_rate: f.td.sampleRate,
      t0: 0,
      samples: Array.from(f.td.samples),
    };
  }
  if (f.fd) {
    out.fd = {
      domain: "fd",
      freqs: Array.from(f.fd.freqs),
      mag_db: Array.from(f.fd.magDb),
      phase_deg: null,
    };
  }
  if (f.sweep) {
    out.sweep = {
      domain: "sweep",
      freqs: Array.from(f.sweep.freqs),
      curves: f.sweep.curves.map((c) => ({
        label: c.label,
        values: Array.from(c.values),
        phase_deg: c.phaseDeg ? Array.from(c.phaseDeg) : null,
      })),
    };
    if (f.sweep.xUnit) out.sweepXUnit = f.sweep.xUnit;
    if (f.sweep.yUnit) out.sweepYUnit = f.sweep.yUnit;
  }
  return out;
}

/** Decode a document's persisted frames back into cache form. */
export function docToFrames(p: PersistedFrames): {
  td?: ReturnType<typeof wireToTd>;
  fd?: ReturnType<typeof wireToFd>;
  sweep?: ReturnType<typeof wireToSweep>;
} {
  return {
    td: p.td ? wireToTd(p.td) : undefined,
    fd: p.fd ? wireToFd(p.fd) : undefined,
    sweep: p.sweep ? wireToSweep(p.sweep, p.sweepXUnit, p.sweepYUnit) : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Snapshot: state → document                                          */
/* ------------------------------------------------------------------ */

/**
 * The persistable projection of the state tree. Transients are normalized
 * OUT here (not at load) so the auto-saved document is stable: nothing
 * plays, no program runs, no tile is focused, live seqs/domains are zeroed.
 * Memory traces keep seq 1 + domains + their baked offset, and their frames
 * ride along in `refFrames`.
 */
export function snapshotWorkspace(s: AppState): WorkspaceDoc {
  const sourcesById: Record<string, SourceMeta> = {};
  for (const [id, src] of Object.entries(s.sources.byId)) {
    sourcesById[id] = { ...src, playing: false };
  }

  const tracesById: Record<string, TraceMeta> = {};
  const refFrames: Record<TraceId, PersistedFrames> = {};
  for (const [id, t] of Object.entries(s.traces.byId)) {
    if (t.source.kind === "memory") {
      tracesById[id] = { ...t, seq: 1 };
      const f = getFrames(id);
      if (f) refFrames[id] = framesToDoc(f);
    } else {
      // Live/derived traces re-acquire or recompute on load — their capture
      // snapshot (issue #40) is zeroed with their data, like offsetDb; only
      // the ❄ memory traces above keep theirs (it rides the meta spread).
      //
      // EXCEPTION (lot E4): a slot ≥ 1 ENDPOINT keeps its snapshot. On the
      // next boot its group loads DORMANT (no session exists until an
      // explicit add), and the snapshot's model+serial is precisely what
      // the one-click revive matches against the enumeration
      // (reviveCandidateId — without this, "Connect" stayed greyed after a
      // restart). Harmless staleness: with domains/frames zeroed nothing
      // exports or reads it, and the revive's own mint fresh-slates it
      // (decision B6). Slot 0 keeps the zeroing — its session lives
      // immediately and a stale snapshot could leak into an export in the
      // window before the first frame re-stamps it.
      const dormantIdentity = (hwSlotOfTraceId(id) ?? 0) >= 1 ? t.capture : null;
      tracesById[id] = {
        ...t,
        seq: 0,
        domains: [],
        offsetDb: null,
        capture: dormantIdentity,
      };
    }
  }

  const programsById: Record<string, ProgramMeta> = {};
  for (const [id, p] of Object.entries(s.programs.byId)) {
    programsById[id] = { ...p, run: "idle", progress: null, startedAtMs: null };
  }

  const triggers: Record<TraceId, TriggerSettings> = {};
  for (const [id, t] of Object.entries(s.triggers)) {
    triggers[id] = { ...t, armEpoch: 0 };
  }

  return {
    version: WS_VERSION,
    name: s.workspace.name,
    collapsed: [...s.workspace.collapsed],
    acquisition: { ...s.acquisition, averaging: { ...s.acquisition.averaging } },
    sources: { order: [...s.sources.order], byId: sourcesById },
    traces: { order: [...s.traces.order], byId: tracesById },
    programs: { order: [...s.programs.order], byId: programsById },
    layout: {
      pattern: s.layout.pattern,
      order: [...s.layout.order],
      tiles: { ...s.layout.tiles },
      focus: null,
    },
    refFrames,
    triggers,
    userWeightingCurve: s.weighting.userCurve,
    userWeightingCurveName: s.weighting.userCurveName,
  };
}

/* ------------------------------------------------------------------ */
/* Legacy upgrade chain (v1 → v4) — ported from src/dashboard/store.ts */
/* ------------------------------------------------------------------ */

interface RawTraceDef {
  id?: unknown;
  label?: unknown;
  source?: {
    kind?: string;
    channel?: string;
    input?: unknown;
    steps?: unknown;
    params?: Record<string, unknown>;
  };
  td?: Frame;
  fd?: Frame;
  sweep?: Frame;
}

interface RawV4 {
  version?: number;
  name?: unknown;
  layout?: { pattern?: unknown; slots?: unknown };
  graphs?: unknown;
  traces?: unknown;
  refs?: unknown;
}

function eachTraceDef(ws: RawV4, fix: (def: RawTraceDef) => void): void {
  if (Array.isArray(ws.traces)) ws.traces.forEach(fix);
  if (Array.isArray(ws.refs)) ws.refs.forEach(fix);
}

/** v1 → v2: script traces gained a `role`, classified from their content. */
function upgradeV1(ws: RawV4): void {
  eachTraceDef(ws, (def) => {
    const source = def?.source;
    if (!source || source.kind !== "script" || !source.params) return;
    const params = source.params;
    if (typeof params.source === "string" && params.role === undefined) {
      params.role = classifyScriptRole(params.source);
    }
  });
  ws.version = 2;
}

/** v2 → v3: sine generators gained `extraTones` (the phased tone list). */
function upgradeV2(ws: RawV4): void {
  eachTraceDef(ws, (def) => {
    const source = def?.source;
    if (!source || source.kind !== "generator" || !source.params) return;
    if (source.params.extraTones === undefined) source.params.extraTones = [];
  });
  ws.version = 3;
}

/** v3 → v4 (#49): generators LOSE `analyze`/`capture` (pre-mixer leftovers). */
function upgradeV3(ws: RawV4): void {
  eachTraceDef(ws, (def) => {
    const source = def?.source;
    if (!source || source.kind !== "generator" || !source.params) return;
    delete source.params.analyze;
    delete source.params.capture;
  });
  ws.version = 4;
}

/* ------------------------------------------------------------------ */
/* v4 → v5 importer                                                    */
/* ------------------------------------------------------------------ */

/** Legacy layout pattern → v2 pattern. */
const PATTERN_V4_TO_V5: Record<string, LayoutPattern> = {
  "1": "1",
  "2h": "1x2",
  "2v": "2x1",
  "3": "1x3",
  "2x2": "2x2",
  "6": "2x3",
};

const FD_UNITS: FdUnit[] = ["dbfs", "dbv", "dbu"];

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

/** Map one legacy trace id onto the v2 pool (aliases expand). */
function mapTraceId(id: string): TraceId[] {
  if (id === "hw-in-both") return [HW_TRACE_IDS.inputL, HW_TRACE_IDS.inputR];
  if (id === "dac-output") return [HW_TRACE_IDS.outputL, HW_TRACE_IDS.outputR];
  return [id];
}

/** Legacy generator waveform → a v2 source of the same shape. */
function importGenerator(id: string, label: string, params: Record<string, unknown>): SourceMeta | null {
  const waveform = str(params.waveform, "sine");
  const route = ((): SourceMeta["route"] => {
    const o = str(params.output, "both");
    return o === "left" || o === "right" || o === "off" ? o : "both";
  })();
  const levelDbv = num(params.level, -12);
  const base = { id, label, route, playing: false };
  switch (waveform) {
    case "sine":
    case "square":
    case "triangle":
    case "sawtooth": {
      const extraTones: ExtraTone[] = Array.isArray(params.extraTones)
        ? (params.extraTones as Record<string, unknown>[]).map((t) => ({
            enabled: t.enabled !== false,
            frequencyHz: num(t.frequency, 1000),
            levelDbv: num(t.level, -24),
            phaseDeg: num(t.phase, 0),
          }))
        : [];
      return {
        ...base,
        kind: waveform,
        frequencyHz: num(params.frequency, 1000),
        levelDbv,
        extraTones: waveform === "sine" ? extraTones : [],
      };
    }
    case "multitone":
    case "noise":
    case "chirp":
      return { ...base, kind: waveform, levelDbv };
    default:
      return null;
  }
}

/** Legacy sweep params → v2 program params. */
function importSweepParams(params: Record<string, unknown>): SweepProgramParams {
  const measurement = params.measurement === "fr" ? "fr" : "thd";
  const c = str(params.channel, "left");
  const metric = str(params.metric, "thd_db");
  return {
    measurement,
    // Legacy (v4) sweeps predate the level axis (issue #27) — every one of
    // them was a frequency sweep.
    axis: "frequency",
    channel: c === "right" || c === "both" ? c : "left",
    startHz: num(params.start, DEFAULT_SWEEP_PARAMS.startHz),
    endHz: num(params.end, DEFAULT_SWEEP_PARAMS.endHz),
    levelDbfs: num(params.level, DEFAULT_SWEEP_PARAMS.levelDbfs),
    toneHz: DEFAULT_SWEEP_PARAMS.toneHz,
    startDbfs: DEFAULT_SWEEP_PARAMS.startDbfs,
    endDbfs: DEFAULT_SWEEP_PARAMS.endDbfs,
    // Legacy (v4) sweeps predate wow & flutter as a program kind entirely.
    wowReferenceHz: DEFAULT_SWEEP_PARAMS.wowReferenceHz,
    wowOutputChannel: DEFAULT_SWEEP_PARAMS.wowOutputChannel,
    wowInputChannel: DEFAULT_SWEEP_PARAMS.wowInputChannel,
    wowGenerate: DEFAULT_SWEEP_PARAMS.wowGenerate,
    points: num(params.points, DEFAULT_SWEEP_PARAMS.points),
    durationS: num(params.duration, DEFAULT_SWEEP_PARAMS.durationS),
    metric:
      metric === "thd_percent" || metric === "thdn_db" ? metric : "thd_db",
  };
}

/** Normalize a legacy transform step list onto the generated wire shape. */
function importSteps(steps: unknown, mapRef: (id: string) => TraceId): TransformStep[] {
  if (!Array.isArray(steps)) return [];
  const out: TransformStep[] = [];
  for (const s of steps as Record<string, unknown>[]) {
    switch (s?.type) {
      case "weighting":
        if (s.mode === "a" || s.mode === "c" || s.mode === "riaa") {
          out.push({ type: "weighting", mode: s.mode });
        }
        break;
      case "notch":
        out.push({ type: "notch", freq: num(s.freq, 60), q: typeof s.q === "number" ? s.q : null });
        break;
      case "deconvolve":
        out.push({ type: "deconvolve", ref: mapRef(str(s.ref, "")) });
        break;
      case "script":
        out.push({ type: "script", source: str(s.source, "") });
        break;
    }
  }
  return out;
}

/**
 * Map a legacy v4 workspace blob onto a v5 document. Guarantees: nothing the
 * user can SEE is lost — every source (with params + route), pool trace,
 * program and graph lands in its v2 home. Legacy-only concepts with no v2
 * twin (per-graph transferRef, file traces) are dropped.
 */
export function importV4(ws: RawV4): WorkspaceDoc {
  const base = initialState();
  const traces: TracesState = initialTraces();
  const sources: SourcesState = { order: [], byId: {} };
  const programs: ProgramsState = { order: [], byId: {} };
  const refFrames: Record<TraceId, PersistedFrames> = {};

  // A helper state for color picking as the pool grows.
  const colorState = (): AppState => ({ ...base, traces });

  const addTrace = (meta: TraceMeta): void => {
    traces.order.push(meta.id);
    traces.byId[meta.id] = meta;
  };

  const defs: RawTraceDef[] = Array.isArray(ws.traces) ? (ws.traces as RawTraceDef[]) : [];
  for (const def of defs) {
    const id = str(def.id, "");
    const label = str(def.label, id);
    const source = def.source;
    if (!id || !source || traces.byId[id]) continue;
    switch (source.kind) {
      case "hw_input":
      case "dac":
        break; // the 4 endpoints always exist in v2 (aliases map at use sites)
      case "generator": {
        const src = importGenerator(id, label, source.params ?? {});
        if (src) {
          sources.order.push(id);
          sources.byId[id] = src;
        }
        break;
      }
      case "script": {
        const params = source.params ?? {};
        const text = str(params.source, "");
        if (params.role === "measurement") {
          programs.order.push(id);
          programs.byId[id] = {
            id,
            kind: "script",
            run: "idle",
            progress: null,
            startedAtMs: null,
            source: text,
            role: "measurement",
          };
          addTrace({
            id,
            label: label || str(params.name, "Script"),
            color: nextTraceColor(colorState()),
            source: { kind: "program" },
            domains: [],
            seq: 0,
            offsetDb: null,
            capture: null,
          });
        } else {
          sources.order.push(id);
          sources.byId[id] = {
            id,
            label: label || str(params.name, "Script"),
            route: ((): SourceMeta["route"] => {
              const o = str(params.output, "both");
              return o === "left" || o === "right" || o === "off" ? o : "both";
            })(),
            playing: false,
            kind: "script",
            source: text,
          };
        }
        break;
      }
      case "sweep": {
        programs.order.push(id);
        programs.byId[id] = {
          id,
          kind: "sweep",
          run: "idle",
          progress: null,
          startedAtMs: null,
          params: importSweepParams(source.params ?? {}),
          // Always present, never left `undefined` — see `addProgram`'s
          // same comment (a re-saved-then-reloaded import must digest
          // identically; migrate() only fills a field that's MISSING).
          wowResult: null,
        };
        addTrace({
          id,
          label,
          color: nextTraceColor(colorState()),
          source: { kind: "program" },
          domains: [],
          seq: 0,
          offsetDb: null,
          capture: null,
        });
        break;
      }
      case "transform": {
        const input = mapTraceId(str(source.input, HW_TRACE_IDS.inputL))[0];
        addTrace({
          id,
          label,
          color: nextTraceColor(colorState()),
          source: {
            kind: "transform",
            input,
            steps: importSteps(source.steps, (r) => mapTraceId(r)[0]),
          },
          domains: [],
          seq: 0,
          offsetDb: null,
          capture: null,
        });
        break;
      }
      default:
        break; // "file" (legacy stub), unknown kinds: nothing to restore
    }
  }

  // Frozen references: full data rides in the blob. Legacy frames are stored
  // in DISPLAY-absolute units (offsets applied at ingest in v1), so the v2
  // meta gets offsetDb 0 — identity, already absolute.
  const refs: RawTraceDef[] = Array.isArray(ws.refs) ? (ws.refs as RawTraceDef[]) : [];
  for (const ref of refs) {
    const id = str(ref.id, "");
    if (!id || traces.byId[id]) continue;
    const domains: TraceMeta["domains"] = [];
    const frames: PersistedFrames = {};
    if (ref.td?.domain === "td") {
      frames.td = ref.td;
      domains.push("td");
    }
    if (ref.fd?.domain === "fd") {
      frames.fd = ref.fd;
      domains.push("fd");
    }
    if (ref.sweep?.domain === "sweep") {
      frames.sweep = ref.sweep;
      domains.push("sweep");
    }
    if (domains.length === 0) continue;
    addTrace({
      id,
      label: str(ref.label, id),
      color: nextTraceColor(colorState()),
      source: { kind: "memory", frozenFrom: id },
      domains,
      seq: 1,
      offsetDb: 0,
      capture: null,
    });
    refFrames[id] = frames;
  }

  // Graphs → tiles, in slot order (unslotted graphs append after).
  const pattern =
    PATTERN_V4_TO_V5[str(ws.layout?.pattern, "1")] ?? ("1" as LayoutPattern);
  const rawGraphs: Record<string, unknown>[] = Array.isArray(ws.graphs)
    ? (ws.graphs as Record<string, unknown>[])
    : [];
  const slots: (string | null)[] = Array.isArray(ws.layout?.slots)
    ? (ws.layout!.slots as (string | null)[])
    : [];
  const graphOrder: Record<string, unknown>[] = [];
  for (const slot of slots) {
    const g = rawGraphs.find((x) => x.id === slot);
    if (g && !graphOrder.includes(g)) graphOrder.push(g);
  }
  for (const g of rawGraphs) if (!graphOrder.includes(g)) graphOrder.push(g);

  const layout: LayoutState = { pattern, order: [], tiles: {}, focus: null };
  for (const g of graphOrder) {
    const id = str(g.id, `tile-${layout.order.length + 1}`);
    if (layout.tiles[id]) continue;
    const domain = str(g.domain, "fd");
    const kind = domain === "td" ? "scope" : domain === "sweep" ? "sweep" : "spectrum";

    const memberIds: TraceId[] = [];
    const hidden: TraceId[] = [];
    const hiddenCurves: Record<TraceId, string[]> = {};
    const series: Record<string, unknown>[] = Array.isArray(g.series)
      ? (g.series as Record<string, unknown>[])
      : [];
    for (const ref of series) {
      for (const tid of mapTraceId(str(ref.traceId, ""))) {
        if (!traces.byId[tid] || memberIds.includes(tid)) continue;
        memberIds.push(tid);
        if (ref.hidden === true) hidden.push(tid);
        if (Array.isArray(ref.hiddenCurves) && ref.hiddenCurves.length > 0) {
          hiddenCurves[tid] = (ref.hiddenCurves as unknown[]).map((c) => String(c));
        }
      }
    }

    const y = (g.y ?? {}) as Record<string, unknown>;
    const x = (g.x ?? {}) as Record<string, unknown>;
    const unit = str(g.unit, "dbv");
    const scopeUnit = str(g.scopeUnit, "v");
    const measures = Array.isArray(g.measurements)
      ? (g.measurements as unknown[]).map(String).filter((k) => measureByKey(k))
      : defaultTile(id, kind).measures;
    const chip = str(g.measureTraceId, "");

    const tile: TileConfig = {
      ...defaultTile(id, kind, memberIds),
      hidden,
      hiddenCurves,
      measures,
      chipSource: chip && traces.byId[chip] ? chip : "auto",
      fdUnit: (FD_UNITS as string[]).includes(unit) ? (unit as FdUnit) : "dbv",
      tdUnit: scopeUnit === "mv" ? "mv" : scopeUnit === "fs" ? "pctfs" : ("v" as TdUnit),
      axis: {
        xLog: x.log !== false,
        yAuto: y.autoscale !== false,
        yMin: num(y.min, -140),
        yMax: num(y.max, 10),
        dbrEnabled: g.dualAxis === true,
        dbrRefDb: typeof g.dbrRef === "number" ? g.dbrRef : null,
      },
      showPhase: g.showPhase === true,
      // Not a v4 concept — the marker toggle arrives with v2 (M6).
      showHarmonics: false,
    };
    layout.tiles[id] = tile;
    layout.order.push(id);
  }
  // The pattern always has its full complement of tiles.
  let serial = 0;
  while (layout.order.length < patternTileCount(pattern)) {
    serial += 1;
    const id = `tile-v4-${serial}`;
    if (layout.tiles[id]) continue;
    layout.tiles[id] = defaultTile(id);
    layout.order.push(id);
  }

  return {
    version: WS_VERSION,
    name: str(ws.name, "Imported"),
    collapsed: [],
    acquisition: base.acquisition,
    sources,
    traces,
    programs,
    layout,
    refFrames,
    // Not a v4 concept — the trigger arrives with Lot A (issue #26).
    triggers: {},
    // Not a v4 concept either (issue #29).
    userWeightingCurve: null,
    userWeightingCurveName: null,
  };
}

/**
 * Validate a loaded capture snapshot (issue #40) field by field: every
 * malformed field degrades to its "unknown" value (null / absent marker), a
 * non-object degrades to no snapshot at all. Never throws — the same
 * contract as `sanitizeUserCurve`.
 */
export function sanitizeCapture(raw: unknown): CaptureProvenance | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const numOrNull = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;

  let device: CaptureProvenance["device"] = null;
  if (c.device && typeof c.device === "object") {
    const d = c.device as Record<string, unknown>;
    if (typeof d.model === "string" && typeof d.serial === "string") {
      device = {
        model: d.model,
        serial: d.serial,
        firmware: numOrNull(d.firmware),
        isVirtual: d.isVirtual === true,
      };
    }
  }

  let offsets: CaptureProvenance["offsets"] = null;
  if (c.offsets && typeof c.offsets === "object") {
    const o = c.offsets as Record<string, unknown>;
    const il = numOrNull(o.input_l);
    const ir = numOrNull(o.input_r);
    const ol = numOrNull(o.output_l);
    const or = numOrNull(o.output_r);
    if (il !== null && ir !== null && ol !== null && or !== null) {
      offsets = {
        input_l: il,
        input_r: ir,
        output_l: ol,
        output_r: or,
        calibrated: o.calibrated === true,
      };
    }
  }

  let averaging: CaptureProvenance["averaging"] = null;
  if (c.averaging && typeof c.averaging === "object") {
    const a = c.averaging as Record<string, unknown>;
    const count = numOrNull(a.count);
    if ((a.mode === "off" || a.mode === "power" || a.mode === "coherent") && count !== null) {
      averaging = { mode: a.mode, count };
    }
  }

  const out: CaptureProvenance = {
    device,
    sampleRateHz: numOrNull(c.sampleRateHz),
    inputRangeDbv: numOrNull(c.inputRangeDbv),
    outputRangeDbv: numOrNull(c.outputRangeDbv),
    offsets,
    fftSize: numOrNull(c.fftSize),
    window: c.window === "hann" || c.window === "rect" || c.window === "flattop" ? c.window : null,
    averaging,
    capturedAt: typeof c.capturedAt === "string" ? c.capturedAt : null,
  };
  if (c.derived === true) out.derived = true;
  if (c.mixed === true) out.mixed = true;
  if (c.programParams && typeof c.programParams === "object") {
    // The export only ever JSON-stringifies it — an object is enough.
    out.programParams = c.programParams as SweepProgramParams;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* migrate: any known version → v5                                     */
/* ------------------------------------------------------------------ */

/** Validate + upgrade a parsed blob into a v5 document, or null if
 * unusable. v1 saves walk the whole chain v1 → v4 → v5. */
export function migrate(raw: unknown): WorkspaceDoc | null {
  if (!raw || typeof raw !== "object") return null;
  const ws = raw as RawV4 & { version?: number };
  if (ws.version === 1) upgradeV1(ws);
  if (ws.version === 2) upgradeV2(ws);
  if (ws.version === 3) upgradeV3(ws);
  if (ws.version === 4) {
    if (!ws.layout || !Array.isArray(ws.graphs) || !Array.isArray(ws.traces)) return null;
    return importV4(ws);
  }
  if (ws.version !== WS_VERSION) return null;
  const doc = ws as unknown as WorkspaceDoc;
  if (!doc.layout?.tiles || !doc.traces?.byId || !doc.sources?.byId || !doc.programs?.byId) {
    return null;
  }
  // Older v5 documents predating a field pick up its default here (the v5
  // in-version hook — bump WS_VERSION for shape CHANGES, not additions).
  if (!Array.isArray(doc.collapsed)) doc.collapsed = [];
  if (!doc.refFrames || typeof doc.refFrames !== "object") doc.refFrames = {};
  if (doc.acquisition && typeof doc.acquisition.coherentGen !== "boolean") {
    doc.acquisition.coherentGen = true;
  }
  for (const tile of Object.values(doc.layout.tiles)) {
    if (typeof tile.showPhase !== "boolean") tile.showPhase = false;
    if (typeof tile.showHarmonics !== "boolean") tile.showHarmonics = false;
    // Lot A (issue #26): a doc predating the trigger picks up the same
    // defaults as a fresh tile (defaultTile in state.ts).
    if (tile.triggerSource === undefined) tile.triggerSource = "auto";
    if (typeof tile.triggerPositionPct !== "number") tile.triggerPositionPct = 50;
    if (typeof tile.showTriggerMarkers !== "boolean") tile.showTriggerMarkers = true;
  }
  for (const prog of Object.values(doc.programs.byId)) {
    if (prog.startedAtMs === undefined) prog.startedAtMs = null;
    // Issue #27: a v5 doc saved before the level axis existed picks up the
    // frequency-axis defaults (every sweep it could have saved WAS one).
    if (prog.kind === "sweep") {
      const params = prog.params as Partial<SweepProgramParams>;
      if (params.axis === undefined) params.axis = "frequency";
      if (params.toneHz === undefined) params.toneHz = DEFAULT_SWEEP_PARAMS.toneHz;
      if (params.startDbfs === undefined) params.startDbfs = DEFAULT_SWEEP_PARAMS.startDbfs;
      if (params.endDbfs === undefined) params.endDbfs = DEFAULT_SWEEP_PARAMS.endDbfs;
      // Issue #28 second pass: a v5 doc saved before wow & flutter became a
      // program kind never had these fields (only thd/fr existed) — pick up
      // the same defaults a fresh program gets.
      if (params.wowReferenceHz === undefined) {
        params.wowReferenceHz = DEFAULT_SWEEP_PARAMS.wowReferenceHz;
      }
      if (params.wowOutputChannel === undefined) {
        params.wowOutputChannel = DEFAULT_SWEEP_PARAMS.wowOutputChannel;
      }
      if (params.wowInputChannel === undefined) {
        params.wowInputChannel = DEFAULT_SWEEP_PARAMS.wowInputChannel;
      }
      if (params.wowGenerate === undefined) params.wowGenerate = DEFAULT_SWEEP_PARAMS.wowGenerate;
      if (prog.wowResult === undefined) prog.wowResult = null;
    }
  }
  // Issue #40: a doc predating the capture snapshot has none — the exports
  // then fall back to the live bench, exactly the pre-#40 behavior. Any doc
  // that DOES carry one gets the same shape/value validation as the user
  // weighting curve below (typeof-checks, review-#1-of-this-lot): a
  // hand-edited or corrupted snapshot must degrade field-by-field to
  // "unknown", never crash the export with `capture_window=undefined` or a
  // TypeError deep in `captureProvenanceLines`.
  for (const t of Object.values(doc.traces.byId)) {
    t.capture = t.capture === undefined ? null : sanitizeCapture(t.capture);
  }
  if (!doc.triggers || typeof doc.triggers !== "object") doc.triggers = {};
  // A SINGLE arm is a live-session gesture, never a saved-bench fact — any
  // loaded doc (even a hand-edited one) starts unarmed.
  for (const t of Object.values(doc.triggers)) {
    if (t && typeof t === "object") t.armEpoch = 0;
  }
  // A doc predating the user weighting curve (issue #29) has none — and
  // ANY doc's curve gets the same shape/value validation as a fresh CSV
  // import (typeof-checks, like this hook's other siblings, not just an
  // `undefined` check — a hand-edited or corrupted blob must degrade to
  // "no curve" rather than crash `describeUserCurve`/the transform dialog
  // later, review finding #5).
  doc.userWeightingCurve = sanitizeUserCurve(doc.userWeightingCurve);
  doc.userWeightingCurveName =
    typeof doc.userWeightingCurveName === "string" ? doc.userWeightingCurveName : null;
  return doc;
}

function read(raw: string | null): WorkspaceDoc | null {
  if (!raw) return null;
  try {
    return migrate(JSON.parse(raw));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Legacy (v1 frontend) storage — read-only                            */
/* ------------------------------------------------------------------ */

/** True for a storage-quota write failure (`DOMException` name or the
 * legacy numeric code some engines still use) — IndexedDB rejects with the
 * same `QuotaExceededError` DOMException localStorage threw. */
export function isQuotaExceeded(e: unknown): boolean {
  return (
    e instanceof DOMException &&
    (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED" || e.code === 22)
  );
}

/** The LEGACY frontend's auto-saved current, through the importer — the
 * boot fallback when IndexedDB has no current doc (a user upgrading
 * mid-transition keeps their bench). All three legacy readers guard the
 * localStorage ACCESS itself (disabled/blocked storage throws — the same
 * reason main.ts's theme/REST-token reads are wrapped): "no legacy blobs"
 * is a state, an exception at boot or in the Load menu is not. */
export function loadLegacyCurrent(): WorkspaceDoc | null {
  try {
    return read(localStorage.getItem(LEGACY_CURRENT_KEY));
  } catch {
    return null;
  }
}

/** Names of LEGACY saved workspaces (the v1 frontend's), sorted. Loading
 * one goes through the importer; v2 never writes or deletes these. */
export function listLegacyNamed(): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LEGACY_SAVED_PREFIX)) out.push(k.slice(LEGACY_SAVED_PREFIX.length));
    }
  } catch {
    return [];
  }
  return out.sort();
}

export function loadLegacyNamed(name: string): WorkspaceDoc | null {
  try {
    return read(localStorage.getItem(LEGACY_SAVED_PREFIX + name));
  } catch {
    return null;
  }
}

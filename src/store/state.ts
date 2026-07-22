/**
 * AppState — the single serializable state tree (plan §3.1).
 *
 * M1 scope: device + acquisition + run + traces + sources + ui. The
 * programs / workspace slices land with their milestones (M4/M5).
 *
 * Everything here must survive JSON.stringify: no typed arrays (frame data
 * lives in `data/frames.ts`), no DOM, no functions.
 */
import type {
  ClipState,
  DeviceConfig,
  DeviceMeta,
  LevelOffsetsDb,
  RestStatus,
  ScriptRole,
  SlotError,
  Telemetry,
  TransformStep,
} from "../gen";
import type { Chan, Domain, FdUnit, TdUnit, TraceId } from "../core/model";

/**
 * Per-converter, per-channel dBFS→dBV display offsets. Four values, never
 * one — each converter's dBFS reference moves with its OWN range register
 * (the #48/#50/#51/#58/#60 bug class, encoded as a type). Since M1 this is
 * the ts-rs GENERATED wire type: the backend computes it per frame (B-3).
 */
export type { LevelOffsetsDb };

export type DeviceStatus = "disconnected" | "connecting" | "connected";

export interface DeviceState {
  status: DeviceStatus;
  /** A QA40x is on the USB bus (regardless of connection). */
  present: boolean;
  /**
   * The user explicitly disconnected: suppresses auto-(re)connect until
   * they connect again by hand (v1 behavior).
   */
  userDisconnected: boolean;
  info: DeviceMeta | null;
  config: DeviceConfig | null;
  telemetry: Telemetry | null;
  /** Refreshed at connect and after every range change. Null until read. */
  offsets: LevelOffsetsDb | null;
}

/**
 * "power" = rolling power average of the last `count` spectra (what the
 * backend actually computes — the M0 name "exp" claimed an exponential
 * average that never existed); "coherent" = complex averaging with per-frame
 * phase alignment.
 */
export type AveragingMode = "off" | "power" | "coherent";
export type WindowKind = "hann" | "rect" | "flattop";

export interface AcquisitionState {
  fftSize: number;
  averaging: { mode: AveragingMode; count: number };
  window: WindowKind;
  peakHold: boolean;
  /** Snap every periodic source onto the FFT bin grid — the official app's
   * "Round to eliminate leakage", on by default there too (issue #14). Off
   * plays the asked frequency verbatim (a legitimate precision mode; the
   * live THD+N/SNR tiles then integrate the window skirts of a
   * non-coherent tone, ~12 dB pessimistic at 1 kHz / 32768). */
  coherentGen: boolean;
}

export interface RunState {
  streaming: boolean;
  /** A stop request is in flight (backend draining its last frame). The
   * transport is optimistic — `streaming` drops immediately — but starts
   * are held off until the backend acknowledged the stop. */
  stopping: boolean;
  stats: { fps: number; frameMs: number; frames: number };
  /** Peak of the summed DAC buffer, from the backend frame (M1+). */
  sigmaPeakDbv: number | null;
  clip: { input: ClipState; output: boolean };
  fittedOutputRangeDbv: number | null;
  /** Per-slot source problems from the backend (bad script, unknown
   * waveform…) — named per source id, never wholesale (M2). */
  slotErrors: SlotError[];
  /**
   * Output-only session mode (M2, v1 #49): playing sources drive the DAC
   * gap-free with NO capture — for feeding an external DUT. A property of
   * the SESSION, never of one source, and deliberately not persisted / off
   * at startup: analysis needs the capture, and a session must never come
   * up silently deaf.
   */
  outputOnly: boolean;
  /** True while the gap-free output-only generator loop is running. */
  generatorRunning: boolean;
  /** Id of the exclusive measurement program holding the device, if any. */
  programLock: string | null;
}

/* ------------------------------------------------------------------ */
/* Traces (M1): the pool of displayable trace definitions.              */
/* ------------------------------------------------------------------ */

/** Where a trace's frames come from: the 4 hardware endpoints, a frozen
 * snapshot (❄ M3), a transform endpoint (M4: `input → steps → this trace`,
 * DSP backend-side via apply_transform_chain), or a measurement program's
 * result (M4: the program definition lives in `programs.byId[id]` under the
 * SAME id — the trace is its displayable face). */
export type TraceSource =
  | { kind: "hw_input"; channel: Chan }
  | { kind: "hw_output"; channel: Chan }
  /** `ratio` records at freeze time that the copied spectrum was a
   * deconvolved RATIO (its origin's chain may change or vanish later). */
  | { kind: "memory"; frozenFrom: TraceId; ratio?: boolean }
  | { kind: "transform"; input: TraceId; steps: TransformStep[] }
  | { kind: "program" };

/**
 * Metadata ONLY — never frame data (that lives in `data/frames.ts`, keyed
 * by id; `seq` is the store-side freshness stamp the ingest bumps after
 * writing the cache).
 */
export interface TraceMeta {
  id: TraceId;
  label: string;
  color: string;
  source: TraceSource;
  /** Domains this trace currently carries frames for. */
  domains: Domain[];
  /** Bumped after each cache write; tiles re-render on it. */
  seq: number;
  /**
   * This trace's own converter dBFS→dBV offset, buffered at ingest from the
   * frame's per-converter offsets (B-3): ADC L/R for hw_input, DAC L/R for
   * hw_output. Null until the first frame. A chart never sees a register.
   */
  offsetDb: number | null;
}

export interface TracesState {
  order: TraceId[];
  byId: Record<TraceId, TraceMeta>;
}

/* ------------------------------------------------------------------ */
/* Signal sources (M2: the full family).                                */
/* ------------------------------------------------------------------ */

export type SourceRoute = "left" | "right" | "both" | "off";

export type SourceKind = SourceMeta["kind"];

/** One extra tone riding on a sine source: the sine then plays as a phased
 * tone list (v1 Phase G2). Level is dBV (the tone's own output RMS). */
export interface ExtraTone {
  enabled: boolean;
  frequencyHz: number;
  levelDbv: number;
  phaseDeg: number;
}

interface SourceBase {
  id: string;
  label: string;
  route: SourceRoute;
  playing: boolean;
}

/** The periodic waveforms: frequency + sine-referenced level in dBV (every
 * waveform's RMS lands at its level — crest factors normalized backend-side,
 * task #48). */
export interface PeriodicSource extends SourceBase {
  kind: "sine" | "square" | "triangle" | "sawtooth";
  frequencyHz: number;
  levelDbv: number;
  /** Sine only: extra phased tones (empty/disabled = the classic
   * bit-identical sine slot). Other waveforms ignore it. */
  extraTones: ExtraTone[];
}

/** The broadband sources: level only (multitone/chirp normalize by measured
 * frame RMS, noise analytically — sources.rs). */
export interface BroadbandSource extends SourceBase {
  kind: "multitone" | "noise" | "chirp";
  levelDbv: number;
}

/** A Rhai signal script: `fn render(ctx)` produces samples in level-volts
 * (a ±1.0 sine plays at 0 dBV). Compile/render failures come back as named
 * per-slot errors, never a torn-down mix. */
export interface ScriptSource extends SourceBase {
  kind: "script";
  source: string;
}

export type SourceMeta = PeriodicSource | BroadbandSource | ScriptSource;

export interface SourcesState {
  order: string[];
  byId: Record<string, SourceMeta>;
}

/* ------------------------------------------------------------------ */
/* Measurement programs (M4): sweeps + measure scripts.                 */
/* ------------------------------------------------------------------ */

/** Parameters of a swept measurement program (v1 SweepParams): THD vs
 * frequency (point sweep) or frequency response (chirp). */
export interface SweepProgramParams {
  measurement: "thd" | "fr";
  channel: "left" | "right" | "both";
  startHz: number;
  endHz: number;
  /** Stimulus level in dBFS (the sweep drives the DAC directly). */
  levelDbfs: number;
  /** THD only: number of tone points. */
  points: number;
  /** FR only: chirp length in seconds. */
  durationS: number;
  /** THD only: which curve to keep. */
  metric: "thd_db" | "thd_percent" | "thdn_db";
}

export const DEFAULT_SWEEP_PARAMS: SweepProgramParams = {
  measurement: "thd",
  channel: "left",
  startHz: 20,
  endHz: 20000,
  levelDbfs: -6,
  points: 30,
  durationS: 1,
  metric: "thd_db",
};

export type ProgramRun = "idle" | "running";

interface ProgramBase {
  /** Also the id of this program's result trace in `traces.byId`. */
  id: string;
  run: ProgramRun;
  /** Sweep progress while running ("12/30"), from backend events. */
  progress: string | null;
  /** performance.now() when the run started (null when idle) — drives the
   * time-based estimate while the batched capture gives no counts. */
  startedAtMs: number | null;
}

export interface SweepProgram extends ProgramBase {
  kind: "sweep";
  params: SweepProgramParams;
}

/** A measurement (or plot) script program: the inline Rhai source it runs.
 * The role is re-classified from the text on every Apply (a script that
 * calls acquire()/measure verbs owns the device; one that only plots runs
 * engine-only — both are exclusive programs here; render-defining SOURCE
 * scripts belong to the Signal Sources panel instead). */
export interface ScriptProgram extends ProgramBase {
  kind: "script";
  source: string;
  role: ScriptRole;
}

export type ProgramMeta = SweepProgram | ScriptProgram;

export interface ProgramsState {
  order: string[];
  byId: Record<string, ProgramMeta>;
}

export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  message: string;
}

/**
 * Workspace identity (M5): the name shown in (and edited from) the
 * workspace bar, and which sidebar panels are collapsed. Both persist in
 * the workspace document (store/persist.ts) — the serializable subset of
 * this state tree IS that document.
 */
export interface WorkspaceState {
  name: string;
  /** Collapsed sidebar panels ("sources" | "traces" | "programs"). */
  collapsed: string[];
}

/** Transient UI state — excluded from persistence. */
export interface UiState {
  theme: "dark" | "light";
  toasts: Toast[];
  /** REST automation-server status (app-side, NOT a device concern —
   * maintainer taxonomy). Null until the first read. */
  rest: RestStatus | null;
  /** Bumped by "Reset avg & peak": spectrum tiles reset their peak-hold
   * overlay when it changes. Transient — never part of the workspace doc. */
  peakHoldEpoch: number;
}

/* ------------------------------------------------------------------ */
/* Layout (M3): the multi-tile graph grid.                              */
/* ------------------------------------------------------------------ */

export type GraphKind = "spectrum" | "scope" | "sweep";

/** Grid presets, rows×cols (the v1 set). */
export type LayoutPattern = "1" | "1x2" | "2x1" | "1x3" | "2x2" | "2x3";

export const LAYOUT_PATTERNS: Record<LayoutPattern, { rows: number; cols: number }> = {
  "1": { rows: 1, cols: 1 },
  "1x2": { rows: 1, cols: 2 },
  "2x1": { rows: 2, cols: 1 },
  "1x3": { rows: 1, cols: 3 },
  "2x2": { rows: 2, cols: 2 },
  "2x3": { rows: 2, cols: 3 },
};

export function patternTileCount(pattern: LayoutPattern): number {
  const { rows, cols } = LAYOUT_PATTERNS[pattern];
  return rows * cols;
}

/** Y axis of a spectrum tile, in the tile's display unit. */
export interface TileAxis {
  xLog: boolean;
  yAuto: boolean;
  yMin: number;
  yMax: number;
  /**
   * Dual-dBr: when enabled the level axis reads relative to `dbrRefDb`
   * (a scalar in the tile's absolute display unit — subtracted in the VM,
   * never in the renderer). Null ref = "auto": the primary series' peak.
   */
  dbrEnabled: boolean;
  dbrRefDb: number | null;
}

/**
 * One graph tile: what it draws (trace membership — the display budget the
 * backend spectra request derives from), how it draws it (kind + units +
 * axis), and its measure chips.
 */
export interface TileConfig {
  id: string;
  kind: GraphKind;
  fdUnit: FdUnit;
  tdUnit: TdUnit;
  /** Pool traces on this tile, in draw order. */
  traces: TraceId[];
  /** Members temporarily hidden via the legend (v1 behavior: the legend
   * chip toggles display; ✕ removes membership). Hidden traces leave the
   * fd display budget — no FFT is computed for a curve nobody sees. */
  hidden: TraceId[];
  /** Per-member hidden CURVES of a multi-curve sweep trace (curve labels,
   * e.g. "Right") — the v1 per-curve legend chips (one chip per curve,
   * independent toggles; ✕ still removes the whole trace). */
  hiddenCurves: Record<TraceId, string[]>;
  /** Measure-chip keys (core/measure.ts) shown above the chart. */
  measures: string[];
  /** Which trace the chips read: "auto" = first trace with data. */
  chipSource: "auto" | TraceId;
  axis: TileAxis;
  /** Scope: displayed time window in ms; null = the whole capture. */
  timeWindowMs: number | null;
  /** Sweep tiles: draw the ∠ phase overlay (FR). In the config — not tile-
   * local — so a saved workspace restores it (v1 GraphConfig.showPhase). */
  showPhase: boolean;
  /** Spectrum tiles: draw the harmonic markers (H1..H10 of the chip-source
   * trace, backend-located). Off by default — a multi-tile dashboard reads
   * cleaner without them (maintainer decision, M6 gap review). */
  showHarmonics: boolean;
}

export interface LayoutState {
  pattern: LayoutPattern;
  /** All tiles ever configured; the pattern displays the first N. Keeping
   * the tail means switching 2x2 → 1 → 2x2 restores the hidden tiles. */
  order: string[];
  tiles: Record<string, TileConfig>;
  /** Tile temporarily filling the whole grid (⛶); transient by design but
   * kept here so tiles/panels derive from ONE tree. */
  focus: string | null;
}

export interface AppState {
  device: DeviceState;
  acquisition: AcquisitionState;
  run: RunState;
  traces: TracesState;
  sources: SourcesState;
  programs: ProgramsState;
  layout: LayoutState;
  workspace: WorkspaceState;
  ui: UiState;
}

export const FFT_SIZES = [
  4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576,
] as const;

export const INPUT_RANGES_DBV = [0, 6, 12, 18, 24, 30, 36, 42] as const;
export const OUTPUT_RANGES_DBV = [-12, -2, 8, 18] as const;

/* The 4 hardware endpoints — always present, never deletable (Traces V2).
 * Ids are stable (they key the frames cache and the e2e specs); colors are
 * the validated series palette so In L/R match the classic L/R hues. */
export const HW_TRACE_IDS = {
  inputL: "hw-in-left",
  inputR: "hw-in-right",
  outputL: "hw-out-left",
  outputR: "hw-out-right",
} as const;

function hwTrace(
  id: TraceId,
  label: string,
  color: string,
  source: TraceSource
): TraceMeta {
  return { id, label, color, source, domains: [], seq: 0, offsetDb: null };
}

/** A transform chain containing a deconvolve step produces a RATIO spectrum
 * (dB re its reference): converter offsets / absolute fd units must not
 * apply to it (its td passes through untouched and stays absolute). A
 * frozen copy carries the flag on its memory source. */
export function isRatioTrace(t: TraceMeta): boolean {
  if (t.source.kind === "memory") return t.source.ratio === true;
  return (
    t.source.kind === "transform" &&
    t.source.steps.some((st) => st.type === "deconvolve")
  );
}

/** Colors handed to user-created traces (transforms, programs), cycling —
 * distinct from the 4 hardware endpoint hues. */
const EXTRA_TRACE_COLORS = [
  "#9a6ee2", "#4dc4cf", "#d1793c", "#7fb069", "#c95d63", "#5a7bd8",
];

/** Color for one curve of a multi-curve trace (a sweep's L + R): curve 0 is
 * the trace's own color; each further curve steps to the next palette slot,
 * so sibling curves are always DISTINCT (the v1 traceCurveColor rule — a
 * same-hue tint made a both-channel loopback FR read as one curve). */
export function traceCurveColor(t: TraceMeta, curveIndex: number): string {
  if (curveIndex === 0) return t.color;
  const base = EXTRA_TRACE_COLORS.indexOf(t.color);
  let idx = base;
  if (idx < 0) {
    idx = 0;
    for (const ch of t.id) idx = (idx + ch.charCodeAt(0)) % EXTRA_TRACE_COLORS.length;
  }
  return EXTRA_TRACE_COLORS[(idx + curveIndex) % EXTRA_TRACE_COLORS.length];
}

/** The next free color for a user-created trace: least-used of the extra
 * palette across the current pool (stable under add/remove). */
export function nextTraceColor(s: AppState): string {
  const used = new Map<string, number>(EXTRA_TRACE_COLORS.map((c) => [c, 0]));
  for (const id of s.traces.order) {
    const c = s.traces.byId[id]?.color;
    if (c !== undefined && used.has(c)) used.set(c, (used.get(c) ?? 0) + 1);
  }
  let best = EXTRA_TRACE_COLORS[0];
  for (const c of EXTRA_TRACE_COLORS) {
    if ((used.get(c) ?? 0) < (used.get(best) ?? 0)) best = c;
  }
  return best;
}

export function initialTraces(): TracesState {
  const traces = [
    hwTrace(HW_TRACE_IDS.inputL, "Input L", "#3987e5", { kind: "hw_input", channel: "left" }),
    hwTrace(HW_TRACE_IDS.inputR, "Input R", "#199e70", { kind: "hw_input", channel: "right" }),
    hwTrace(HW_TRACE_IDS.outputL, "Output L", "#e6a23c", { kind: "hw_output", channel: "left" }),
    hwTrace(HW_TRACE_IDS.outputR, "Output R", "#e06ca6", { kind: "hw_output", channel: "right" }),
  ];
  return {
    order: traces.map((t) => t.id),
    byId: Object.fromEntries(traces.map((t) => [t.id, t])),
  };
}

/** Default chips per graph kind (the v1 defaults). */
export const DEFAULT_FD_MEASURES = ["thd", "peakfreq"];
export const DEFAULT_TD_MEASURES = ["rms", "peak"];

/** A fresh tile showing Input L (the classic first view). */
export function defaultTile(
  id: string,
  kind: GraphKind = "spectrum",
  traces: TraceId[] = [HW_TRACE_IDS.inputL]
): TileConfig {
  return {
    id,
    kind,
    // dBV by default (maintainer M4 review): the absolute unit is the one a
    // measurement bench reads; dBFS stays one click away (and remains the
    // honest fallback while uncalibrated — offsets null → identity).
    fdUnit: "dbv",
    tdUnit: "v",
    traces: [...traces],
    hidden: [],
    hiddenCurves: {},
    measures: [...(kind === "spectrum" ? DEFAULT_FD_MEASURES : DEFAULT_TD_MEASURES)],
    chipSource: "auto",
    axis: { xLog: true, yAuto: true, yMin: -140, yMax: 10, dbrEnabled: false, dbrRefDb: null },
    // ~10 ms default scope window (maintainer M4 review): a full 32k-sample
    // capture squashes a 1 kHz sine into an unreadable block; 10 ms shows
    // its cycles. Clearable to full capture via the ⚙ gear.
    timeWindowMs: 10,
    showPhase: false,
    showHarmonics: false,
  };
}

/** The out-of-the-box workspace: a 2×2 grid, Spectrum | Scope on each row —
 * row 1 on Input L, row 2 on Input R (maintainer defaults, M3/M4 review). */
export function initialLayout(): LayoutState {
  const tiles = [
    defaultTile("tile-1", "spectrum"),
    defaultTile("tile-2", "scope"),
    defaultTile("tile-3", "spectrum", [HW_TRACE_IDS.inputR]),
    defaultTile("tile-4", "scope", [HW_TRACE_IDS.inputR]),
  ];
  return {
    pattern: "2x2",
    order: tiles.map((t) => t.id),
    tiles: Object.fromEntries(tiles.map((t) => [t.id, t])),
    focus: null,
  };
}

/** One ready-to-play sine, so the first Play is a single gesture (maintainer
 * default, M3 review). Shape mirrors `defaultSource("sine")` in
 * actions/sources.ts — whose id counter starts at 2 because of this one. */
export function initialSources(): SourcesState {
  const sine: SourceMeta = {
    id: "src-sine-1",
    label: "Sine 1",
    route: "left",
    playing: false,
    kind: "sine",
    frequencyHz: 1000,
    levelDbv: -12,
    extraTones: [],
  };
  return { order: [sine.id], byId: { [sine.id]: sine } };
}

export function initialState(): AppState {
  return {
    device: {
      status: "disconnected",
      present: false,
      userDisconnected: false,
      info: null,
      config: null,
      telemetry: null,
      offsets: null,
    },
    acquisition: {
      fftSize: 32768,
      averaging: { mode: "off", count: 1 },
      window: "hann",
      peakHold: false,
      coherentGen: true,
    },
    run: {
      streaming: false,
      stopping: false,
      stats: { fps: 0, frameMs: 0, frames: 0 },
      sigmaPeakDbv: null,
      clip: { input: "none", output: false },
      fittedOutputRangeDbv: null,
      slotErrors: [],
      outputOnly: false,
      generatorRunning: false,
      programLock: null,
    },
    traces: initialTraces(),
    sources: initialSources(),
    programs: { order: [], byId: {} },
    layout: initialLayout(),
    workspace: { name: "Untitled", collapsed: [] },
    ui: {
      theme: "dark",
      toasts: [],
      rest: null,
      peakHoldEpoch: 0,
    },
  };
}

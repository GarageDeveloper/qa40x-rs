/**
 * Built-in workspace templates (M5) — the legacy set (src/dashboard/store.ts,
 * task #18/#30) rebuilt natively on the v5 document. Each `make()` returns a
 * fresh WorkspaceDoc; loading one replaces the bench (the user then saves
 * their own copy under a name).
 */
import type {
  ProgramMeta,
  SourceMeta,
  SweepProgramParams,
  TileConfig,
  TraceMeta,
} from "./state";
import {
  defaultTile,
  DEFAULT_SWEEP_PARAMS,
  HW_TRACE_IDS,
  initialState,
  initialTraces,
  nextTraceColor,
} from "./state";
import type { WorkspaceDoc } from "./persist";
import { snapshotWorkspace } from "./persist";

const L = HW_TRACE_IDS.inputL;
const R = HW_TRACE_IDS.inputR;

/** The chip strip of the featured templates (legacy SPEC_MEAS). */
const SPEC_MEAS = ["thd", "thdn", "snr", "peakfreq", "rms"];

interface Piece {
  tiles: TileConfig[];
  sources?: SourceMeta[];
  programs?: { prog: ProgramMeta; label: string }[];
}

function tile(
  id: string,
  kind: TileConfig["kind"],
  traces: string[],
  over: Partial<TileConfig> = {}
): TileConfig {
  return { ...defaultTile(id, kind, traces), ...over };
}

/** A ready-to-play sine source (paused — nothing plays by itself). */
function sine(route: SourceMeta["route"]): SourceMeta {
  return {
    id: "src-sine-1",
    label: "Sine 1000 Hz",
    route,
    playing: false,
    kind: "sine",
    frequencyHz: 1000,
    levelDbv: -12,
    extraTones: [],
  };
}

function sweep(
  id: string,
  label: string,
  measurement: "thd" | "fr",
  channel: SweepProgramParams["channel"],
  over: Partial<SweepProgramParams> = {}
): { prog: ProgramMeta; label: string } {
  return {
    label,
    prog: {
      id,
      kind: "sweep",
      run: "idle",
      progress: null,
      startedAtMs: null,
      params: { ...DEFAULT_SWEEP_PARAMS, measurement, channel, ...over },
    },
  };
}

/** Assemble a document from tiles + sources + programs on a fresh state. */
function doc(name: string, pattern: WorkspaceDoc["layout"]["pattern"], piece: Piece): WorkspaceDoc {
  const s = initialState();
  const traces = initialTraces();
  const programs: WorkspaceDoc["programs"] = { order: [], byId: {} };
  for (const { prog, label } of piece.programs ?? []) {
    programs.order.push(prog.id);
    programs.byId[prog.id] = prog;
    const meta: TraceMeta = {
      id: prog.id,
      label,
      color: nextTraceColor({ ...s, traces }),
      source: { kind: "program" },
      domains: [],
      seq: 0,
      offsetDb: null,
    };
    traces.order.push(prog.id);
    traces.byId[prog.id] = meta;
  }
  const sources = piece.sources ?? [];
  return snapshotWorkspace({
    ...s,
    workspace: { name, collapsed: [] },
    traces,
    programs,
    sources: {
      order: sources.map((x) => x.id),
      byId: Object.fromEntries(sources.map((x) => [x.id, x])),
    },
    layout: {
      pattern,
      order: piece.tiles.map((t) => t.id),
      tiles: Object.fromEntries(piece.tiles.map((t) => [t.id, t])),
      focus: null,
    },
  });
}

/** The workspace new users open on first run — the classic analyzer view. */
export function firstRunWorkspace(): WorkspaceDoc {
  return templates()[0].make();
}

/** Built-in starting points, featured first (design spec), extras after. */
export function templates(): { name: string; make: () => WorkspaceDoc }[] {
  return [
    // 1. First Look — live spectrum over a scope, one channel.
    {
      name: "First Look",
      make: () =>
        doc("First Look", "2x1", {
          tiles: [
            tile("g-spec", "spectrum", [L], { measures: SPEC_MEAS }),
            tile("g-scope", "scope", [L]),
          ],
        }),
    },
    // 2. Quick THD Check — one big spectrum with the full distortion readout.
    {
      name: "Quick THD Check",
      make: () =>
        doc("Quick THD Check", "1", {
          tiles: [
            tile("g-spec", "spectrum", [L], {
              measures: ["thd", "thddb", "thdn", "snr", "peakfreq"],
            }),
          ],
        }),
    },
    // 3. Stereo L/R — 2×3: FR · Spectrum · Scope, L on top, R below.
    {
      name: "Stereo L/R",
      make: () =>
        doc("Stereo L/R", "2x3", {
          tiles: [
            tile("g-fr-l", "sweep", ["t-fr-left"]),
            tile("g-spec-l", "spectrum", [L], { measures: ["thd", "thdn"] }),
            tile("g-scope-l", "scope", [L]),
            tile("g-fr-r", "sweep", ["t-fr-right"]),
            tile("g-spec-r", "spectrum", [R], { measures: ["thd", "thdn"] }),
            tile("g-scope-r", "scope", [R]),
          ],
          programs: [
            sweep("t-fr-left", "FR L", "fr", "left"),
            sweep("t-fr-right", "FR R", "fr", "right"),
          ],
        }),
    },
    // 4. FR + Phase (Bode) — a frequency-response sweep with phase shown.
    {
      name: "FR + Phase",
      make: () =>
        doc("FR + Phase", "1", {
          tiles: [tile("g-fr", "sweep", ["t-fr-both"], { showPhase: true })],
          programs: [sweep("t-fr-both", "FR L/R", "fr", "both")],
        }),
    },

    // ---- Advanced templates (#30) — task-focused benches ----

    // 5. Amp / DAC bench — 1 kHz tone: distortion, THD sweep, FR, scope.
    {
      name: "Amp / DAC bench",
      make: () =>
        doc("Amp / DAC bench", "2x2", {
          tiles: [
            tile("g-spec", "spectrum", [L], {
              measures: ["thd", "thddb", "thdn", "sinad"],
            }),
            tile("g-thd", "sweep", ["t-thd"]),
            tile("g-fr", "sweep", ["t-fr"], { showPhase: true }),
            tile("g-scope", "scope", [L], { measures: ["rms", "peak", "crest"] }),
          ],
          sources: [sine("both")],
          programs: [
            sweep("t-thd", "THD vs freq", "thd", "left"),
            sweep("t-fr", "FR L", "fr", "left"),
          ],
        }),
    },
    // 6. Distortion deep-dive — full distortion readout over a THD sweep.
    {
      name: "Distortion deep-dive",
      make: () =>
        doc("Distortion deep-dive", "2x1", {
          tiles: [
            tile("g-spec", "spectrum", [L], {
              measures: ["thd", "thddb", "thdn", "sinad", "peakfreq"],
            }),
            tile("g-thd", "sweep", ["t-thd"]),
          ],
          sources: [sine("left")],
          programs: [sweep("t-thd", "THD vs freq", "thd", "left")],
        }),
    },
    // 7. Noise / SNR — noise floor + SNR, with the scope RMS.
    {
      name: "Noise / SNR",
      make: () =>
        doc("Noise / SNR", "1x2", {
          tiles: [
            tile("g-spec", "spectrum", [L], {
              measures: ["snr", "thdn", "peaklvl", "peakfreq"],
            }),
            tile("g-scope", "scope", [L], { measures: ["rms", "peak"] }),
          ],
          sources: [sine("left")],
        }),
    },
    // 8. Phono / RIAA — FR sweep (with phase) beside the spectrum.
    {
      name: "Phono / RIAA",
      make: () =>
        doc("Phono / RIAA", "1x2", {
          tiles: [
            tile("g-fr", "sweep", ["t-fr"], { showPhase: true }),
            tile("g-spec", "spectrum", [L], { measures: ["thd", "thdn"] }),
          ],
          programs: [sweep("t-fr", "RIAA response", "fr", "both")],
        }),
    },
    // 9. Loopback self-test — one big spectrum, driven by a 1 kHz tone.
    {
      name: "Loopback self-test",
      make: () =>
        doc("Loopback self-test", "1", {
          tiles: [
            tile("g-spec", "spectrum", [L], {
              measures: ["thd", "thddb", "thdn", "sinad", "snr", "peakfreq"],
            }),
          ],
          sources: [sine("both")],
        }),
    },

    // ---- extras (not featured) ----
    {
      name: "Dual spectrum L/R",
      make: () =>
        doc("Dual spectrum L/R", "1x2", {
          tiles: [
            tile("g-spec-l", "spectrum", [L]),
            tile("g-spec-r", "spectrum", [R]),
          ],
        }),
    },
    {
      name: "Quad (2×2)",
      make: () =>
        doc("Quad (2×2)", "2x2", {
          tiles: [
            tile("g1", "spectrum", [L]),
            tile("g2", "scope", [L]),
            tile("g3", "spectrum", [R]),
            tile("g4", "scope", [R]),
          ],
        }),
    },
  ];
}

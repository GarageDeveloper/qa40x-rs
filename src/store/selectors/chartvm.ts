/**
 * Per-tile chart view-models (plan §3.4): converter offsets and unit
 * conversion are applied HERE, before the renderer — the charts are provably
 * blind to converters. A selector may map units (scalar offsets, scalar dBr
 * reference); it never does DSP (no interpolation, weighting or transfer
 * division — those are backend transforms, M4).
 *
 * Wire truth: a spectrum arrives as dBFS of its OWN converter's full scale,
 * a scope frame as digital full-scale samples of its own converter.
 *   dBFS → identity                     %FS → ×100
 *   dBV  → + the trace's own offset     V   → ×10^(offset/20)
 *   dBu  → dBV + DBU_OVER_DBV_DB        mV  → V × 1000
 * An ADC range step changes ONLY the input offsets, so a DAC trace's dBV
 * curve (or scope volts) cannot move — the #51/#58/#60 invariant.
 */
import type { FdUnit, TdUnit, TraceId } from "../../core/model";
import type { TriggerState } from "../../gen";
import { displayOffsetDb, displayScale } from "../../core/units";
import { getFrames } from "../../data/frames";
import { getTriggerSnapshot } from "../../data/triggered";
import { chipSourceTraceId, shownTraces } from "./layout";
import { tileTriggerSourceId, tileWindowSamples } from "./trigger";
import {
  DEFAULT_TRIGGER,
  isRatioTrace,
  traceCurveColor,
  type AppState,
  type TileConfig,
  type TraceMeta,
} from "../state";

export { displayOffsetDb, displayScale };
// Re-exported (not defined here) so panels/grid/tile.ts keeps importing it
// from chartvm.ts — the real definition (selectors/layout.ts) is shared with
// selectors/trigger.ts without chartvm.ts <-> trigger.ts becoming a cycle.
export { chipSourceTraceId };

export interface SeriesVM {
  id: TraceId;
  label: string;
  color: string;
  /** Frequency bins (Hz). */
  x: Float64Array;
  /** Magnitudes ALREADY in display units — the renderer adds nothing. */
  y: Float64Array;
  seq: number;
}

export interface SpectrumVM {
  series: SeriesVM[];
  unitLabel: string;
  /** Backend-located harmonic markers of the tile's chip-source trace, in
   * DISPLAY units like the series (empty when the tile toggle is off or the
   * source has none). The renderer draws them verbatim. */
  harmonics: HarmonicMarkVM[];
}

export interface HarmonicMarkVM {
  n: number;
  frequency: number;
  /** Level in the tile's display unit (same conversion as its series). */
  magnitudeDb: number;
  /** dB relative to the fundamental (unit-independent). */
  magnitudeDbc: number;
}

export interface TdSeriesVM {
  id: TraceId;
  label: string;
  color: string;
  /** Samples ALREADY in display units — the renderer scales nothing. */
  samples: Float64Array;
  sampleRate: number;
  seq: number;
}

/** A scope tile's trigger overlay — null when the resolved source's trigger
 * is off (or no aligned picture exists yet): today's shape, unchanged. */
export interface ScopeTriggerVM {
  sourceId: TraceId;
  state: TriggerState;
  /** Sub-sample residual in [0,1) — the renderer's fractional x-shift. */
  frac: number;
  /** Y of the level marker, in the tile's display unit. */
  levelDisplay: number;
  /** X of the trigger point, 0..1 of the displayed window. */
  position: number;
  /** True for `waiting`/`stopped` — the picture is the last HELD snapshot,
   * not this frame's live capture (NORMAL/SINGLE holding). */
  held: boolean;
}

export interface ScopeVM {
  series: TdSeriesVM[];
  unitLabel: string;
  trigger: ScopeTriggerVM | null;
}

/** A level in level-volts of an endpoint's own converter (the wire
 * `TriggerConfig.level_v` domain — see stream.rs's module doc) to/from the
 * tile's td display unit, via the SAME per-converter offset the series
 * itself scales by (`displayScale`'s "V" case is exactly volts-per-FS, so
 * the ratio to another unit's scale cancels the offset for V/mV and folds
 * in the %FS conversion — the twin of `level_fs = level_v * 10^(-off/20)`
 * the backend applies, #60-style). */
export function triggerLevelToDisplay(
  levelV: number,
  unit: TdUnit,
  offsetDb: number | null
): number {
  return (levelV * displayScale(unit, offsetDb)) / displayScale("v", offsetDb);
}

/** Inverse of {@link triggerLevelToDisplay}: a tile-unit level back to the
 * endpoint's own level-volts (what `setTriggerLevelV` sends). */
export function triggerLevelFromDisplay(
  value: number,
  unit: TdUnit,
  offsetDb: number | null
): number {
  return (value * displayScale("v", offsetDb)) / displayScale(unit, offsetDb);
}

/** One curve of a swept measurement (a trace can carry several — e.g. a
 * both-channel THD sweep, a multi-curve script plot). */
export interface SweepSeriesVM {
  id: TraceId;
  label: string;
  /** The curve's own short name ("Left"/"Right") when the trace carries
   * several curves; null for a single-curve trace. */
  curveLabel: string | null;
  color: string;
  /** Frequency points (Hz). */
  x: Float64Array;
  /** Curve values, already in their display unit (dB or %). */
  y: Float64Array;
  /** Phase in degrees when the measurement carries it (FR sweeps). */
  phaseDeg: Float64Array | null;
  seq: number;
}

export interface SweepVM {
  series: SweepSeriesVM[];
  unitLabel: string;
}

export const FD_UNIT_LABELS: Record<FdUnit, string> = {
  dbfs: "dBFS",
  dbv: "dBV",
  dbu: "dBu",
};

export const TD_UNIT_LABELS: Record<TdUnit, string> = {
  v: "V",
  mv: "mV",
  pctfs: "%FS",
};

/**
 * Build a spectrum tile's view-model: every member trace with an fd frame,
 * converted to the tile's display unit; dual-dBr subtracts a scalar
 * reference (explicit, or the primary series' peak) and relabels the axis.
 * Reads the frames cache — call it inside the tile's select callback (the
 * seqs in `s.traces` are the reactive dependency).
 */
export function spectrumVM(s: AppState, tile: TileConfig): SpectrumVM {
  const unit = tile.fdUnit;
  const series: SeriesVM[] = [];
  for (const id of shownTraces(tile)) {
    const t = s.traces.byId[id];
    if (!t) continue;
    const fd = getFrames(id)?.fd;
    if (!fd) continue;
    // A deconvolved spectrum is a RATIO (dB re its reference, ≈ 0 on a
    // matched pair) — converter offsets and absolute units don't apply, or
    // the flat-at-0 curve lands at +offset, off the top of a dBV tile
    // (maintainer report, M4 review). Its td samples stay absolute volts —
    // deconvolve never touches the scope — so this guard is fd-only.
    const offset = isRatioTrace(t) ? 0 : displayOffsetDb(unit, t.offsetDb);
    const y =
      offset === 0 ? fd.magDb : Float64Array.from(fd.magDb, (v) => v + offset);
    series.push({ id, label: t.label, color: t.color, x: fd.freqs, y, seq: t.seq });
  }
  let dbrRef = 0;
  let unitLabel = FD_UNIT_LABELS[unit];
  if (tile.axis.dbrEnabled && series.length > 0) {
    let ref = tile.axis.dbrRefDb;
    if (ref === null) {
      ref = -Infinity;
      for (const v of series[0].y) if (v > ref) ref = v;
      if (!isFinite(ref)) ref = 0;
    }
    for (const sv of series) {
      sv.y = Float64Array.from(sv.y, (v) => v - (ref as number));
    }
    dbrRef = ref;
    unitLabel = "dBr";
  }
  return { series, unitLabel, harmonics: harmonicsVM(s, tile, dbrRef) };
}

/** The chip-source trace's harmonic marks, shifted exactly like its series
 * (its own converter offset for the tile's unit, then the dBr reference).
 * Only marks whose curve is actually drawn on this tile qualify. */
function harmonicsVM(s: AppState, tile: TileConfig, dbrRef: number): HarmonicMarkVM[] {
  if (!tile.showHarmonics) return [];
  const id = chipSourceTraceId(tile);
  // A legend-hidden source draws no curve — markers would float over nothing.
  if (!id || !shownTraces(tile).includes(id)) return [];
  const t = s.traces.byId[id];
  const f = getFrames(id);
  if (!t || !f?.fd || !f.harmonics?.length) return [];
  const offset = isRatioTrace(t) ? 0 : displayOffsetDb(tile.fdUnit, t.offsetDb);
  return f.harmonics.map((h) => ({
    n: h.n,
    frequency: h.frequency,
    magnitudeDb: h.magnitude_db + offset - dbrRef,
    magnitudeDbc: h.magnitude_dbc,
  }));
}

/** A sweep trace's Y unit: "%" for a THD-percent program curve, "dB"
 * otherwise (sweep values are measurement units, not converter-referenced —
 * no offsets apply). */
function sweepUnitLabel(s: AppState, id: TraceId): string {
  const p = s.programs.byId[id];
  if (p?.kind === "sweep" && p.params.measurement === "thd" && p.params.metric === "thd_percent") {
    return "%";
  }
  return "dB";
}

/**
 * Build a sweep tile's view-model: every member trace with a sweep frame,
 * one series per curve (multi-curve traces suffix the curve label). Values
 * are measurement units already — the renderer adds nothing.
 */
export function sweepVM(s: AppState, tile: TileConfig): SweepVM {
  const series: SweepSeriesVM[] = [];
  let unitLabel = "dB";
  for (const id of shownTraces(tile)) {
    const t = s.traces.byId[id];
    if (!t) continue;
    const sweep = getFrames(id)?.sweep;
    if (!sweep) continue;
    if (series.length === 0) unitLabel = sweepUnitLabel(s, id);
    const hiddenCurves = tile.hiddenCurves[id] ?? [];
    sweep.curves.forEach((c, i) => {
      if (hiddenCurves.includes(c.label)) return; // per-curve legend hide
      series.push({
        id,
        label: sweep.curves.length > 1 ? `${t.label} ${c.label}` : t.label,
        curveLabel: sweep.curves.length > 1 ? c.label : null,
        // Sibling curves (L + R) get DISTINCT palette slots, v1 rule.
        color: traceCurveColor(t, i),
        x: sweep.freqs,
        y: c.values,
        phaseDeg: c.phaseDeg,
        seq: t.seq,
      });
    });
  }
  return { series, unitLabel };
}

/** Scale + wrap one member's samples into a `TdSeriesVM` (shared by both the
 * live and trigger-aligned paths of {@link scopeVM}). */
function scaledTdSeries(
  t: TraceMeta,
  samples: Float64Array,
  sampleRate: number,
  unit: TdUnit,
  offsetDb: number | null
): TdSeriesVM {
  const k = displayScale(unit, offsetDb);
  const scaled = k === 1 ? samples : Float64Array.from(samples, (v) => v * k);
  return { id: t.id, label: t.label, color: t.color, samples: scaled, sampleRate, seq: t.seq };
}

/** Every member trace's OWN live td frame, scaled by its OWN converter
 * offset — today's (pre-trigger) shape, also the trigger-off / no-snapshot
 * fallback. */
function liveScopeSeries(s: AppState, tile: TileConfig): TdSeriesVM[] {
  const unit = tile.tdUnit;
  const series: TdSeriesVM[] = [];
  for (const id of shownTraces(tile)) {
    const t = s.traces.byId[id];
    if (!t) continue;
    const td = getFrames(id)?.td;
    if (!td) continue;
    series.push(scaledTdSeries(t, td.samples, td.sampleRate, unit, t.offsetDb));
  }
  return series;
}

/**
 * Build a scope tile's view-model. With no trigger (mode off, or no aligned
 * picture latched yet): every member's OWN live td frame, scaled by its OWN
 * converter offset — `trigger: null`, byte-identical to the pre-Lot-A shape
 * (regression-pinned).
 *
 * With a trigger on and a snapshot latched (data/triggered.ts): every hw
 * endpoint member is built from the SNAPSHOT's arrays (references, already
 * simultaneous with the trigger scan — all 4 hw channels share one capture),
 * sliced to `[start, start + windowSamples)` around the trigger index, and
 * scaled by the snapshot's OWN baked offset (never the live one — a range
 * change must not rescale a HELD waiting/stopped picture, #60-style). A
 * `memory`/`program` member keeps its own live, unsliced origin — it has its
 * own time base, not the synchronized hw capture the trigger indexes into.
 */
export function scopeVM(s: AppState, tile: TileConfig): ScopeVM {
  const unit = tile.tdUnit;
  const sourceId = tileTriggerSourceId(s, tile);
  const settings = sourceId ? (s.triggers[sourceId] ?? DEFAULT_TRIGGER) : DEFAULT_TRIGGER;
  const snap = sourceId && settings.mode !== "off" ? getTriggerSnapshot(sourceId) : undefined;

  if (!sourceId || !snap) {
    return { series: liveScopeSeries(s, tile), unitLabel: TD_UNIT_LABELS[unit], trigger: null };
  }

  const windowSamples = tileWindowSamples(s, tile);
  const pre = Math.round((tile.triggerPositionPct / 100) * windowSamples);
  const start = Math.max(0, snap.index - pre);
  const end = start + windowSamples;

  const series: TdSeriesVM[] = [];
  for (const id of shownTraces(tile)) {
    const t = s.traces.byId[id];
    if (!t) continue;
    const own = t.source.kind === "memory" || t.source.kind === "program";
    const aligned = !own ? snap.samples[id] : undefined;
    if (aligned) {
      const offsetDb = snap.offsetDb[id] ?? null;
      series.push(scaledTdSeries(t, aligned.slice(start, end), snap.sampleRate, unit, offsetDb));
      continue;
    }
    const td = getFrames(id)?.td;
    if (!td) continue;
    series.push(scaledTdSeries(t, td.samples, td.sampleRate, unit, t.offsetDb));
  }

  const state: TriggerState = s.run.triggers[sourceId]?.state ?? snap.state;
  const trigger: ScopeTriggerVM = {
    sourceId,
    state,
    frac: snap.frac,
    levelDisplay: triggerLevelToDisplay(settings.levelV, unit, snap.offsetDb[sourceId] ?? null),
    position: windowSamples > 0 ? pre / windowSamples : 0,
    held: state === "waiting" || state === "stopped",
  };
  return { series, unitLabel: TD_UNIT_LABELS[unit], trigger };
}

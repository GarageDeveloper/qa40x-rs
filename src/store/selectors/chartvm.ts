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
import { displayOffsetDb, displayScale } from "../../core/units";
import { getFrames } from "../../data/frames";
import { shownTraces } from "./layout";
import {
  isRatioTrace,
  traceCurveColor,
  type AppState,
  type TileConfig,
} from "../state";

export { displayOffsetDb, displayScale };

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

/**
 * The trace a tile's readouts (chips, harmonic markers) follow: the explicit
 * chip source when it is still a member, else the first DRAWN trace with
 * data (a legend-hidden curve isn't what the user is reading).
 */
export function chipSourceTraceId(tile: TileConfig): TraceId | null {
  if (tile.chipSource !== "auto" && tile.traces.includes(tile.chipSource)) {
    return tile.chipSource;
  }
  const drawn = shownTraces(tile);
  for (const id of drawn) {
    const f = getFrames(id);
    if (f && (f.td || f.fd)) return id;
  }
  return drawn[0] ?? tile.traces[0] ?? null;
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

export interface ScopeVM {
  series: TdSeriesVM[];
  unitLabel: string;
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

/** Build a scope tile's view-model: every member trace with a td frame,
 * samples scaled to the tile's display unit by the trace's OWN converter
 * offset. */
export function scopeVM(s: AppState, tile: TileConfig): ScopeVM {
  const unit = tile.tdUnit;
  const series: TdSeriesVM[] = [];
  for (const id of shownTraces(tile)) {
    const t = s.traces.byId[id];
    if (!t) continue;
    const td = getFrames(id)?.td;
    if (!td) continue;
    const k = displayScale(unit, t.offsetDb);
    const samples =
      k === 1 ? td.samples : Float64Array.from(td.samples, (v) => v * k);
    series.push({
      id,
      label: t.label,
      color: t.color,
      samples,
      sampleRate: td.sampleRate,
      seq: t.seq,
    });
  }
  return { series, unitLabel: TD_UNIT_LABELS[unit] };
}

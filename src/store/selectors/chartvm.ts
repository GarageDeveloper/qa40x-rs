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
import { getFrames, type DecodedSweep } from "../../data/frames";
import { getTriggerSnapshot, type TriggerSnapshot } from "../../data/triggered";
import { chipSourceTraceId, shownTraces } from "./layout";
import { tileTriggerSourceId, tileWindowSamples } from "./trigger";
import {
  DEFAULT_TRIGGER,
  isRatioTrace,
  traceCurveColor,
  type AppState,
  type CaptureProvenance,
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
  /** The dBr reference actually subtracted from every series (in the tile's
   * pre-dBr unit — dBV/dBu/dBFS); null when dBr is off. Surfaced for the
   * CSV export's provenance (issue #30 review finding #4): with an AUTO
   * reference this is a runtime peak nothing else records, and without it a
   * dBr file can never be re-absolutized. */
  dbrRefDb: number | null;
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
  /** Sub-sample residual in [0,1] — the renderer's fractional x-shift. */
  frac: number;
  /** Y of the level marker, in the tile's display unit. */
  levelDisplay: number;
  /** X of the trigger point, 0..1 of the displayed window. */
  position: number;
  /** True for `waiting`/`stopped` — the picture is the last HELD snapshot,
   * not this frame's live capture (NORMAL/SINGLE holding). */
  held: boolean;
  /** The converter offset actually used to build `levelDisplay` (the
   * snapshot's OWN baked offset — the trigger object is only ever built once
   * a snapshot is resolved, see `scopeVM`). A drag handler or a gear field
   * that also converts `settings.levelV` must read THIS value, never the
   * trace's live `offsetDb` — the two can differ after a range change while
   * a picture is held, and reading two different offsets for "the same"
   * conversion makes the marker jump (issue #26 review #5, #60-style). */
  sourceOffsetDb: number | null;
  /** The latched frame's capture provenance (issue #40) — same baked-at-
   * latch rule as `sourceOffsetDb`: an export of this picture must be
   * signed by the bench that produced it, not the live one. */
  capture: CaptureProvenance | null;
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

/**
 * The trigger snapshot `scopeVM` (and `triggerSourceOffsetDb`) treat as
 * "resolved" for `sourceId`: absent when the mode is off, no picture has
 * latched yet, OR the held snapshot's own sample array no longer matches the
 * CURRENT acquisition fftSize. A snapshot's arrays were captured at the
 * fftSize in effect at latch time; if the user changes fftSize while
 * NORMAL/SINGLE holds a picture, that stale buffer no longer lines up with
 * the live acquisition — treat it as absent (falls back to the live,
 * unaligned path) rather than slicing samples at the wrong time base
 * (issue #26 review #3).
 */
function resolvedTriggerSnapshot(s: AppState, sourceId: TraceId): TriggerSnapshot | undefined {
  const settings = s.triggers[sourceId] ?? DEFAULT_TRIGGER;
  if (settings.mode === "off") return undefined;
  const snap = getTriggerSnapshot(sourceId);
  if (!snap) return undefined;
  const held = snap.samples[sourceId];
  if (!held || held.length !== s.acquisition.fftSize) return undefined;
  return snap;
}

/**
 * The offset `scopeVM` actually converts `sourceId`'s trigger level through:
 * the HELD snapshot's own baked offset when one is resolved (mirrors
 * `levelDisplay`'s exact conversion, #60-style — a live range change must
 * never rescale a held picture), else the trace's current live offset. Any
 * OTHER code converting the same endpoint's trigger level (a canvas drag
 * handler, the gear level field) must read this, not `traces.byId[id]
 * .offsetDb` directly — the two can disagree once a picture is held across a
 * range change, which used to make the level marker jump (issue #26 review
 * #5).
 */
export function triggerSourceOffsetDb(s: AppState, sourceId: TraceId): number | null {
  const snap = resolvedTriggerSnapshot(s, sourceId);
  if (snap) return snap.offsetDb[sourceId] ?? null;
  return s.traces.byId[sourceId]?.offsetDb ?? null;
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
  /** This curve's OWN y unit ("dB"/"%"), from its trace's frame (program
   * fallback per `sweepUnitLabel`). The tile-level `unitLabel` is fixed by
   * the FIRST member only — a THD-dB and a THD-% sweep can share a tile, and
   * the CSV export must label each column truthfully (issue #30 review
   * finding #5) instead of stamping the first trace's unit on all. */
  yUnitLabel: string;
}

export interface SweepVM {
  series: SweepSeriesVM[];
  unitLabel: string;
  /** X-axis unit: "Hz" for a frequency sweep (THD-vs-frequency or FR),
   * "dBFS" for a THD-vs-level sweep (issue #27), or "rateHz" for a wow &
   * flutter deviation spectrum (issue #28 second pass — a DIFFERENT
   * quantity from stimulus Hz, so it never silently shares an axis with
   * one) — the renderer switches its axis scale/floor and tick/marker
   * formatting on this. Fixed by the FIRST member trace with data; any
   * other member whose OWN axis differs lands in `omitted` instead of
   * `series` (a tile can't mix incompatible x-axes on one plot). */
  xUnit: "Hz" | "dBFS" | "rateHz";
  /** Member traces skipped because their sweep's x-axis unit doesn't match
   * `xUnit` (issue #27 review finding #3) — tile.ts marks their legend chip
   * instead of silently dropping them. */
  omitted: TraceId[];
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
  let dbrApplied = false;
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
    dbrApplied = true;
    unitLabel = "dBr";
  }
  return {
    series,
    unitLabel,
    harmonics: harmonicsVM(s, tile, dbrRef),
    dbrRefDb: dbrApplied ? dbrRef : null,
  };
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

/**
 * A sweep trace's Y unit — read from the FRAME first (issue #28 second
 * pass review finding #5), the SAME reasoning as `sweepXUnit` below: "%"
 * for a THD-percent program curve or a wow & flutter deviation spectrum,
 * "dB" otherwise (sweep values are measurement units, not converter-
 * referenced — no offsets apply). Deriving this from the CURRENT program
 * params only (the original approach) lost the unit the moment a trace
 * froze into a program-less `memory` trace or the doc reloaded — exactly
 * the freeze-and-compare use case wow & flutter exists for. The
 * program-params lookup is only a fallback for frames predating this field.
 */
export function sweepUnitLabel(s: AppState, id: TraceId, sweep: DecodedSweep | undefined): string {
  if (sweep?.yUnit) return sweep.yUnit;
  const p = s.programs.byId[id];
  if (p?.kind === "sweep") {
    if (p.params.measurement === "wowflutter") return "%";
    if (p.params.measurement === "thd" && p.params.metric === "thd_percent") return "%";
  }
  return "dB";
}

/**
 * A sweep trace's X unit — read from the FRAME first (issue #27 review
 * finding #1): `sweep.xUnit`, set at land time from the backend's OWN
 * `swept` field (see `runSweep` in actions/programs.ts), survives a freeze
 * (❄ copies the frame verbatim) and a save/reload (persisted alongside the
 * frame, `persist.ts`'s `PersistedFrames.sweepXUnit`) even once the
 * originating program is gone. The program-params lookup is only a
 * fallback for frames that predate this field (a script-emitted sweep, or
 * an old saved doc) — deriving it from the program's CURRENT params would
 * relabel a landed Hz sweep the moment the dialog's axis is flipped to
 * Level without a re-run (finding #4), and strand a level sweep's frozen /
 * program-deleted trace back on "Hz" (log10 of a negative dBFS is NaN —
 * the original bug report). "rateHz" (issue #28 second pass) is wow &
 * flutter's own axis — a DIFFERENT quantity from stimulus Hz (modulation
 * rate, not tone frequency), so it never silently shares "Hz"'s axis/floor
 * with an actual frequency sweep on the same tile (findings #3/#7).
 */
export function sweepXUnit(
  s: AppState,
  id: TraceId,
  sweep: DecodedSweep | undefined
): "Hz" | "dBFS" | "rateHz" {
  if (sweep?.xUnit) return sweep.xUnit;
  const p = s.programs.byId[id];
  if (p?.kind === "sweep") {
    if (p.params.measurement === "wowflutter") return "rateHz";
    if (p.params.measurement === "thd" && p.params.axis === "level") return "dBFS";
  }
  return "Hz";
}

/**
 * Build a sweep tile's view-model: every member trace with a sweep frame,
 * one series per curve (multi-curve traces suffix the curve label). Values
 * are measurement units already — the renderer adds nothing.
 *
 * The tile's x-axis unit is fixed by the FIRST member with data (issue #27):
 * a log-Hz frequency sweep and a linear-dBFS level sweep can't share one
 * plot's scale, so a later member on the OTHER axis is omitted rather than
 * drawn (NaN'd/garbled extents) — see finding #3.
 */
export function sweepVM(s: AppState, tile: TileConfig): SweepVM {
  const series: SweepSeriesVM[] = [];
  const omitted: TraceId[] = [];
  let unitLabel = "dB";
  let xUnit: "Hz" | "dBFS" | "rateHz" = "Hz";
  let xUnitFixed = false;
  for (const id of shownTraces(tile)) {
    const t = s.traces.byId[id];
    if (!t) continue;
    const sweep = getFrames(id)?.sweep;
    if (!sweep) continue;
    const traceXUnit = sweepXUnit(s, id, sweep);
    if (!xUnitFixed) {
      unitLabel = sweepUnitLabel(s, id, sweep);
      xUnit = traceXUnit;
      xUnitFixed = true;
    } else if (traceXUnit !== xUnit) {
      omitted.push(id);
      continue;
    }
    const hiddenCurves = tile.hiddenCurves[id] ?? [];
    const traceYUnit = sweepUnitLabel(s, id, sweep);
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
        yUnitLabel: traceYUnit,
      });
    });
  }
  return { series, unitLabel, xUnit, omitted };
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
 * Build a scope tile's view-model. With no trigger (mode off, no aligned
 * picture latched yet, or a held picture whose fftSize no longer matches the
 * live acquisition — review #3): every member's OWN live td frame, scaled by
 * its OWN converter offset — `trigger: null`, byte-identical to the
 * pre-Lot-A shape (regression-pinned).
 *
 * With a trigger on and a snapshot resolved (data/triggered.ts): every hw
 * endpoint member is built from the SNAPSHOT's arrays (references, already
 * simultaneous with the trigger scan — all 4 hw channels share one capture),
 * sliced to `[start, end)` around the trigger index — `start = index -
 * preUsed` with `preUsed` clamped to `index` (never slices before sample 0)
 * and `end` clamped to the snapshot's own length (never past the held
 * buffer) — and scaled by the snapshot's OWN baked offset (never the live
 * one — a range change must not rescale a HELD waiting/stopped picture,
 * #60-style). A `memory`/`program` member keeps its own live, unsliced
 * origin — it has its own time base, not the synchronized hw capture the
 * trigger indexes into.
 */
export function scopeVM(s: AppState, tile: TileConfig): ScopeVM {
  const unit = tile.tdUnit;
  const sourceId = tileTriggerSourceId(s, tile);
  const settings = sourceId ? (s.triggers[sourceId] ?? DEFAULT_TRIGGER) : DEFAULT_TRIGGER;
  const snap = sourceId ? resolvedTriggerSnapshot(s, sourceId) : undefined;

  if (!sourceId || !snap) {
    return { series: liveScopeSeries(s, tile), unitLabel: TD_UNIT_LABELS[unit], trigger: null };
  }

  // The canvas draws sample `i` at `(i - (frac - 1)) / (count - 1)` of the
  // plot (canvas.ts's `xOf`, `count = displayCount()`), so the crossing at
  // continuous sample `index - 1 + frac` lands exactly on the marker only
  // when THIS selector's `position` (the marker's X, 0..1) uses the SAME
  // `count - 1` denominator — `windowSamples` alone is wrong whenever the
  // slice was clamped (see below). `preUsed` is clamped to `snap.index` so
  // the slice never starts before sample 0; `end` is clamped to the
  // snapshot's own length so it never reads past the held buffer (issue #26
  // reviews #4/#7).
  const windowSamples = tileWindowSamples(s, tile);
  const rawPre = Math.round((tile.triggerPositionPct / 100) * windowSamples);
  const preUsed = Math.min(rawPre, snap.index);
  const start = snap.index - preUsed;
  const snapshotLength = snap.samples[sourceId]?.length ?? 0;
  const end = Math.min(start + windowSamples, snapshotLength);
  const count = end - start;

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
  const sourceOffsetDb = snap.offsetDb[sourceId] ?? null;
  const trigger: ScopeTriggerVM = {
    sourceId,
    state,
    frac: snap.frac,
    levelDisplay: triggerLevelToDisplay(settings.levelV, unit, sourceOffsetDb),
    position: preUsed / Math.max(1, count - 1),
    held: state === "waiting" || state === "stopped",
    sourceOffsetDb,
    capture: snap.capture,
  };
  return { series, unitLabel: TD_UNIT_LABELS[unit], trigger };
}

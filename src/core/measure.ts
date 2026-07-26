/**
 * Measure chips (M3 — port of v1 dashboard/measure.ts): small readouts shown
 * above a graph tile. The VALUES come from the backend — `measure_frames`
 * (td RMS/peak/DC + fd peak bin, memoized by trace seq in data/measures.ts)
 * and the stream frame's harmonic metrics (THD/THD+N/SNR/SINAD, input
 * channels). This module only FORMATS — level chips in the TILE's display
 * unit through the measured trace's OWN converter offset (v1 printed raw
 * dBFS everywhere; a scope in volts now reads its chips in volts too).
 */
import type { AnalysisResult, FrameMeasures, ScopeMeasures, ScopeStat } from "../gen";
import type { FdUnit, TdUnit } from "./model";
import { db, displayOffsetDb, displayScale, formatVrms } from "./units";

/** Everything a chip may read for one trace. Null = not landed yet. */
export interface ChipContext {
  measures: FrameMeasures | null;
  metrics: AnalysisResult | null;
  /** Backend scope measurement suite + sliding stats (issue #26 lot B) —
   * null while the endpoint isn't in the stream's `MeasureRequest`. */
  scope: ScopeMeasures | null;
  /** The measured trace's own converter dBFS→dBV offset (null until known
   * — level chips then fall back to the converter-relative dBFS). */
  offsetDb: number | null;
  /** The tile's display units — level chips follow them. */
  tdUnit: TdUnit;
  fdUnit: FdUnit;
}

const FD_UNIT_LABELS: Record<FdUnit, string> = { dbfs: "dBFS", dbv: "dBV", dbu: "dBu" };

/** A td level (linear digital full-scale, RMS-referenced) in the tile's td
 * unit: volts (through the converter offset) or %FS; dBFS fallback while
 * the offset is unknown. `peak` levels print as Vpk. */
function fmtTdLevel(ctx: ChipContext, linearFs: number, peak: boolean): string {
  if (ctx.tdUnit === "pctfs") {
    return `${(linearFs * 100).toPrecision(3)} %FS`;
  }
  if (ctx.offsetDb === null) return dbfs(linearFs);
  const volts = linearFs * displayScale("v", ctx.offsetDb);
  // formatVrms takes CANONICAL Vrms: a peak value converts through √2 so
  // the printed number stays the instantaneous volts ("Vpk").
  return peak ? formatVrms(volts / Math.SQRT2, "vpk") : formatVrms(volts, "vrms");
}

/** Compact frequency label (kept local so this module stays DOM-free). */
function fmtHz(f: number): string {
  if (f >= 1000) return `${Number((f / 1000).toFixed(2))} kHz`;
  return `${Math.round(f)} Hz`;
}

// Metric formatters — mirror v1 so readouts keep their exact shapes.
// metrics.thd/thd_n are percentages; snr/sinad dB.
function pct(v: number): string {
  if (!isFinite(v)) return "—";
  return `${Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(4)} %`;
}
function percentToDb(percent: number): string {
  if (!isFinite(percent) || percent <= 0) return "−∞ dB";
  return `${db(percent / 100).toFixed(1)} dB`;
}
function dbMetric(v: number): string {
  if (!isFinite(v)) return v > 0 ? "∞ dB" : "−∞ dB";
  return `${v.toFixed(1)} dB`;
}
function dbfs(v: number): string {
  return v > 0 ? `${db(v).toFixed(1)} dBFS` : "−∞ dBFS";
}

export interface MeasureDef {
  key: string;
  label: string;
  desc: string;
  domain: "td" | "fd";
  /** A display string, or "—" when the value is unavailable (frame missing,
   * or its backend measurement hasn't landed yet). */
  format: (ctx: ChipContext) => string;
  /** Sliding-window statistics line for the chip tooltip (scope measurement
   * suite, issue #26 lot B) — null when no reading is in the window yet. */
  statsTooltip?: (ctx: ChipContext) => string | null;
}

/* ---- scope measurement suite (issue #26 lot B) ----------------------- */

/** A linear FS-domain level in the tile's td unit, with an explicit suffix
 * ("Vpp", "Vrms", "V"…): %FS mode stays in %FS, volts go through the
 * measured trace's own converter offset with an adaptive SI prefix; raw
 * "FS" while the offset is unknown (a dB reading of a Vpp makes no sense,
 * unlike the RMS/Peak chips' dBFS fallback). */
function fmtScopeLevel(ctx: ChipContext, linearFs: number, suffix: string): string {
  if (ctx.tdUnit === "pctfs") return `${(linearFs * 100).toPrecision(3)} %FS`;
  if (ctx.offsetDb === null) return `${linearFs.toPrecision(3)} FS`;
  const v = linearFs * displayScale("v", ctx.offsetDb);
  const a = Math.abs(v);
  const [scaled, prefix] =
    a >= 1 || a === 0 ? [v, ""] : a >= 1e-3 ? [v * 1e3, "m"] : a >= 1e-6 ? [v * 1e6, "µ"] : [v * 1e9, "n"];
  return `${scaled.toPrecision(3)} ${prefix}${suffix}`;
}

/** A frequency with DSO-grade digits (the backend refines to ~0.005 Hz on
 * long windows — a rounded "1 kHz" would throw that away). */
function fmtScopeHz(f: number): string {
  const decimals = f < 100 ? 4 : f < 10_000 ? 3 : 2;
  return `${f.toFixed(decimals)} Hz`;
}

/** A time in seconds with an adaptive SI prefix (ms / µs / ns). */
function fmtScopeSeconds(t: number): string {
  const a = Math.abs(t);
  const [scaled, prefix] =
    a >= 1 || a === 0 ? [t, ""] : a >= 1e-3 ? [t * 1e3, "m"] : a >= 1e-6 ? [t * 1e6, "µ"] : [t * 1e9, "n"];
  return `${scaled.toPrecision(3)} ${prefix}s`;
}

/** One suite chip: value from this frame's `ScopeStat`, stats tooltip from
 * its sliding window (`n == 0` = nothing measured yet — no tooltip). */
function scopeDef(
  key: string,
  label: string,
  desc: string,
  pick: (m: ScopeMeasures) => ScopeStat,
  fmt: (ctx: ChipContext, v: number) => string
): MeasureDef {
  return {
    key,
    label,
    desc,
    domain: "td",
    format: (ctx) => {
      const stat = ctx.scope ? pick(ctx.scope) : null;
      return stat && stat.value !== null ? fmt(ctx, stat.value) : "—";
    },
    statsTooltip: (ctx) => {
      const stat = ctx.scope ? pick(ctx.scope) : null;
      if (!stat || stat.n === 0) return null;
      return (
        `avg ${fmt(ctx, stat.avg)} · min ${fmt(ctx, stat.min)} · max ${fmt(ctx, stat.max)}` +
        ` · σ ${fmt(ctx, stat.sd)} · n=${stat.n}`
      );
    },
  };
}

export const MEASURES: MeasureDef[] = [
  {
    key: "rms",
    label: "RMS",
    desc: "Time-domain RMS",
    domain: "td",
    format: (ctx) => (ctx.measures?.td ? fmtTdLevel(ctx, ctx.measures.td.rms, false) : "—"),
  },
  {
    key: "peak",
    label: "Peak",
    desc: "Peak sample",
    domain: "td",
    format: (ctx) => (ctx.measures?.td ? fmtTdLevel(ctx, ctx.measures.td.peak, true) : "—"),
  },
  {
    key: "crest",
    label: "Crest",
    desc: "Peak ÷ RMS",
    domain: "td",
    format: ({ measures: m }) =>
      m?.td && m.td.rms > 0 ? `${db(m.td.peak / m.td.rms).toFixed(1)} dB` : "—",
  },
  {
    key: "dc",
    label: "DC",
    desc: "DC offset (mean)",
    domain: "td",
    format: (ctx) => {
      const m = ctx.measures;
      if (!m?.td) return "—";
      if (ctx.tdUnit === "pctfs") return `${(m.td.dc_offset * 100).toPrecision(3)} %FS`;
      if (ctx.offsetDb === null) return `${(m.td.dc_offset * 1e3).toPrecision(3) } mFS`;
      const volts = m.td.dc_offset * displayScale("v", ctx.offsetDb);
      return `${(volts * 1e3).toPrecision(3)} mV`;
    },
  },
  {
    key: "peakfreq",
    label: "Peak freq",
    desc: "Loudest bin",
    domain: "fd",
    format: ({ measures: m }) => (m?.fd ? fmtHz(m.fd.freq) : "—"),
  },
  {
    key: "peaklvl",
    label: "Peak level",
    desc: "Loudest bin level",
    domain: "fd",
    format: (ctx) => {
      const m = ctx.measures;
      if (!m?.fd) return "—";
      const v = m.fd.mag_db + displayOffsetDb(ctx.fdUnit, ctx.offsetDb);
      const unit = ctx.offsetDb === null ? "dBFS" : FD_UNIT_LABELS[ctx.fdUnit];
      return `${v.toFixed(1)} ${unit}`;
    },
  },
  // Scope measurement suite (issue #26 lot B) — backend-computed per
  // endpoint with sliding-window stats on the chip tooltip. The values ride
  // the stream frame (data/frames.ts `scope`), not `measure_frames`.
  scopeDef("vpp", "Vpp", "Peak-to-peak amplitude", (m) => m.vpp, (ctx, v) =>
    fmtScopeLevel(ctx, v, "Vpp")
  ),
  // Vmean goes through the same adaptive-SI path as the other levels: a
  // hard-coded mV would print "5.00e+3 mV" for a 5 V mean (reachable on a
  // +18 dBV range — review lot B #12).
  scopeDef("vmean", "Vmean", "Mean level (DC) of the frame", (m) => m.vmean, (ctx, v) =>
    fmtScopeLevel(ctx, v, "V")
  ),
  scopeDef(
    "acrms",
    "AC RMS",
    "AC-coupled RMS over whole periods (crossing to crossing)",
    (m) => m.rms_ac,
    (ctx, v) => fmtScopeLevel(ctx, v, "Vrms")
  ),
  scopeDef(
    "freq",
    "Freq",
    "Fundamental frequency (crossing seed, Goertzel-refined)",
    (m) => m.freq_hz,
    (_ctx, v) => fmtScopeHz(v)
  ),
  scopeDef("rise", "Rise", "Mean 10–90 % rise time", (m) => m.rise_s, (_ctx, v) =>
    fmtScopeSeconds(v)
  ),
  scopeDef("fall", "Fall", "Mean 90–10 % fall time", (m) => m.fall_s, (_ctx, v) =>
    fmtScopeSeconds(v)
  ),
  scopeDef("duty", "Duty", "Time above the 50 % level, whole periods", (m) => m.duty, (_ctx, v) =>
    `${(v * 100).toFixed(1)} %`
  ),
  // Backend harmonic metrics — input endpoints only (the stream analyzes
  // captured channels; an ideal stimulus has no distortion to measure).
  { key: "thd", label: "THD", desc: "Total harmonic distortion", domain: "fd", format: ({ metrics }) => (metrics ? pct(metrics.thd) : "—") },
  { key: "thddb", label: "THD (dB)", desc: "THD relative, in dB", domain: "fd", format: ({ metrics }) => (metrics ? percentToDb(metrics.thd) : "—") },
  { key: "thdn", label: "THD+N", desc: "THD + noise, in dB", domain: "fd", format: ({ metrics }) => (metrics ? percentToDb(metrics.thd_n) : "—") },
  { key: "snr", label: "SNR", desc: "Signal-to-noise ratio", domain: "fd", format: ({ metrics }) => (metrics ? dbMetric(metrics.snr) : "—") },
  { key: "sinad", label: "SINAD", desc: "Signal to noise+distortion", domain: "fd", format: ({ metrics }) => (metrics ? dbMetric(metrics.sinad) : "—") },
];

/** The chip keys served by the backend scope measurement suite — the keys
 * whose presence on a visible tile puts its chip-source endpoint into the
 * stream's `MeasureRequest` (selectors/measures.ts). */
export const SCOPE_MEASURE_KEYS: ReadonlySet<string> = new Set([
  "vpp",
  "vmean",
  "acrms",
  "freq",
  "rise",
  "fall",
  "duty",
]);

export function measureByKey(key: string): MeasureDef | undefined {
  return MEASURES.find((m) => m.key === key);
}

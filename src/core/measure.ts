/**
 * Measure chips (M3 — port of v1 dashboard/measure.ts): small readouts shown
 * above a graph tile. The VALUES come from the backend — `measure_frames`
 * (td RMS/peak/DC + fd peak bin, memoized by trace seq in data/measures.ts)
 * and the stream frame's harmonic metrics (THD/THD+N/SNR/SINAD, input
 * channels). This module only FORMATS — level chips in the TILE's display
 * unit through the measured trace's OWN converter offset (v1 printed raw
 * dBFS everywhere; a scope in volts now reads its chips in volts too).
 */
import type { AnalysisResult, FrameMeasures } from "../gen";
import type { FdUnit, TdUnit } from "./model";
import { db, displayOffsetDb, displayScale, formatVrms } from "./units";

/** Everything a chip may read for one trace. Null = not landed yet. */
export interface ChipContext {
  measures: FrameMeasures | null;
  metrics: AnalysisResult | null;
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
  // Backend harmonic metrics — input endpoints only (the stream analyzes
  // captured channels; an ideal stimulus has no distortion to measure).
  { key: "thd", label: "THD", desc: "Total harmonic distortion", domain: "fd", format: ({ metrics }) => (metrics ? pct(metrics.thd) : "—") },
  { key: "thddb", label: "THD (dB)", desc: "THD relative, in dB", domain: "fd", format: ({ metrics }) => (metrics ? percentToDb(metrics.thd) : "—") },
  { key: "thdn", label: "THD+N", desc: "THD + noise, in dB", domain: "fd", format: ({ metrics }) => (metrics ? percentToDb(metrics.thd_n) : "—") },
  { key: "snr", label: "SNR", desc: "Signal-to-noise ratio", domain: "fd", format: ({ metrics }) => (metrics ? dbMetric(metrics.snr) : "—") },
  { key: "sinad", label: "SINAD", desc: "Signal to noise+distortion", domain: "fd", format: ({ metrics }) => (metrics ? dbMetric(metrics.sinad) : "—") },
];

export function measureByKey(key: string): MeasureDef | undefined {
  return MEASURES.find((m) => m.key === key);
}

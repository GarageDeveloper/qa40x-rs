/**
 * Canonical units core (dashboard task #19).
 *
 * The data plane keeps amplitudes in ONE canonical unit — RMS volts (Vrms) —
 * and this module converts a canonical value to whatever unit a graph/axis or
 * readout wants to show: peak volts, dBV, dBu, dBFS, dBr, watts, or percent.
 *
 * Keeping a single canonical unit means a trace is measured once and displayed
 * in any unit without re-measuring, and two traces in different units can share
 * a graph by projecting both through here. All functions are pure (no DOM), so
 * they are unit-tested directly.
 *
 * References:
 *   dBV  → 1 Vrms
 *   dBu  → 0.7746 Vrms (√(1 mW into 600 Ω))
 *   dBFS → the device's full-scale Vrms for the active input range (in refs)
 *   dBr  → a user/reference level in Vrms (in refs)
 *   W    → v² / load Ω (in refs)
 *   %    → v / reference Vrms × 100 (in refs)
 */

import type { FdUnit, TdUnit, Unit } from "./model";

/** Reference levels a conversion may need (device/range/context dependent). */
export interface UnitRefs {
  /** Vrms that corresponds to 0 dBFS for the active input range. */
  fullScaleVrms: number;
  /** Reference level for dBr / percent (e.g. a stored "0 dBr" level). */
  refVrms: number;
  /** Load resistance (Ω) used to turn volts into watts. */
  loadOhms: number;
}

/** Neutral defaults (1 Vrms full-scale & reference, 8 Ω load). */
export const DEFAULT_REFS: UnitRefs = { fullScaleVrms: 1, refVrms: 1, loadOhms: 8 };

const DBV_REF = 1; // 1 Vrms
const DBU_REF = 0.7745966692414834; // √(0.001 W · 600 Ω)
const SQRT2 = Math.SQRT2;

/** dB-family (logarithmic) units — displayed to 0.1 dB, floor at −∞. */
const DB_UNITS: ReadonlySet<Unit> = new Set(["dbv", "dbu", "dbfs", "dbr", "db"]);

export function isDbUnit(unit: Unit): boolean {
  return DB_UNITS.has(unit);
}

/** Amplitude ratio → dB (20·log10); −∞ for silence. */
export const db = (ratio: number): number => (ratio > 0 ? 20 * Math.log10(ratio) : -Infinity);
/** dB → amplitude ratio (inverse of {@link db}). */
export const undb = (value: number): number => Math.pow(10, value / 20);

/** The constant dB offset between the dBu and dBV scales (≈ +2.2185 dB):
 * `dBu = dBV + DBU_OVER_DBV_DB`. Single TS definition — the Rust twin is
 * `measurements::units::dbv_to_dbu_db()`. */
export const DBU_OVER_DBV_DB = 20 * Math.log10(DBV_REF / DBU_REF);

/* ------------------------------------------------------------------ */
/* Per-converter display mapping (the #51/#60 pair, in one place).      */
/* ------------------------------------------------------------------ */

/** dB to add to a trace's raw (own-converter dBFS) spectrum for `unit`. */
export function displayOffsetDb(unit: FdUnit, traceOffsetDb: number | null): number {
  switch (unit) {
    case "dbfs":
      return 0;
    case "dbv":
      return traceOffsetDb ?? 0;
    case "dbu":
      return (traceOffsetDb ?? 0) + DBU_OVER_DBV_DB;
  }
}

/** Linear factor mapping a full-scale sample of the trace's converter to
 * `unit` — the td twin of {@link displayOffsetDb} (#60). */
export function displayScale(unit: TdUnit, traceOffsetDb: number | null): number {
  switch (unit) {
    case "pctfs":
      return 100;
    case "v":
      return Math.pow(10, (traceOffsetDb ?? 0) / 20);
    case "mv":
      return 1000 * Math.pow(10, (traceOffsetDb ?? 0) / 20);
  }
}

/** Convert a canonical Vrms amplitude to a target unit's numeric value. */
export function fromVrms(vrms: number, unit: Unit, refs: UnitRefs = DEFAULT_REFS): number {
  const v = Math.max(0, vrms);
  switch (unit) {
    case "vrms":
      return v;
    case "vpk":
      return v * SQRT2;
    case "dbv":
    case "db":
      return db(v / DBV_REF);
    case "dbu":
      return db(v / DBU_REF);
    case "dbfs":
      return db(v / refs.fullScaleVrms);
    case "dbr":
      return db(v / refs.refVrms);
    case "percent":
      return refs.refVrms > 0 ? (v / refs.refVrms) * 100 : 0;
    case "watt":
      return refs.loadOhms > 0 ? (v * v) / refs.loadOhms : 0;
  }
}

/** Inverse of {@link fromVrms}: a unit's numeric value back to canonical Vrms. */
export function toVrms(value: number, unit: Unit, refs: UnitRefs = DEFAULT_REFS): number {
  switch (unit) {
    case "vrms":
      return value;
    case "vpk":
      return value / SQRT2;
    case "dbv":
    case "db":
      return DBV_REF * undb(value);
    case "dbu":
      return DBU_REF * undb(value);
    case "dbfs":
      return refs.fullScaleVrms * undb(value);
    case "dbr":
      return refs.refVrms * undb(value);
    case "percent":
      return (refs.refVrms * value) / 100;
    case "watt":
      return Math.sqrt(Math.max(0, value) * refs.loadOhms);
  }
}

/** Short axis/badge caption for a unit (e.g. "dBV", "Vrms", "%"). */
export function unitLabel(unit: Unit): string {
  switch (unit) {
    case "vrms":
      return "Vrms";
    case "vpk":
      return "Vpk";
    case "dbv":
      return "dBV";
    case "dbu":
      return "dBu";
    case "dbfs":
      return "dBFS";
    case "dbr":
      return "dBr";
    case "watt":
      return "W";
    case "percent":
      return "%";
    case "db":
      return "dB";
  }
}

/** Adaptive SI prefix for a linear magnitude (V or W): value scaled + prefix. */
function siScale(x: number): { value: number; prefix: string } {
  const a = Math.abs(x);
  if (a === 0 || !isFinite(a)) return { value: x, prefix: "" };
  if (a >= 1) return { value: x, prefix: "" };
  if (a >= 1e-3) return { value: x * 1e3, prefix: "m" };
  if (a >= 1e-6) return { value: x * 1e6, prefix: "µ" };
  return { value: x * 1e9, prefix: "n" };
}

export interface FormatOpts {
  /** Significant decimals for dB / percent readouts (default 1). */
  dbDigits?: number;
  /** Significant figures for linear (V / W) readouts (default 3). */
  sig?: number;
}

/**
 * Format a canonical Vrms amplitude in a unit as a display string with its
 * suffix (e.g. "−6.0 dBV", "1.23 Vrms", "12.3 mVrms", "0.50 W", "50.0 %").
 * dB-family units below −200 dB show "−∞".
 */
export function formatVrms(
  vrms: number,
  unit: Unit,
  refs: UnitRefs = DEFAULT_REFS,
  opts: FormatOpts = {}
): string {
  const value = fromVrms(vrms, unit, refs);
  const label = unitLabel(unit);
  if (isDbUnit(unit)) {
    if (!isFinite(value) || value <= -200) return `−∞ ${label}`;
    return `${minus(value.toFixed(opts.dbDigits ?? 1))} ${label}`;
  }
  if (unit === "percent") {
    return `${minus(value.toFixed(opts.dbDigits ?? 1))} ${label}`;
  }
  // Linear volts / watts: adaptive SI prefix + ~3 significant figures.
  const { value: scaled, prefix } = siScale(value);
  const sig = opts.sig ?? 3;
  const intDigits = scaled === 0 ? 1 : Math.max(1, Math.floor(Math.log10(Math.abs(scaled))) + 1);
  const digits = Math.max(0, sig - intDigits);
  // "Vrms"/"Vpk" keep their rms/pk hint after the SI prefix (e.g. "mVrms").
  const suffix =
    unit === "watt" ? `${prefix}W` : `${prefix}V${label.startsWith("V") ? label.slice(1) : ""}`;
  return `${minus(scaled.toFixed(digits))} ${suffix}`;
}

/** Normalise a leading ASCII hyphen to the app's U+2212 minus sign. */
function minus(s: string): string {
  return s.startsWith("-") ? `−${s.slice(1)}` : s;
}

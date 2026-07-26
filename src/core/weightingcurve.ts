/**
 * User weighting curve CSV import (issue #29): the frontend counterpart to
 * `measurements::weighting::UserWeightingCurve` — the backend already
 * accepts an arbitrary `(freqs, gains)` curve as a parameter (log-f/linear-dB
 * interpolation, held flat past the ends); this module is the only place
 * that turns a user-supplied file into that shape.
 */
import type { UserWeightingCurve } from "../gen";

/**
 * A REW/ARTA-style export can carry ~20k rows (review finding #2): embedded
 * verbatim in a `TransformStep`, that is re-stringified by the chain
 * watcher on every store batch and by the auto-save, and a JSON blob that
 * size risks blowing the localStorage quota. Decimated at import instead —
 * the curve is already log-f/linear-dB interpolated behind the scenes, so a
 * few hundred well-chosen points reproduce it with no audible/visible loss.
 */
export const MAX_CURVE_POINTS = 1000;

export interface ParsedUserCurve {
  curve: UserWeightingCurve;
  /** Lines that looked like data but didn't parse (a lenient import notes
   * this instead of refusing the whole file over one bad row). */
  skipped: number;
  /** True when the import exceeded `MAX_CURVE_POINTS` and was decimated. */
  decimated: boolean;
  /** Point count BEFORE decimation (only meaningful when `decimated`). */
  originalPoints: number;
}

export interface ParseError {
  error: string;
}

/**
 * Resample `(freqs, gains)` down to at most `maxPoints`, picking the
 * nearest ORIGINAL point to each of `maxPoints` targets evenly spaced in
 * log-frequency (never inventing a value — the curve is already log-f
 * interpolated downstream, so nearest-neighbor decimation in the same
 * domain preserves its shape). Always keeps the first and last point and
 * stays strictly ascending (duplicate nearest-picks are dropped).
 */
function decimateLogF(
  freqs: number[],
  gains: number[],
  maxPoints: number
): { freqs: number[]; gains: number[] } {
  const n = freqs.length;
  if (n <= maxPoints) return { freqs, gains };
  const logLo = Math.log(freqs[0]);
  const logHi = Math.log(freqs[n - 1]);
  const outFreqs: number[] = [];
  const outGains: number[] = [];
  for (let k = 0; k < maxPoints; k++) {
    const t = maxPoints === 1 ? 1 : k / (maxPoints - 1);
    const targetLog = logLo + t * (logHi - logLo);
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (Math.log(freqs[mid]) <= targetLog) lo = mid;
      else hi = mid;
    }
    const idx =
      Math.abs(Math.log(freqs[lo]) - targetLog) <= Math.abs(Math.log(freqs[hi]) - targetLog)
        ? lo
        : hi;
    if (outFreqs.length === 0 || freqs[idx] > outFreqs[outFreqs.length - 1]) {
      outFreqs.push(freqs[idx]);
      outGains.push(gains[idx]);
    }
  }
  return { freqs: outFreqs, gains: outGains };
}

/**
 * Parse a simple two-column CSV: `freq_hz, gain_db` per line (comma- or
 * whitespace-separated). Blank lines, `#` comments, and a non-numeric header
 * row are skipped silently; other unparsable rows count toward `skipped`.
 * Points are sorted ascending by frequency (duplicates keep the LAST row) —
 * the backend's log-f interpolation assumes strictly ascending, distinct
 * frequencies. A curve over `MAX_CURVE_POINTS` is decimated (see
 * `decimateLogF`) — `decimated`/`originalPoints` let the caller say so.
 */
export function parseUserCurveCsv(text: string): ParsedUserCurve | ParseError {
  const rows: [number, number][] = [];
  let skipped = 0;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/[,\s]+/).filter((p) => p.length > 0);
    if (parts.length < 2) {
      skipped++;
      continue;
    }
    const f = Number(parts[0]);
    const g = Number(parts[1]);
    if (!Number.isFinite(f) || !Number.isFinite(g) || f <= 0) {
      skipped++;
      continue;
    }
    rows.push([f, g]);
  }
  if (rows.length === 0) {
    return { error: "No valid \"freq_hz, gain_db\" rows found." };
  }
  rows.sort((a, b) => a[0] - b[0]);
  const freqs: number[] = [];
  const gains: number[] = [];
  for (const [f, g] of rows) {
    if (freqs.length > 0 && freqs[freqs.length - 1] === f) {
      gains[gains.length - 1] = g; // duplicate frequency: last row wins
    } else {
      freqs.push(f);
      gains.push(g);
    }
  }
  const originalPoints = freqs.length;
  const capped = decimateLogF(freqs, gains, MAX_CURVE_POINTS);
  return {
    curve: capped,
    skipped,
    decimated: capped.freqs.length < originalPoints,
    originalPoints,
  };
}

/** A short "N points, lo Hz–hi Hz" summary for the dialog readout. Defensive
 * against a malformed value (issue #29 review finding #5 — a workspace doc
 * that slipped past `migrate()`'s validation, or any other non-`UserWeightingCurve`
 * shape) so a bad curve degrades to "No curve loaded" instead of throwing
 * and leaving the transform dialog impossible to open. */
export function describeUserCurve(curve: UserWeightingCurve | null | undefined): string {
  if (
    !curve ||
    !Array.isArray(curve.freqs) ||
    !Array.isArray(curve.gains) ||
    curve.freqs.length === 0 ||
    curve.freqs.length !== curve.gains.length
  ) {
    return "No curve loaded";
  }
  const n = curve.freqs.length;
  const lo = curve.freqs[0];
  const hi = curve.freqs[n - 1];
  const fmt = (hz: number) => (hz >= 1000 ? `${(hz / 1000).toFixed(hz % 1000 ? 1 : 0)} kHz` : `${hz} Hz`);
  return n === 1 ? `1 point, ${fmt(lo)}` : `${n} points, ${fmt(lo)}–${fmt(hi)}`;
}

/**
 * Runtime shape/value guard for a value claiming to be a `UserWeightingCurve`
 * (issue #29 review finding #5): non-empty, matching-length `freqs`/`gains`,
 * every frequency a positive finite number, strictly ascending — the same
 * invariants the backend's `UserWeightingCurve::validate()` enforces. Used
 * wherever a curve crosses a trust boundary the ts-rs types don't police at
 * runtime: `persist.ts::migrate()` (a hand-edited or pre-#29 workspace
 * blob) and `applyWorkspaceDoc` (a template or any other doc not run
 * through `migrate()` first).
 */
export function sanitizeUserCurve(value: unknown): UserWeightingCurve | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { freqs?: unknown; gains?: unknown };
  if (!Array.isArray(v.freqs) || !Array.isArray(v.gains)) return null;
  const freqs = v.freqs;
  const gains = v.gains;
  if (freqs.length === 0 || freqs.length !== gains.length) return null;
  if (!gains.every((g) => typeof g === "number" && Number.isFinite(g))) return null;
  let prev = 0;
  for (const f of freqs) {
    if (typeof f !== "number" || !Number.isFinite(f) || !(f > prev)) return null;
    prev = f;
  }
  return { freqs: freqs as number[], gains: gains as number[] };
}

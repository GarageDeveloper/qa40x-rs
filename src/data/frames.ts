/**
 * The frames cache — trace DATA lives here, OUTSIDE the store (plan §3.1).
 *
 * A non-reactive Map keyed by trace id: typed arrays never enter the
 * (serializable, deep-frozen) state tree. The ingest writes this cache
 * FIRST, then bumps `TraceMeta.seq` through a store action; tiles select
 * the seqs and pull the arrays here inside their render callback. Frames
 * only move forward: a stale write (seq ≤ the cached one) is dropped.
 *
 * Wire round trip: `apply_transform_chain` and `measure_frames` speak the
 * backend `Frame` (tagged by domain, plain arrays). The encode/decode
 * helpers below are the ONE place cache typed-arrays meet that shape.
 */
import type { TraceId } from "../core/model";
import type { AnalysisResult, Frame, HarmonicMark } from "../gen";
import type { DecodedFd, DecodedTd } from "../ipc/stream";

/** A swept measurement's curves (THD vs freq, FR) in cache form. */
export interface DecodedSweep {
  freqs: Float64Array;
  curves: {
    label: string;
    values: Float64Array;
    phaseDeg: Float64Array | null;
  }[];
}

export interface TraceFrames {
  seq: number;
  td?: DecodedTd;
  fd?: DecodedFd;
  sweep?: DecodedSweep;
  /** Backend harmonic analysis (THD/SNR/… chips) — input endpoints only. */
  metrics?: AnalysisResult;
  /** Backend-located harmonic series (spectrum-tile markers, same frame). */
  harmonics?: HarmonicMark[];
}

const cache = new Map<TraceId, TraceFrames>();

/**
 * Write a trace's frames for `seq`. Returns false (and writes nothing) if
 * the cache already holds a same-or-newer seq — the stale-drop guard.
 */
export function putFrames(
  id: TraceId,
  seq: number,
  frames: {
    td?: DecodedTd;
    fd?: DecodedFd;
    sweep?: DecodedSweep;
    metrics?: AnalysisResult;
    harmonics?: HarmonicMark[];
  }
): boolean {
  const existing = cache.get(id);
  if (existing && existing.seq >= seq) return false;
  cache.set(id, { seq, ...frames });
  return true;
}

export function getFrames(id: TraceId): TraceFrames | undefined {
  return cache.get(id);
}

export function clearFrames(id: TraceId): void {
  cache.delete(id);
}

export function clearAllFrames(): void {
  cache.clear();
}

/* ------------------------------------------------------------------ */
/* Cache ⇄ wire `Frame` conversion                                      */
/* ------------------------------------------------------------------ */

export function tdToWire(td: DecodedTd): Frame {
  return {
    domain: "td",
    sample_rate: td.sampleRate,
    t0: 0,
    samples: Array.from(td.samples),
  };
}

export function fdToWire(fd: DecodedFd): Frame {
  return {
    domain: "fd",
    freqs: Array.from(fd.freqs),
    mag_db: Array.from(fd.magDb),
    phase_deg: null,
  };
}

export function wireToTd(f: Frame): DecodedTd | undefined {
  if (f.domain !== "td") return undefined;
  return { sampleRate: f.sample_rate, samples: Float64Array.from(f.samples) };
}

export function wireToFd(f: Frame): DecodedFd | undefined {
  if (f.domain !== "fd") return undefined;
  return { freqs: Float64Array.from(f.freqs), magDb: Float64Array.from(f.mag_db) };
}

export function wireToSweep(f: Frame): DecodedSweep | undefined {
  if (f.domain !== "sweep") return undefined;
  return {
    freqs: Float64Array.from(f.freqs),
    curves: f.curves.map((c) => ({
      label: c.label,
      values: Float64Array.from(c.values),
      phaseDeg: c.phase_deg ? Float64Array.from(c.phase_deg) : null,
    })),
  };
}

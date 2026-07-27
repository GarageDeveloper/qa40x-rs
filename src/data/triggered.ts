/**
 * The trigger snapshot cache — the HELD scope picture, outside the store
 * (plan §3.3, mirrors data/frames.ts). Keyed by trigger-SOURCE endpoint
 * (`HW_TRACE_IDS.*`): one snapshot per endpoint a tile can trigger on, not
 * per tile — several tiles sharing a trigger source share the same held
 * picture.
 *
 * `ingestFrame` (store/actions/stream.ts) writes here only on `triggered` /
 * `auto` alignments; `waiting`/`stopped` frames leave the previous snapshot
 * untouched — that's how NORMAL/SINGLE hold their last picture. `samples`
 * are REFERENCES into the frame's already-decoded arrays (zero copy, the
 * same rule as the ❄ freeze in actions/traces.ts); `offsetDb` is baked at
 * latch time so a later range change can never rescale a held picture.
 */
import type { TraceId } from "../core/model";
import type { TriggerState } from "../gen";
import type { CaptureProvenance } from "../store/state";

export interface TriggerSnapshot {
  /** The ingest seq (actions/stream.ts) latched at — NOT the wire frame
   * seq, same freshness-order rule as the frames cache. */
  seq: number;
  state: TriggerState;
  /** Trigger point in `samples` (each hw endpoint's own capture buffer). */
  index: number;
  frac: number;
  sampleRate: number;
  /** Every hw endpoint's samples AT THIS FRAME (they share one capture, so
   * slicing every channel at the same index/frac is valid regardless of
   * which endpoint fired) — keyed by `HW_TRACE_IDS.*`. */
  samples: Record<TraceId, Float64Array>;
  /** Each entry's own converter offset, baked at latch time. */
  offsetDb: Record<TraceId, number | null>;
  /** The capture provenance of the LATCHED frame (issue #40), baked with
   * the samples for the same reason as `offsetDb`/`sampleRate`: a held
   * NORMAL/SINGLE picture keeps describing the bench that produced it,
   * however far the live bench moves meanwhile. */
  capture: CaptureProvenance | null;
}

const cache = new Map<TraceId, TriggerSnapshot>();

export function putTriggerSnapshot(sourceId: TraceId, snap: TriggerSnapshot): void {
  cache.set(sourceId, snap);
}

export function getTriggerSnapshot(sourceId: TraceId): TriggerSnapshot | undefined {
  return cache.get(sourceId);
}

export function clearTriggerSnapshots(): void {
  cache.clear();
}

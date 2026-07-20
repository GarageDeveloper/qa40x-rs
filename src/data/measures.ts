/**
 * Memoized backend measurements for the tile chips (plan M3): one
 * `measure_frames` call per (trace, seq), cached like the frames themselves
 * — the frontend triggers and formats, the math lives in `measurements::`.
 * Results land asynchronously; callers pass `onLanded` to re-render.
 */
import type { Frame, FrameMeasures } from "../gen";
import type { Ipc } from "../ipc/ipc";
import type { TraceId } from "../core/model";
import { fdToWire, getFrames, tdToWire } from "./frames";

interface Entry {
  seq: number;
  measures: FrameMeasures | null;
  inFlight: boolean;
}

const cache = new Map<TraceId, Entry>();

/** Drop a trace's cached measurement (trace deleted). */
export function clearMeasures(id: TraceId): void {
  cache.delete(id);
}

export function clearAllMeasures(): void {
  cache.clear();
}

/**
 * The measures for `id` at `seq`, if already landed; otherwise null — and
 * (once per seq) fires the backend call, invoking `onLanded` when a NEWER
 * result arrives. Stale results (a fresher seq was requested meanwhile) are
 * dropped, mirroring the frames cache stale-drop.
 */
export function measuresFor(
  ipc: Ipc,
  id: TraceId,
  seq: number,
  onLanded: () => void
): FrameMeasures | null {
  const entry = cache.get(id);
  if (entry && entry.seq >= seq) return entry.measures;
  if (entry?.inFlight) return entry.measures ?? null;

  const frames = getFrames(id);
  if (!frames || frames.seq < seq) return entry?.measures ?? null;

  const td: Frame | null = frames.td ? tdToWire(frames.td) : null;
  const fd: Frame | null = frames.fd ? fdToWire(frames.fd) : null;
  if (!td && !fd) return entry?.measures ?? null;

  cache.set(id, { seq, measures: entry?.measures ?? null, inFlight: true });
  void ipc
    .call("measure_frames", { td, fd })
    .then((measures) => {
      const cur = cache.get(id);
      if (!cur || cur.seq > seq) return; // stale — a newer request superseded us
      cache.set(id, { seq, measures, inFlight: false });
      onLanded();
    })
    .catch(() => {
      const cur = cache.get(id);
      if (cur && cur.seq === seq) cache.set(id, { ...cur, inFlight: false });
    });
  return entry?.measures ?? null;
}

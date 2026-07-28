/**
 * Traces-panel grouping selectors (issue #25 lot E4): one group per DEVICE
 * SLOT, derived from the union of live sessions and the hw endpoint ids
 * actually in the pool — so a doc from a bigger bench loaded here still
 * shows its `@n` endpoints, as a DORMANT group (decision B1; the D1
 * never-prune rule made those traces survive the load).
 *
 * Memory / transform / program traces stay OUTSIDE groups, in a flat tail
 * (decision B2): `sessionKeyForTrace` deliberately resolves them to the
 * FOCUSED session — a moving target — so a group placement would assert an
 * ownership the data model refuses to; a transform can read inputs from
 * several slots at once; and a frozen ❄ copy outlives its origin device.
 */
import type { TraceId } from "../../core/model";
import type { AppState } from "../state";
import { hwSlotOfTraceId } from "../hwtraces";
import { sessionKeyForSlot } from "../sessionkey";
import type { SessionKey } from "../sessionkey";

export interface TraceGroup {
  key: SessionKey;
  slot: number;
  /** A session exists for this slot (slot 0 always; an added device while
   * open). False = dormant: endpoint traces with no live session. */
  live: boolean;
  /** The live session's adopted registry id (null while unadopted or
   * dormant — callers own the "unknown device" presentation, item 8). */
  deviceId: string | null;
  /** The slot's hw endpoint ids present in the pool, in pool order. */
  traceIds: TraceId[];
}

/** The device groups, in slot order. */
export function deviceGroups(s: AppState): TraceGroup[] {
  const bySlot = new Map<number, TraceId[]>();
  for (const sess of Object.values(s.devices.sessions)) {
    bySlot.set(sess.slot, []);
  }
  for (const id of s.traces.order) {
    const slot = hwSlotOfTraceId(id);
    if (slot === null) continue;
    let ids = bySlot.get(slot);
    if (!ids) {
      ids = [];
      bySlot.set(slot, ids);
    }
    ids.push(id);
  }
  return [...bySlot.entries()]
    .sort(([a], [b]) => a - b)
    .map(([slot, traceIds]) => {
      const key = sessionKeyForSlot(slot);
      const sess = s.devices.sessions[key];
      return {
        key,
        slot,
        live: sess !== undefined,
        deviceId: sess?.deviceId ?? null,
        traceIds,
      };
    });
}

/** The flat tail below the groups: every non-hw trace, in pool order —
 * which preserves today's relative order (the grid.pw.ts pin's premise). */
export function ungroupedTraceIds(s: AppState): TraceId[] {
  return s.traces.order.filter((id) => hwSlotOfTraceId(id) === null);
}

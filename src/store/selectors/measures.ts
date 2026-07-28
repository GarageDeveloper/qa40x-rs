/**
 * Measure-request selector (issue #26 lot B): the display-budget projection
 * for the backend scope measurement suite — an endpoint is measured only
 * when at least one visible tile's chip strip shows a suite readout AND
 * that tile's readouts follow this endpoint (`chipSourceTraceId`, the same
 * resolution the chips themselves use). #52's rule, measures twin: no
 * Goertzel for an endpoint nothing displays.
 *
 * Independent of chartvm.ts for the same reason selectors/trigger.ts is —
 * both lean on selectors/layout.ts to avoid a cycle.
 */
import type { TraceId } from "../../core/model";
import type { MeasureRequest } from "../../gen";
import { SCOPE_MEASURE_KEYS } from "../../core/measure";
import { hwTraceIds, type AppState } from "../state";
import { chipSourceTraceId, visibleTiles } from "./layout";

/** `slot` projects the request for ONE device's stream (lot E3) — same
 * contract as `triggerRequest`: byte-identical wire shape, the four booleans
 * read through `slot`'s endpoint ids; default 0 = the historic request. */
export function measureRequest(s: AppState, slot = 0): MeasureRequest {
  const wanted = new Set<TraceId>();
  for (const tile of visibleTiles(s)) {
    // Sweeps have no chip strip (tile.ts hides it) — their stale `measures`
    // list must not keep an endpoint's suite computing.
    if (tile.kind === "sweep") continue;
    if (!tile.measures.some((k) => SCOPE_MEASURE_KEYS.has(k))) continue;
    // NOTE: chipSourceTraceId's "auto" resolution reads the frames CACHE
    // (state outside the store), so this projection can drift as frames
    // land. Every event that makes a trace gain or lose data (source
    // start/stop, trace add/remove/hide, pattern, workspace) calls
    // syncStream, which rebuilds it — keep it that way (the lot-A re-feed
    // selector trap, mirror image). Also: a non-hardware chip source (file
    // or transform trace) contributes nothing here — its suite chips read
    // "—" (backend suites exist for live hw endpoints only, for now).
    const src = chipSourceTraceId(tile);
    if (src) wanted.add(src);
  }
  const ids = hwTraceIds(slot);
  return {
    input_l: wanted.has(ids.inputL),
    input_r: wanted.has(ids.inputR),
    output_l: wanted.has(ids.outputL),
    output_r: wanted.has(ids.outputR),
  };
}

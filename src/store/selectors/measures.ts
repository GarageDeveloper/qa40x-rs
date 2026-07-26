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
import { HW_TRACE_IDS, type AppState } from "../state";
import { chipSourceTraceId, visibleTiles } from "./layout";

export function measureRequest(s: AppState): MeasureRequest {
  const wanted = new Set<TraceId>();
  for (const tile of visibleTiles(s)) {
    // Sweeps have no chip strip (tile.ts hides it) — their stale `measures`
    // list must not keep an endpoint's suite computing.
    if (tile.kind === "sweep") continue;
    if (!tile.measures.some((k) => SCOPE_MEASURE_KEYS.has(k))) continue;
    const src = chipSourceTraceId(tile);
    if (src) wanted.add(src);
  }
  return {
    input_l: wanted.has(HW_TRACE_IDS.inputL),
    input_r: wanted.has(HW_TRACE_IDS.inputR),
    output_l: wanted.has(HW_TRACE_IDS.outputL),
    output_r: wanted.has(HW_TRACE_IDS.outputR),
  };
}

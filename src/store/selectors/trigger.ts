/**
 * Trigger selectors (Lot A, issue #26): resolve a scope tile's trigger
 * source, its pre-trigger depth, and the state → wire `TriggerRequest`
 * projection `buildStreamConfig` sends (actions/stream.ts).
 *
 * Deliberately independent of chartvm.ts (which imports FROM here for
 * `scopeVM`'s trigger alignment) — importing chipSourceTraceId from
 * chartvm.ts here would make chartvm.ts <-> trigger.ts a cycle; both instead
 * get it from selectors/layout.ts.
 */
import type { TraceId } from "../../core/model";
import type { TriggerConfig, TriggerRequest } from "../../gen";
import {
  DEFAULT_TRIGGER,
  hwSlotOfTraceId,
  hwTraceIds,
  sessionKeyForSlot,
  type AppState,
  type TileConfig,
} from "../state";
import { chipSourceTraceId, visibleTiles } from "./layout";
import { focusedDevice, session } from "./session";

/**
 * The endpoint a tile's trigger aligns to: the explicit `triggerSource` when
 * it is still a member of BOTH the tile and the trace pool, else the same
 * fallback the chips use (`chipSourceTraceId`) — a tile with no explicit
 * choice tracks whatever it's already showing.
 */
export function tileTriggerSourceId(s: AppState, tile: TileConfig): TraceId | null {
  const explicit = tile.triggerSource;
  if (explicit !== "auto" && tile.traces.includes(explicit) && s.traces.byId[explicit]) {
    return explicit;
  }
  return chipSourceTraceId(tile);
}

/** A scope tile's displayed window, in samples: the whole capture
 * (`timeWindowMs === null`) or `ms` worth of the device's sample rate,
 * clamped to the fftSize (a window can't outgrow the capture it slices).
 *
 * "The device" is the one the tile's TRIGGER SOURCE belongs to (lot E3:
 * the slot rides the endpoint id — a tile scoping `hw-in-left@1` sizes its
 * window in slot 1's sample rate, which also reaches the wire via
 * `pre_samples`). Non-hw or absent source falls back to the focused
 * session — identical behavior while one session exists. */
export function tileWindowSamples(s: AppState, tile: TileConfig): number {
  const fftSize = s.acquisition.fftSize;
  if (tile.timeWindowMs === null) return fftSize;
  const srcId = tileTriggerSourceId(s, tile);
  const slot = srcId === null ? null : hwSlotOfTraceId(srcId);
  const sampleRate =
    (slot !== null
      ? session(s, sessionKeyForSlot(slot))?.device.config?.sample_rate
      : undefined) ??
    focusedDevice(s).config?.sample_rate ??
    48000;
  const samples = Math.round((tile.timeWindowMs / 1000) * sampleRate);
  return Math.min(Math.max(samples, 1), fftSize);
}

/**
 * The pre-trigger depth (`TriggerConfig.pre_samples`) the backend must
 * search from for `endpointId`: the WIDEST ask across every visible scope
 * tile that resolves its trigger to this endpoint (a narrower tile still
 * gets enough history), clamped so the search always leaves room for a
 * post-trigger tail (`fftSize/2 - 1`, mirrors the backend's
 * `validate_config` bound).
 */
export function triggerPreSamples(s: AppState, endpointId: TraceId): number {
  const cap = Math.max(0, Math.floor(s.acquisition.fftSize / 2) - 1);
  let pre = 0;
  for (const tile of visibleTiles(s)) {
    if (tile.kind !== "scope") continue;
    if (tileTriggerSourceId(s, tile) !== endpointId) continue;
    const windowSamples = tileWindowSamples(s, tile);
    const want = Math.round((tile.triggerPositionPct / 100) * windowSamples);
    if (want > pre) pre = want;
  }
  return Math.min(pre, cap);
}

/**
 * The wire `TriggerRequest`: an endpoint is included only when its own
 * setting is not "off" AND at least one visible scope tile actually points
 * its trigger there (the display-budget rule, #52's trigger twin — no scan
 * for an endpoint nothing shows).
 *
 * `slot` projects the request for ONE device's stream (lot E3): the wire
 * shape stays byte-identical — the four channels are `slot`'s endpoints,
 * read through their slot-scoped trace ids. Default 0 = the historic
 * single-device request, pinned unchanged.
 */
export function triggerRequest(s: AppState, slot = 0): TriggerRequest {
  const ids = hwTraceIds(slot);
  const build = (endpointId: TraceId): TriggerConfig | null => {
    const t = s.triggers[endpointId] ?? DEFAULT_TRIGGER;
    if (t.mode === "off") return null;
    const wanted = visibleTiles(s).some(
      (tile) => tile.kind === "scope" && tileTriggerSourceId(s, tile) === endpointId
    );
    if (!wanted) return null;
    return {
      mode: t.mode,
      edge: t.edge,
      level_v: t.levelV,
      hysteresis_v: t.hystV,
      pre_samples: triggerPreSamples(s, endpointId),
      arm_epoch: t.armEpoch,
    };
  };
  return {
    input_l: build(ids.inputL),
    input_r: build(ids.inputR),
    output_l: build(ids.outputL),
    output_r: build(ids.outputR),
  };
}

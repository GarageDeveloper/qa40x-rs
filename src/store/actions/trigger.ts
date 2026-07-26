/**
 * Trigger actions (Lot A, issue #26): per-endpoint scope trigger settings
 * (`AppState.triggers`, keyed by `HW_TRACE_IDS.*`). Mode/edge/level/
 * hysteresis are SHARED by every tile pointing its trigger source at the
 * same endpoint (plan §3.2 decision 2) — tile-local trigger fields
 * (source/position/markers) live in actions/layout.ts instead. Every setter
 * ends with `syncStream` (the layout-actions pattern): a running loop must
 * re-read the `TriggerRequest` selectors/trigger.ts::triggerRequest builds.
 */
import type { Ipc } from "../../ipc/ipc";
import type { TraceId } from "../../core/model";
import type { Store } from "../store";
import type { AppState, TriggerEdge, TriggerMode, TriggerSettings } from "../state";
import { DEFAULT_TRIGGER } from "../state";
import { syncStream } from "./stream";

function patchTrigger(
  store: Store<AppState>,
  action: string,
  endpointId: TraceId,
  patch: (t: TriggerSettings) => TriggerSettings
): void {
  store.update(action, (s) => {
    const cur = s.triggers[endpointId] ?? DEFAULT_TRIGGER;
    const next = patch(cur);
    if (next === cur) return s;
    return { ...s, triggers: { ...s.triggers, [endpointId]: next } };
  });
}

export function setTriggerMode(
  store: Store<AppState>,
  ipc: Ipc,
  endpointId: TraceId,
  mode: TriggerMode
): void {
  patchTrigger(store, "trigger/mode", endpointId, (t) => (t.mode === mode ? t : { ...t, mode }));
  syncStream(store, ipc);
}

export function setTriggerEdge(
  store: Store<AppState>,
  ipc: Ipc,
  endpointId: TraceId,
  edge: TriggerEdge
): void {
  patchTrigger(store, "trigger/edge", endpointId, (t) => (t.edge === edge ? t : { ...t, edge }));
  syncStream(store, ipc);
}

export function setTriggerLevelV(
  store: Store<AppState>,
  ipc: Ipc,
  endpointId: TraceId,
  levelV: number
): void {
  patchTrigger(store, "trigger/level", endpointId, (t) =>
    t.levelV === levelV ? t : { ...t, levelV }
  );
  syncStream(store, ipc);
}

/** `hystV: null` = auto (2 % of the frame's own peak, floored at 1e-4 FS —
 * the backend's `evaluate_trigger` default). */
export function setTriggerHystV(
  store: Store<AppState>,
  ipc: Ipc,
  endpointId: TraceId,
  hystV: number | null
): void {
  patchTrigger(store, "trigger/hyst", endpointId, (t) =>
    t.hystV === hystV ? t : { ...t, hystV }
  );
  syncStream(store, ipc);
}

/** Re-arm a SINGLE shot: bump `armEpoch`. Idempotent backend-side (only a
 * strictly larger value re-arms) — a duplicate click is harmless. */
export function armSingle(store: Store<AppState>, ipc: Ipc, endpointId: TraceId): void {
  patchTrigger(store, "trigger/arm", endpointId, (t) => ({ ...t, armEpoch: t.armEpoch + 1 }));
  syncStream(store, ipc);
}

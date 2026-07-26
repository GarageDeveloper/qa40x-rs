/**
 * Trigger actions (Lot A, issue #26): per-endpoint scope trigger settings
 * (`AppState.triggers`, keyed by `HW_TRACE_IDS.*`). Mode/edge/level/
 * hysteresis are SHARED by every tile pointing its trigger source at the
 * same endpoint (plan §3.2 decision 2) — tile-local trigger fields
 * (source/position/markers) live in actions/layout.ts instead. Every setter
 * that actually changes the store ends with `syncStream` by default (the
 * layout-actions pattern): a running loop must re-read the `TriggerRequest`
 * selectors/trigger.ts::triggerRequest builds. `setTriggerLevelV` accepts
 * `opts.sync` for the canvas drag path (review #10); non-finite/garbage
 * input is a true no-op — no store update, no sync (review #1).
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
  store.update("trigger/mode", (s) => {
    const cur = s.triggers[endpointId] ?? DEFAULT_TRIGGER;
    if (cur.mode === mode) return s;
    // Re-selecting SINGLE must always start freshly armed. Without this, a
    // `fired` latch left over from an EARLIER single session (the backend
    // state is independent of whatever mode is currently displayed) makes
    // the chip read "STOP" the instant SINGLE is picked again, before any
    // new shot has actually fired (issue #26 review #8). The arm-pending
    // flag keeps the Arm highlight truthful until a frame proves the
    // re-armed scan ran (see RunState.trigArmPending).
    const toSingle = mode === "single";
    const next = toSingle ? { ...cur, mode, armEpoch: cur.armEpoch + 1 } : { ...cur, mode };
    return {
      ...s,
      triggers: { ...s.triggers, [endpointId]: next },
      run: toSingle
        ? { ...s.run, trigArmPending: { ...s.run.trigArmPending, [endpointId]: true } }
        : s.run,
    };
  });
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

/**
 * `opts.sync` (default true): whether to push the new config to the running
 * stream immediately. A canvas drag calls this once per pointermove with
 * `sync: false` (store-only — cheap) and once more with `sync: true` on
 * pointerup (issue #26 review #10: an IPC round trip + full grid re-feed on
 * every pointermove is wasteful and unnecessary until the drag settles).
 */
export function setTriggerLevelV(
  store: Store<AppState>,
  ipc: Ipc,
  endpointId: TraceId,
  levelV: number,
  opts: { sync?: boolean } = {}
): void {
  // A non-finite value (a cleared/garbage gear field, a drag glitch) must
  // never reach the wire: `validate_config` rejects the WHOLE stream config
  // on a single bad trigger field, which would silently reject every LATER
  // `stream_update` too (including play/stop) until the value is fixed —
  // issue #26 review #1. Ignoring it here is a true no-op: no store update,
  // no sync.
  if (!Number.isFinite(levelV)) return;
  patchTrigger(store, "trigger/level", endpointId, (t) =>
    t.levelV === levelV ? t : { ...t, levelV }
  );
  if (opts.sync ?? true) syncStream(store, ipc);
}

/** `hystV: null` = auto (2 % of the frame's own peak, floored at 1e-4 FS —
 * the backend's `evaluate_trigger` default). Same choke-point discipline as
 * `setTriggerLevelV` (review #1): a non-finite value is ignored outright, a
 * finite negative one clamps to 0 (hysteresis has no meaningful sign) —
 * `null` (auto) passes through untouched either way. */
export function setTriggerHystV(
  store: Store<AppState>,
  ipc: Ipc,
  endpointId: TraceId,
  hystV: number | null
): void {
  let next = hystV;
  if (next !== null) {
    if (!Number.isFinite(next)) return;
    if (next < 0) next = 0;
  }
  patchTrigger(store, "trigger/hyst", endpointId, (t) =>
    t.hystV === next ? t : { ...t, hystV: next }
  );
  syncStream(store, ipc);
}

/** Re-arm a SINGLE shot: bump `armEpoch`. The backend re-arms on ANY change
 * to `arm_epoch` (an increase OR a decrease — e.g. a workspace load resets
 * it to 0 while the loop's own latch may sit higher, issue #26 review #2),
 * so a duplicate click here is harmless: it just moves to a new value. */
export function armSingle(store: Store<AppState>, ipc: Ipc, endpointId: TraceId): void {
  store.update("trigger/arm", (s) => {
    const cur = s.triggers[endpointId] ?? DEFAULT_TRIGGER;
    return {
      ...s,
      triggers: { ...s.triggers, [endpointId]: { ...cur, armEpoch: cur.armEpoch + 1 } },
      run: { ...s.run, trigArmPending: { ...s.run.trigArmPending, [endpointId]: true } },
    };
  });
  syncStream(store, ipc);
}

/**
 * The per-device SESSION seam (issue #25 lot E2): every read of "the open
 * device's live state" (`DeviceState`) and "the run transport state"
 * (`RunState`) goes through here, never through the state tree directly.
 * Sessions live in `devices.sessions`, keyed by backend runtime SLOT (see
 * `SessionKey` in state.ts for why slot, not device id).
 *
 * Two families, chosen at the call site by what the code MEANS:
 *  - `focused*`: the session the single-device chrome describes and the
 *    transport (Run button / Space) acts on — Raphaël's decision 2
 *    (2026-07-28, issue #25): Run/Space = focused device.
 *  - `any*`: bench-global predicates — a workspace load replaces the WHOLE
 *    bench and the idle-refresh gate must not enumerate while ANY session
 *    is busy, not just the focused one.
 */
import type { TraceId } from "../../core/model";
import type {
  AppState,
  DeviceSession,
  DeviceState,
  RunState,
} from "../state";
// Values from the LEAF modules only (never from state.ts): state.ts imports
// focusedDevice from here at runtime, and a value import back into it
// would recreate the cycle review #8 removed. hwtraces.ts is a leaf too
// (lot E3): no runtime imports of its own.
import { hwSlotOfTraceId } from "../hwtraces";
import { SLOT0, sessionKeyForSlot } from "../sessionkey";
import type { SessionKey } from "../sessionkey";

/** The session for `key`, or null — never a phantom: writes to an absent
 * key are no-ops (`updateSession`), reads fall back explicitly. */
export function session(s: AppState, key: SessionKey): DeviceSession | null {
  return s.devices.sessions[key] ?? null;
}

/** The FOCUSED session. `focus` always names an existing session by
 * invariant (initialState seeds SLOT0; nothing removes it); the SLOT0
 * fallback keeps a corrupted-state failure legible instead of a TypeError
 * deep in a selector. */
export function focusedSession(s: AppState): DeviceSession {
  return s.devices.sessions[s.devices.focus] ?? s.devices.sessions[SLOT0];
}

/** Every session key, in slot order (stable for panels and iteration). */
export function sessionKeys(s: AppState): SessionKey[] {
  return Object.values(s.devices.sessions)
    .sort((a, b) => a.slot - b.slot)
    .map((x) => x.key);
}

/** The device state of the FOCUSED session (what the top-bar chrome, the
 * exports' live-bench fallback and the transport guards describe). */
export function focusedDevice(s: AppState): DeviceState {
  return focusedSession(s).device;
}

/** The run state of the FOCUSED session (transport, stats, clip, lock). */
export function focusedRun(s: AppState): RunState {
  return focusedSession(s).run;
}

/** The registry id of the focused session's open unit (null until the
 * first post-open enumeration adopts it). */
export function focusedDeviceId(s: AppState): string | null {
  return focusedSession(s).deviceId;
}

/**
 * The session that OWNS a trace (lot E3): a hw endpoint id carries its
 * slot (`hw-in-left` → slot 0, `hw-in-left@1` → slot 1); any other id
 * (memory / transform / program / unknown) resolves to the FOCUSED session
 * — those traces are bench artifacts, not device endpoints.
 */
export function sessionKeyForTrace(s: AppState, id: TraceId): SessionKey {
  const slot = hwSlotOfTraceId(id);
  return slot === null ? s.devices.focus : sessionKeyForSlot(slot);
}

/** The run state of the session owning `id` (see sessionKeyForTrace).
 * Falls back to the FOCUSED run when the owning slot has no live session
 * (a dormant doc-loaded trace): transport/chip chrome reads stay legible,
 * never a TypeError — and a dormant endpoint has no entry in any run's
 * `triggers`, so the fallback can't show another device's state for it. */
export function runForTrace(s: AppState, id: TraceId): RunState {
  return session(s, sessionKeyForTrace(s, id))?.run ?? focusedRun(s);
}

/** The device state of the session owning `id`, or NULL when the owning
 * slot has no live session. Deliberately not a focused-device fallback
 * (E3 review #4): a DeviceState carries calibration — sample rate, ranges,
 * offsets — and silently substituting another converter's numbers is the
 * exact bug class the four-offsets model closed. Callers own the "unknown
 * device" presentation. (Dormant in E3 — E4's readout/export paths are the
 * intended consumers.) */
export function deviceForTrace(s: AppState, id: TraceId): DeviceState | null {
  return session(s, sessionKeyForTrace(s, id))?.device ?? null;
}

/** Immutable write to one session. Returns `s` UNCHANGED (same reference)
 * when the key names no session — a late callback for a torn-down session
 * must never mint a phantom. */
export function updateSession(
  s: AppState,
  key: SessionKey,
  fn: (x: DeviceSession) => DeviceSession
): AppState {
  const sess = s.devices.sessions[key];
  if (!sess) return s;
  return {
    ...s,
    devices: {
      ...s.devices,
      sessions: { ...s.devices.sessions, [key]: fn(sess) },
    },
  };
}

/** Keyed write to a session's device state. Rebuilds ONLY `device` —
 * `run` keeps its reference (the shallowEq contract, see DeviceSession). */
export function updateDevice(
  s: AppState,
  key: SessionKey,
  fn: (d: DeviceState) => DeviceState
): AppState {
  return updateSession(s, key, (x) => ({ ...x, device: fn(x.device) }));
}

/** Keyed write to a session's run state (leaves `device`'s reference). */
export function updateRun(
  s: AppState,
  key: SessionKey,
  fn: (r: RunState) => RunState
): AppState {
  return updateSession(s, key, (x) => ({ ...x, run: fn(x.run) }));
}

/** Write to the focused session's device state. */
export function updateFocusedDevice(
  s: AppState,
  fn: (d: DeviceState) => DeviceState
): AppState {
  return updateDevice(s, s.devices.focus, fn);
}

/** Write to the focused session's run state. */
export function updateFocusedRun(
  s: AppState,
  fn: (r: RunState) => RunState
): AppState {
  return updateRun(s, s.devices.focus, fn);
}

/** The program lock of ANY session (bench-global): a measurement running on
 * a non-focused device must still refuse a workspace load — the load
 * replaces the whole trace pool, including that program's result trace. */
export function anyProgramLock(s: AppState): string | null {
  for (const sess of Object.values(s.devices.sessions)) {
    if (sess.run.programLock !== null) return sess.run.programLock;
  }
  return null;
}

/** ANY session is capturing, draining a stop, generating, in output-only
 * mode or mid-connect — the bench-global "leave the bus alone" predicate
 * (the idle-refresh enumeration gate). Program locks are separate
 * (`anyProgramLock`): callers gate on both, legibly. */
export function anyBusy(s: AppState): boolean {
  for (const sess of Object.values(s.devices.sessions)) {
    if (
      sess.run.streaming ||
      sess.run.stopping ||
      sess.run.generatorRunning ||
      sess.run.outputOnly ||
      sess.device.status === "connecting"
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The `deviceId` a device-scoped command for `key` carries on the wire.
 * SLOT 0 STAYS ARG-LESS in lot E2: the backend's default runtime IS slot 0
 * (registry.rs::runtime_for(None)), routing it by id would (a) break
 * devices.pw.ts's `connectDeviceIds() === [null]` pin and (b) expose every
 * command to a transiently stale enumeration answer → `Unknown device`.
 * A slot ≥ 1 session routes by its adopted id (lot E4 starts opening
 * those); one whose id hasn't been adopted yet stays arg-less too — the
 * command then drives the default runtime, which is wrong for slot ≥ 1,
 * but no E2 caller passes a non-SLOT0 key before E4 wires adoption-first.
 */
export function sessionArgs(
  s: AppState,
  key: SessionKey
): { deviceId?: string } {
  if (key === SLOT0) return {};
  const id = session(s, key)?.deviceId;
  return id ? { deviceId: id } : {};
}

/**
 * Whether a device-scoped command for `key` can be ROUTED safely: slot 0
 * always (arg-less by contract), a slot ≥ 1 only once its registry id is
 * adopted. Without this gate, `sessionArgs`'s `{}` for an unadopted
 * slot ≥ 1 would silently drive the DEFAULT runtime — the command would
 * act on the OTHER device (E2 review #2: a slot-1 stop killing slot 0's
 * capture). Transport verbs check this before touching the wire.
 */
export function isRoutable(s: AppState, key: SessionKey): boolean {
  if (key === SLOT0) return true;
  return (session(s, key)?.deviceId ?? null) !== null;
}

/**
 * The e2e/console debug projection (`qa40xV2Debug.state()`): the focused
 * session's `device`/`run` flattened back onto the root, so the four
 * adapter accessors (tests/e2e/adapter/app.ts — fittedOutputRange,
 * frameCount, generatorRunning, streaming — all `state().run.*`) and any
 * console muscle memory keep working across the E2 shape flip. A vitest
 * pin holds this contract; main.ts is the only production caller.
 */
export function debugState(
  s: AppState
): AppState & { device: DeviceState; run: RunState } {
  return { ...s, device: focusedDevice(s), run: focusedRun(s) };
}

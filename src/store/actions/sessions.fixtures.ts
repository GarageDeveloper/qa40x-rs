/**
 * Test fixtures for the per-device sessions fold (issue #25 lot E2) — a
 * NON-test module so every suite that used to spread `device:`/`run:` onto
 * the root can patch the slot-0 session in one line instead (importing a
 * *.test.ts module re-registers and re-runs its whole suite under the
 * importer's file — same rationale as devices.fixtures.ts).
 */
import type { AppState, DeviceState, RunState, SessionKey } from "../state";
import { SLOT0 } from "../state";
import { updateDevice, updateRun } from "../selectors/session";

/** `s` with the given session's device state patched (default slot 0). */
export function withDevice(
  s: AppState,
  patch: Partial<DeviceState>,
  key: SessionKey = SLOT0
): AppState {
  return updateDevice(s, key, (d) => ({ ...d, ...patch }));
}

/** `s` with the given session's run state patched (default slot 0). */
export function withRun(
  s: AppState,
  patch: Partial<RunState>,
  key: SessionKey = SLOT0
): AppState {
  return updateRun(s, key, (r) => ({ ...r, ...patch }));
}

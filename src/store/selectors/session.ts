/**
 * The per-device SESSION seam (issue #25 lot E2): every read of "the open
 * device's live state" (`DeviceState`) and "the run transport state"
 * (`RunState`) goes through here, never through the state tree directly.
 *
 * Step 1a is shape-free: the bodies are passthroughs to the still-root-level
 * `AppState.device` / `AppState.run`. Step 1b folds both into
 * `devices.sessions[slot]` + a `focus` key and only this file's bodies (and
 * the state shape) change — the ~75 call sites stay put.
 *
 * Two families, chosen at the call site by what the code MEANS:
 *  - `focused*`: the session the single-device chrome describes and the
 *    transport (Run button / Space) acts on — Raphaël's decision 2
 *    (2026-07-28, issue #25): Run/Space = focused device.
 *  - `any*`: bench-global predicates — a workspace load replaces the WHOLE
 *    bench and the idle-refresh gate must not enumerate while ANY session
 *    is busy, not just the focused one.
 */
import type { AppState, DeviceState, RunState } from "../state";

/** The device state of the FOCUSED session (what the top-bar chrome, the
 * exports' live-bench fallback and the transport guards describe). */
export function focusedDevice(s: AppState): DeviceState {
  return s.device;
}

/** The run state of the FOCUSED session (transport, stats, clip, lock). */
export function focusedRun(s: AppState): RunState {
  return s.run;
}

/** Immutable write to the focused session's device state. Returns a new
 * root; composes with other slice writes inside one `store.update`. */
export function updateFocusedDevice(
  s: AppState,
  fn: (d: DeviceState) => DeviceState
): AppState {
  return { ...s, device: fn(s.device) };
}

/** Immutable write to the focused session's run state. */
export function updateFocusedRun(
  s: AppState,
  fn: (r: RunState) => RunState
): AppState {
  return { ...s, run: fn(s.run) };
}

/** The program lock of ANY session (bench-global): a measurement running on
 * a non-focused device must still refuse a workspace load — the load
 * replaces the whole trace pool, including that program's result trace. */
export function anyProgramLock(s: AppState): string | null {
  return s.run.programLock;
}

/** ANY session is capturing, draining a stop, generating, in output-only
 * mode or mid-connect — the bench-global "leave the bus alone" predicate
 * (the idle-refresh enumeration gate). Program locks are separate
 * (`anyProgramLock`): callers gate on both, legibly. */
export function anyBusy(s: AppState): boolean {
  return (
    s.run.streaming ||
    s.run.stopping ||
    s.run.generatorRunning ||
    s.run.outputOnly ||
    s.device.status === "connecting"
  );
}

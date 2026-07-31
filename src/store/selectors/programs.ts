/**
 * Program-session selectors (issue #25 lot F4) — pure reads answering "which
 * device does this program run (or would run) on", from state alone.
 *
 * The resolution rule, in priority order:
 *  1. `runKey` — a RUNNING program's binding, captured once at `runProgram`
 *     entry (lot F1: a mid-run focus move must never migrate a program).
 *  2. `deviceSlot` — the user's explicit pin (the ⚙ dialog's Device row).
 *  3. the focused session — the default, and the whole single-device story.
 *
 * Leaf-module imports only (selectors/session, store/sessionkey) — never an
 * action module: panels and actions both read these.
 */
import type { AppState, ProgramMeta } from "../state";
import type { SessionKey } from "../sessionkey";
import { sessionKeyForSlot, slotOfSessionKey } from "../sessionkey";
import { session } from "./session";
import { liveSessionCount, sessionLabel } from "./devices";

/** The session `prog` is bound to (running) or would bind to (idle). */
export function programSessionKey(s: AppState, prog: ProgramMeta): SessionKey {
  if (prog.runKey !== null) return prog.runKey;
  if (prog.deviceSlot === null) return s.devices.focus;
  return sessionKeyForSlot(prog.deviceSlot);
}

/** The sample rate driving `prog`'s time estimates — the PROGRAM session's
 * rate, never the focused one's (lot F4 item 5: a slot-1 program's progress
 * percentage ran 8× off under a 384 kHz focus). 48 k when the session is
 * absent or not configured yet — the historical fallback. */
export function programSampleRateHz(s: AppState, prog: ProgramMeta): number {
  const sess = session(s, programSessionKey(s, prog));
  return sess?.device.config?.sample_rate ?? 48000;
}

/** Every RUNNING program, in panel order. */
export function runningPrograms(s: AppState): ProgramMeta[] {
  return s.programs.order
    .map((id) => s.programs.byId[id])
    .filter((p): p is ProgramMeta => !!p && p.run === "running");
}

/** The RUNNING script program's id, or null. Script ROUTING is per device
 * since F1/F4 (`script_run` carries the program's `deviceId`, the backend
 * builds the Session from that runtime and claims ITS gate — a slot-1 pin
 * really runs on slot 1); what stays bench-exclusive is CONCURRENCY: the
 * backend `ScriptControl` is a single engine (one `running` flag, an
 * arg-less `script_stop`, un-keyed `script-log`/`script-frame` events —
 * unambiguous precisely because only one script runs). N concurrent
 * scripts (one engine per device) is a candidate follow-up, not scheduled
 * (issue #25 lot F6). */
export function runningScriptId(s: AppState): string | null {
  for (const p of runningPrograms(s)) {
    if (p.kind === "script") return p.id;
  }
  return null;
}

/** The running program bound to the session whose adopted registry id is
 * `deviceId` — the `thd-sweep-progress` router (the payload names the swept
 * unit; lot F1 landed the field as forward wiring for exactly this). Null
 * when no running program's session carries that id — e.g. a REST/Rhai
 * sweep on a device the UI isn't sweeping (its counts must not land in
 * anyone's row). */
export function programForDeviceId(
  s: AppState,
  deviceId: string
): ProgramMeta | null {
  for (const p of runningPrograms(s)) {
    const sess = session(s, programSessionKey(s, p));
    if (sess?.deviceId === deviceId) return p;
  }
  return null;
}

/**
 * Why `prog`'s ▶ is DISABLED right now, or null. Exactly two reasons grey
 * the button (everything else — not connected, id not adopted, empty script
 * — keeps today's click-time toast, so the single-device behavior is
 * byte-identical):
 *  (a) the program's target session already holds ANOTHER program's lock —
 *      the per-device exclusivity (one USB stream per unit);
 *  (b) the program is a script and another SCRIPT runs anywhere — the
 *      bench-global engine limit (see `runningScriptId`).
 * `runProgram` calls this first, so display and guard always agree (v1
 * invariant C: never enabled-and-refusing).
 */
export function programBlockReason(s: AppState, prog: ProgramMeta): string | null {
  const holder = session(s, programSessionKey(s, prog))?.run.programLock ?? null;
  if (holder !== null && holder !== prog.id) {
    const label = s.traces.byId[holder]?.label ?? "program";
    return `measurement "${label}" is running on this device`;
  }
  const scriptId = runningScriptId(s);
  if (prog.kind === "script" && scriptId !== null && scriptId !== prog.id) {
    const label = s.traces.byId[scriptId]?.label ?? "script";
    return `script "${label}" is running — one script at a time (bench-wide)`;
  }
  return null;
}

/**
 * The device annotation a program row carries: null at one live session
 * with no explicit pin (the single-device bench — nothing to disambiguate,
 * the type line stays byte-identical, a RUNNING follows-focus program
 * included), else `{ short, full }` — `"#2"` for the type line, the
 * session label for its tooltip. The one single-session case that still
 * annotates: a run bound to an EVICTED session (unplugged mid-run) — the
 * row must not read as running on the surviving device.
 */
export function programDeviceNote(
  s: AppState,
  prog: ProgramMeta
): { short: string; full: string } | null {
  if (
    liveSessionCount(s) <= 1 &&
    prog.deviceSlot === null &&
    (prog.runKey === null || session(s, prog.runKey) !== null)
  ) {
    return null;
  }
  const key = programSessionKey(s, prog);
  const slot = slotOfSessionKey(key);
  return { short: `#${slot + 1}`, full: sessionLabel(s, key) };
}

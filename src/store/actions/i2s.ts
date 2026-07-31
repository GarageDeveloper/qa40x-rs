/**
 * The front-panel I2S port actions (issue #71) — structurally outputonly.ts'
 * twin: a per-device toggle + reference level in `AppState.i2sPorts`
 * (slot-keyed, persisted with `enabled` normalized off), live readouts in
 * `run.i2s`, and one idempotent wire call (`i2s_apply`) that the per-session
 * rebuild chain serializes — several edits landing in the same tick must not
 * leave the port streaming a stale mix.
 *
 * The port runs CONCURRENTLY with the capture stream backend-side (the whole
 * point of the engine's endpoint design), so unlike output-only mode this is
 * not a DAC-owner branch: enabling I2S never stops a stream, and source
 * edits fan out to BOTH (syncSourcesEverywhere).
 */
import type { Ipc } from "../../ipc/ipc";
import type { I2sStatus } from "../../gen";
import type { Store } from "../store";
import type { AppState, I2sPortConfig } from "../state";
import {
  DEFAULT_I2S_PORT,
  I2S_REFERENCE_MAX_DBV,
  I2S_REFERENCE_MIN_DBV,
  initialSessionI2s,
} from "../state";
import type { SessionKey } from "../sessionkey";
import { slotOfSessionKey } from "../sessionkey";
import {
  isRoutable,
  session,
  sessionArgs,
  sessionKeys,
  updateRun,
} from "../selectors/session";
import { i2sSlotsFromSources, registerSessionDisposer } from "./stream";
import { toast } from "./ui";

/** Read-through port config for a session's slot. */
export function i2sPortConfig(s: AppState, key: SessionKey): I2sPortConfig {
  return s.i2sPorts[String(slotOfSessionKey(key))] ?? DEFAULT_I2S_PORT;
}

/** Rebuild chains PER SESSION — the outputonly.ts discipline: session B's
 * rebuild must not queue behind session A's, and a session re-minted on
 * the same slot must not queue behind the dead session's settled chain. */
const chains = new Map<SessionKey, Promise<void>>();
registerSessionDisposer((key) => chains.delete(key));

function patchPort(
  store: Store<AppState>,
  action: string,
  key: SessionKey,
  fn: (p: I2sPortConfig) => I2sPortConfig
): void {
  const slot = String(slotOfSessionKey(key));
  store.update(action, (s) => ({
    ...s,
    i2sPorts: { ...s.i2sPorts, [slot]: fn(s.i2sPorts[slot] ?? DEFAULT_I2S_PORT) },
  }));
}

/** Flip a session's I2S port. */
export function setI2sEnabled(
  store: Store<AppState>,
  ipc: Ipc,
  key: SessionKey,
  on: boolean
): void {
  if (i2sPortConfig(store.get(), key).enabled === on) return;
  patchPort(store, "i2s/enabled", key, (p) => ({ ...p, enabled: on }));
  syncI2s(store, ipc, key);
}

/** Set a session's port reference level (dBV at digital full scale). */
export function setI2sReference(
  store: Store<AppState>,
  ipc: Ipc,
  key: SessionKey,
  dbv: number
): void {
  if (!Number.isFinite(dbv)) return;
  const clamped = Math.min(Math.max(dbv, I2S_REFERENCE_MIN_DBV), I2S_REFERENCE_MAX_DBV);
  if (i2sPortConfig(store.get(), key).referenceDbv === clamped) return;
  patchPort(store, "i2s/reference", key, (p) => ({ ...p, referenceDbv: clamped }));
  syncI2s(store, ipc, key);
}

/** Queue a re-sync of `key`'s port with the current state. The session key
 * is captured here, never focus-at-execution-time (the outputonly E2 rule). */
export function syncI2s(store: Store<AppState>, ipc: Ipc, key: SessionKey): void {
  const chain = (chains.get(key) ?? Promise.resolve())
    .then(() => sync(store, ipc, key))
    .catch((e) => toast(store, "error", `I2S: ${e}`));
  chains.set(key, chain);
}

/** Re-sync every session whose port is (or claims to be) on — bench-global
 * mutators (workspace load, focus change fanning the implicit target). */
export function syncAllI2s(store: Store<AppState>, ipc: Ipc): void {
  const s = store.get();
  for (const key of sessionKeys(s)) {
    if (i2sPortConfig(s, key).enabled || session(s, key)?.run.i2s.running) {
      syncI2s(store, ipc, key);
    }
  }
}

/** Fold one backend `I2sStatus` into a session's `run.i2s`. */
export function applyI2sStatus(
  store: Store<AppState>,
  key: SessionKey,
  status: I2sStatus
): void {
  store.update("i2s/status", (s) =>
    updateRun(s, key, (r) => ({
      ...r,
      i2s: {
        running: status.running,
        sigmaPeakDbv: status.sigma_peak_dbv,
        clipped: status.clipped,
        blocks: status.blocks_written,
        error: status.last_error,
        // Per-slot source problems ride the same channel as the DAC's
        // (run.slotErrors is the stream's) — surface the port's own here.
      },
      // I2S slot errors land in the shared per-source error store so the
      // sources panel attributes them like DAC slot errors.
      slotErrors: mergeI2sErrors(r.slotErrors, status),
    }))
  );
}

/** The port's per-slot errors merged into the session's slotErrors: replace
 * previous I2S-tagged entries, keep the DAC's. Tagging by message prefix
 * keeps the wire type untouched. */
function mergeI2sErrors(
  existing: { id: string; error: string }[],
  status: I2sStatus
): { id: string; error: string }[] {
  const keep = existing.filter((e) => !e.error.startsWith("I2S: "));
  return [
    ...keep,
    ...status.errors.map((e) => ({ id: e.id, error: `I2S: ${e.error}` })),
  ];
}

/** Reset a session's live port state (disconnect / device lost): the
 * device's next connect writes I2S_CTRL = 0, so the state must not claim a
 * running port — and the persisted toggle drops to off (a reconnect must
 * not silently restart a digital stream into a DUT). */
export function resetI2sOnDisconnect(s: AppState, key: SessionKey): AppState {
  const slot = String(slotOfSessionKey(key));
  const port = s.i2sPorts[slot];
  const next = updateRun(s, key, (r) => ({ ...r, i2s: initialSessionI2s() }));
  if (!port?.enabled) return next;
  return {
    ...next,
    i2sPorts: { ...next.i2sPorts, [slot]: { ...port, enabled: false } },
  };
}

async function sync(store: Store<AppState>, ipc: Ipc, key: SessionKey): Promise<void> {
  const s = store.get();
  const sess = session(s, key);
  if (!sess) return; // torn-down session's queued rebuild
  // Never retarget the default runtime (the outputonly gate): an unadopted
  // slot ≥ 1 key would drive the OTHER device's I2S port.
  if (!isRoutable(s, key)) return;
  // A measurement program owns this session's device exclusively — the
  // apply's register writes would land mid-sweep. The routing editor's
  // note already says the edit is deferred; the port re-syncs on the next
  // gesture after the program ends.
  if (sess.run.programLock !== null) return;
  const wanted = i2sPortConfig(s, key).enabled && sess.device.status === "connected";
  if (!wanted && !sess.run.i2s.running) return; // nothing to declare, nothing to stop
  const status = await ipc.call("i2s_apply", {
    enabled: wanted,
    slots: wanted ? i2sSlotsFromSources(s, key) : [],
    referenceDbv: i2sPortConfig(s, key).referenceDbv,
    ...sessionArgs(s, key),
  });
  applyI2sStatus(store, key, status);
}

/** The ~1 Hz status poll body (app.ts): refresh sessions whose port is on
 * or recently died, so a writer that stopped on a USB error surfaces as a
 * readout instead of silence. Pure cache read backend-side. */
export async function pollI2sStatus(store: Store<AppState>, ipc: Ipc): Promise<void> {
  const s = store.get();
  for (const key of sessionKeys(s)) {
    const sess = session(s, key);
    if (!sess || sess.device.status !== "connected" || !isRoutable(s, key)) continue;
    const port = i2sPortConfig(s, key);
    if (!port.enabled && !sess.run.i2s.running) continue;
    try {
      const status = await ipc.call("i2s_status", sessionArgs(s, key));
      applyI2sStatus(store, key, status);
    } catch {
      // Transient (mid-disconnect) — the next poll or the reset path wins.
    }
  }
}

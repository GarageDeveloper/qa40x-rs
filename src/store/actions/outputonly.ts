/**
 * Output-only session mode (M2 — v1 #49): the playing sources drive the DAC
 * gap-free (a 1 s loop buffer) with NO capture, for feeding an external DUT.
 * The backend owns the whole render → range-fit → scale path
 * (`output_only_start`); this module owns the session flag and keeps the DAC
 * loop in sync with the playing set.
 *
 * The gap-free path plays a FIXED buffer — unlike the stream loop it does not
 * re-render per frame — so every membership or parameter change has to
 * rebuild it (a different mix is a different buffer). Rebuilds are serialized
 * on one chain: several changes landing in the same tick must not leave the
 * DAC looping a stale mix.
 */
import type { Ipc } from "../../ipc/ipc";
import type { Store } from "../store";
import type { AppState, SessionKey } from "../state";
import {
  isRoutable,
  session,
  sessionArgs,
  sessionKeys,
  updateRun,
} from "../selectors/session";
import { sessionHasSources } from "../selectors/sources";
import {
  registerSessionDisposer,
  slotsFromSources,
  startRun,
  syncAllStreams,
} from "./stream";
import { toast } from "./ui";

/** Rebuild chains PER SESSION (issue #25 lot E2): several changes landing
 * in the same tick must not leave a DAC looping a stale mix — and session
 * B's rebuild must not queue behind session A's. Since lot F2 the whole
 * module is session-keyed: a generator belongs to the SESSION whose
 * `run.outputOnly` is on, and its slot set is what the routing matrix
 * resolves onto that session (selectors/sources.ts). */
const chains = new Map<SessionKey, Promise<void>>();

// Session eviction drops this map's entry too (lot F2 review note #8 —
// the "per-session module maps get disposed" rule): a session re-minted
// on the same slot must not queue its first rebuild behind the dead
// session's settled chain.
registerSessionDisposer((key) => chains.delete(key));

/** Flip a session's mode (default: the focused one — the footer checkbox
 * stays focus-bound, Raphaël R3 2026-07-29). With sources routed here this
 * hands the DAC over immediately: on = stream loop → gap-free generator,
 * off = back to capture + analysis (the stream restarts under the
 * play-auto-starts rule). */
export function setOutputOnly(
  store: Store<AppState>,
  ipc: Ipc,
  on: boolean,
  sessionKey?: SessionKey
): void {
  const key = sessionKey ?? store.get().devices.focus;
  if (session(store.get(), key)?.run.outputOnly === on) return;
  store.update("outputonly/mode", (s) =>
    updateRun(s, key, (r) => ({ ...r, outputOnly: on }))
  );
  syncOutputOnly(store, ipc, key);
}

/** Re-sync the DAC loop with the current state (queued; see module docs).
 * Source actions call this instead of `syncStream` while the mode is on.
 * The session key is captured ONCE, here — `sync` acts on that key, never
 * on focus-at-execution-time (E2 review #6: two rebuilds queued around a
 * focus change must not both land on whichever session is focused later).
 * `sessionKey` (issue #25 lot F): an explicit target for the one
 * non-focus-bound caller — a program's output-only resume must re-arm the
 * session that RAN it, wherever the focus moved meanwhile; the full
 * per-session keying of this module is lot F2. */
export function syncOutputOnly(store: Store<AppState>, ipc: Ipc, sessionKey?: SessionKey): void {
  const key = sessionKey ?? store.get().devices.focus;
  const chain = (chains.get(key) ?? Promise.resolve())
    .then(() => sync(store, ipc, key))
    .catch((e) => toast(store, "error", `Output-only: ${e}`));
  chains.set(key, chain);
}

/** Re-sync EVERY session that holds (or held) a generator: sessions with
 * the mode on re-evaluate their slot set, sessions whose generator should
 * stop (nothing routed anymore) take the stop branch. Bench-global
 * mutators that reshape the mix everywhere — the coherent-gen toggle, a
 * workspace load, a focus change — call this; per-session gestures keep
 * calling `syncOutputOnly(key)`. Idle sessions are skipped entirely: the
 * resume-to-capture tail of `sync` belongs to explicit mode/source
 * gestures, never to a bench-global sweep. */
export function syncAllOutputOnly(store: Store<AppState>, ipc: Ipc): void {
  const s = store.get();
  for (const key of sessionKeys(s)) {
    const run = session(s, key)?.run;
    if (run && (run.outputOnly || run.generatorRunning)) {
      syncOutputOnly(store, ipc, key);
    }
  }
}

/** Re-sync BOTH DAC-owner kinds on every session — running streams follow
 * the new state (syncAllStreams) and generators rebuild or stop
 * (syncAllOutputOnly). The one call for gestures that can move the DAC
 * program across devices in a single stroke (issue #25 lot F2: the focus
 * change, a workspace load). Lives here, not in stream.ts: outputonly.ts
 * may import stream.ts, never the reverse. */
export function syncAllDacOwners(store: Store<AppState>, ipc: Ipc): void {
  syncAllStreams(store, ipc);
  syncAllOutputOnly(store, ipc);
}

async function sync(store: Store<AppState>, ipc: Ipc, key: SessionKey): Promise<void> {
  const s = store.get();
  const sess = session(s, key);
  if (!sess) return; // torn-down session's queued rebuild
  // Never retarget the default runtime (lot E4 review #2a, the same gate
  // as startRun/stopRun/syncStream): an unadopted slot ≥ 1 key would start
  // the gap-free generator on the OTHER device's DAC — a stimulus on an
  // unintended converter (and possibly a DUT).
  if (!isRoutable(s, key)) return;
  // A measurement program owns this session's device EXCLUSIVELY (F2
  // review MUST-FIX #1): `output_only_start` stops the device's capture
  // and rewrites the output-range register, so a rebuild queued by a
  // source edit — or by a focus change fanning out to a locked session —
  // would garble the sweep mid-batch. runProgram keeps `outputOnly` set
  // for the whole run and clears the lock BEFORE its keyed resume call,
  // so the legitimate resume passes this gate.
  if (sess.run.programLock !== null) return;
  // Per-session since lot F2: the mode wants a generator only when the
  // routing matrix resolves something onto THIS session — a session in
  // output-only with nothing routed must take the stop branch below, never
  // call output_only_start with an empty slot set (the backend rejects it).
  const wanted =
    sess.run.outputOnly &&
    sess.device.status === "connected" &&
    sessionHasSources(s, key);
  if (wanted) {
    // (Re)build the loop buffer. The backend stops the stream loop and any
    // previous generator itself — one DAC owner at a time; run.streaming
    // clears when the stream's Stopped message lands.
    const status = await ipc.call("output_only_start", {
      slots: slotsFromSources(s, key),
      ...sessionArgs(s, key),
    });
    store.update("outputonly/started", (st) =>
      updateRun(st, key, (r) => ({
        ...r,
        generatorRunning: true,
        sigmaPeakDbv: status.sigma_peak_dbv,
        clip: { ...r.clip, output: status.clipped },
        fittedOutputRangeDbv: status.fitted_output_range_dbv,
        slotErrors: status.errors,
      }))
    );
    return;
  }
  if (session(store.get(), key)?.run.generatorRunning) {
    // Re-gated after the awaits above (lot F2 — sessionArgs THROWS on an
    // unadopted slot ≥ 1 now): the state may have moved since the entry
    // gate, and an arg-less stop here would kill the DEFAULT runtime's
    // generator, the exact class the entry gate exists for.
    if (!isRoutable(store.get(), key)) return;
    await ipc.call("stop_generator", sessionArgs(store.get(), key));
    store.update("outputonly/stopped", (st) =>
      updateRun(st, key, (r) => ({
        ...r,
        generatorRunning: false,
        // The Σ readout follows the DAC: nothing driving it, nothing to show.
        sigmaPeakDbv: r.streaming ? r.sigmaPeakDbv : null,
      }))
    );
  }
  // Mode off with sources still playing: capture + analysis resume.
  const st = store.get();
  const after = session(st, key);
  if (
    after &&
    !after.run.outputOnly &&
    after.device.status === "connected" &&
    !after.run.streaming &&
    sessionHasSources(st, key)
  ) {
    await startRun(store, ipc, { sessionKey: key });
  }
}

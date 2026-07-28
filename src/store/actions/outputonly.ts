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
  focusedDevice,
  focusedRun,
  updateFocusedRun,
} from "../selectors/session";
import { slotsFromSources, startRun } from "./stream";
import { toast } from "./ui";

/** Rebuild chains PER SESSION (issue #25 lot E2): several changes landing
 * in the same tick must not leave a DAC looping a stale mix — and session
 * B's rebuild must not queue behind session A's. Output-only remains a
 * focused-session mode in E2 (sources drive the focused device, decision
 * 1); the map removes the device-global either way. */
const chains = new Map<SessionKey, Promise<void>>();

function anyPlaying(s: AppState): boolean {
  return s.sources.order.some((id) => s.sources.byId[id]?.playing);
}

/** Flip the session mode. With sources playing this hands the DAC over
 * immediately: on = stream loop → gap-free generator, off = back to capture
 * + analysis (the stream restarts under the play-auto-starts rule). */
export function setOutputOnly(store: Store<AppState>, ipc: Ipc, on: boolean): void {
  if (focusedRun(store.get()).outputOnly === on) return;
  store.update("outputonly/mode", (s) =>
    updateFocusedRun(s, (r) => ({ ...r, outputOnly: on }))
  );
  syncOutputOnly(store, ipc);
}

/** Re-sync the DAC loop with the current state (queued; see module docs).
 * Source actions call this instead of `syncStream` while the mode is on. */
export function syncOutputOnly(store: Store<AppState>, ipc: Ipc): void {
  const key = store.get().devices.focus;
  const chain = (chains.get(key) ?? Promise.resolve())
    .then(() => sync(store, ipc))
    .catch((e) => toast(store, "error", `Output-only: ${e}`));
  chains.set(key, chain);
}

async function sync(store: Store<AppState>, ipc: Ipc): Promise<void> {
  const s = store.get();
  const wanted =
    focusedRun(s).outputOnly && focusedDevice(s).status === "connected" && anyPlaying(s);
  if (wanted) {
    // (Re)build the loop buffer. The backend stops the stream loop and any
    // previous generator itself — one DAC owner at a time; run.streaming
    // clears when the stream's Stopped message lands.
    const status = await ipc.call("output_only_start", { slots: slotsFromSources(s) });
    store.update("outputonly/started", (st) =>
      updateFocusedRun(st, (r) => ({
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
  if (focusedRun(store.get()).generatorRunning) {
    await ipc.call("stop_generator", {});
    store.update("outputonly/stopped", (st) =>
      updateFocusedRun(st, (r) => ({
        ...r,
        generatorRunning: false,
        // The Σ readout follows the DAC: nothing driving it, nothing to show.
        sigmaPeakDbv: r.streaming ? r.sigmaPeakDbv : null,
      }))
    );
  }
  // Mode off with sources still playing: capture + analysis resume.
  const st = store.get();
  if (
    !focusedRun(st).outputOnly &&
    focusedDevice(st).status === "connected" &&
    !focusedRun(st).streaming &&
    anyPlaying(st)
  ) {
    await startRun(store, ipc);
  }
}

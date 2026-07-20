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
import type { AppState } from "../state";
import { slotsFromSources, startRun } from "./stream";
import { toast } from "./ui";

let chain: Promise<void> = Promise.resolve();

function anyPlaying(s: AppState): boolean {
  return s.sources.order.some((id) => s.sources.byId[id]?.playing);
}

/** Flip the session mode. With sources playing this hands the DAC over
 * immediately: on = stream loop → gap-free generator, off = back to capture
 * + analysis (the stream restarts under the play-auto-starts rule). */
export function setOutputOnly(store: Store<AppState>, ipc: Ipc, on: boolean): void {
  if (store.get().run.outputOnly === on) return;
  store.update("outputonly/mode", (s) => ({
    ...s,
    run: { ...s.run, outputOnly: on },
  }));
  syncOutputOnly(store, ipc);
}

/** Re-sync the DAC loop with the current state (queued; see module docs).
 * Source actions call this instead of `syncStream` while the mode is on. */
export function syncOutputOnly(store: Store<AppState>, ipc: Ipc): void {
  chain = chain
    .then(() => sync(store, ipc))
    .catch((e) => toast(store, "error", `Output-only: ${e}`));
}

async function sync(store: Store<AppState>, ipc: Ipc): Promise<void> {
  const s = store.get();
  const wanted = s.run.outputOnly && s.device.status === "connected" && anyPlaying(s);
  if (wanted) {
    // (Re)build the loop buffer. The backend stops the stream loop and any
    // previous generator itself — one DAC owner at a time; run.streaming
    // clears when the stream's Stopped message lands.
    const status = await ipc.call("output_only_start", { slots: slotsFromSources(s) });
    store.update("outputonly/started", (st) => ({
      ...st,
      run: {
        ...st.run,
        generatorRunning: true,
        sigmaPeakDbv: status.sigma_peak_dbv,
        clip: { ...st.run.clip, output: status.clipped },
        fittedOutputRangeDbv: status.fitted_output_range_dbv,
        slotErrors: status.errors,
      },
    }));
    return;
  }
  if (store.get().run.generatorRunning) {
    await ipc.call("stop_generator", {});
    store.update("outputonly/stopped", (st) => ({
      ...st,
      run: {
        ...st.run,
        generatorRunning: false,
        // The Σ readout follows the DAC: nothing driving it, nothing to show.
        sigmaPeakDbv: st.run.streaming ? st.run.sigmaPeakDbv : null,
      },
    }));
  }
  // Mode off with sources still playing: capture + analysis resume.
  const st = store.get();
  if (
    !st.run.outputOnly &&
    st.device.status === "connected" &&
    !st.run.streaming &&
    anyPlaying(st)
  ) {
    await startRun(store, ipc);
  }
}

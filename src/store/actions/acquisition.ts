/**
 * Acquisition actions. Since M1 every capture-affecting change also pushes
 * the config to a running backend stream (`stream_update` via syncStream) —
 * the loop follows the store, never the other way round.
 */
import type { Ipc } from "../../ipc/ipc";
import type { Store } from "../store";
import type { AppState, AveragingMode, WindowKind } from "../state";
import { FFT_SIZES } from "../state";
import { syncStream } from "./stream";
import { syncOutputOnly } from "./outputonly";
import { toast } from "./ui";

export function setFftSize(store: Store<AppState>, ipc: Ipc, fftSize: number): void {
  if (!(FFT_SIZES as readonly number[]).includes(fftSize)) return;
  store.update("acq/fft-size", (s) => ({
    ...s,
    acquisition: { ...s.acquisition, fftSize },
  }));
  syncStream(store, ipc);
}

export function setAveraging(
  store: Store<AppState>,
  ipc: Ipc,
  mode: AveragingMode,
  count: number
): void {
  store.update("acq/averaging", (s) => ({
    ...s,
    acquisition: { ...s.acquisition, averaging: { mode, count } },
  }));
  syncStream(store, ipc);
}

export function setWindow(store: Store<AppState>, ipc: Ipc, window: WindowKind): void {
  store.update("acq/window", (s) => ({
    ...s,
    acquisition: { ...s.acquisition, window },
  }));
  syncStream(store, ipc);
}

/** The coherent-generator toggle (issue #14). Both DAC owners must follow:
 * the stream loop rebuilds via syncStream, and the gap-free generator —
 * which only rebuilds on source/mode actions — via syncOutputOnly, so a
 * flip while "Output only" is on retunes the loop buffer too. */
export function setCoherentGen(store: Store<AppState>, ipc: Ipc, coherentGen: boolean): void {
  store.update("acq/coherent-gen", (s) => ({
    ...s,
    acquisition: { ...s.acquisition, coherentGen },
  }));
  syncStream(store, ipc);
  syncOutputOnly(store, ipc);
}

/** Peak hold is display-side (the chart keeps the per-bin max) — no stream
 * sync needed; the annunciator reads the flag from state. */
export function setPeakHold(store: Store<AppState>, peakHold: boolean): void {
  store.update("acq/peak-hold", (s) => ({
    ...s,
    acquisition: { ...s.acquisition, peakHold },
  }));
}

/**
 * "Reset avg & peak" (the legacy one-click restart): the BACKEND empties its
 * averaging accumulators (`stream_reset_averaging` — the analyzers live in
 * the stream task, the front never touches them), and bumping
 * `ui.peakHoldEpoch` makes every spectrum tile drop its peak-hold overlay.
 */
export function resetAveraging(store: Store<AppState>, ipc: Ipc): void {
  void ipc.call("stream_reset_averaging", {}).catch(() => {
    // Idle stream (or none): nothing to reset backend-side — fine.
  });
  store.update("acq/reset-avg-peak", (s) => ({
    ...s,
    ui: { ...s.ui, peakHoldEpoch: s.ui.peakHoldEpoch + 1 },
  }));
  // The visible effect waits for the next analyzed frame (up to one frame
  // period) — acknowledge the click immediately, like the legacy button.
  toast(store, "info", "Averaging & peak-hold reset — takes effect on the next frame.");
}

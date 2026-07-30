/**
 * Acquisition actions. Since M1 every capture-affecting change also pushes
 * the config to a running backend stream (`stream_update` via syncStream) —
 * the loop follows the store, never the other way round.
 */
import type { Ipc } from "../../ipc/ipc";
import type { Store } from "../store";
import type { AppState, AveragingMode, WindowKind } from "../state";
import { FFT_SIZES } from "../state";
import type { SessionKey } from "../sessionkey";
import { isRoutable, sessionArgs } from "../selectors/session";
import { syncAllStreams } from "./stream";
import { syncAllOutputOnly } from "./outputonly";
import { toast } from "./ui";

export function setFftSize(store: Store<AppState>, ipc: Ipc, fftSize: number): void {
  if (!(FFT_SIZES as readonly number[]).includes(fftSize)) return;
  store.update("acq/fft-size", (s) => ({
    ...s,
    acquisition: { ...s.acquisition, fftSize },
  }));
  syncAllStreams(store, ipc);
  // Generators too (F2 review note #9): the coherent bin grid is
  // fftSize-dependent (playedFrequencyHz), so a running gap-free loop
  // would otherwise keep playing tones snapped to the OLD grid.
  syncAllOutputOnly(store, ipc);
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
  syncAllStreams(store, ipc);
}

export function setWindow(store: Store<AppState>, ipc: Ipc, window: WindowKind): void {
  store.update("acq/window", (s) => ({
    ...s,
    acquisition: { ...s.acquisition, window },
  }));
  syncAllStreams(store, ipc);
}

/** The coherent-generator toggle (issue #14). Both DAC owners must follow:
 * running streams rebuild via syncAllStreams, and every session's gap-free
 * generator — which only rebuilds on source/mode actions — via
 * syncAllOutputOnly (lot F2: bin snapping is per-device, so EVERY
 * generator retunes, not just the focused one's). */
export function setCoherentGen(store: Store<AppState>, ipc: Ipc, coherentGen: boolean): void {
  store.update("acq/coherent-gen", (s) => ({
    ...s,
    acquisition: { ...s.acquisition, coherentGen },
  }));
  syncAllStreams(store, ipc);
  syncAllOutputOnly(store, ipc);
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
export function resetAveraging(
  store: Store<AppState>,
  ipc: Ipc,
  key?: SessionKey
): void {
  // KEYED since lot F4 (the F2 carried note): arg-less, this drove the
  // DEFAULT runtime whatever the focus — a reset clicked under a slot-1
  // focus emptied slot 0's accumulators and left the visible stream's
  // untouched. Focused by default (the toolbar button's meaning). An
  // unadopted slot ≥ 1 (the one-enumeration window) is a legible REFUSAL
  // (review SHOULD-FIX #4 — never a silent default-runtime hit, never a
  // half-true success toast), same wording as runProgram's.
  const s = store.get();
  const k = key ?? s.devices.focus;
  if (!isRoutable(s, k)) {
    toast(store, "error", "Device id not adopted yet — retry in a moment.");
    return;
  }
  void ipc.call("stream_reset_averaging", sessionArgs(s, k)).catch(() => {
    // Idle stream (or none): nothing to reset backend-side — fine.
  });
  store.update("acq/reset-avg-peak", (st) => ({
    ...st,
    ui: { ...st.ui, peakHoldEpoch: st.ui.peakHoldEpoch + 1 },
  }));
  // The visible effect waits for the next analyzed frame (up to one frame
  // period) — acknowledge the click immediately, like the legacy button.
  toast(store, "info", "Averaging & peak-hold reset — takes effect on the next frame.");
}

/**
 * "Reset stats" (issue #26 lot B): the BACKEND drops every scope-measure
 * sliding-stats window (all four endpoints), so the avg/min/max/σ tooltips
 * restart from the next frame instead of purging the old signal over a
 * full window length. The stats live in the stream task — the front never
 * touches them, same contract as `resetAveraging`.
 */
export function resetMeasureStats(
  store: Store<AppState>,
  ipc: Ipc,
  key?: SessionKey
): void {
  // Keyed like resetAveraging above (lot F4) — same default, same refusal.
  const s = store.get();
  const k = key ?? s.devices.focus;
  if (!isRoutable(s, k)) {
    toast(store, "error", "Device id not adopted yet — retry in a moment.");
    return;
  }
  void ipc.call("stream_reset_measure_stats", sessionArgs(s, k)).catch(() => {
    // Idle stream (or none): nothing to reset backend-side — fine.
  });
  toast(store, "info", "Measurement stats reset — takes effect on the next frame.");
}

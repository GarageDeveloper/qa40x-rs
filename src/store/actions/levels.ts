/**
 * Levels panel actions (issue #29 — exposes `measure_levels`): unweighted /
 * A / C RMS + peak, plus absolute Vrms/dBV/dBu via calibration. Same
 * exclusive-device handshake as a sweep program (`programs.ts::runProgram`)
 * — stop whichever loop owns the DAC, run the one-shot capture, resume the
 * session that ran before — but the result is a single scalar `LevelResult`,
 * not a trace, so it stays out of `ProgramsState` entirely.
 */
import type { Channel } from "../../gen";
import type { Ipc } from "../../ipc/ipc";
import type { Store } from "../store";
import type { AppState, LevelsState } from "../state";
import { LEVELS_LOCK_ID } from "./programs";
import { syncOutputOnly } from "./outputonly";
import { startRun, stopRun } from "./stream";
import { toast } from "./ui";

const toChannel = (c: "left" | "right"): Channel => (c === "left" ? "Left" : "Right");

export function setLevelsInputChannel(store: Store<AppState>, ch: "left" | "right"): void {
  store.update("levels/input-channel", (s) => ({
    ...s,
    levels: { ...s.levels, inputChannel: ch },
  }));
}

export function setLevelsOutputChannel(store: Store<AppState>, ch: "left" | "right"): void {
  store.update("levels/output-channel", (s) => ({
    ...s,
    levels: { ...s.levels, outputChannel: ch },
  }));
}

export function setLevelsDurationSecs(store: Store<AppState>, secs: number): void {
  const v = Number.isFinite(secs) ? Math.min(15, Math.max(0.2, secs)) : 1;
  store.update("levels/duration", (s) => ({ ...s, levels: { ...s.levels, durationSecs: v } }));
}

export function setLevelsGenerate(store: Store<AppState>, generate: boolean): void {
  store.update("levels/generate", (s) => ({ ...s, levels: { ...s.levels, generate } }));
}

/** `[1 Hz, 0.98·Nyquist]` — same policy as `stream.ts::playedFrequencyHz`
 * and the backend's `measure_levels` (issue #29 review finding #1): the
 * stimulus is a raw tone, not a coherent-gen mixer slot, so above this a
 * request would play an ALIASED frequency and report levels for a tone
 * that was never actually generated. The backend clamps too (defense in
 * depth against a stale sample rate here) and returns the frequency it
 * ACTUALLY played in `LevelResult.stimulus_freq_hz` — the panel reads that
 * back rather than trusting this input echoes reality.
 */
function nyquistCapHz(store: Store<AppState>): number {
  const sampleRate = store.get().device.config?.sample_rate ?? 48000;
  return (sampleRate / 2) * 0.98;
}

export function setLevelsStimulusFreqHz(store: Store<AppState>, hz: number): void {
  const cap = nyquistCapHz(store);
  const v = Number.isFinite(hz) ? Math.min(cap, Math.max(1, hz)) : Math.min(cap, 1000);
  store.update("levels/stimulus-freq", (s) => ({
    ...s,
    levels: { ...s.levels, stimulusFreqHz: v },
  }));
}

export function setLevelsStimulusDbfs(store: Store<AppState>, dbfs: number): void {
  const v = Number.isFinite(dbfs) ? Math.min(0, Math.max(-80, dbfs)) : -20;
  store.update("levels/stimulus-dbfs", (s) => ({
    ...s,
    levels: { ...s.levels, stimulusDbfs: v },
  }));
}

function patchLevels(store: Store<AppState>, name: string, patch: Partial<LevelsState>): void {
  store.update(name, (s) => ({ ...s, levels: { ...s.levels, ...patch } }));
}

/** Run one `measure_levels` capture under the exclusive device lock. */
export async function runLevelsMeasurement(store: Store<AppState>, ipc: Ipc): Promise<void> {
  const s = store.get();
  if (s.levels.running || s.run.programLock !== null) {
    toast(store, "info", "Another measurement is running — try again once it finishes.");
    return;
  }
  if (s.device.status !== "connected") {
    toast(store, "error", "Connect the device first — Levels drives the hardware.");
    return;
  }

  const wasStreaming = s.run.streaming;
  const wasOutputOnly = s.run.outputOnly && s.run.generatorRunning;
  store.update("levels/start", (st) => ({
    ...st,
    run: { ...st.run, programLock: LEVELS_LOCK_ID },
    levels: { ...st.levels, running: true, error: null },
  }));

  try {
    if (wasOutputOnly) {
      await ipc.call("stop_generator", {});
      store.update("levels/generator-stopped", (st) => ({
        ...st,
        run: { ...st.run, generatorRunning: false },
      }));
    }
    if (wasStreaming || s.run.stopping) await stopRun(store, ipc);

    const p = store.get().levels;
    const result = await ipc.call("measure_levels", {
      inputChannel: toChannel(p.inputChannel),
      outputChannel: toChannel(p.outputChannel),
      durationSecs: p.durationSecs,
      generate: p.generate,
      stimulusFreq: p.stimulusFreqHz,
      stimulusDbfs: p.stimulusDbfs,
    });
    patchLevels(store, "levels/result", { result, error: null });
    toast(store, "success", "Levels measured.");
  } catch (e) {
    patchLevels(store, "levels/error", { error: String(e) });
    toast(store, "error", `Levels measurement failed: ${e}`);
  } finally {
    store.update("levels/finish", (st) => ({
      ...st,
      run: { ...st.run, programLock: null },
      levels: { ...st.levels, running: false },
    }));
    if (wasOutputOnly) syncOutputOnly(store, ipc);
    else if (wasStreaming) void startRun(store, ipc);
  }
}

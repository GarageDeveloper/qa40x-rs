/**
 * The Levels panel's device lock (issue #29 — exposes `measure_levels`):
 * same choreography as a sweep program (stop the stream first, hold a named
 * lock, resume after) but the result is one scalar `LevelResult`, not a
 * trace — these tests assert the lock/resume plumbing and result landing,
 * never the level math (that's the Rust `audio::weighting` tests' job).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: unknown;
    constructor(cb?: unknown) {
      this.onmessage = cb;
    }
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import type { Commands, Ipc } from "../../ipc/ipc";
import { Store } from "../store";
import { initialState, type AppState } from "../state";
import { clearAllFrames } from "../../data/frames";
import { programLockReason } from "./programs";
import { runLevelsMeasurement, setLevelsInputChannel, setLevelsStimulusFreqHz } from "./levels";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function connectedStreamingState(): AppState {
  const s = initialState();
  return {
    ...s,
    device: { ...s.device, status: "connected" },
    run: { ...s.run, streaming: true },
  };
}

const STUB_RESULT: Commands["measure_levels"]["result"] = {
  rms_dbfs: -20,
  peak_dbfs: -15,
  rms_a_dbfs: -22,
  rms_c_dbfs: -20.5,
  rms_vrms: 0.1,
  rms_dbv: -20,
  rms_dbu: -17.8,
  rms_a_dbv: -22,
  calibrated: true,
  clipped: false,
  stimulus_freq_hz: 1000,
};

/** Stub backend: records call order, holds `measure_levels` until released
 * (so the test can observe the locked state), and serves a stub result. */
function stubIpc(): { ipc: Ipc; log: string[]; release: () => void } {
  const log: string[] = [];
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((r) => (releaseGate = r));
  const ipc: Ipc = {
    async call<K extends keyof Commands>(
      cmd: K,
      _args: Commands[K]["args"]
    ): Promise<Commands[K]["result"]> {
      log.push(cmd);
      if (cmd === "measure_levels") {
        await gate;
        return STUB_RESULT as Commands[K]["result"];
      }
      return null as Commands[K]["result"];
    },
  };
  return { ipc, log, release: () => releaseGate() };
}

describe("actions/levels — the device lock", () => {
  beforeEach(() => clearAllFrames());

  it("stops the stream first, locks by name, lands the result, resumes after", async () => {
    const store = new Store(connectedStreamingState());
    const { ipc, log, release } = stubIpc();

    const run = runLevelsMeasurement(store, ipc);
    await flush();
    expect(programLockReason(store.get())).toBe('measurement "Levels" is running');
    expect(store.get().levels.running).toBe(true);
    release();
    await run;

    expect(log.indexOf("stream_stop")).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("stream_stop")).toBeLessThan(log.indexOf("measure_levels"));
    expect(log.indexOf("stream_start")).toBeGreaterThan(log.indexOf("measure_levels"));

    expect(programLockReason(store.get())).toBeNull();
    expect(store.get().levels.running).toBe(false);
    expect(store.get().levels.result).toEqual(STUB_RESULT);
    expect(store.get().levels.error).toBeNull();
  });

  it("a running program elsewhere refuses the levels measurement", async () => {
    const seed: AppState = {
      ...connectedStreamingState(),
      run: { ...connectedStreamingState().run, programLock: "some-program" },
    };
    const store = new Store(seed);
    const { ipc, log } = stubIpc();
    await runLevelsMeasurement(store, ipc);
    expect(log).toHaveLength(0);
    expect(store.get().levels.running).toBe(false);
    expect(
      store.get().ui.toasts.some((t) => t.message.includes("Another measurement"))
    ).toBe(true);
  });

  it("refuses when the device isn't connected", async () => {
    const store = new Store(initialState()); // disconnected
    const { ipc, log } = stubIpc();
    await runLevelsMeasurement(store, ipc);
    expect(log).toHaveLength(0);
    expect(
      store.get().ui.toasts.some((t) => t.message.includes("Connect the device first"))
    ).toBe(true);
  });

  it("a backend failure lands the error and still releases the lock", async () => {
    const store = new Store(connectedStreamingState());
    const ipc: Ipc = {
      async call<K extends keyof Commands>(cmd: K): Promise<Commands[K]["result"]> {
        if (cmd === "measure_levels") throw new Error("levels measurement failed: timeout");
        return null as Commands[K]["result"];
      },
    };
    await runLevelsMeasurement(store, ipc);
    expect(store.get().levels.running).toBe(false);
    expect(store.get().levels.error).toContain("timeout");
    expect(programLockReason(store.get())).toBeNull();
  });

  it("setLevelsInputChannel updates just the input channel", () => {
    const store = new Store(initialState());
    expect(store.get().levels.inputChannel).toBe("left");
    setLevelsInputChannel(store, "right");
    expect(store.get().levels.inputChannel).toBe("right");
  });

  describe("setLevelsStimulusFreqHz — Nyquist-alias clamp (review finding #1)", () => {
    it("passes a sub-Nyquist request through unchanged", () => {
      const store = new Store(initialState()); // default sample_rate 48000 via device.config fallback
      setLevelsStimulusFreqHz(store, 1000);
      expect(store.get().levels.stimulusFreqHz).toBe(1000);
    });

    it("clamps a request above 0.98*Nyquist instead of letting it alias", () => {
      const seed: AppState = {
        ...initialState(),
        device: {
          ...initialState().device,
          config: { input_gain: 0, output_gain: -12, sample_rate: 48000 },
        },
      };
      const store = new Store(seed);
      // 30 kHz at 48 kHz sample rate would alias past Nyquist (24 kHz).
      setLevelsStimulusFreqHz(store, 30000);
      expect(store.get().levels.stimulusFreqHz).toBeCloseTo(23520, 0);
    });

    it("floors a sub-1 Hz or non-finite request at 1 Hz", () => {
      const store = new Store(initialState());
      setLevelsStimulusFreqHz(store, 0);
      expect(store.get().levels.stimulusFreqHz).toBe(1);
      setLevelsStimulusFreqHz(store, NaN);
      expect(store.get().levels.stimulusFreqHz).toBeGreaterThan(0);
    });

    it("scales the cap with the CURRENT device sample rate", () => {
      const seed: AppState = {
        ...initialState(),
        device: {
          ...initialState().device,
          config: { input_gain: 0, output_gain: -12, sample_rate: 192000 },
        },
      };
      const store = new Store(seed);
      setLevelsStimulusFreqHz(store, 100000);
      expect(store.get().levels.stimulusFreqHz).toBeCloseTo(94080, 0);
    });
  });
});

/**
 * Wow & flutter's device handover (issue #28 review point 6) — the same
 * choreography `runProgram` uses (see `programs.test.ts`), exercised here
 * for `runWowFlutter` specifically since it has no persisted `ProgramMeta`
 * to hang the handover off of: the stream stops BEFORE the measurement
 * drives the device and restarts after; an idle session stays idle; and
 * output-only mode stops its generator before and restarts it after.
 */
import { describe, expect, it, vi } from "vitest";

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

import type { WowFlutterResult } from "../../gen";
import type { Commands, Ipc } from "../../ipc/ipc";
import { Store } from "../store";
import { initialState, type AppState, type SourceMeta } from "../state";
import { programLockReason } from "./programs";
import { runWowFlutter, WOW_FLUTTER_LOCK_ID } from "./wowflutter";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const STUB_RESULT: WowFlutterResult = {
  reference_freq: 3150,
  weighted_rms_percent: 0.011,
  unweighted_rms_percent: 0.013,
  peak_weighted_percent: 0.02,
  static_offset_hz: 0.05,
  demod_rate: 1000,
  deviation_series: [],
  rate_hz: [],
  spectrum_percent: [],
};

const PARAMS = {
  referenceFreq: 3150,
  durationSecs: 4,
  outputChannel: "Left" as const,
  inputChannel: "Left" as const,
  generate: true,
};

/** Stub backend: records the call order, serves a fixed result. The
 * measurement stays in flight until `release()`, mirroring
 * `programs.test.ts`'s `stubIpc` (the fake harness's `holdPrograms` gate). */
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
      if (cmd === "measure_wow_flutter") {
        await gate;
        return STUB_RESULT as Commands[K]["result"];
      }
      if (cmd === "output_only_start") {
        return {
          sigma_peak_dbv: -6,
          clipped: false,
          fitted_output_range_dbv: 8,
          errors: [],
        } as Commands[K]["result"];
      }
      return null as Commands[K]["result"];
    },
  };
  return { ipc, log, release: () => releaseGate() };
}

function connectedStreamingState(): AppState {
  const s = initialState();
  return {
    ...s,
    device: { ...s.device, status: "connected" },
    run: { ...s.run, streaming: true },
  };
}

describe("actions/wowflutter — the device handover", () => {
  it("stops the stream first, locks by name, runs the measurement, resumes after", async () => {
    const store = new Store(connectedStreamingState());
    const { ipc, log, release } = stubIpc();

    const run = runWowFlutter(store, ipc, PARAMS);
    await flush();
    // While in flight: the lock names it and the stream is down.
    expect(programLockReason(store.get())).toBe('measurement "Wow & flutter" is running');
    expect(store.get().run.programLock).toBe(WOW_FLUTTER_LOCK_ID);
    release();
    const result = await run;

    // Choreography: the stream stopped BEFORE the device measurement ran,
    // and was started again after it finished — same contract as a sweep.
    expect(log.indexOf("stream_stop")).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("stream_stop")).toBeLessThan(log.indexOf("measure_wow_flutter"));
    expect(log.indexOf("stream_start")).toBeGreaterThan(log.indexOf("measure_wow_flutter"));

    // The lock lifted; the result reached the caller (not a workspace trace
    // — this measurement has none).
    expect(programLockReason(store.get())).toBeNull();
    expect(result).toEqual(STUB_RESULT);
  });

  it("an idle session (nothing streaming, not output-only) stays idle after", async () => {
    const store = new Store({
      ...connectedStreamingState(),
      run: { ...connectedStreamingState().run, streaming: false },
    });
    const { ipc, log, release } = stubIpc();
    release(); // no need to observe the lock here

    await runWowFlutter(store, ipc, PARAMS);

    expect(log).toContain("measure_wow_flutter");
    expect(log).not.toContain("stream_start"); // nothing ran before → nothing resumes
    expect(log).not.toContain("stream_stop");
    expect(programLockReason(store.get())).toBeNull();
  });

  it("output-only mode: the generator stops before the measurement and restarts after", async () => {
    const playing: SourceMeta = {
      id: "src-1",
      label: "Sine 1000 Hz",
      route: "left",
      playing: true,
      kind: "sine",
      frequencyHz: 1000,
      levelDbv: -12,
      extraTones: [],
    };
    const base = connectedStreamingState();
    const store = new Store<AppState>({
      ...base,
      run: {
        ...base.run,
        streaming: false,
        outputOnly: true,
        generatorRunning: true,
      },
      sources: { order: [playing.id], byId: { [playing.id]: playing } },
    });
    const { ipc, log, release } = stubIpc();

    const run = runWowFlutter(store, ipc, PARAMS);
    await flush();

    // The generator was stopped BEFORE the measurement drove the device —
    // same order as runProgram's wasOutputOnly branch.
    expect(log.indexOf("stop_generator")).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("stop_generator")).toBeLessThan(log.indexOf("measure_wow_flutter"));
    expect(store.get().run.generatorRunning).toBe(false);

    release();
    await run;
    // `syncOutputOnly`'s resume is chained fire-and-forget (module-level
    // queue) — give its microtasks a tick to land, like the real dialog
    // would observe on the next render.
    await flush();

    expect(log.indexOf("output_only_start")).toBeGreaterThan(
      log.indexOf("measure_wow_flutter")
    );
    expect(store.get().run.generatorRunning).toBe(true);
    expect(programLockReason(store.get())).toBeNull();
  });
});

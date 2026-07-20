/**
 * The measurement-program lock (M4): a program stops the stream BEFORE
 * driving the device, holds a named lock while it runs, lands its sweep on
 * its trace, and brings the streaming session back afterwards. The device
 * numbers are stubs — these tests assert the lock/resume choreography.
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
import { clearAllFrames, getFrames } from "../../data/frames";
import {
  addProgram,
  programLockReason,
  runProgram,
  sweepLabel,
} from "./programs";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function connectedStreamingState(): AppState {
  const s = initialState();
  return {
    ...s,
    device: { ...s.device, status: "connected" },
    run: { ...s.run, streaming: true },
  };
}

/** Stub backend: records the call order, serves a 3-point THD sweep. The
 * measurement stays in flight until `release()` (the fake harness's
 * holdPrograms gate), so tests can OBSERVE the locked state. */
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
      if (cmd === "measure_thd_vs_frequency") {
        await gate;
        const points = [20, 1000, 20000].map((frequency) => ({
          frequency,
          level_dbfs: -6,
          thd_percent: 1e-4,
          thd_db: -120,
          thd_n_percent: 3e-4,
          thd_n_db: -110,
          fundamental_dbfs: -6,
        }));
        return { points, swept: "frequency" } as Commands[K]["result"];
      }
      return null as Commands[K]["result"];
    },
  };
  return { ipc, log, release: () => releaseGate() };
}

describe("actions/programs — the device lock", () => {
  beforeEach(() => clearAllFrames());

  it("stops the stream first, locks by name, lands the sweep, resumes after", async () => {
    const store = new Store(connectedStreamingState());
    const { ipc, log, release } = stubIpc();
    const id = addProgram(store, "thd");
    expect(store.get().traces.byId[id].label).toBe("Sweep 20–20000 Hz");

    const run = runProgram(store, ipc, id);
    await flush();
    // While in flight: the lock names the program and the stream is down.
    expect(programLockReason(store.get())).toBe(
      'measurement "Sweep 20–20000 Hz" is running'
    );
    expect(store.get().programs.byId[id].run).toBe("running");
    release();
    await run;

    // Choreography: the stream stopped BEFORE the device program ran, and
    // was started again after it finished.
    expect(log.indexOf("stream_stop")).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("stream_stop")).toBeLessThan(
      log.indexOf("measure_thd_vs_frequency")
    );
    expect(log.indexOf("stream_start")).toBeGreaterThan(
      log.indexOf("measure_thd_vs_frequency")
    );

    // The lock lifted; the result landed on the program's trace.
    expect(programLockReason(store.get())).toBeNull();
    expect(store.get().programs.byId[id].run).toBe("idle");
    expect(store.get().traces.byId[id].domains).toEqual(["sweep"]);
    const sweep = getFrames(id)?.sweep;
    expect(sweep && Array.from(sweep.freqs)).toEqual([20, 1000, 20000]);
    expect(sweep?.curves[0].label).toBe("Left");
  });

  it("a second program is refused while one runs; an idle session stays idle", async () => {
    // NOT streaming: completion must not start a stream that never ran.
    const store = new Store({
      ...connectedStreamingState(),
      run: { ...connectedStreamingState().run, streaming: false },
    });
    const { ipc, log, release } = stubIpc();
    const a = addProgram(store, "thd");
    const b = addProgram(store, "thd");

    const run = runProgram(store, ipc, a);
    await flush();
    await runProgram(store, ipc, b); // lock held → refused with a toast
    expect(store.get().programs.byId[b].run).toBe("idle");
    expect(
      store.get().ui.toasts.some((t) => t.message.includes("Another measurement"))
    ).toBe(true);
    release();
    await run;

    expect(log.filter((c) => c === "measure_thd_vs_frequency")).toHaveLength(1);
    expect(log).not.toContain("stream_start"); // nothing ran before → nothing resumes
    expect(log).not.toContain("stream_stop");
  });

  it("both-channel THD runs one pass per channel into two curves", async () => {
    const store = new Store(connectedStreamingState());
    const { ipc, log, release } = stubIpc();
    release(); // no need to observe the lock here
    const id = addProgram(store, "thd");
    store.update("test/both", (s) => {
      const p = s.programs.byId[id];
      if (p.kind !== "sweep") return s;
      return {
        ...s,
        programs: {
          ...s.programs,
          byId: {
            ...s.programs.byId,
            [id]: { ...p, params: { ...p.params, channel: "both" as const } },
          },
        },
      };
    });
    await runProgram(store, ipc, id);
    expect(log.filter((c) => c === "measure_thd_vs_frequency")).toHaveLength(2);
    const sweep = getFrames(id)?.sweep;
    expect(sweep?.curves.map((c) => c.label)).toEqual(["Left", "Right"]);
  });

  it("sweepLabel pins the e2e-visible default shape", () => {
    expect(
      sweepLabel({
        measurement: "fr",
        channel: "left",
        startHz: 20,
        endHz: 20000,
        levelDbfs: -6,
        points: 30,
        durationS: 1,
        metric: "thd_db",
      })
    ).toBe("FR 20–20000 Hz");
  });
});

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
  configureSweepProgram,
  programLockReason,
  runProgram,
  sweepEstimateSeconds,
  sweepLabel,
} from "./programs";
import { wowSummary } from "../../panels/programs/panel";

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
      if (cmd === "measure_thd_vs_level") {
        await gate;
        const points = [-60, -30, 0].map((level_dbfs) => ({
          frequency: 1000,
          level_dbfs,
          thd_percent: 1e-4,
          thd_db: -120,
          thd_n_percent: 3e-4,
          thd_n_db: -110,
          fundamental_dbfs: level_dbfs,
        }));
        return { points, swept: "level" } as Commands[K]["result"];
      }
      if (cmd === "measure_wow_flutter") {
        await gate;
        return {
          reference_freq: 3150,
          weighted_rms_percent: 0.011,
          unweighted_rms_percent: 0.013,
          peak_weighted_percent: 0.02,
          static_offset_hz: 0.05,
          demod_rate: 1000,
          deviation_series: [],
          rate_hz: [0, 2, 4, 6, 200],
          spectrum_percent: [0, 0.005, 0.013, 0.004, 0.0001],
        } as Commands[K]["result"];
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

  it("a THD level-axis program calls measure_thd_vs_level and lands level_dbfs as the sweep's x-axis (issue #27)", async () => {
    const store = new Store(connectedStreamingState());
    const { ipc, log, release } = stubIpc();
    release();
    const id = addProgram(store, "thd");
    store.update("test/level-axis", (s) => {
      const p = s.programs.byId[id];
      if (p.kind !== "sweep") return s;
      return {
        ...s,
        programs: {
          ...s.programs,
          byId: {
            ...s.programs.byId,
            [id]: {
              ...p,
              params: { ...p.params, axis: "level" as const, startDbfs: -60, endDbfs: 0, toneHz: 1000 },
            },
          },
        },
      };
    });
    await runProgram(store, ipc, id);
    expect(log.filter((c) => c === "measure_thd_vs_level")).toHaveLength(1);
    expect(log).not.toContain("measure_thd_vs_frequency");
    const sweep = getFrames(id)?.sweep;
    expect(sweep && Array.from(sweep.freqs)).toEqual([-60, -30, 0]);
  });

  it("sweepLabel pins the e2e-visible default shape", () => {
    expect(
      sweepLabel({
        measurement: "fr",
        axis: "frequency",
        channel: "left",
        startHz: 20,
        endHz: 20000,
        levelDbfs: -6,
        toneHz: 1000,
        startDbfs: -60,
        endDbfs: 0,
        points: 30,
        durationS: 1,
        metric: "thd_db",
        wowReferenceHz: 3150,
        wowOutputChannel: "left",
        wowInputChannel: "left",
        wowGenerate: true,
      })
    ).toBe("FR 20–20000 Hz");
  });

  it("sweepLabel names its own swept range for a THD level-axis sweep (issue #27)", () => {
    expect(
      sweepLabel({
        measurement: "thd",
        axis: "level",
        channel: "left",
        startHz: 20,
        endHz: 20000,
        levelDbfs: -6,
        toneHz: 1000,
        startDbfs: -60,
        endDbfs: 0,
        points: 30,
        durationS: 1,
        metric: "thd_db",
        wowReferenceHz: 3150,
        wowOutputChannel: "left",
        wowInputChannel: "left",
        wowGenerate: true,
      })
    ).toBe("Sweep -60–0 dBFS");
  });

  it("sweepLabel names the reference tone for a wow & flutter program (issue #28 second pass)", () => {
    expect(
      sweepLabel({
        measurement: "wowflutter",
        axis: "frequency",
        channel: "left",
        startHz: 20,
        endHz: 20000,
        levelDbfs: -6,
        toneHz: 1000,
        startDbfs: -60,
        endDbfs: 0,
        points: 30,
        durationS: 4,
        metric: "thd_db",
        wowReferenceHz: 3150,
        wowOutputChannel: "left",
        wowInputChannel: "left",
        wowGenerate: true,
      })
    ).toBe("W&F 3150 Hz");
  });
});

/**
 * Wow & flutter as a PROGRAM (issue #28 second pass): it fits the SAME
 * "sweep" program kind — device lock, ▶/⏹, freeze, persistence — as
 * THD/FR, not its own dialog. These tests mirror the choreography above
 * plus the wasOutputOnly branch (never covered before this pass, for ANY
 * program kind) and the scalar readout (`wowResult`) that rides alongside
 * the deviation-spectrum curve.
 */
describe("actions/programs — wow & flutter as a sweep program", () => {
  beforeEach(() => clearAllFrames());

  it("lands the deviation spectrum as a percent, rateHz-axis sweep curve, plus the scalar readout on the program", async () => {
    const store = new Store(connectedStreamingState());
    const { ipc, log, release } = stubIpc();
    const id = addProgram(store, "wowflutter");
    expect(store.get().traces.byId[id].label).toBe("W&F 3150 Hz");

    const run = runProgram(store, ipc, id);
    await flush();
    expect(programLockReason(store.get())).toBe('measurement "W&F 3150 Hz" is running');
    release();
    await run;

    // Choreography identical to THD/FR: stream down before, back up after.
    expect(log.indexOf("stream_stop")).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("stream_stop")).toBeLessThan(log.indexOf("measure_wow_flutter"));
    expect(log.indexOf("stream_start")).toBeGreaterThan(log.indexOf("measure_wow_flutter"));
    expect(programLockReason(store.get())).toBeNull();

    // The curve: the DC (0 Hz) bin dropped, the rest landed verbatim,
    // "rateHz" x-axis (its OWN axis, distinct from stimulus "Hz" — findings
    // #3/#7 — log-scaled by the chart with a sub-1 Hz floor), percent
    // values (also on the FRAME, not just derived from the program —
    // finding #5).
    expect(store.get().traces.byId[id].domains).toEqual(["sweep"]);
    const sweep = getFrames(id)?.sweep;
    expect(sweep && Array.from(sweep.freqs)).toEqual([2, 4, 6, 200]);
    expect(sweep?.xUnit).toBe("rateHz");
    expect(sweep?.yUnit).toBe("%");
    expect(sweep?.curves[0].label).toBe("Left");
    expect(sweep && Array.from(sweep.curves[0].values)).toEqual([0.005, 0.013, 0.004, 0.0001]);

    // The scalars ride on the program itself, not the curve.
    const prog = store.get().programs.byId[id];
    expect(prog.kind).toBe("sweep");
    expect(prog.kind === "sweep" ? prog.wowResult : null).toEqual({
      weightedPercent: 0.011,
      unweightedPercent: 0.013,
      peakPercent: 0.02,
      staticOffsetHz: 0.05,
      referenceFreqUsed: 3150,
    });
  });

  it("converting a THD program into wow & flutter via the gear dialog picks up scalars after running (issue #28 second-pass review finding #1)", async () => {
    // The bug: `wowSummary`'s row-readout slot used to only be BUILT for a
    // program that was ALREADY wowflutter at row-creation time — a
    // conversion via `configureSweepProgram` (the gear dialog's Apply)
    // AFTER that point never had anywhere for its scalars to land, because
    // `keyedList` never rebuilds an existing row. The line is now
    // unconditional, so this is really a `wowSummary` behavior test: it
    // must read "—" while `measurement` is anything else, and the real
    // readout once the SAME id's program has both converted AND run.
    const store = new Store(connectedStreamingState());
    const id = addProgram(store, "thd");
    expect(wowSummary(store.get().programs.byId[id])).toBe("—");

    const { ipc, release } = stubIpc();
    const before = store.get().programs.byId[id];
    if (before.kind !== "sweep") throw new Error("expected a sweep program");
    configureSweepProgram(store, id, {
      label: store.get().traces.byId[id].label,
      params: { ...before.params, measurement: "wowflutter" },
    });
    expect(wowSummary(store.get().programs.byId[id])).toBe("not run yet");

    release();
    await runProgram(store, ipc, id);

    const after = store.get().programs.byId[id];
    expect(after.kind).toBe("sweep");
    expect(after.kind === "sweep" ? after.params.measurement : null).toBe("wowflutter");
    const summary = wowSummary(after);
    expect(summary).not.toBe("—");
    expect(summary).not.toBe("not run yet");
    expect(summary).toContain("weighted");
  });

  it("converting a THD program (1 s default duration) into wow & flutter bumps the capture to 4 s (finding #8)", () => {
    const store = new Store(connectedStreamingState());
    const id = addProgram(store, "thd");
    const before = store.get().programs.byId[id];
    if (before.kind !== "sweep") throw new Error("expected a sweep program");
    expect(before.params.durationS).toBe(1);

    configureSweepProgram(store, id, {
      label: store.get().traces.byId[id].label,
      params: { ...before.params, measurement: "wowflutter" },
    });

    const after = store.get().programs.byId[id];
    expect(after.kind === "sweep" ? after.params.durationS : null).toBe(4);
  });

  it("does NOT override a duration the user already set to something longer when converting", () => {
    const store = new Store(connectedStreamingState());
    const id = addProgram(store, "thd");
    const before = store.get().programs.byId[id];
    if (before.kind !== "sweep") throw new Error("expected a sweep program");

    configureSweepProgram(store, id, {
      label: store.get().traces.byId[id].label,
      params: { ...before.params, measurement: "wowflutter", durationS: 8 },
    });

    const after = store.get().programs.byId[id];
    expect(after.kind === "sweep" ? after.params.durationS : null).toBe(8);
  });

  it("converting wow & flutter BACK into THD drops the readout to '—'; the bumped duration is NOT re-reduced (asymmetric by design)", () => {
    // The forward bump (thd/fr -> wowflutter, 1s -> 4s) exists because a
    // too-short capture barely covers the 4 Hz reference wow. There is no
    // equivalent reason to shrink it back on the reverse conversion: a
    // longer-than-default THD/FR capture is merely slower, never broken
    // (unlike a too-short wow & flutter capture, which is useless) — so
    // `configureSweepProgram` only ever bumps FORWARD, never reduces. This
    // pins that asymmetry as INTENTIONAL, not an oversight.
    const store = new Store(connectedStreamingState());
    const id = addProgram(store, "wowflutter");
    const wf = store.get().programs.byId[id];
    if (wf.kind !== "sweep") throw new Error("expected a sweep program");
    expect(wf.params.durationS).toBe(4);
    expect(wowSummary(wf)).toBe("not run yet");

    configureSweepProgram(store, id, {
      label: store.get().traces.byId[id].label,
      params: { ...wf.params, measurement: "thd" },
    });

    const after = store.get().programs.byId[id];
    if (after.kind !== "sweep") throw new Error("expected a sweep program");
    expect(after.params.measurement).toBe("thd");
    expect(wowSummary(after)).toBe("—"); // no longer a wowflutter program
    expect(after.params.durationS).toBe(4); // NOT reduced back to 1
  });

  it("sweepEstimateSeconds clamps a wow & flutter duration to the backend's [1, 15] s capture, +2 s overhead (finding #4)", () => {
    // Pinned against `measure_wow_flutter`'s own `duration_secs.clamp(1.0,
    // 15.0)` (src-tauri) — an unclamped estimate off a dialog value outside
    // that range would run the panel's progress percentage far past (or
    // well short of) the capture's ACTUAL length.
    const store = new Store(connectedStreamingState());
    const id = addProgram(store, "wowflutter");
    const sr = 48000;

    const over = store.get().programs.byId[id];
    if (over.kind !== "sweep") throw new Error("expected a sweep program");
    configureSweepProgram(store, id, {
      label: store.get().traces.byId[id].label,
      params: { ...over.params, durationS: 30 },
    });
    expect(sweepEstimateSeconds(store.get().programs.byId[id], sr)).toBe(17); // min(15,30)+2

    configureSweepProgram(store, id, {
      label: store.get().traces.byId[id].label,
      params: { ...over.params, durationS: 0.3 },
    });
    expect(sweepEstimateSeconds(store.get().programs.byId[id], sr)).toBe(3); // max(1,0.3)+2

    configureSweepProgram(store, id, {
      label: store.get().traces.byId[id].label,
      params: { ...over.params, durationS: 6 },
    });
    expect(sweepEstimateSeconds(store.get().programs.byId[id], sr)).toBe(8); // 6+2, no clamp needed
  });

  it("wowSummary surfaces the backend's ACTUALLY-used reference frequency when the Nyquist clamp moved it (finding #4)", () => {
    const store = new Store(connectedStreamingState());
    const id = addProgram(store, "wowflutter");
    const prog = store.get().programs.byId[id];
    if (prog.kind !== "sweep") throw new Error("expected a sweep program");

    // Asked for 21600 Hz (e.g. at 24 kHz sample rate, above 0.9·Nyquist);
    // the backend clamped it down to 10800 Hz and reports THAT.
    const clamped = {
      ...prog,
      params: { ...prog.params, wowReferenceHz: 21600 },
      wowResult: {
        weightedPercent: 0.02,
        unweightedPercent: 0.03,
        peakPercent: 0.05,
        staticOffsetHz: 0,
        referenceFreqUsed: 10800,
      },
    };
    expect(wowSummary(clamped)).toContain("@ 10800 Hz");
  });

  it("wowSummary omits the '@ N Hz' note when the backend used exactly what was asked", () => {
    const store = new Store(connectedStreamingState());
    const id = addProgram(store, "wowflutter");
    const prog = store.get().programs.byId[id];
    if (prog.kind !== "sweep") throw new Error("expected a sweep program");

    const unclamped = {
      ...prog,
      wowResult: {
        weightedPercent: 0.02,
        unweightedPercent: 0.03,
        peakPercent: 0.05,
        staticOffsetHz: 0,
        referenceFreqUsed: prog.params.wowReferenceHz,
      },
    };
    expect(wowSummary(unclamped)).not.toContain("@");
  });

  it("the generator stops before the measurement and restarts after, in output-only mode", async () => {
    const base = connectedStreamingState();
    const store = new Store<AppState>({
      ...base,
      run: { ...base.run, streaming: false, outputOnly: true, generatorRunning: true },
      sources: {
        order: ["src-1"],
        byId: {
          "src-1": {
            id: "src-1",
            label: "Sine 1000 Hz",
            route: "left",
            playing: true,
            kind: "sine",
            frequencyHz: 1000,
            levelDbv: -12,
            extraTones: [],
          },
        },
      },
    });
    const { ipc, log, release } = stubIpc();
    const id = addProgram(store, "wowflutter");

    const run = runProgram(store, ipc, id);
    await flush();
    expect(log.indexOf("stop_generator")).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("stop_generator")).toBeLessThan(log.indexOf("measure_wow_flutter"));
    expect(store.get().run.generatorRunning).toBe(false);

    release();
    await run;
    // `syncOutputOnly`'s resume is a fire-and-forget chained promise — give
    // its microtasks a tick to land, as the panel's next render would.
    await flush();

    expect(log.indexOf("output_only_start")).toBeGreaterThan(log.indexOf("measure_wow_flutter"));
    expect(store.get().run.generatorRunning).toBe(true);
    expect(programLockReason(store.get())).toBeNull();
  });

  it("a cancelled wow & flutter measurement toasts a stop, not a failure", async () => {
    const store = new Store(connectedStreamingState());
    const id = addProgram(store, "wowflutter");
    const ipc: Ipc = {
      async call<K extends keyof Commands>(cmd: K): Promise<Commands[K]["result"]> {
        if (cmd === "measure_wow_flutter") {
          throw new Error("wow & flutter measurement cancelled");
        }
        return null as Commands[K]["result"];
      },
    };
    await runProgram(store, ipc, id);
    expect(store.get().ui.toasts.some((t) => t.message === "W&F stopped.")).toBe(true);
    expect(store.get().ui.toasts.some((t) => t.kind === "error")).toBe(false);
  });

  it("a genuine USB disconnect mid-capture toasts an ERROR, not a stop (issue #28 second-pass review finding #2)", async () => {
    // Pinned: this is the REAL message a mid-capture USB unplug produces —
    // nusb's TransferError::Cancelled, wrapped by the backend's generic
    // error path (`format!("wow & flutter measurement failed: {e}")`,
    // src-tauri/src/lib.rs). It CONTAINS the substring "cancelled" (like
    // the two legitimate user-stop messages) but is not one of them — a
    // loose substring match here used to swallow a real hardware failure
    // as an info "stopped" toast.
    const store = new Store(connectedStreamingState());
    const id = addProgram(store, "wowflutter");
    const ipc: Ipc = {
      async call<K extends keyof Commands>(cmd: K): Promise<Commands[K]["result"]> {
        if (cmd === "measure_wow_flutter") {
          throw new Error(
            "wow & flutter measurement failed: USB transfer error: transfer was cancelled"
          );
        }
        return null as Commands[K]["result"];
      },
    };
    await runProgram(store, ipc, id);
    expect(store.get().ui.toasts.some((t) => t.kind === "error")).toBe(true);
    expect(store.get().ui.toasts.some((t) => t.message.includes("stopped"))).toBe(false);
  });

  it("a genuine USB disconnect during a THD sweep also toasts an ERROR, not a stop", async () => {
    // Same pinned shape, THD's own wrap (`run_thd_batch`'s error map).
    const store = new Store(connectedStreamingState());
    const id = addProgram(store, "thd");
    const ipc: Ipc = {
      async call<K extends keyof Commands>(cmd: K): Promise<Commands[K]["result"]> {
        if (cmd === "measure_thd_vs_frequency") {
          throw new Error("THD sweep capture failed: USB transfer error: transfer was cancelled");
        }
        return null as Commands[K]["result"];
      },
    };
    await runProgram(store, ipc, id);
    expect(store.get().ui.toasts.some((t) => t.kind === "error")).toBe(true);
    expect(store.get().ui.toasts.some((t) => t.message.includes("stopped"))).toBe(false);
  });
});

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
import { initialSession, initialState, type AppState, type DeviceSession } from "../state";
import { focusedRun, session } from "../selectors/session";
import { withDevice, withRun } from "./sessions.fixtures";
import { clearAllFrames, getFrames } from "../../data/frames";
import {
  addProgram,
  configureSweepProgram,
  initProgramEvents,
  programLockReason,
  runProgram,
  setProgramDeviceSlot,
  stopProgram,
  sweepEstimateSeconds,
  sweepLabel,
} from "./programs";
import { wowSummary } from "../../panels/programs/panel";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function connectedStreamingState(): AppState {
  return withRun(withDevice(initialState(), { status: "connected" }), {
    streaming: true,
  });
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
    const store = new Store(withRun(connectedStreamingState(), { streaming: false }));
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
 * A program result's capture snapshot (issue #40, "programs.ts::programCapture
 * with programParams" — the pilot lot's own gap list): the DEVICE IDENTITY a
 * sweep landed under, PLUS the exact params that produced the curve, frozen
 * at land time so a later edit to the (idle) program can't retroactively
 * change what an already-landed curve says it was measured with. Everything
 * else (rate/ranges/offsets AND the fft/window/averaging trio) stays null,
 * deliberately (adversarial review finding #4): a program run writes
 * registers behind the frontend's back (`apply_config`, `auto_level`, the
 * Rhai `set_*` verbs, nothing restored), so the UI-cached values describe
 * the bench BEFORE the run — stamping them would contradict the frame-side
 * truths (`trace_sample_rate_hz`) in the same exported file. Unknown, never
 * guessed.
 */
describe("actions/programs — capture provenance stamped at land (issue #40)", () => {
  beforeEach(() => clearAllFrames());

  function connectedDeviceStreamingState(): AppState {
    return withDevice(connectedStreamingState(), {
      info: {
        model: "QA403",
        firmware_version: 61,
        serial: "AB12-CD34",
        product: "QA403 Audio Analyzer",
        sample_rates: [48000],
        supports_flash: false,
        capabilities: {} as never,
        is_virtual: false,
      },
      config: { input_gain: 42, output_gain: 18, sample_rate: 48000 },
      offsets: { input_l: 20, input_r: 20.5, output_l: 1, output_r: 1.5, calibrated: true },
    });
  }

  it("lands a THD sweep's result with the device identity, a frozen programParams copy, a pinned instant — and NO UI-cached bench values", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T10:00:00.000Z"));
    try {
      const store = new Store(connectedDeviceStreamingState());
      const { ipc, release } = stubIpc();
      release(); // no need to observe the in-flight lock here
      const id = addProgram(store, "thd");
      const progAtRun = store.get().programs.byId[id];
      if (progAtRun.kind !== "sweep") throw new Error("expected a sweep program");

      await runProgram(store, ipc, id);

      const capture = store.get().traces.byId[id].capture;
      expect(capture).not.toBeNull();
      expect(capture!.device).toEqual({
        model: "QA403",
        serial: "AB12-CD34",
        firmware: 61,
        isVirtual: false,
      });
      // Rate/ranges/offsets are the UI's PRE-RUN cache — the run may have
      // rewritten every one of them backend-side (`apply_config`,
      // `auto_level`, Rhai `set_*`; nothing restored). Unknown, never
      // guessed (review finding #4).
      expect(capture!.sampleRateHz).toBeNull();
      expect(capture!.inputRangeDbv).toBeNull();
      expect(capture!.outputRangeDbv).toBeNull();
      expect(capture!.offsets).toBeNull();
      // A program captures with its OWN fft/window/averaging, never the live
      // stream's — `programCapture`'s explicit override, never a value
      // leaking from `acquisition`.
      expect(capture!.fftSize).toBeNull();
      expect(capture!.window).toBeNull();
      expect(capture!.averaging).toBeNull();
      expect(capture!.capturedAt).toBe("2026-07-27T10:00:00.000Z");
      expect(capture!.programParams).toEqual(progAtRun.params);

      // The snapshot is a COPY frozen at land time: reconfiguring the
      // (still-idle) program afterward must NOT retroactively change what
      // the ALREADY-LANDED curve says it was measured with (issue #40's
      // second note — "the live program's params can be edited without a
      // re-run and go stale").
      configureSweepProgram(store, id, {
        label: store.get().traces.byId[id].label,
        params: { ...progAtRun.params, levelDbfs: -20 },
      });
      const captureAfter = store.get().traces.byId[id].capture;
      expect(captureAfter!.programParams!.levelDbfs).toBe(progAtRun.params.levelDbfs);
      expect(captureAfter!.programParams!.levelDbfs).not.toBe(-20);
    } finally {
      vi.useRealTimers();
    }
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
    const base = withRun(connectedStreamingState(), {
      streaming: false,
      outputOnly: true,
      generatorRunning: true,
    });
    const store = new Store<AppState>({
      ...base,
      sources: {
        order: ["src-1"],
        byId: {
          "src-1": {
            id: "src-1",
            label: "Sine 1000 Hz",
            route: "left",
            targets: [],
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
    expect(focusedRun(store.get()).generatorRunning).toBe(false);

    release();
    await run;
    // `syncOutputOnly`'s resume is a fire-and-forget chained promise — give
    // its microtasks a tick to land, as the panel's next render would.
    await flush();

    expect(log.indexOf("output_only_start")).toBeGreaterThan(log.indexOf("measure_wow_flutter"));
    expect(focusedRun(store.get()).generatorRunning).toBe(true);
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

/**
 * Programs are SESSION-keyed, captured once at entry (issue #25 lot F —
 * both findings from Raphaël's F1 validation on real hardware): launching a
 * program under one focus and finishing (or stopping) it under another used
 * to (a) run the sweep on the DEFAULT device regardless of the selected
 * one (arg-less invokes), and (b) release the lock on the WRONG session —
 * `updateFocusedRun` at completion time — stranding the original session's
 * lock forever ("Another measurement is running" with nothing running,
 * until an app restart). Every read, update and wire call in
 * runProgram/runSweep/runScript/stopProgram now uses the key captured at
 * entry.
 */
describe("actions/programs — session-keyed programs (issue #25 lot F)", () => {
  beforeEach(() => clearAllFrames());

  /** `s` with a CONNECTED, id-adopted second session at slot 1 (device
   * "usb/B") — the routable target the F4-era program selection will offer;
   * here it is reached by focusing it. */
  function withConnectedSlot1(s: AppState): AppState {
    const sess: DeviceSession = {
      ...initialSession(1),
      deviceId: "usb/B",
      device: {
        ...initialSession(1).device,
        status: "connected",
        info: {
          model: "QA402",
          firmware_version: 55,
          serial: "B-SERIAL",
          product: "QA402 Audio Analyzer",
          sample_rates: [48000],
          supports_flash: false,
          capabilities: {} as never,
          is_virtual: false,
        },
      },
    };
    return {
      ...s,
      devices: { ...s.devices, sessions: { ...s.devices.sessions, "slot-1": sess } },
    };
  }

  function focusOn(store: Store<AppState>, key: string): void {
    // Direct write, test-only (production code funnels through
    // setFocusedSession — the focus-mutator scan excludes *.test.ts): these
    // pins need a focus move WITHOUT the mutator's own re-sync side
    // effects, to isolate what runProgram itself keys.
    store.update("test/focus", (s) => ({ ...s, devices: { ...s.devices, focus: key } }));
  }

  /** Recording ipc: every call's args, plus a gate holding the measure in
   * flight so the test can move the focus mid-run. */
  function recordingIpc(): {
    ipc: Ipc;
    calls: { cmd: string; args: unknown }[];
    release: () => void;
  } {
    const calls: { cmd: string; args: unknown }[] = [];
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((r) => (releaseGate = r));
    const ipc: Ipc = {
      async call<K extends keyof Commands>(
        cmd: K,
        args: Commands[K]["args"]
      ): Promise<Commands[K]["result"]> {
        calls.push({ cmd, args });
        if (cmd === "measure_thd_vs_frequency") {
          await gate;
          return {
            points: [
              {
                frequency: 1000,
                level_dbfs: -6,
                thd_percent: 1e-4,
                thd_db: -120,
                thd_n_percent: 3e-4,
                thd_n_db: -110,
                fundamental_dbfs: -6,
              },
            ],
            swept: "frequency",
          } as Commands[K]["result"];
        }
        return null as Commands[K]["result"];
      },
    };
    return { ipc, calls, release: () => releaseGate() };
  }

  it("a program launched under a slot-1 focus routes every invoke with THAT session's deviceId", async () => {
    const store = new Store(withConnectedSlot1(initialState()));
    focusOn(store, "slot-1");
    const { ipc, calls, release } = recordingIpc();
    const id = addProgram(store, "thd");
    release();
    await runProgram(store, ipc, id);

    const sweep = calls.find((c) => c.cmd === "measure_thd_vs_frequency");
    expect(sweep, "the sweep must have been invoked").toBeDefined();
    expect((sweep!.args as { deviceId?: string }).deviceId).toBe("usb/B");
  });

  it("the lock is released on the session that RAN the program, not the one focused at completion (the stranded-lock bug)", async () => {
    const store = new Store(withConnectedSlot1(initialState()));
    focusOn(store, "slot-1");
    const { ipc, release } = recordingIpc();
    const id = addProgram(store, "thd");

    const run = runProgram(store, ipc, id);
    await flush();
    expect(session(store.get(), "slot-1")?.run.programLock).toBe(id);

    // The user focuses the other device while the sweep is in flight.
    focusOn(store, "slot-0");
    release();
    await run;

    expect(session(store.get(), "slot-1")?.run.programLock).toBeNull();
    expect(session(store.get(), "slot-0")?.run.programLock).toBeNull();
    expect(store.get().programs.byId[id].run).toBe("idle");
    // And a fresh program on the returned-to session is NOT refused.
    const next = addProgram(store, "thd");
    focusOn(store, "slot-1");
    const second = recordingIpc();
    second.release();
    await runProgram(store, second.ipc, next);
    expect(second.calls.some((c) => c.cmd === "measure_thd_vs_frequency")).toBe(true);
  });

  it("the landed capture carries the PROGRAM session's device identity, wherever the focus moved meanwhile", async () => {
    const store = new Store(withConnectedSlot1(initialState()));
    focusOn(store, "slot-1");
    const { ipc, release } = recordingIpc();
    const id = addProgram(store, "thd");

    const run = runProgram(store, ipc, id);
    await flush();
    focusOn(store, "slot-0"); // slot 0 has NO device info (disconnected)
    release();
    await run;

    const capture = store.get().traces.byId[id].capture;
    expect(capture?.device?.serial).toBe("B-SERIAL");
  });

  it("stopProgram routes sweep_stop to the session holding the program's lock, not the focused one", async () => {
    const store = new Store(withConnectedSlot1(initialState()));
    focusOn(store, "slot-1");
    const { ipc, calls, release } = recordingIpc();
    const id = addProgram(store, "thd");

    const run = runProgram(store, ipc, id);
    await flush();
    focusOn(store, "slot-0");
    stopProgram(store, ipc, id);

    const stop = calls.find((c) => c.cmd === "sweep_stop");
    expect(stop, "sweep_stop must have been sent").toBeDefined();
    expect((stop!.args as { deviceId?: string }).deviceId).toBe("usb/B");
    release();
    await run;
  });

  it("sweep progress lands on the RUNNING program's row even when the focus moved away mid-sweep", async () => {
    const store = new Store(withConnectedSlot1(initialState()));
    initProgramEvents(store);
    const { listen } = await import("@tauri-apps/api/event");
    const progressHandler = (listen as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "thd-sweep-progress"
    )?.[1] as (e: { payload: { done: number; total: number } }) => void;
    expect(progressHandler, "initProgramEvents must have mounted the listener").toBeDefined();

    focusOn(store, "slot-1");
    const { ipc, release } = recordingIpc();
    const id = addProgram(store, "thd");
    const run = runProgram(store, ipc, id);
    await flush();
    focusOn(store, "slot-0");

    progressHandler({ payload: { done: 2, total: 3 } });
    expect(store.get().programs.byId[id].progress).toBe("2/3");
    release();
    await run;
  });

  function evictSlot1(store: Store<AppState>): void {
    store.update("test/evict", (s) => {
      const sessions = { ...s.devices.sessions };
      delete sessions["slot-1"];
      return { ...s, devices: { ...s.devices, sessions } };
    });
  }

  it("a session evicted between passes ABORTS the program — the next invoke must never fall back to the default runtime (review MUST-FIX #1)", async () => {
    const store = new Store(withConnectedSlot1(initialState()));
    focusOn(store, "slot-1");
    const { ipc, calls, release } = recordingIpc();
    const id = addProgram(store, "thd");
    store.update("test/both", (s) => {
      const p = s.programs.byId[id];
      if (p.kind !== "sweep") return s;
      return {
        ...s,
        programs: {
          ...s.programs,
          byId: { ...s.programs.byId, [id]: { ...p, params: { ...p.params, channel: "both" as const } } },
        },
      };
    });

    const run = runProgram(store, ipc, id);
    await flush();
    // Device B vanishes while pass 1 (Left) is in flight.
    evictSlot1(store);
    release();
    await run;

    // Pass 2 (Right) was refused BEFORE the wire — one measure call only,
    // and none of them arg-less (which would have driven slot 0's device).
    const sweeps = calls.filter((c) => c.cmd === "measure_thd_vs_frequency");
    expect(sweeps).toHaveLength(1);
    expect((sweeps[0].args as { deviceId?: string }).deviceId).toBe("usb/B");
    expect(
      store.get().ui.toasts.some(
        (t) => t.kind === "error" && t.message.includes("no longer available")
      )
    ).toBe(true);
    expect(store.get().programs.byId[id].run).toBe("idle");
  });

  it("stopProgram sends NO sweep_stop when the lock-holding session was evicted — an arg-less stop would cancel an unrelated default-runtime sweep (review MUST-FIX #2)", async () => {
    const store = new Store(withConnectedSlot1(initialState()));
    focusOn(store, "slot-1");
    const { ipc, calls, release } = recordingIpc();
    const id = addProgram(store, "thd");

    const run = runProgram(store, ipc, id);
    await flush();
    evictSlot1(store);
    stopProgram(store, ipc, id);

    expect(calls.some((c) => c.cmd === "sweep_stop")).toBe(false);
    release();
    await run;
  });

  it("a backend ProgramBusy mid-run surfaces as a PERSISTENT error toast, not auto-dismissing info (review note #4 — completed passes were discarded)", async () => {
    const store = new Store(withConnectedSlot1(initialState()));
    focusOn(store, "slot-1");
    const id = addProgram(store, "thd");
    const ipc: Ipc = {
      async call<K extends keyof Commands>(cmd: K): Promise<Commands[K]["result"]> {
        if (cmd === "measure_thd_vs_frequency") {
          throw new Error(
            "A measurement program is already running on this device"
          );
        }
        return null as Commands[K]["result"];
      },
    };
    await runProgram(store, ipc, id);
    const t = store.get().ui.toasts.find((x) => x.message.includes("Program aborted"));
    expect(t).toBeDefined();
    expect(t!.kind).toBe("error");
  });

  it("a progress event stamped with ANOTHER device's id never writes into the running program's row (review note #8)", async () => {
    const store = new Store(withConnectedSlot1(initialState()));
    initProgramEvents(store);
    const { listen } = await import("@tauri-apps/api/event");
    const registrations = (listen as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === "thd-sweep-progress"
    );
    const progressHandler = registrations[registrations.length - 1]?.[1] as (e: {
      payload: { done: number; total: number; device_id?: string | null };
    }) => void;

    focusOn(store, "slot-1");
    const { ipc, release } = recordingIpc();
    const id = addProgram(store, "thd");
    const run = runProgram(store, ipc, id);
    await flush();

    // An external (REST/Rhai) sweep on the OTHER device reports progress.
    progressHandler({ payload: { done: 1, total: 9, device_id: "usb/OTHER" } });
    expect(store.get().programs.byId[id].progress).toBeNull();
    // The program's own device reports — accepted.
    progressHandler({ payload: { done: 2, total: 3, device_id: "usb/B" } });
    expect(store.get().programs.byId[id].progress).toBe("2/3");
    release();
    await run;
  });

  it("the refusal is PER DEVICE (lot F4): a program on slot 0 runs concurrently with one on slot 1; a third on the busy device still refuses", async () => {
    // Successor of the F1-era placeholder that pinned the bench-global
    // refusal and named F4 as its removal point (replaced in place,
    // deliberately — it asserted the very behavior this lot removes).
    const store = new Store(
      withConnectedSlot1(withDevice(initialState(), { status: "connected" }))
    );
    const { ipc, release } = recordingIpc();
    const a = addProgram(store, "thd");
    const b = addProgram(store, "thd");
    const extra = addProgram(store, "thd");

    const runA = runProgram(store, ipc, a); // focus = slot-0 → binds slot 0
    await flush();
    focusOn(store, "slot-1");
    const second = recordingIpc();
    const runB = runProgram(store, second.ipc, b); // binds slot 1 — concurrent
    await flush();

    // Both run, each under its OWN session's lock, each routed to its unit.
    expect(store.get().programs.byId[a].run).toBe("running");
    expect(store.get().programs.byId[b].run).toBe("running");
    expect(session(store.get(), "slot-0")?.run.programLock).toBe(a);
    expect(session(store.get(), "slot-1")?.run.programLock).toBe(b);
    const sweepB = second.calls.find((c) => c.cmd === "measure_thd_vs_frequency");
    expect(sweepB, "slot-1's sweep must have been invoked").toBeDefined();
    expect((sweepB!.args as { deviceId?: string }).deviceId).toBe("usb/B");

    // A third program resolving onto a BUSY device refuses — the
    // historical toast, byte-identical.
    focusOn(store, "slot-0");
    const third = recordingIpc();
    await runProgram(store, third.ipc, extra);
    expect(store.get().programs.byId[extra].run).toBe("idle");
    expect(third.calls).toHaveLength(0);
    expect(
      store.get().ui.toasts.some((t) => t.message.includes("Another measurement"))
    ).toBe(true);

    release();
    second.release();
    await runA;
    await runB;
    expect(session(store.get(), "slot-0")?.run.programLock).toBeNull();
    expect(session(store.get(), "slot-1")?.run.programLock).toBeNull();
  });

  it("a program PINNED to slot 1 runs there with no focus gesture (deviceSlot, lot F4)", async () => {
    const store = new Store(withConnectedSlot1(initialState()));
    // Focus stays on slot 0 the whole time.
    const { ipc, calls, release } = recordingIpc();
    const id = addProgram(store, "thd");
    setProgramDeviceSlot(store, id, 1);

    const run = runProgram(store, ipc, id);
    await flush();
    expect(session(store.get(), "slot-1")?.run.programLock ?? null).toBe(id);
    expect(session(store.get(), "slot-0")?.run.programLock ?? null).toBeNull();
    release();
    await run;

    const sweep = calls.find((c) => c.cmd === "measure_thd_vs_frequency");
    expect(sweep, "the sweep must have been invoked").toBeDefined();
    expect((sweep!.args as { deviceId?: string }).deviceId).toBe("usb/B");
    // The landed provenance names the PINNED unit.
    expect(store.get().traces.byId[id].capture?.device?.serial).toBe("B-SERIAL");
  });

  it("a second SCRIPT is refused bench-wide while one runs — and never clobbers the first run's record (globals-per-run, lot F4)", async () => {
    const store = new Store(withConnectedSlot1(withDevice(initialState(), { status: "connected" })));
    initProgramEvents(store);
    const { listen } = await import("@tauri-apps/api/event");
    const regs = (listen as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === "script-state"
    );
    const stateHandler = regs[regs.length - 1]?.[1] as (e: {
      payload: { running: boolean; error: string | null };
    }) => void;
    expect(stateHandler).toBeDefined();

    const { ipc, calls } = recordingIpc();
    const s1 = addProgram(store, "script");
    const s2 = addProgram(store, "script");
    setProgramDeviceSlot(store, s2, 1); // ANOTHER device — still refused

    const run1 = runProgram(store, ipc, s1);
    await flush();
    expect(store.get().programs.byId[s1].run).toBe("running");

    const second = recordingIpc();
    await runProgram(store, second.ipc, s2);
    expect(store.get().programs.byId[s2].run).toBe("idle");
    expect(second.calls).toHaveLength(0);
    expect(
      store.get().ui.toasts.some((t) => t.message.includes("A script is already running"))
    ).toBe(true);

    // The first run's resolver survived: completing the script resolves IT.
    stateHandler({ payload: { running: false, error: null } });
    await run1;
    expect(store.get().programs.byId[s1].run).toBe("idle");
    expect(calls.some((c) => c.cmd === "script_run")).toBe(true);
  });

  it("an eviction mid-script releases the lock early, yet a second script is STILL refused until the first resolves (the F1 review's overwrite window)", async () => {
    const store = new Store(withConnectedSlot1(initialState()));
    initProgramEvents(store);
    const { listen } = await import("@tauri-apps/api/event");
    const regs = (listen as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === "script-state"
    );
    const stateHandler = regs[regs.length - 1]?.[1] as (e: {
      payload: { running: boolean; error: string | null };
    }) => void;

    focusOn(store, "slot-1");
    const { ipc } = recordingIpc();
    const s1 = addProgram(store, "script");
    const run1 = runProgram(store, ipc, s1);
    await flush();
    expect(session(store.get(), "slot-1")?.run.programLock).toBe(s1);

    // Device B vanishes — the lock evaporates with its session, opening
    // the window the F1 review flagged.
    evictSlot1(store);
    focusOn(store, "slot-0");

    const s2 = addProgram(store, "script");
    const second = recordingIpc();
    await runProgram(store, second.ipc, s2);
    // Refused by the SCRIPT gate (program s1 is still `running`), not by
    // any lock — and s1's resolver is intact.
    expect(second.calls).toHaveLength(0);
    expect(store.get().programs.byId[s2].run).toBe("idle");

    stateHandler({ payload: { running: false, error: null } });
    await run1; // resolves — the old globals-clobber left this hanging
    expect(store.get().programs.byId[s1].run).toBe("idle");
  });

  it("completion re-arms an idle session whose PLAYING routed source appeared during the run (the F3 lock-note residual)", async () => {
    // Idle at program start (not streaming, not output-only); the bench's
    // source is set playing during the run — pre-F4 the release path left
    // the session silent until the next source gesture.
    const store = new Store(withDevice(initialState(), { status: "connected" }));
    const { ipc, calls, release } = recordingIpc();
    const id = addProgram(store, "thd");

    const run = runProgram(store, ipc, id);
    await flush();
    store.update("test/play-during-run", (s) => {
      const srcId = s.sources.order[0];
      return {
        ...s,
        sources: {
          ...s.sources,
          byId: { ...s.sources.byId, [srcId]: { ...s.sources.byId[srcId], playing: true } },
        },
      };
    });
    expect(calls.some((c) => c.cmd === "stream_start")).toBe(false);
    release();
    await run;
    await flush();

    // The release fan-out started the capture for the now-audible source.
    expect(calls.some((c) => c.cmd === "stream_start")).toBe(true);
  });
});

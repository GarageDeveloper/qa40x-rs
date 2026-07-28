/**
 * buildStreamConfig — the state → StreamConfig projection the backend loop
 * follows (sources → slots, averaging mapping, visibility → spectra budget) —
 * and the slot-building invariants ported from mixer.test.ts (M2: the
 * mixer.ts slot-building half must not drift in the port).
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

// startRun/stopRun's per-session sequencing pins (below) exercise the real
// startStream() → `new Channel()` path — mocked the same way
// programs.test.ts does it, so no real Tauri IPC runtime is required.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: unknown;
    constructor(cb?: unknown) {
      this.onmessage = cb;
    }
  },
}));

import type { ScopeMeasures, TriggerAlign } from "../../gen";
import type { DecodedFrame } from "../../ipc/stream";
import type { Ipc } from "../../ipc/ipc";
import { clearAllFrames, getFrames } from "../../data/frames";
import { clearTriggerSnapshots, getTriggerSnapshot } from "../../data/triggered";
import type { AppState, PeriodicSource, ScriptSource, SourceMeta } from "../state";
import { initialSession, initialState, SLOT0 } from "../state";
import { HW_TRACE_IDS } from "../state";
import { focusedRun } from "../selectors/session";
import { withDevice, withRun } from "./sessions.fixtures";
import { Store } from "../store";
import {
  __resetSessionGlobals,
  buildStreamConfig,
  frameCaptureProvenance,
  ingestFrame,
  levelToAmplitude,
  playedFrequencyHz,
  slotFromSource,
  slotsFromSources,
  snapToBin,
  startRun,
  stopRun,
} from "./stream";

const noSnap = (hz: number): number => hz;

function sineSource(id: string, over: Partial<PeriodicSource> = {}): SourceMeta {
  return {
    id,
    label: id,
    kind: "sine",
    frequencyHz: 1000,
    levelDbv: -12,
    extraTones: [],
    route: "left",
    playing: true,
    ...over,
  } as SourceMeta;
}

describe("snapToBin", () => {
  it("snaps to the nearest FFT bin at the device sample rate", () => {
    // 1 kHz at 48 kHz / 32768 → bin 683 → 1000.34 Hz (v1 behavior).
    const snapped = snapToBin(1000, 32768, 48000);
    expect(snapped).toBeCloseTo((683 * 48000) / 32768, 9);
  });

  it("never snaps below bin 1 (DC is not a tone)", () => {
    expect(snapToBin(0.01, 4096, 48000)).toBeCloseTo(48000 / 4096, 9);
  });
});

describe("playedFrequencyHz (the coherent-generator toggle, issue #14)", () => {
  it("snaps by default (official 'Round to eliminate leakage' behavior)", () => {
    const s = initialState();
    // 48 kHz / 32768 → bin 683 = 1000.4883 Hz, the frequency the official
    // app's rounded generator plays.
    expect(playedFrequencyHz(s, 1000)).toBeCloseTo((683 * 48000) / 32768, 4);
  });

  it("off plays the asked frequency verbatim (clamp aside)", () => {
    const s = initialState();
    s.acquisition.coherentGen = false;
    expect(playedFrequencyHz(s, 1000)).toBe(1000);
    // The safety clamp survives the toggle.
    expect(playedFrequencyHz(s, 0)).toBe(1);
  });

  it("slots follow the toggle for the primary tone and the extras", () => {
    const s = initialState();
    s.sources.order = ["a"];
    s.sources.byId["a"] = sineSource("a", {
      extraTones: [{ frequencyHz: 2000, levelDbv: -20, phaseDeg: 0, enabled: true }],
    });
    const freqOf = (st: typeof s): number[] => {
      const src = slotsFromSources(st)[0].source;
      return src.kind === "tones"
        ? src.tones.map((t) => t.frequency_hz)
        : src.kind === "waveform"
          ? [src.frequency_hz]
          : [];
    };
    expect(freqOf(s)).toEqual([
      expect.closeTo((683 * 48000) / 32768, 3),
      expect.closeTo((1365 * 48000) / 32768, 3),
    ]);
    s.acquisition.coherentGen = false;
    expect(freqOf(s)).toEqual([1000, 2000]);
  });
});

describe("buildStreamConfig", () => {
  it("maps averaging: off → count 1; power/coherent keep the count", () => {
    const s = initialState();
    s.acquisition.averaging = { mode: "off", count: 8 };
    expect(buildStreamConfig(s).averaging).toEqual({ coherent: false, count: 1 });
    s.acquisition.averaging = { mode: "power", count: 8 };
    expect(buildStreamConfig(s).averaging).toEqual({ coherent: false, count: 8 });
    s.acquisition.averaging = { mode: "coherent", count: 16 };
    expect(buildStreamConfig(s).averaging).toEqual({ coherent: true, count: 16 });
  });

  it("requests exactly the spectra some spectrum tile shows (display budget)", () => {
    const s = initialState();
    // One displayed tile: the boot 2×2 also shows Input R (row 2 default)
    // and would rightly widen the budget.
    s.layout.pattern = "1";
    s.layout.tiles["tile-1"].traces = [HW_TRACE_IDS.inputL, HW_TRACE_IDS.outputL];
    expect(buildStreamConfig(s).spectra).toEqual({
      input_l: true,
      input_r: false,
      output_l: true,
      output_r: false,
    });
  });

  it("a legend-hidden trace leaves the fd budget", () => {
    const s = initialState();
    s.layout.pattern = "1"; // keep the boot row-2 (Input R) tiles out
    s.layout.tiles["tile-1"].traces = [HW_TRACE_IDS.inputL, HW_TRACE_IDS.inputR];
    s.layout.tiles["tile-1"].hidden = [HW_TRACE_IDS.inputR];
    expect(buildStreamConfig(s).spectra.input_l).toBe(true);
    expect(buildStreamConfig(s).spectra.input_r).toBe(false);
  });

  it("a scope tile requests NO spectra — td is always carried (#52)", () => {
    const s = initialState();
    s.layout.pattern = "1"; // isolate tile-1 (the boot layout is 2×2)
    s.layout.tiles["tile-1"].kind = "scope";
    s.layout.tiles["tile-1"].traces = [HW_TRACE_IDS.inputL, HW_TRACE_IDS.inputR];
    expect(buildStreamConfig(s).spectra).toEqual({
      input_l: false,
      input_r: false,
      output_l: false,
      output_r: false,
    });
  });

  it("a hidden tile (beyond the pattern) does not inflate the budget", () => {
    const s = initialState();
    // The "1" pattern shows only tile-1; tile-3 (a spectrum) is hidden —
    // its Output R must not be computed.
    s.layout.pattern = "1";
    s.layout.tiles["tile-3"].traces = [HW_TRACE_IDS.outputR];
    expect(buildStreamConfig(s).spectra.output_r).toBe(false);
  });

  it("declares one slot per PLAYING source, bin-snapped, dBV → linear", () => {
    const s = withDevice(initialState(), {
      config: { input_gain: 18, output_gain: 8, sample_rate: 48000 },
    });
    s.sources = {
      order: ["a", "b"],
      byId: {
        a: sineSource("a", { label: "Sine 1" }),
        b: sineSource("b", {
          label: "Sine 2",
          frequencyHz: 2000,
          levelDbv: 0,
          route: "right",
          playing: false,
        }),
      },
    };
    const slots = buildStreamConfig(s).slots;
    expect(slots).toHaveLength(1);
    expect(slots[0].id).toBe("a");
    expect(slots[0].route).toBe("left");
    const src = slots[0].source;
    if (src.kind !== "waveform") throw new Error("expected a waveform slot");
    expect(src.frequency_hz).toBeCloseTo((683 * 48000) / 32768, 6);
    expect(src.amplitude).toBeCloseTo(Math.pow(10, -12 / 20), 9);
  });
});

/* Ports of the mixer.test.ts slot-building invariants (M2). The v1 trace
 * classification half (definesRender/isMixSource) has no v2 counterpart by
 * design: sources are explicitly typed here, and a script without
 * `fn render(ctx)` comes back as a named backend SlotError (pinned by
 * mixer::tests::a_bad_slot_is_dropped_and_named_the_rest_play). */
describe("slotFromSource (the mixer.ts slot-building port)", () => {
  it("levels map dBV → linear level-volts (0 dBV ≙ 1.0)", () => {
    expect(levelToAmplitude(0)).toBeCloseTo(1.0, 12);
    expect(levelToAmplitude(-6)).toBeCloseTo(0.5011872, 6);
    expect(levelToAmplitude(8)).toBeCloseTo(2.5118864, 6);
  });

  it("a plain sine keeps the classic waveform slot, bin-snapped", () => {
    const snap = (hz: number): number => Math.round(hz / 100) * 100;
    const slot = slotFromSource(sineSource("s", { frequencyHz: 997 }), snap);
    expect(slot).toEqual({
      id: "s",
      source: {
        kind: "waveform",
        waveform: "sine",
        frequency_hz: 1000,
        amplitude: levelToAmplitude(-12),
      },
      route: "left",
      enabled: true,
    });
  });

  it("routes follow the source's declared route — including off (muted)", () => {
    for (const route of ["left", "right", "both", "off"] as const) {
      const slot = slotFromSource(sineSource("s", { route }), noSnap);
      expect(slot.route).toBe(route);
      expect(slot.enabled).toBe(true);
    }
  });

  it("a sine with extra tones becomes a phased tone list", () => {
    const snap = (hz: number): number => Math.round(hz / 100) * 100;
    const slot = slotFromSource(
      sineSource("g", {
        frequencyHz: 997,
        extraTones: [
          { enabled: true, frequencyHz: 2503, levelDbv: -18, phaseDeg: 90 },
          { enabled: false, frequencyHz: 5000, levelDbv: -6, phaseDeg: 0 }, // skipped
        ],
      }),
      snap
    );
    // The primary {frequency, level} tone rides at phase 0; each enabled
    // extra is bin-snapped and converted dBV → Vrms at this boundary.
    expect(slot.source).toEqual({
      kind: "tones",
      tones: [
        {
          enabled: true,
          frequency_hz: 1000,
          amplitude_vrms: levelToAmplitude(-12),
          phase_degrees: 0,
        },
        {
          enabled: true,
          frequency_hz: 2500,
          amplitude_vrms: levelToAmplitude(-18),
          phase_degrees: 90,
        },
      ],
    });
  });

  it("a sine with no (or only disabled) extra tones keeps the classic slot", () => {
    // The plain-sine path is the bit-identical one the hardware level
    // measurement was pinned on — it must not silently reroute.
    const disabled = [{ enabled: false, frequencyHz: 2000, levelDbv: -6, phaseDeg: 0 }];
    for (const extraTones of [[], disabled]) {
      const slot = slotFromSource(sineSource("g", { extraTones }), noSnap);
      expect(slot.source.kind).toBe("waveform");
    }
  });

  it("square / triangle / sawtooth become waveform slots", () => {
    for (const kind of ["square", "triangle", "sawtooth"] as const) {
      const slot = slotFromSource(
        sineSource("g", { kind, frequencyHz: 440, levelDbv: -20 }),
        noSnap
      );
      expect(slot.source).toEqual({
        kind: "waveform",
        waveform: kind,
        frequency_hz: 440,
        amplitude: levelToAmplitude(-20),
      });
    }
  });

  it("extra tones apply to sine only — a square with tones stays a square", () => {
    const extraTones = [{ enabled: true, frequencyHz: 2000, levelDbv: -6, phaseDeg: 0 }];
    const slot = slotFromSource(sineSource("g", { kind: "square", extraTones }), noSnap);
    expect(slot.source.kind).toBe("waveform");
  });

  it("multitone / noise / chirp carry only their level", () => {
    for (const kind of ["multitone", "noise", "chirp"] as const) {
      const slot = slotFromSource(
        { id: "b", label: kind, kind, levelDbv: -12, route: "both", playing: true },
        noSnap
      );
      expect(slot.source).toEqual({ kind, amplitude: levelToAmplitude(-12) });
    }
  });

  it("a script slot carries its source text and declared route", () => {
    const script: ScriptSource = {
      id: "sq",
      label: "Script",
      kind: "script",
      source: "fn render(ctx) { [] }",
      route: "both",
      playing: true,
    };
    const slot = slotFromSource(script, noSnap);
    expect(slot.source).toEqual({ kind: "script", source: "fn render(ctx) { [] }" });
    expect(slot.route).toBe("both");
  });
});

describe("buildStreamConfig — triggers (Lot A, issue #26)", () => {
  it("carries the triggerRequest projection", () => {
    const s = initialState();
    s.layout.pattern = "1";
    s.layout.tiles["tile-1"].kind = "scope";
    s.layout.tiles["tile-1"].traces = [HW_TRACE_IDS.inputL];
    s.triggers[HW_TRACE_IDS.inputL] = {
      mode: "auto",
      edge: "rising",
      levelV: 0.1,
      hystV: null,
      armEpoch: 0,
    };
    const cfg = buildStreamConfig(s);
    expect(cfg.triggers?.input_l).toMatchObject({ mode: "auto", edge: "rising", level_v: 0.1 });
    expect(cfg.triggers?.input_r).toBeNull();
  });

  it("carries the measureRequest projection (lot B)", () => {
    const s = initialState();
    s.layout.pattern = "1";
    s.layout.tiles["tile-1"].kind = "scope";
    s.layout.tiles["tile-1"].traces = [HW_TRACE_IDS.inputL];
    s.layout.tiles["tile-1"].measures = ["freq", "vpp"];
    const cfg = buildStreamConfig(s);
    expect(cfg.measures).toEqual({
      input_l: true,
      input_r: false,
      output_l: false,
      output_r: false,
    });
  });

  it("a trigger-only change does NOT touch averaging", () => {
    const s = initialState();
    s.acquisition.averaging = { mode: "power", count: 8 };
    s.triggers[HW_TRACE_IDS.inputL] = {
      mode: "single",
      edge: "falling",
      levelV: -0.2,
      hystV: 0.02,
      armEpoch: 5,
    };
    expect(buildStreamConfig(s).averaging).toEqual({ coherent: false, count: 8 });
  });
});

describe("ingestFrame — trigger snapshot + run.triggers mirror (Lot A, issue #26)", () => {
  beforeEach(() => {
    clearAllFrames();
    clearTriggerSnapshots();
  });

  /** A minimal but fully-typed pushed frame, decoded-shape (bypasses
   * decodeFrame — ingestFrame consumes DecodedFrame directly). */
  function frame(over: {
    inputL?: TriggerAlign | null;
    inputR?: TriggerAlign | null;
  }): DecodedFrame {
    return {
      seq: 1,
      deviceId: null,
      sampleRate: 48000,
      input: {
        l: { sampleRate: 48000, samples: Float64Array.from([0.1, 0.2, 0.3]) },
        r: { sampleRate: 48000, samples: Float64Array.from([0.4, 0.5, 0.6]) },
      },
      output: null,
      fd: { inputL: null, inputR: null, outputL: null, outputR: null },
      metrics: { inputL: null, inputR: null, harmonicsL: null, harmonicsR: null },
      mix: {
        sigma_peak_dbv: null,
        clip_input: "none",
        clip_output: false,
        fitted_output_range_dbv: 8,
      },
      offsets: { input_l: 20, input_r: 20, output_l: 0, output_r: 0, calibrated: true },
      stats: { frames: 1, fps: 30, frame_ms: 33 },
      errors: [],
      trigger: {
        inputL: over.inputL ?? null,
        inputR: over.inputR ?? null,
        outputL: null,
        outputR: null,
      },
      measures: { inputL: null, inputR: null, outputL: null, outputR: null },
    };
  }

  const align = (state: TriggerAlign["state"], index: number, frac: number): TriggerAlign => ({
    state,
    index,
    frac,
    level_fs: 0,
    hysteresis_fs: 0,
  });

  function freshStore() {
    return new Store(initialState(), { freeze: true });
  }

  it("writes a snapshot on 'triggered' and mirrors run.triggers", () => {
    const store = freshStore();
    ingestFrame(store, SLOT0, frame({ inputL: align("triggered", 2, 0.5) }));
    const snap = getTriggerSnapshot(HW_TRACE_IDS.inputL);
    expect(snap).toBeDefined();
    expect(snap!.state).toBe("triggered");
    expect(snap!.index).toBe(2);
    expect(snap!.frac).toBe(0.5);
    expect(Array.from(snap!.samples[HW_TRACE_IDS.inputL])).toEqual([0.1, 0.2, 0.3]);
    expect(snap!.offsetDb[HW_TRACE_IDS.inputL]).toBe(20);
    expect(focusedRun(store.get()).triggers[HW_TRACE_IDS.inputL]).toEqual({
      state: "triggered",
      index: 2,
      frac: 0.5,
    });
  });

  it("writes a snapshot on 'auto' too", () => {
    const store = freshStore();
    ingestFrame(store, SLOT0, frame({ inputL: align("auto", 0, 0) }));
    expect(getTriggerSnapshot(HW_TRACE_IDS.inputL)).toBeDefined();
  });

  it("leaves a PREVIOUS snapshot untouched on 'waiting'/'stopped'", () => {
    const store = freshStore();
    ingestFrame(store, SLOT0, frame({ inputL: align("triggered", 2, 0.5) }));
    const latched = getTriggerSnapshot(HW_TRACE_IDS.inputL);

    ingestFrame(store, SLOT0, frame({ inputL: align("waiting", 0, 0) }));
    expect(getTriggerSnapshot(HW_TRACE_IDS.inputL)).toBe(latched); // same object — not rewritten
    // The live state still mirrors "waiting" — only the snapshot is held.
    expect(focusedRun(store.get()).triggers[HW_TRACE_IDS.inputL].state).toBe("waiting");

    ingestFrame(store, SLOT0, frame({ inputL: align("stopped", 0, 0) }));
    expect(getTriggerSnapshot(HW_TRACE_IDS.inputL)).toBe(latched);
    expect(focusedRun(store.get()).triggers[HW_TRACE_IDS.inputL].state).toBe("stopped");
  });

  it("a pending Arm survives a stale 'stopped' frame and settles on any other state", () => {
    const store = freshStore();
    store.update("test/arm", (s) =>
      withRun(s, { trigArmPending: { [HW_TRACE_IDS.inputL]: true } })
    );

    // The in-flight frame captured under the PRE-re-arm config still says
    // "stopped" — the pending flag (and the Arm highlight) must hold.
    ingestFrame(store, SLOT0, frame({ inputL: align("stopped", 0, 0) }));
    expect(focusedRun(store.get()).trigArmPending[HW_TRACE_IDS.inputL]).toBe(true);

    // First frame proving the re-armed scan ran settles it.
    ingestFrame(store, SLOT0, frame({ inputL: align("waiting", 0, 0) }));
    expect(focusedRun(store.get()).trigArmPending[HW_TRACE_IDS.inputL]).toBeUndefined();
  });

  it("an endpoint the frame doesn't report is absent from run.triggers", () => {
    const store = freshStore();
    ingestFrame(store, SLOT0, frame({ inputL: align("triggered", 1, 0) }));
    expect(focusedRun(store.get()).triggers[HW_TRACE_IDS.inputR]).toBeUndefined();
  });

  it("run.triggers is replaced wholesale — a since-disabled endpoint drops out", () => {
    const store = freshStore();
    ingestFrame(store, SLOT0, frame({ inputL: align("triggered", 1, 0) }));
    expect(focusedRun(store.get()).triggers[HW_TRACE_IDS.inputL]).toBeDefined();
    ingestFrame(store, SLOT0, frame({})); // input_l no longer requested
    expect(focusedRun(store.get()).triggers[HW_TRACE_IDS.inputL]).toBeUndefined();
  });
});

describe("ingestFrame — scope measurement suite reaches the frames cache (issue #26 lot B)", () => {
  beforeEach(() => {
    clearAllFrames();
    clearTriggerSnapshots();
  });

  const stat = (value: number): { value: number; avg: number; min: number; max: number; sd: number; n: number } => ({
    value,
    avg: value,
    min: value,
    max: value,
    sd: 0,
    n: 1,
  });
  const scopeFixture = (vpp: number): ScopeMeasures => ({
    vpp: stat(vpp),
    vmean: stat(0),
    rms_ac: stat(vpp / 2),
    freq_hz: stat(1000),
    rise_s: stat(1e-6),
    fall_s: stat(1e-6),
    duty: stat(0.5),
  });

  /** Same minimal shape as the trigger-block `frame()` above, but exposes
   * `measures.inputL` so a test can drive it on and off across frames —
   * the trigger block's helper hardcodes it to `null`. */
  function frameWithMeasures(inputL: ScopeMeasures | null): DecodedFrame {
    return {
      seq: 1,
      deviceId: null,
      sampleRate: 48000,
      input: {
        l: { sampleRate: 48000, samples: Float64Array.from([0.1, 0.2, 0.3]) },
        r: { sampleRate: 48000, samples: Float64Array.from([0.4, 0.5, 0.6]) },
      },
      output: null,
      fd: { inputL: null, inputR: null, outputL: null, outputR: null },
      metrics: { inputL: null, inputR: null, harmonicsL: null, harmonicsR: null },
      mix: {
        sigma_peak_dbv: null,
        clip_input: "none",
        clip_output: false,
        fitted_output_range_dbv: 8,
      },
      offsets: { input_l: 20, input_r: 20, output_l: 0, output_r: 0, calibrated: true },
      stats: { frames: 1, fps: 30, frame_ms: 33 },
      errors: [],
      trigger: { inputL: null, inputR: null, outputL: null, outputR: null },
      measures: { inputL: inputL, inputR: null, outputL: null, outputR: null },
    };
  }

  function freshStore() {
    return new Store(initialState(), { freeze: true });
  }

  it("a landed scope suite reaches data/frames.ts's cache for that trace", () => {
    const store = freshStore();
    ingestFrame(store, SLOT0, frameWithMeasures(scopeFixture(2.0)));
    const cached = getFrames(HW_TRACE_IDS.inputL);
    expect(cached?.scope?.vpp.value).toBe(2.0);
    expect(cached?.scope?.freq_hz.value).toBe(1000);
  });

  it("the scope field disappears once the endpoint drops out of the MeasureRequest", () => {
    const store = freshStore();
    // Frame 1: the suite is requested and lands.
    ingestFrame(store, SLOT0, frameWithMeasures(scopeFixture(2.0)));
    expect(getFrames(HW_TRACE_IDS.inputL)?.scope).toBeDefined();

    // Frame 2: same td (so the write isn't skipped), but the backend no
    // longer reports a suite for this endpoint (tile's chip strip changed,
    // or the selector stopped requesting it) — `measures.inputL` is null.
    // `putFrames` replaces the cached record wholesale, so `scope` must be
    // gone entirely, not a stale leftover from frame 1.
    ingestFrame(store, SLOT0, frameWithMeasures(null));
    expect(getFrames(HW_TRACE_IDS.inputL)?.scope).toBeUndefined();
  });
});

describe("ingestFrame — capture provenance stamped on endpoint traces (issue #40)", () => {
  beforeEach(() => {
    clearAllFrames();
    clearTriggerSnapshots();
  });

  function frame(over: Partial<Pick<DecodedFrame, "sampleRate" | "offsets">> = {}): DecodedFrame {
    return {
      seq: 1,
      deviceId: null,
      sampleRate: over.sampleRate ?? 48000,
      input: {
        l: { sampleRate: over.sampleRate ?? 48000, samples: Float64Array.from([0.1, 0.2]) },
        r: { sampleRate: over.sampleRate ?? 48000, samples: Float64Array.from([0.3, 0.4]) },
      },
      output: null,
      fd: { inputL: null, inputR: null, outputL: null, outputR: null },
      metrics: { inputL: null, inputR: null, harmonicsL: null, harmonicsR: null },
      mix: {
        sigma_peak_dbv: null,
        clip_input: "none",
        clip_output: false,
        fitted_output_range_dbv: 8,
      },
      offsets:
        over.offsets ??
        { input_l: 20, input_r: 20.5, output_l: 0, output_r: 0, calibrated: true },
      stats: { frames: 1, fps: 30, frame_ms: 33 },
      errors: [],
      trigger: { inputL: null, inputR: null, outputL: null, outputR: null },
      measures: { inputL: null, inputR: null, outputL: null, outputR: null },
    };
  }

  function connectedStore() {
    const store = new Store(initialState(), { freeze: true });
    store.update("test/connect", (s) =>
      withDevice(s, {
        info: {
          model: "QA403",
          firmware_version: 61,
          serial: "AB12_CD34",
          product: "QA403 Audio Analyzer",
          sample_rates: [48000],
          supports_flash: false,
          capabilities: {} as never,
          is_virtual: false,
        },
        config: { input_gain: 42, output_gain: 18, sample_rate: 48000 },
      })
    );
    return store;
  }

  it("stamps the frame's bench on every written endpoint (frame-side truth first)", () => {
    const store = connectedStore();
    ingestFrame(store, SLOT0, frame());
    const cap = store.get().traces.byId[HW_TRACE_IDS.inputL].capture;
    expect(cap).not.toBeNull();
    expect(cap!.device).toEqual({
      model: "QA403",
      serial: "AB12_CD34",
      firmware: 61,
      isVirtual: false,
    });
    expect(cap!.sampleRateHz).toBe(48000); // the frame's, not the config's
    expect(cap!.inputRangeDbv).toBe(42);
    expect(cap!.outputRangeDbv).toBe(8); // fitted range the loop actually used
    expect(cap!.offsets).toEqual({
      input_l: 20,
      input_r: 20.5,
      output_l: 0,
      output_r: 0,
      calibrated: true,
    });
    expect(cap!.fftSize).toBe(32768);
    expect(cap!.window).toBe("hann");
    expect(cap!.averaging).toEqual({ mode: "off", count: 1 });
    // Live data: no pinned instant — the freeze/program land stamps one.
    expect(cap!.capturedAt).toBeNull();
  });

  it("one frozen snapshot object rides every frame until the bench moves (no per-frame churn)", () => {
    const store = connectedStore();
    ingestFrame(store, SLOT0, frame());
    const first = store.get().traces.byId[HW_TRACE_IDS.inputL].capture;
    // All four endpoints of one capture share the ONE object…
    expect(store.get().traces.byId[HW_TRACE_IDS.inputR].capture).toBe(first);
    // …and the next same-bench frame reuses it (identity, not equality).
    ingestFrame(store, SLOT0, frame());
    expect(store.get().traces.byId[HW_TRACE_IDS.inputL].capture).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);

    // The bench moves (a range change shifts the ADC offsets): new snapshot.
    ingestFrame(
      store,
      SLOT0,
      frame({ offsets: { input_l: 32, input_r: 32.5, output_l: 0, output_r: 0, calibrated: true } })
    );
    const second = store.get().traces.byId[HW_TRACE_IDS.inputL].capture;
    expect(second).not.toBe(first);
    expect(second!.offsets!.input_l).toBe(32);
  });

  it("frameCaptureProvenance with no device info still records the frame's bench", () => {
    const store = new Store(initialState(), { freeze: true });
    const cap = frameCaptureProvenance(store.get(), SLOT0, frame({ sampleRate: 96000 }));
    expect(cap.device).toBeNull();
    expect(cap.sampleRateHz).toBe(96000);
    expect(cap.inputRangeDbv).toBeNull(); // no config read yet — unknown, never guessed
  });

  it("the module-level memo is keyed on BENCH CONTENT, not on call order or store identity — a differently-configured store right after another's ingest gets its OWN fresh snapshot", () => {
    // `lastCaptureSig`/`lastCapture` (stream.ts) are module-scope, not
    // per-store — deliberate (one physical device, one capture, shared by
    // every trace). That single shared memo persists across every test in
    // this file/module, so it's worth pinning explicitly that a genuinely
    // DIFFERENT bench occurring right after a prior ingest is never served
    // the stale object: content-addressing (the signature), not
    // last-call-wins, is what makes reuse across unrelated tests safe.
    const storeA = connectedStore(); // QA403 / AB12_CD34, 42/18 dBV, 20/20.5
    ingestFrame(storeA, SLOT0, frame());
    const capA = storeA.get().traces.byId[HW_TRACE_IDS.inputL].capture;
    expect(capA!.device?.serial).toBe("AB12_CD34");

    const storeB = new Store(initialState(), { freeze: true });
    storeB.update("test/connect-other", (s) =>
      withDevice(s, {
        info: {
          model: "QA402",
          firmware_version: 12,
          serial: "ZZ99_OTHER",
          product: "QA402 Audio Analyzer",
          sample_rates: [48000],
          supports_flash: true,
          capabilities: {} as never,
          is_virtual: true,
        },
        config: { input_gain: 6, output_gain: -2, sample_rate: 48000 },
      })
    );
    ingestFrame(
      storeB,
      SLOT0,
      frame({ offsets: { input_l: 0, input_r: 0, output_l: 0, output_r: 0, calibrated: false } })
    );
    const capB = storeB.get().traces.byId[HW_TRACE_IDS.inputL].capture;

    // storeB's own bench, not a leftover from storeA's ingest just above.
    expect(capB).not.toBe(capA);
    expect(capB!.device).toEqual({
      model: "QA402",
      serial: "ZZ99_OTHER",
      firmware: 12,
      isVirtual: true,
    });
    expect(capB!.inputRangeDbv).toBe(6);
    expect(capB!.outputRangeDbv).toBe(8); // frame's own fitted_output_range_dbv wins over config's -2

    // …and storeA is untouched by storeB's ingest (no cross-store bleed).
    expect(storeA.get().traces.byId[HW_TRACE_IDS.inputL].capture).toBe(capA);
  });

  it("keyed PER SESSION (lot E2): two sessions with an IDENTICAL bench get their own frozen objects, never a shared one", () => {
    // Same store, same content on both sessions — the memo is a Map keyed
    // by SessionKey (lastCaptureBySession), so identity must differ even
    // though the two captures are content-equal.
    const store = connectedStore(); // slot-0: QA403 / AB12_CD34, 42/18 dBV
    store.update("test/add-slot1-same-bench", (s) => ({
      ...s,
      devices: {
        ...s.devices,
        sessions: {
          ...s.devices.sessions,
          "slot-1": { ...initialSession(1), device: s.devices.sessions[SLOT0].device },
        },
      },
    }));

    const f = frame();
    const capSlot0 = frameCaptureProvenance(store.get(), SLOT0, f);
    const capSlot1 = frameCaptureProvenance(store.get(), "slot-1", f);
    expect(capSlot1).toEqual(capSlot0); // same bench content
    expect(capSlot1).not.toBe(capSlot0); // but independently frozen — never shared cross-session
  });
});

/** A minimal fully-typed pushed frame for the per-session ingest/routing
 * pins below — same shape as the other describe blocks' local `frame()`
 * helpers, parameterized on the fields each test actually varies. */
function minimalFrame(
  over: {
    deviceId?: string | null;
    frames?: number;
    offsets?: DecodedFrame["offsets"];
  } = {}
): DecodedFrame {
  return {
    seq: 1,
    deviceId: over.deviceId ?? null,
    sampleRate: 48000,
    input: {
      l: { sampleRate: 48000, samples: Float64Array.from([0.1, 0.2]) },
      r: { sampleRate: 48000, samples: Float64Array.from([0.3, 0.4]) },
    },
    output: null,
    fd: { inputL: null, inputR: null, outputL: null, outputR: null },
    metrics: { inputL: null, inputR: null, harmonicsL: null, harmonicsR: null },
    mix: {
      sigma_peak_dbv: null,
      clip_input: "none",
      clip_output: false,
      fitted_output_range_dbv: 8,
    },
    offsets: over.offsets ?? { input_l: 1, input_r: 2, output_l: 3, output_r: 4, calibrated: true },
    stats: { frames: over.frames ?? 1, fps: 30, frame_ms: 33 },
    errors: [],
    trigger: { inputL: null, inputR: null, outputL: null, outputR: null },
    measures: { inputL: null, inputR: null, outputL: null, outputR: null },
  };
}

/** `s` with a second session added at slot 1 (E4 mints these; these tests
 * hand-build one to exercise the per-session ingest routing). */
function addSlot1(s: AppState): AppState {
  return {
    ...s,
    devices: {
      ...s.devices,
      sessions: { ...s.devices.sessions, "slot-1": initialSession(1) },
    },
  };
}

describe("ingestFrame — per-session routing (issue #25 lot E2)", () => {
  beforeEach(() => {
    clearAllFrames();
    clearTriggerSnapshots();
    __resetSessionGlobals();
  });

  // SCOPE of this isolation (E2 review #7): only the run/device HALVES are
  // per-session. The frames cache and traces.byId keys (HW_TRACE_IDS.*)
  // stay bench-global until E3 slots the trace ids — two sessions streaming
  // concurrently WOULD interleave on the same four traces today. This pin
  // must not be read as trace-pool isolation.
  it("ingestFrame(store, 'slot-1', frame) writes slot-1's run.stats/clip and device.offsets, and leaves slot-0 untouched", () => {
    const store = new Store(initialState(), { freeze: true });
    store.update("test/add-slot1", addSlot1);

    ingestFrame(
      store,
      "slot-1",
      minimalFrame({
        frames: 7,
        offsets: { input_l: 9, input_r: 9, output_l: 9, output_r: 9, calibrated: true },
      })
    );

    const s = store.get();
    expect(s.devices.sessions["slot-1"].run.stats.frames).toBe(7);
    expect(s.devices.sessions["slot-1"].run.clip).toEqual({ input: "none", output: false });
    expect(s.devices.sessions["slot-1"].device.offsets).toEqual({
      input_l: 9,
      input_r: 9,
      output_l: 9,
      output_r: 9,
      calibrated: true,
    });
    // slot-0 never asked for — still its fresh initial values.
    expect(s.devices.sessions[SLOT0].run.stats.frames).toBe(0);
    expect(s.devices.sessions[SLOT0].device.offsets).toBeNull();
  });

  it("ingestFrame on an absent session key is a no-op — no cache write, no store change", () => {
    const store = new Store(initialState(), { freeze: true });
    const before = store.get();
    ingestFrame(store, "slot-99", minimalFrame());
    expect(store.get()).toBe(before); // the guard returns before any store.update
    expect(getFrames(HW_TRACE_IDS.inputL)).toBeUndefined();
  });
});

describe("ingestFrame — F5: frame.deviceId is asserted, never routed on (issue #25 lot E2)", () => {
  beforeEach(() => {
    clearAllFrames();
    clearTriggerSnapshots();
    __resetSessionGlobals();
  });

  function adoptedStore(id: string): Store<AppState> {
    const store = new Store(initialState(), { freeze: true });
    store.update("test/adopt", (s) => ({
      ...s,
      devices: {
        ...s.devices,
        sessions: {
          ...s.devices.sessions,
          [SLOT0]: { ...s.devices.sessions[SLOT0], deviceId: id },
        },
      },
    }));
    return store;
  }

  it("a frame whose deviceId mismatches the session's adopted id is STILL ingested", () => {
    const store = adoptedStore("usb/A");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ingestFrame(store, SLOT0, minimalFrame({ deviceId: "usb/B", frames: 3 }));
    expect(focusedRun(store.get()).stats.frames).toBe(3); // ingested, not dropped
    warn.mockRestore();
  });

  it("console.warn fires exactly once for 3 identical mismatching frames (throttled per (session, stamp, adopted) triple)", () => {
    const store = adoptedStore("usb/A");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ingestFrame(store, SLOT0, minimalFrame({ deviceId: "usb/B" }));
    ingestFrame(store, SLOT0, minimalFrame({ deviceId: "usb/B" }));
    ingestFrame(store, SLOT0, minimalFrame({ deviceId: "usb/B" }));
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("a frame with deviceId null never warns (the e2e fake and every pre-adoption frame)", () => {
    const store = adoptedStore("usb/A");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ingestFrame(store, SLOT0, minimalFrame({ deviceId: null }));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("the mismatch check is skipped while the session's OWN deviceId is still null (not yet adopted)", () => {
    const store = new Store(initialState(), { freeze: true }); // SLOT0.deviceId is null
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ingestFrame(store, SLOT0, minimalFrame({ deviceId: "usb/X" }));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("startRun/stopRun — per-session sequencing (issue #25 lot E2)", () => {
  beforeEach(() => __resetSessionGlobals());

  it("stopRun('slot-0') in flight does NOT sequence startRun('slot-1') behind it", async () => {
    const store = new Store(initialState(), { freeze: true });
    store.update("test/add-slot1-connected", (s) => ({
      ...s,
      devices: {
        ...s.devices,
        sessions: {
          ...s.devices.sessions,
          "slot-1": {
            ...initialSession(1),
            // Adopted id: an UNADOPTED slot ≥ 1 is refused by the
            // isRoutable gate (pinned below) and would never reach the wire.
            deviceId: "usb/B",
            device: { ...initialSession(1).device, status: "connected" as const },
          },
        },
      },
    }));

    const order: string[] = [];
    let resolveStop!: () => void;
    const ipc: Ipc = {
      call: (method: string) => {
        if (method === "stream_stop") {
          return new Promise((resolve) => {
            resolveStop = () => {
              order.push("stop-resolved");
              resolve(undefined as never);
            };
          }) as never;
        }
        if (method === "stream_start") order.push("stream_start");
        return Promise.resolve(null as never);
      },
    };

    const stopP = stopRun(store, ipc, SLOT0); // gated: never resolves until resolveStop()
    // A DIFFERENT session's start must not be sequenced behind it.
    await startRun(store, ipc, { sessionKey: "slot-1" });
    expect(order).toEqual(["stream_start"]); // reached BEFORE the slot-0 stop resolved

    resolveStop();
    await stopP;
    expect(order).toEqual(["stream_start", "stop-resolved"]);
  });

  it("an UNADOPTED slot-1 never touches the wire — startRun and stopRun both refuse (E2 review #2/#3: the arg-less command would drive the DEFAULT runtime, the other device)", async () => {
    const store = new Store(initialState(), { freeze: true });
    store.update("test/add-slot1-unadopted", (s) => ({
      ...s,
      devices: {
        ...s.devices,
        sessions: {
          ...s.devices.sessions,
          "slot-1": {
            ...initialSession(1), // deviceId stays null
            device: { ...initialSession(1).device, status: "connected" as const },
          },
        },
      },
    }));
    const calls: string[] = [];
    const ipc: Ipc = {
      call: (method: string) => {
        calls.push(method);
        return Promise.resolve(null as never);
      },
    };
    await startRun(store, ipc, { sessionKey: "slot-1" });
    await stopRun(store, ipc, "slot-1");
    expect(calls).toEqual([]);
    // And the refused stop left no dangling transport state.
    expect(store.get().devices.sessions["slot-1"].run.stopping).toBe(false);
  });

  it("stopRun on an ABSENT session resolves without touching the wire (E2 review #3)", async () => {
    const store = new Store(initialState(), { freeze: true });
    const calls: string[] = [];
    const ipc: Ipc = {
      call: (method: string) => {
        calls.push(method);
        return Promise.resolve(null as never);
      },
    };
    await stopRun(store, ipc, "slot-99");
    expect(calls).toEqual([]);
  });
});

describe("stopRun — F8: 'Unknown device' rejection is swallowed, not toasted (issue #25 lot E2)", () => {
  beforeEach(() => __resetSessionGlobals());

  function ipcRejecting(message: string): Ipc {
    return {
      call: (method: string) =>
        method === "stream_stop"
          ? Promise.reject(new Error(message))
          : (Promise.resolve(null) as never),
    };
  }

  it("swallows 'Unknown device: usb/X' — no toast, and 'stopping' still clears", async () => {
    const store = new Store(initialState(), { freeze: true });
    await stopRun(store, ipcRejecting("Unknown device: usb/X"), SLOT0);
    expect(store.get().ui.toasts).toEqual([]);
    expect(focusedRun(store.get()).stopping).toBe(false);
    expect(focusedRun(store.get()).streaming).toBe(false);
  });

  it("case-insensitive substring match: a command-wrapper-prefixed, differently-cased message also swallows", async () => {
    const store = new Store(initialState(), { freeze: true });
    await stopRun(store, ipcRejecting("stream_stop failed: UNKNOWN DEVICE: usb/Y"), SLOT0);
    expect(store.get().ui.toasts).toEqual([]);
  });

  it("any OTHER rejection still toasts 'Stop failed:'", async () => {
    const store = new Store(initialState(), { freeze: true });
    await stopRun(store, ipcRejecting("USB timeout"), SLOT0);
    expect(store.get().ui.toasts).toHaveLength(1);
    expect(store.get().ui.toasts[0]).toMatchObject({
      kind: "error",
      message: "Stop failed: Error: USB timeout",
    });
    expect(focusedRun(store.get()).stopping).toBe(false);
  });
});

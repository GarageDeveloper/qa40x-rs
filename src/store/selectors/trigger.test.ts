/**
 * Trigger selectors (Lot A, issue #26): source resolution, the pre-trigger
 * depth a tile asks for, and the display-budget-gated `TriggerRequest`
 * projection (the SpectraRequest/#52 twin for triggers).
 */
import { describe, expect, it, beforeEach } from "vitest";
import { clearAllFrames } from "../../data/frames";
import { initialSession, initialState, HW_TRACE_IDS, type AppState } from "../state";
import { focusedDevice } from "./session";
import { tileTriggerSourceId, tileWindowSamples, triggerPreSamples, triggerRequest } from "./trigger";

function tile(s: AppState, id = "tile-1") {
  return s.layout.tiles[id];
}

describe("tileTriggerSourceId", () => {
  beforeEach(() => clearAllFrames());

  it("an explicit source still a tile member wins", () => {
    const s = initialState();
    s.layout.pattern = "1";
    tile(s).traces = [HW_TRACE_IDS.inputL, HW_TRACE_IDS.inputR];
    tile(s).triggerSource = HW_TRACE_IDS.inputR;
    expect(tileTriggerSourceId(s, tile(s))).toBe(HW_TRACE_IDS.inputR);
  });

  it("'auto' resolves through chipSourceTraceId (the chip fallback)", () => {
    const s = initialState();
    s.layout.pattern = "1";
    tile(s).traces = [HW_TRACE_IDS.inputL];
    tile(s).triggerSource = "auto";
    expect(tileTriggerSourceId(s, tile(s))).toBe(HW_TRACE_IDS.inputL);
  });

  it("a non-member explicit source falls back to the chip source", () => {
    const s = initialState();
    s.layout.pattern = "1";
    tile(s).traces = [HW_TRACE_IDS.inputL];
    // Output R was never added to this tile — a stale/foreign choice.
    tile(s).triggerSource = HW_TRACE_IDS.outputR;
    expect(tileTriggerSourceId(s, tile(s))).toBe(HW_TRACE_IDS.inputL);
  });
});

describe("tileWindowSamples", () => {
  it("null timeWindowMs is the whole capture (fftSize)", () => {
    const s = initialState();
    s.acquisition.fftSize = 4096;
    tile(s).timeWindowMs = null;
    expect(tileWindowSamples(s, tile(s))).toBe(4096);
  });

  it("converts ms at the device sample rate, clamped to fftSize", () => {
    const s = initialState();
    focusedDevice(s).config ={ input_gain: 0, output_gain: 0, sample_rate: 48000 };
    s.acquisition.fftSize = 32768;
    tile(s).timeWindowMs = 10; // 480 samples @ 48 kHz
    expect(tileWindowSamples(s, tile(s))).toBe(480);
    tile(s).timeWindowMs = 100_000; // absurdly wide — clamps to fftSize
    expect(tileWindowSamples(s, tile(s))).toBe(32768);
  });
});

describe("triggerPreSamples / triggerRequest", () => {
  beforeEach(() => clearAllFrames());

  it("mode off ⇒ no request even with a pointing tile", () => {
    const s = initialState();
    s.layout.pattern = "1";
    tile(s).kind = "scope";
    tile(s).traces = [HW_TRACE_IDS.inputL];
    // s.triggers is empty — DEFAULT_TRIGGER's mode is "off".
    const req = triggerRequest(s);
    expect(req.input_l).toBeNull();
    expect(req.input_r).toBeNull();
    expect(req.output_l).toBeNull();
    expect(req.output_r).toBeNull();
  });

  it("only VISIBLE scope tiles count — mode on with no pointing tile ⇒ null", () => {
    const s = initialState();
    s.layout.pattern = "1"; // hides tile-3 (the boot 2x2's spectrum row)
    tile(s).kind = "spectrum"; // tile-1 itself isn't a scope
    s.triggers[HW_TRACE_IDS.inputL] = {
      mode: "auto",
      edge: "rising",
      levelV: 0,
      hystV: null,
      armEpoch: 0,
    };
    expect(triggerRequest(s).input_l).toBeNull();

    tile(s).kind = "scope";
    tile(s).traces = [HW_TRACE_IDS.inputL];
    expect(triggerRequest(s).input_l).not.toBeNull();
    expect(triggerRequest(s).input_l?.mode).toBe("auto");
  });

  it("a hidden (beyond-pattern) tile does not open a request", () => {
    const s = initialState();
    s.layout.pattern = "1"; // tile-3 (a scope in some configs) is hidden here
    s.layout.tiles["tile-3"].kind = "scope";
    s.layout.tiles["tile-3"].traces = [HW_TRACE_IDS.outputR];
    s.triggers[HW_TRACE_IDS.outputR] = {
      mode: "normal",
      edge: "falling",
      levelV: 0.1,
      hystV: null,
      armEpoch: 0,
    };
    expect(triggerRequest(s).output_r).toBeNull();
  });

  it("two tiles on the same endpoint: pre_samples is the WIDEST ask", () => {
    const s = initialState();
    focusedDevice(s).config ={ input_gain: 0, output_gain: 0, sample_rate: 48000 };
    s.layout.pattern = "1x2";
    const [t1, t2] = s.layout.order.map((id) => s.layout.tiles[id]);
    t1.kind = "scope";
    t1.traces = [HW_TRACE_IDS.inputL];
    t1.timeWindowMs = 10; // 480 samples
    t1.triggerPositionPct = 25; // pre = round(0.25*480) = 120

    t2.kind = "scope";
    t2.traces = [HW_TRACE_IDS.inputL];
    t2.timeWindowMs = 10;
    t2.triggerPositionPct = 75; // pre = round(0.75*480) = 360

    s.triggers[HW_TRACE_IDS.inputL] = {
      mode: "auto",
      edge: "rising",
      levelV: 0,
      hystV: null,
      armEpoch: 0,
    };
    expect(triggerPreSamples(s, HW_TRACE_IDS.inputL)).toBe(360);
    expect(triggerRequest(s).input_l?.pre_samples).toBe(360);
  });

  it("clamps pre_samples to fftSize/2 - 1", () => {
    const s = initialState();
    s.layout.pattern = "1";
    s.acquisition.fftSize = 4096;
    tile(s).kind = "scope";
    tile(s).traces = [HW_TRACE_IDS.inputL];
    tile(s).timeWindowMs = null; // full window = fftSize
    tile(s).triggerPositionPct = 100; // pre would be 4096, way past the cap
    s.triggers[HW_TRACE_IDS.inputL] = {
      mode: "single",
      edge: "rising",
      levelV: 0,
      hystV: null,
      armEpoch: 0,
    };
    expect(triggerPreSamples(s, HW_TRACE_IDS.inputL)).toBe(4096 / 2 - 1);
    expect(triggerRequest(s).input_l?.pre_samples).toBe(4096 / 2 - 1);
  });

  it("carries mode/edge/level/hysteresis/armEpoch onto the wire config", () => {
    const s = initialState();
    s.layout.pattern = "1";
    tile(s).kind = "scope";
    tile(s).traces = [HW_TRACE_IDS.inputL];
    s.triggers[HW_TRACE_IDS.inputL] = {
      mode: "normal",
      edge: "falling",
      levelV: -0.25,
      hystV: 0.01,
      armEpoch: 3,
    };
    expect(triggerRequest(s).input_l).toMatchObject({
      mode: "normal",
      edge: "falling",
      level_v: -0.25,
      hysteresis_v: 0.01,
      arm_epoch: 3,
    });
  });
});

describe("triggerRequest(s, slot) — per-slot projection (issue #25 lot E3)", () => {
  beforeEach(() => clearAllFrames());

  it("slot 1 reads s.triggers keyed on the @1 id, gated on an @1-scoped visible tile", () => {
    const s = initialState();
    s.layout.pattern = "1";
    tile(s).kind = "scope";
    tile(s).traces = ["hw-in-left@1"];
    s.triggers["hw-in-left@1"] = {
      mode: "auto",
      edge: "rising",
      levelV: 0.2,
      hystV: null,
      armEpoch: 0,
    };
    const req = triggerRequest(s, 1);
    expect(req.input_l).toMatchObject({ mode: "auto", edge: "rising", level_v: 0.2 });
    expect(req.input_r).toBeNull();
  });

  it("triggerRequest(s, 0) is byte-identical to the historic arg-less call — the default is pinned unchanged", () => {
    const s = initialState();
    s.layout.pattern = "1";
    tile(s).kind = "scope";
    tile(s).traces = [HW_TRACE_IDS.inputL];
    s.triggers[HW_TRACE_IDS.inputL] = {
      mode: "normal",
      edge: "falling",
      levelV: -0.1,
      hystV: 0.02,
      armEpoch: 2,
    };
    expect(triggerRequest(s, 0)).toEqual(triggerRequest(s));
  });

  it("slot 1's request is independent of an identically-shaped slot-0 setting", () => {
    const s = initialState();
    s.layout.pattern = "1";
    tile(s).kind = "scope";
    tile(s).traces = [HW_TRACE_IDS.inputL]; // slot 0 only — slot 1 has no member tile
    s.triggers[HW_TRACE_IDS.inputL] = {
      mode: "auto",
      edge: "rising",
      levelV: 0.2,
      hystV: null,
      armEpoch: 0,
    };
    s.triggers["hw-in-left@1"] = {
      mode: "auto",
      edge: "rising",
      levelV: 0.2,
      hystV: null,
      armEpoch: 0,
    };
    // slot 0 is requested (a visible scope tile points at it)...
    expect(triggerRequest(s, 0).input_l).not.toBeNull();
    // ...but slot 1's identical setting is NOT — no tile scopes @1 (#52's rule).
    expect(triggerRequest(s, 1).input_l).toBeNull();
  });
});

describe("tileWindowSamples — slot-scoped sample rate (issue #25 lot E3)", () => {
  it("sizes the window in the trigger source's OWNING slot's sample rate, not the focused one's", () => {
    const s = initialState();
    focusedDevice(s).config = { input_gain: 0, output_gain: 0, sample_rate: 48000 };
    s.devices.sessions["slot-1"] = {
      ...initialSession(1),
      device: {
        ...initialSession(1).device,
        config: { input_gain: 0, output_gain: 0, sample_rate: 96000 },
      },
    };
    s.acquisition.fftSize = 32768;
    tile(s).kind = "scope";
    tile(s).traces = ["hw-in-left@1"];
    tile(s).triggerSource = "hw-in-left@1";
    tile(s).timeWindowMs = 10; // 960 samples @ 96 kHz — would be 480 @ the focused 48 kHz
    expect(tileWindowSamples(s, tile(s))).toBe(960);
  });

  it("falls back to the focused session's rate for a non-hw / absent trigger source", () => {
    const s = initialState();
    focusedDevice(s).config = { input_gain: 0, output_gain: 0, sample_rate: 48000 };
    s.acquisition.fftSize = 32768;
    tile(s).kind = "scope";
    tile(s).traces = ["mem-1"]; // a frozen/memory trace — never a hw endpoint
    tile(s).triggerSource = "mem-1";
    tile(s).timeWindowMs = 10; // 480 samples @ the focused 48 kHz
    expect(tileWindowSamples(s, tile(s))).toBe(480);
  });
});

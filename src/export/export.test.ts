/**
 * tileCapture (issue #40, review findings #2/#5): which capture snapshot a
 * TILE export is signed with. The pure builders live in csv.ts; this is the
 * one piece of export.ts logic with real decision content — the chip-source
 * preference, the hidden-chip refusal, and the mixed-bench detection.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { clearAllFrames, putFrames } from "../data/frames";
import {
  defaultTile,
  initialState,
  HW_TRACE_IDS,
  type AppState,
  type CaptureProvenance,
  type TileConfig,
} from "../store/state";
import { tileCapture } from "./export";

const capture = (serial: string): CaptureProvenance => ({
  device: { model: "QA403", serial, firmware: 61, isVirtual: false },
  sampleRateHz: 48000,
  inputRangeDbv: 42,
  outputRangeDbv: 18,
  offsets: { input_l: 32.1, input_r: 32.2, output_l: 8.1, output_r: 8.2, calibrated: true },
  fftSize: 32768,
  window: "flattop",
  averaging: { mode: "off", count: 1 },
  capturedAt: null,
});

/** State where inputL/inputR carry data (+ optional captures). */
function stateWith(
  caps: Partial<Record<string, CaptureProvenance | null>>,
  dataless: string[] = []
): AppState {
  const s = initialState();
  for (const id of [HW_TRACE_IDS.inputL, HW_TRACE_IDS.inputR]) {
    const t = s.traces.byId[id];
    if (dataless.includes(id)) continue;
    putFrames(id, 1, {
      fd: { freqs: Float64Array.from([100]), magDb: Float64Array.from([-6]) },
    });
    s.traces.byId[id] = {
      ...t,
      seq: 1,
      domains: ["fd"],
      capture: caps[id] ?? null,
    };
  }
  return s;
}

function tile(over: Partial<TileConfig> = {}): TileConfig {
  return {
    ...defaultTile("t", "spectrum", [HW_TRACE_IDS.inputL, HW_TRACE_IDS.inputR]),
    ...over,
  };
}

describe("tileCapture", () => {
  beforeEach(() => clearAllFrames());

  it("rides the chip-source trace's snapshot; same bench ⇒ no mixed flag", () => {
    const s = stateWith({
      [HW_TRACE_IDS.inputL]: capture("AB12"),
      [HW_TRACE_IDS.inputR]: capture("AB12"),
    });
    const c = tileCapture(s, tile())!;
    expect(c.device!.serial).toBe("AB12");
    expect(c.mixed).toBeUndefined();
  });

  it("members captured on different benches flag mixed", () => {
    const s = stateWith({
      [HW_TRACE_IDS.inputL]: capture("AB12"),
      [HW_TRACE_IDS.inputR]: capture("ZZ99"),
    });
    const c = tileCapture(s, tile())!;
    expect(c.mixed).toBe(true);
    expect(c.device!.serial).toBe("AB12"); // still the chip source's
  });

  it("a legend-HIDDEN explicit chip source never signs the file (review finding #2)", () => {
    // chipSource = inputR (pinned bench ZZ99), but the user hid it: only
    // inputL's columns are in the file — signing with ZZ99 would re-create
    // the #40 bug with more confidence than before.
    const s = stateWith({
      [HW_TRACE_IDS.inputL]: capture("AB12"),
      [HW_TRACE_IDS.inputR]: capture("ZZ99"),
    });
    const c = tileCapture(
      s,
      tile({ chipSource: HW_TRACE_IDS.inputR, hidden: [HW_TRACE_IDS.inputR] })
    )!;
    expect(c.device!.serial).toBe("AB12");
    expect(c.mixed).toBeUndefined(); // the hidden member's bench is not drawn
  });

  it("a drawn member WITH data but WITHOUT a snapshot counts as an unknown bench (review finding #5)", () => {
    const s = stateWith({
      [HW_TRACE_IDS.inputL]: capture("AB12"),
      [HW_TRACE_IDS.inputR]: null, // e.g. a ❄ trace from a pre-#40 doc
    });
    const c = tileCapture(s, tile())!;
    expect(c.mixed).toBe(true);
  });

  it("a dataless member contributes no columns and no mixed flag", () => {
    const s = stateWith({ [HW_TRACE_IDS.inputL]: capture("AB12") }, [HW_TRACE_IDS.inputR]);
    const c = tileCapture(s, tile())!;
    expect(c.device!.serial).toBe("AB12");
    expect(c.mixed).toBeUndefined();
  });

  it("no member has a snapshot ⇒ null (the export falls back to the live bench)", () => {
    const s = stateWith({});
    expect(tileCapture(s, tile())).toBeNull();
  });
});

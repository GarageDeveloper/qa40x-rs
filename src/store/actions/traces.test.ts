/**
 * Freeze ❄ semantics for the capture snapshot (issue #40): the copy carries
 * its source's provenance, and the freeze pins the instant — a live trace's
 * snapshot has none (the data keeps refreshing; the freeze IS the moment the
 * kept picture stops).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { clearAllFrames, putFrames } from "../../data/frames";
import { initialState, HW_TRACE_IDS, type CaptureProvenance } from "../state";
import { Store } from "../store";
import { freezeTrace } from "./traces";

const capture: CaptureProvenance = {
  device: { model: "QA403", serial: "AB12_CD34", firmware: 61, isVirtual: false },
  sampleRateHz: 48000,
  inputRangeDbv: 42,
  outputRangeDbv: 18,
  offsets: { input_l: 32.1, input_r: 32.2, output_l: 8.1, output_r: 8.2, calibrated: true },
  fftSize: 32768,
  window: "flattop",
  averaging: { mode: "power", count: 8 },
  capturedAt: null,
};

function storeWithLiveInputL(cap: CaptureProvenance | null): Store<ReturnType<typeof initialState>> {
  const store = new Store(initialState(), { freeze: true });
  putFrames(HW_TRACE_IDS.inputL, 1, {
    fd: { freqs: Float64Array.from([100]), magDb: Float64Array.from([-6]) },
  });
  store.update("test/stamp", (s) => ({
    ...s,
    traces: {
      ...s.traces,
      byId: {
        ...s.traces.byId,
        [HW_TRACE_IDS.inputL]: {
          ...s.traces.byId[HW_TRACE_IDS.inputL],
          seq: 1,
          domains: ["fd" as const],
          offsetDb: 32.1,
          capture: cap,
        },
      },
    },
  }));
  return store;
}

describe("freezeTrace — capture snapshot (issue #40)", () => {
  beforeEach(() => clearAllFrames());

  it("copies the snapshot and pins the freeze instant on a live source", () => {
    const store = storeWithLiveInputL(capture);
    const memId = freezeTrace(store, HW_TRACE_IDS.inputL)!;
    const frozen = store.get().traces.byId[memId].capture!;
    expect(frozen.device).toEqual(capture.device);
    expect(frozen.offsets).toEqual(capture.offsets);
    // The live source had no instant — the freeze stamps one (ISO 8601).
    expect(frozen.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The source itself keeps refreshing: its own snapshot stays unpinned.
    expect(store.get().traces.byId[HW_TRACE_IDS.inputL].capture!.capturedAt).toBeNull();
  });

  it("keeps an ALREADY pinned instant (freezing a program result keeps its run time)", () => {
    const store = storeWithLiveInputL({ ...capture, capturedAt: "2026-07-26T08:00:00.000Z" });
    const memId = freezeTrace(store, HW_TRACE_IDS.inputL)!;
    expect(store.get().traces.byId[memId].capture!.capturedAt).toBe(
      "2026-07-26T08:00:00.000Z"
    );
  });

  it("a source without a snapshot freezes with none — never a fabricated one", () => {
    const store = storeWithLiveInputL(null);
    const memId = freezeTrace(store, HW_TRACE_IDS.inputL)!;
    expect(store.get().traces.byId[memId].capture).toBeNull();
  });
});

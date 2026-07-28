/**
 * Freeze ❄ semantics for the capture snapshot (issue #40): the copy carries
 * its source's provenance, and the freeze pins the instant — a live trace's
 * snapshot has none (the data keeps refreshing; the freeze IS the moment the
 * kept picture stops).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { clearAllFrames, putFrames } from "../../data/frames";
import {
  hwTraceMetas,
  initialSession,
  initialState,
  HW_TRACE_IDS,
  type AppState,
  type CaptureProvenance,
  type TraceSource,
} from "../state";
import { Store } from "../store";
import { freezeTrace, reconcileHwTraces } from "./traces";

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

/** `s` with a second session at slot 1 (E4 mints these; this file hand-
 * builds one to exercise reconcileHwTraces — same helper shape as
 * selectors/session.test.ts's withSlot1). */
function withSlot1(s: AppState): AppState {
  return {
    ...s,
    devices: {
      ...s.devices,
      sessions: { ...s.devices.sessions, "slot-1": initialSession(1) },
    },
  };
}

describe("reconcileHwTraces — the hw pool vs LIVE sessions (issue #25 lot E3, F6)", () => {
  it("returns the SAME reference on initialState() — nothing missing, nothing to restore", () => {
    const s = initialState();
    expect(reconcileHwTraces(s)).toBe(s);
  });

  it("appends exactly the 4 @1 traces, slot-then-endpoint order, for a hand-built slot-1 session — the slot-0 prefix is untouched", () => {
    const s = withSlot1(initialState());
    const next = reconcileHwTraces(s);
    expect(next).not.toBe(s);
    expect(next.traces.order).toEqual([
      ...s.traces.order,
      "hw-in-left@1",
      "hw-in-right@1",
      "hw-out-left@1",
      "hw-out-right@1",
    ]);
    expect(next.traces.order.slice(0, s.traces.order.length)).toEqual(s.traces.order);
    // The slot-1 metas are exactly hwTraceMetas(1) — nothing hand-rolled here.
    expect(next.traces.byId["hw-in-left@1"]).toEqual(hwTraceMetas(1)[0]);
    // Untouched slot-0 entries keep their EXACT reference — no needless copy.
    for (const id of s.traces.order) {
      expect(next.traces.byId[id]).toBe(s.traces.byId[id]);
    }
  });

  it("is idempotent — reconciling an already-reconciled state returns the SAME reference again", () => {
    const s = withSlot1(initialState());
    const once = reconcileHwTraces(s);
    const twice = reconcileHwTraces(once);
    expect(twice).toBe(once);
  });

  it("keeps a user-renamed/recolored hw-in-left but restores a corrupted source (a doc must not turn a hw endpoint into a memory trace)", () => {
    const s = initialState();
    s.traces.byId[HW_TRACE_IDS.inputL] = {
      ...s.traces.byId[HW_TRACE_IDS.inputL],
      label: "My Input",
      color: "#123456",
      source: { kind: "memory", frozenFrom: "gone" } as TraceSource,
    };
    const next = reconcileHwTraces(s);
    const t = next.traces.byId[HW_TRACE_IDS.inputL];
    expect(t.label).toBe("My Input");
    expect(t.color).toBe("#123456");
    expect(t.source).toEqual({ kind: "hw_input", channel: "left" });
  });

  it("re-appends an endpoint present in byId but MISSING from order — an order/byId desync must not leave it unreachable (E3 review #2)", () => {
    const s = initialState();
    // A hand-edited/corrupt doc dropped the row but kept the meta.
    const kept = s.traces.byId[HW_TRACE_IDS.inputL];
    s.traces.order = s.traces.order.filter((id) => id !== HW_TRACE_IDS.inputL);
    const next = reconcileHwTraces(s);
    expect(next).not.toBe(s);
    expect(next.traces.order).toContain(HW_TRACE_IDS.inputL);
    // The existing meta is KEPT (user label/color), only the row returns.
    expect(next.traces.byId[HW_TRACE_IDS.inputL]).toBe(kept);
  });

  it("never deletes a doc-provided @1 trace when no slot-1 session exists (dormant, revives when the device comes back)", () => {
    const s = initialState();
    const dormant = { ...hwTraceMetas(1)[0], label: "Renamed while dormant" };
    s.traces.order = [...s.traces.order, dormant.id];
    s.traces.byId = { ...s.traces.byId, [dormant.id]: dormant };
    // No slot-1 session — reconcile must not touch or drop it.
    const next = reconcileHwTraces(s);
    expect(next).toBe(s); // nothing missing (slot-0 complete) and nothing corrupted ⇒ unchanged
    expect(next.traces.byId[dormant.id]).toBe(dormant);
    expect(next.traces.order).toContain(dormant.id);
  });
});

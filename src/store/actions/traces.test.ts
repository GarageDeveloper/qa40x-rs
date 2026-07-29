/**
 * Freeze ❄ semantics for the capture snapshot (issue #40): the copy carries
 * its source's provenance, and the freeze pins the instant — a live trace's
 * snapshot has none (the data keeps refreshing; the freeze IS the moment the
 * kept picture stops).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { clearAllFrames, getFrames, putFrames } from "../../data/frames";
import type { Ipc } from "../../ipc/ipc";
import {
  hwTraceIds,
  hwTraceMetas,
  initialSession,
  initialState,
  HW_TRACE_IDS,
  type AppState,
  type CaptureProvenance,
  type TraceSource,
} from "../state";
import { Store } from "../store";
import { setDeviceAlias } from "./devices";
import {
  freezeTrace,
  purgeSlotEndpointTraces,
  reconcileHwTraces,
  resetSlotEndpointTraces,
} from "./traces";

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

  it("a device alias never leaks into the minted endpoint labels — labels are always slot-derived (issue #25 lot E4, hwtraces.ts's own rule, pinned here at the mint call site)", () => {
    // A registry alias set on the unit BEFORE it ever occupies slot-1 (the
    // realistic ordering: aliases persist across replugs/slots) must not
    // change what reconcileHwTraces mints — hwTraceMetas(slot) takes no
    // AppState/alias input at all, so this is structurally guaranteed, but
    // pinned here at the real call site anyway (mint-then-reconcile, the
    // actual addDevice flow) so a future refactor that threaded aliases in
    // would fail loudly.
    const store = new Store(initialState(), { freeze: true });
    setDeviceAlias(store, "usb/B", "Raphaël's Bench");
    store.update("test/mint-slot1", (s) => withSlot1(s));
    store.update("test/reconcile", reconcileHwTraces);
    expect(store.get().traces.byId["hw-in-left@1"].label).toBe("Input L #2");
    expect(store.get().traces.byId["hw-in-left@1"].label).not.toContain("Raphaël's Bench");
  });
});

describe("resetSlotEndpointTraces — fresh-slate a mint-reused slot (issue #25 lot E4, decision B6)", () => {
  beforeEach(() => clearAllFrames());

  /** `s` with slot-1's 4 endpoints reconciled AND stamped as if a capture
   * already landed on them — resetSlotEndpointTraces's target shape. */
  function withStampedSlot1(): AppState {
    const s = reconcileHwTraces(withSlot1(initialState()));
    const ids = Object.values(hwTraceIds(1));
    for (const id of ids) {
      putFrames(id, 1, { fd: { freqs: Float64Array.from([100]), magDb: Float64Array.from([-6]) } });
    }
    return {
      ...s,
      traces: {
        ...s.traces,
        byId: Object.fromEntries(
          Object.entries(s.traces.byId).map(([id, t]) =>
            ids.includes(id)
              ? [id, { ...t, label: "Renamed #2", color: "#abcdef", domains: ["fd" as const], offsetDb: 12, capture: null, seq: 5 }]
              : [id, t]
          )
        ),
      },
    };
  }

  it("zeroes domains/offsetDb/capture, bumps seq, KEEPS the user label/color, and clears the frames cache", () => {
    const store = new Store(withStampedSlot1(), { freeze: true });
    const before = store.get().traces.byId["hw-in-left@1"];
    expect(before.domains).toEqual(["fd"]);
    expect(getFrames("hw-in-left@1")).toBeDefined();

    resetSlotEndpointTraces(store, 1);

    const after = store.get().traces.byId["hw-in-left@1"];
    expect(after.domains).toEqual([]);
    expect(after.offsetDb).toBeNull();
    expect(after.capture).toBeNull();
    expect(after.seq).toBe(before.seq + 1);
    expect(after.label).toBe("Renamed #2"); // user edit kept
    expect(after.color).toBe("#abcdef"); // user edit kept
    expect(getFrames("hw-in-left@1")).toBeUndefined(); // cache cleared
  });

  it("touches all 4 of the slot's endpoints, and ONLY that slot's", () => {
    const store = new Store(withStampedSlot1(), { freeze: true });
    resetSlotEndpointTraces(store, 1);
    const s = store.get();
    for (const id of Object.values(hwTraceIds(1))) {
      expect(s.traces.byId[id].domains, id).toEqual([]);
    }
    // Slot 0's own endpoints are untouched (never stamped in this fixture)
    // — value-equal to a fresh boot state (hwTraceMetas returns fresh
    // objects per call, so this is a content check, not identity).
    const boot = initialState();
    for (const id of Object.values(HW_TRACE_IDS)) {
      expect(s.traces.byId[id]).toEqual(boot.traces.byId[id]);
    }
  });
});

describe("purgeSlotEndpointTraces — remove a device's endpoints from the whole bench (issue #25 lot E4, decision B5)", () => {
  const noopIpc: Ipc = { call: () => Promise.resolve(null as never) };

  /** `s` with slot-1 reconciled, its Input L a member of tile-1 (also its
   * chipSource/triggerSource), legend-hidden, and a trigger setting on it —
   * every seam purgeSlotEndpointTraces must clean up. */
  function withWiredSlot1(): AppState {
    const s = reconcileHwTraces(withSlot1(initialState()));
    const tile1 = s.layout.tiles["tile-1"];
    return {
      ...s,
      layout: {
        ...s.layout,
        tiles: {
          ...s.layout.tiles,
          "tile-1": {
            ...tile1,
            traces: [...tile1.traces, "hw-in-left@1"],
            hidden: [...tile1.hidden, "hw-in-left@1"],
            hiddenCurves: { ...tile1.hiddenCurves, "hw-in-left@1": ["Right"] },
            chipSource: "hw-in-left@1",
            triggerSource: "hw-in-left@1",
          },
        },
      },
      triggers: {
        ...s.triggers,
        "hw-in-left@1": { mode: "auto", edge: "rising", levelV: 0.1, hystV: null, armEpoch: 0 },
      },
    };
  }

  it("removes exactly the 4 slot-1 ids from the pool, every tile's membership/hidden/hiddenCurves, resets chip/triggerSource to 'auto', drops s.triggers — leaves slot 0 byte-identical", () => {
    const store = new Store(withWiredSlot1(), { freeze: true });
    purgeSlotEndpointTraces(store, noopIpc, 1);
    const s = store.get();

    const slot1Ids = Object.values(hwTraceIds(1));
    for (const id of slot1Ids) {
      expect(s.traces.byId[id], id).toBeUndefined();
      expect(s.traces.order, id).not.toContain(id);
    }
    const tile1 = s.layout.tiles["tile-1"];
    expect(tile1.traces).not.toContain("hw-in-left@1");
    expect(tile1.hidden).not.toContain("hw-in-left@1");
    expect("hw-in-left@1" in tile1.hiddenCurves).toBe(false);
    expect(tile1.chipSource).toBe("auto");
    expect(tile1.triggerSource).toBe("auto");
    expect(s.triggers["hw-in-left@1"]).toBeUndefined();

    // Slot 0 is entirely untouched — same references as a fresh boot state
    // for every field the purge could plausibly have brushed.
    const boot = initialState();
    for (const id of Object.values(HW_TRACE_IDS)) {
      expect(s.traces.byId[id]).toEqual(boot.traces.byId[id]);
    }
  });

  it("clears the frames cache for the purged ids", () => {
    const s = withWiredSlot1();
    putFrames("hw-in-left@1", 1, { fd: { freqs: Float64Array.from([100]), magDb: Float64Array.from([-6]) } });
    const store = new Store(s, { freeze: true });
    expect(getFrames("hw-in-left@1")).toBeDefined();
    purgeSlotEndpointTraces(store, noopIpc, 1);
    expect(getFrames("hw-in-left@1")).toBeUndefined();
  });

  it("slot 0 is REFUSED — the default device's endpoints are permanent, no ✕ ever applies to them", () => {
    const store = new Store(initialState(), { freeze: true });
    const before = store.get();
    purgeSlotEndpointTraces(store, noopIpc, 0);
    expect(store.get()).toBe(before);
    for (const id of Object.values(HW_TRACE_IDS)) {
      expect(store.get().traces.byId[id]).toBeDefined();
    }
  });
});

/**
 * Traces-panel grouping selectors (issue #25 lot E4): `deviceGroups` (one
 * group per device SLOT, from the union of live sessions and the hw
 * endpoint ids actually in the pool) and `ungroupedTraceIds` (the flat tail
 * — memory/transform/program traces, which never belong to a device).
 */
import { describe, expect, it } from "vitest";
import type { TraceMeta } from "../state";
import { HW_TRACE_IDS, hwTraceMetas, initialSession, initialState } from "../state";
import { deviceGroups, ungroupedTraceIds } from "./traces";

describe("deviceGroups — boot state (issue #25 lot E4)", () => {
  it("exactly one LIVE group, slot 0, the 4 verbatim hw ids in pool order, deviceId null", () => {
    const groups = deviceGroups(initialState());
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: "slot-0", slot: 0, live: true, deviceId: null });
    expect(groups[0].traceIds).toEqual([
      HW_TRACE_IDS.inputL,
      HW_TRACE_IDS.inputR,
      HW_TRACE_IDS.outputL,
      HW_TRACE_IDS.outputR,
    ]);
  });

  it("no ungrouped traces at boot — nothing sits outside the slot-0 group", () => {
    expect(ungroupedTraceIds(initialState())).toEqual([]);
  });
});

describe("deviceGroups — a doc-loaded slot-1 endpoint set with NO live session is a DORMANT group (decision B1)", () => {
  it("live:false, deviceId:null, still carries its 4 @1 ids", () => {
    const s = initialState();
    const dormant = hwTraceMetas(1);
    s.traces.order = [...s.traces.order, ...dormant.map((m) => m.id)];
    s.traces.byId = { ...s.traces.byId, ...Object.fromEntries(dormant.map((m) => [m.id, m])) };

    const groups = deviceGroups(s);
    expect(groups).toHaveLength(2);
    const g1 = groups[1];
    expect(g1.slot).toBe(1);
    expect(g1.live).toBe(false);
    expect(g1.deviceId).toBeNull();
    expect(g1.traceIds).toEqual(dormant.map((m) => m.id));
  });
});

describe("deviceGroups — a LIVE slot-1 session (issue #25 lot E4)", () => {
  it("live:true, carries the session's adopted deviceId — even with no endpoint traces minted yet", () => {
    const s = initialState();
    s.devices.sessions["slot-1"] = { ...initialSession(1), deviceId: "usb/B" };
    const groups = deviceGroups(s);
    const g1 = groups.find((g) => g.slot === 1);
    expect(g1).toBeDefined();
    expect(g1!.live).toBe(true);
    expect(g1!.deviceId).toBe("usb/B");
    // The union comes from LIVE SESSIONS ∪ pool hw ids — a session with no
    // endpoint traces yet (the pre-reconcile instant) still surfaces as an
    // empty group, never silently dropped.
    expect(g1!.traceIds).toEqual([]);
  });

  it("an UNADOPTED slot-1 session (deviceId still null) is still a live group with deviceId null", () => {
    const s = initialState();
    s.devices.sessions["slot-1"] = initialSession(1);
    const g1 = deviceGroups(s).find((g) => g.slot === 1)!;
    expect(g1.live).toBe(true);
    expect(g1.deviceId).toBeNull();
  });
});

describe("deviceGroups — memory/transform/program traces never enter a group (decision B2)", () => {
  it("ungroupedTraceIds carries them, in pool order; no group's traceIds ever includes them", () => {
    const s = initialState();
    const memMeta: TraceMeta = {
      id: "mem-1",
      label: "Frozen",
      color: "#112233",
      source: { kind: "memory", frozenFrom: HW_TRACE_IDS.inputL },
      domains: [],
      seq: 1,
      offsetDb: null,
      capture: null,
    };
    const fxMeta: TraceMeta = {
      id: "fx-2",
      label: "FX",
      color: "#445566",
      source: { kind: "transform", input: HW_TRACE_IDS.inputL, steps: [] },
      domains: [],
      seq: 0,
      offsetDb: null,
      capture: null,
    };
    s.traces.order = [...s.traces.order, "mem-1", "fx-2"];
    s.traces.byId = { ...s.traces.byId, "mem-1": memMeta, "fx-2": fxMeta };

    expect(ungroupedTraceIds(s)).toEqual(["mem-1", "fx-2"]);
    for (const g of deviceGroups(s)) {
      expect(g.traceIds).not.toContain("mem-1");
      expect(g.traceIds).not.toContain("fx-2");
    }
  });
});

describe("deviceGroups — slot order (issue #25 lot E4)", () => {
  it("returns groups sorted by SLOT ascending, regardless of the sessions map's insertion/key order", () => {
    const s = initialState();
    s.devices.sessions = {
      "slot-2": { ...initialSession(2), deviceId: "usb/C" },
      "slot-0": s.devices.sessions["slot-0"],
      "slot-1": { ...initialSession(1), deviceId: "usb/B" },
    };
    expect(deviceGroups(s).map((g) => g.slot)).toEqual([0, 1, 2]);
  });
});

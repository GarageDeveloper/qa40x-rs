/**
 * hwtraces.ts — slot-keyed hardware endpoint trace ids (issue #25 lot E3).
 * The verbatim pin for slot 0 (written as STRING LITERALS, never through a
 * re-exported constant) is the load-bearing one: every existing workspace,
 * template and e2e spec assumes these four exact strings.
 */
import { describe, expect, it } from "vitest";
import { initialTraces } from "./state";
import {
  EXTRA_TRACE_COLORS,
  HW_ENDPOINTS,
  hwSlotOfTraceId,
  hwTraceIds,
  hwTraceMetas,
  hwTraceSource,
  isHwTraceId,
} from "./hwtraces";

describe("hwTraceIds", () => {
  it("slot 0 returns the four historic ids VERBATIM (string literals, not a re-export)", () => {
    expect(hwTraceIds(0)).toEqual({
      inputL: "hw-in-left",
      inputR: "hw-in-right",
      outputL: "hw-out-left",
      outputR: "hw-out-right",
    });
  });

  it("slot n ≥ 1 suffixes @n", () => {
    expect(hwTraceIds(1).inputL).toBe("hw-in-left@1");
    expect(hwTraceIds(2).outputR).toBe("hw-out-right@2");
  });

  it("returns the SAME reference across calls for a given slot (per-frame paths read this)", () => {
    expect(hwTraceIds(0)).toBe(hwTraceIds(0));
    expect(hwTraceIds(1)).toBe(hwTraceIds(1));
    expect(hwTraceIds(3)).toBe(hwTraceIds(3));
  });
});

describe("hwSlotOfTraceId — strict reverse (never slot 0 by accident)", () => {
  it("round-trips slots 0..8 for all 4 endpoints", () => {
    for (let slot = 0; slot <= 8; slot++) {
      const ids = hwTraceIds(slot);
      for (const key of ["inputL", "inputR", "outputL", "outputR"] as const) {
        expect(hwSlotOfTraceId(ids[key]), `slot ${slot} ${key}`).toBe(slot);
      }
    }
  });

  it("null for non-hw ids and near-miss names — @0/@01/@x never alias slot 0", () => {
    for (const id of [
      "mem-1",
      "fx-2",
      "hw-in-left@0",
      "hw-in-left@01",
      "hw-in-left@x",
      "hw-in-lefty",
      "",
    ]) {
      expect(hwSlotOfTraceId(id), id).toBeNull();
      expect(isHwTraceId(id), id).toBe(false);
    }
  });

  it("isHwTraceId agrees with hwSlotOfTraceId on the valid side too", () => {
    expect(isHwTraceId("hw-in-left")).toBe(true);
    expect(isHwTraceId("hw-out-right@7")).toBe(true);
  });
});

describe("hwTraceSource", () => {
  it("the canonical source for every slot-0 id matches HW_ENDPOINTS", () => {
    for (const def of HW_ENDPOINTS) {
      expect(hwTraceSource(def.base)).toEqual({ kind: def.kind, channel: def.channel });
    }
  });

  it("a slot ≥ 1 id resolves to the SAME canonical source as its slot-0 base", () => {
    expect(hwTraceSource("hw-in-right@3")).toEqual({ kind: "hw_input", channel: "right" });
  });

  it("null for a non-hw id", () => {
    expect(hwTraceSource("mem-1")).toBeNull();
  });
});

describe("hwTraceMetas", () => {
  it("slot 0 deep-equals initialTraces()'s metas", () => {
    const traces = initialTraces();
    const expected = traces.order.map((id) => traces.byId[id]);
    expect(hwTraceMetas(0)).toEqual(expected);
  });

  it("slot 1: @1 ids, human-numbered labels, EXTRA_TRACE_COLORS stepping, canonical sources", () => {
    const metas = hwTraceMetas(1);
    expect(metas.map((m) => m.id)).toEqual([
      "hw-in-left@1",
      "hw-in-right@1",
      "hw-out-left@1",
      "hw-out-right@1",
    ]);
    expect(metas.map((m) => m.label)).toEqual([
      "Input L #2",
      "Input R #2",
      "Output L #2",
      "Output R #2",
    ]);
    expect(metas.map((m) => m.color)).toEqual([
      EXTRA_TRACE_COLORS[0],
      EXTRA_TRACE_COLORS[1],
      EXTRA_TRACE_COLORS[2],
      EXTRA_TRACE_COLORS[3],
    ]);
    expect(metas.map((m) => m.source)).toEqual([
      { kind: "hw_input", channel: "left" },
      { kind: "hw_input", channel: "right" },
      { kind: "hw_output", channel: "left" },
      { kind: "hw_output", channel: "right" },
    ]);
    for (const m of metas) {
      expect(m.seq).toBe(0);
      expect(m.offsetDb).toBeNull();
      expect(m.capture).toBeNull();
      expect(m.domains).toEqual([]);
    }
  });
});

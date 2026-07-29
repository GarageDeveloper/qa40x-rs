/**
 * Layout selectors — `chipSourceTraceId` (issue #25 lot E4, E3 review #5):
 * single-device resolution (unchanged, pinned here directly since no test
 * exercised it in isolation before — trigger.test.ts only reaches it
 * indirectly through `tileTriggerSourceId`'s "auto" case) and the
 * cross-slot "auto never crosses device slots" rule the E4 lot added.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { clearAllFrames, putFrames } from "../../data/frames";
import { HW_TRACE_IDS, initialState } from "../state";
import type { AppState, TileConfig } from "../state";
import { chipSourceTraceId } from "./layout";

function tile(s: AppState, id = "tile-1"): TileConfig {
  return s.layout.tiles[id];
}

/** A minimal fd-carrying frame record — enough for chipSourceTraceId's
 * `f.td || f.fd` "has data" check. */
function stampFd(id: string): void {
  putFrames(id, 1, { fd: { freqs: Float64Array.from([100]), magDb: Float64Array.from([-6]) } });
}

describe("chipSourceTraceId — single-device resolution (unchanged by lot E4)", () => {
  beforeEach(() => clearAllFrames());

  it("an explicit chipSource still a tile member wins outright", () => {
    const s = initialState();
    tile(s).traces = [HW_TRACE_IDS.inputL, HW_TRACE_IDS.inputR];
    tile(s).chipSource = HW_TRACE_IDS.inputR;
    expect(chipSourceTraceId(tile(s))).toBe(HW_TRACE_IDS.inputR);
  });

  it("an explicit chipSource that is NOT a member falls through to auto", () => {
    const s = initialState();
    tile(s).traces = [HW_TRACE_IDS.inputL];
    tile(s).chipSource = HW_TRACE_IDS.outputR; // stale/foreign choice, never added
    expect(chipSourceTraceId(tile(s))).toBe(HW_TRACE_IDS.inputL); // auto's drawn[0] fallback
  });

  it("auto picks the first DRAWN member that actually carries data, in tile.traces order", () => {
    const s = initialState();
    tile(s).traces = [HW_TRACE_IDS.inputL, HW_TRACE_IDS.inputR];
    tile(s).chipSource = "auto";
    stampFd(HW_TRACE_IDS.inputR); // only the SECOND member has data
    expect(chipSourceTraceId(tile(s))).toBe(HW_TRACE_IDS.inputR);
  });

  it("every member legend-hidden (nothing drawn) falls back to tile.traces[0]", () => {
    const s = initialState();
    tile(s).traces = [HW_TRACE_IDS.inputL, HW_TRACE_IDS.inputR];
    tile(s).hidden = [HW_TRACE_IDS.inputL, HW_TRACE_IDS.inputR];
    tile(s).chipSource = "auto";
    stampFd(HW_TRACE_IDS.inputR); // has data, but it's hidden — not "drawn"
    expect(chipSourceTraceId(tile(s))).toBe(HW_TRACE_IDS.inputL); // tile.traces[0], not the one with data
  });

  it("an empty tile resolves to null", () => {
    const s = initialState();
    tile(s).traces = [];
    tile(s).chipSource = "auto";
    expect(chipSourceTraceId(tile(s))).toBeNull();
  });

  it("a memory-only tile resolves through its own (non-hw) member", () => {
    const s = initialState();
    tile(s).traces = ["mem-1"];
    tile(s).chipSource = "auto";
    stampFd("mem-1");
    expect(chipSourceTraceId(tile(s))).toBe("mem-1");
  });
});

describe("chipSourceTraceId — 'auto' never crosses device slots (issue #25 lot E4, E3 review #5)", () => {
  beforeEach(() => clearAllFrames());

  it("tile's FIRST hw member is slot 0 (no frames); a slot-1 member WITH frames is skipped — resolves to the slot-0 fallback, never steals slot 1's data", () => {
    const s = initialState();
    tile(s).traces = [HW_TRACE_IDS.inputL, "hw-in-left@1"];
    tile(s).chipSource = "auto";
    stampFd("hw-in-left@1"); // only the OTHER slot's member has data
    // hw-in-left has none — a pre-E4 selector would fall through to the
    // next drawn candidate with data (hw-in-left@1) and get it wrong.
    expect(chipSourceTraceId(tile(s))).toBe(HW_TRACE_IDS.inputL);
  });

  it("tile's FIRST hw member is slot 1: resolves to the SLOT-1 id, even when a later slot-0 member HAS data (the pin is per-tile slot, not slot 0)", () => {
    const s = initialState();
    tile(s).traces = ["hw-in-left@1", HW_TRACE_IDS.inputL];
    tile(s).chipSource = "auto";
    stampFd(HW_TRACE_IDS.inputL); // slot 0's member has data; slot 1's does not
    // tileSlot is 1 (the FIRST hw member's slot) — hw-in-left@1 has no data
    // (continue), HW_TRACE_IDS.inputL is skipped (wrong slot), loop ends
    // with no match ⇒ fallback is drawn[0] ?? tile.traces[0] = "hw-in-left@1".
    expect(chipSourceTraceId(tile(s))).toBe("hw-in-left@1");
  });

  it("a memory trace on a mixed-slot tile stays eligible — the cross-slot skip only applies to HW candidates", () => {
    const s = initialState();
    tile(s).traces = [HW_TRACE_IDS.inputL, "mem-1"]; // tileSlot = 0 (first hw member)
    tile(s).chipSource = "auto";
    stampFd("mem-1"); // slot-0 member has no data; the memory trace does
    expect(chipSourceTraceId(tile(s))).toBe("mem-1");
  });

  it("a single-slot tile (every hw member the same slot) is byte-identical to the pre-E4 selector — no spurious skip", () => {
    const s = initialState();
    tile(s).traces = [HW_TRACE_IDS.inputL, HW_TRACE_IDS.inputR];
    tile(s).chipSource = "auto";
    stampFd(HW_TRACE_IDS.inputR);
    expect(chipSourceTraceId(tile(s))).toBe(HW_TRACE_IDS.inputR);
  });
});

/**
 * Layout actions — pattern presets, tile identity across switches, drag
 * reorder, focus, membership. (The stream sync side of these actions is
 * covered by buildStreamConfig's budget tests.)
 */
import { describe, expect, it } from "vitest";
import { Store } from "../store";
import { initialState, patternTileCount, HW_TRACE_IDS } from "../state";
import type { AppState } from "../state";
import type { Ipc } from "../../ipc/ipc";
import {
  addTraceToTile,
  moveTile,
  removeTraceFromTile,
  setFocusTile,
  setPattern,
  setTileKind,
  setTileShowTriggerMarkers,
  setTileTriggerPosition,
  setTileTriggerSource,
  toggleTraceHidden,
} from "./layout";
import { shownTraces, visibleTiles } from "../selectors/layout";
import { withRun } from "./sessions.fixtures";

/** An Ipc stub: layout actions only ever fire stream_update (ignored). */
const ipc: Ipc = {
  call: () => Promise.resolve(null as never),
};

function makeStore(): Store<AppState> {
  return new Store(initialState(), { freeze: true });
}

describe("setPattern", () => {
  it("boots on the 2×2 Spectrum|Scope default and creates tiles for bigger patterns", () => {
    const store = makeStore();
    // The out-of-the-box workspace (maintainer default).
    const boot = visibleTiles(store.get());
    expect(boot.map((t) => t.kind)).toEqual(["spectrum", "scope", "spectrum", "scope"]);

    setPattern(store, ipc, "2x3");
    const tiles = visibleTiles(store.get());
    expect(tiles).toHaveLength(6);
    expect(patternTileCount("2x3")).toBe(6);
    expect(tiles[0].id).toBe("tile-1");
    expect(tiles[4].kind).toBe("spectrum"); // new slots get the default tile
  });

  it("keeps hidden tiles' config across pattern round-trips", () => {
    const store = makeStore();
    setPattern(store, ipc, "1x2");
    // Flip tile-2 AWAY from its scope default so the round-trip proves the
    // hidden config survived (not just the default).
    setTileKind(store, ipc, visibleTiles(store.get())[1].id, "spectrum");
    setPattern(store, ipc, "1");
    expect(visibleTiles(store.get())).toHaveLength(1);
    setPattern(store, ipc, "1x2");
    expect(visibleTiles(store.get())[1].kind).toBe("spectrum");
  });

  it("drops a focus the new pattern would hide", () => {
    const store = makeStore();
    setPattern(store, ipc, "1x2");
    const second = visibleTiles(store.get())[1].id;
    setFocusTile(store, second);
    setPattern(store, ipc, "1");
    expect(store.get().layout.focus).toBeNull();
  });
});

describe("moveTile (drag reorder)", () => {
  it("moves a visible tile to the drop position", () => {
    const store = makeStore();
    setPattern(store, ipc, "1x3");
    const [a, b, c] = visibleTiles(store.get()).map((t) => t.id);
    moveTile(store, 0, 2);
    expect(visibleTiles(store.get()).map((t) => t.id)).toEqual([b, c, a]);
  });

  it("ignores out-of-window indices", () => {
    const store = makeStore();
    setPattern(store, ipc, "1x2");
    const before = visibleTiles(store.get()).map((t) => t.id);
    moveTile(store, 0, 5);
    moveTile(store, -1, 0);
    expect(visibleTiles(store.get()).map((t) => t.id)).toEqual(before);
  });
});

describe("membership", () => {
  it("adds and removes traces without duplicating", () => {
    const store = makeStore();
    addTraceToTile(store, ipc, "tile-1", HW_TRACE_IDS.inputR);
    addTraceToTile(store, ipc, "tile-1", HW_TRACE_IDS.inputR);
    expect(store.get().layout.tiles["tile-1"].traces).toEqual([
      HW_TRACE_IDS.inputL,
      HW_TRACE_IDS.inputR,
    ]);
    removeTraceFromTile(store, ipc, "tile-1", HW_TRACE_IDS.inputL);
    expect(store.get().layout.tiles["tile-1"].traces).toEqual([HW_TRACE_IDS.inputR]);
  });
});

describe("legend hidden (v1 toggle)", () => {
  it("toggles drawing without touching membership; removal cleans it", () => {
    const store = makeStore();
    addTraceToTile(store, ipc, "tile-1", HW_TRACE_IDS.inputR);
    toggleTraceHidden(store, ipc, "tile-1", HW_TRACE_IDS.inputR);
    let tile = store.get().layout.tiles["tile-1"];
    expect(tile.traces).toContain(HW_TRACE_IDS.inputR);
    expect(shownTraces(tile)).toEqual([HW_TRACE_IDS.inputL]);

    toggleTraceHidden(store, ipc, "tile-1", HW_TRACE_IDS.inputR);
    tile = store.get().layout.tiles["tile-1"];
    expect(shownTraces(tile)).toEqual([HW_TRACE_IDS.inputL, HW_TRACE_IDS.inputR]);

    toggleTraceHidden(store, ipc, "tile-1", HW_TRACE_IDS.inputR);
    removeTraceFromTile(store, ipc, "tile-1", HW_TRACE_IDS.inputR);
    tile = store.get().layout.tiles["tile-1"];
    expect(tile.hidden).toEqual([]); // no stale hidden entry survives removal
  });

  it("a non-member cannot be hidden", () => {
    const store = makeStore();
    toggleTraceHidden(store, ipc, "tile-1", HW_TRACE_IDS.outputR);
    expect(store.get().layout.tiles["tile-1"].hidden).toEqual([]);
  });
});

describe("setTileKind", () => {
  it("resets the chips to the kind's defaults", () => {
    const store = makeStore();
    expect(store.get().layout.tiles["tile-1"].measures).toEqual(["thd", "peakfreq"]);
    setTileKind(store, ipc, "tile-1", "scope");
    expect(store.get().layout.tiles["tile-1"].measures).toEqual(["rms", "peak"]);
  });
});

describe("tile trigger fields (Lot A, issue #26)", () => {
  it("boot default: 'auto' source, 50% position, markers on", () => {
    const store = makeStore();
    const tile = store.get().layout.tiles["tile-2"]; // the boot scope tile
    expect(tile.triggerSource).toBe("auto");
    expect(tile.triggerPositionPct).toBe(50);
    expect(tile.showTriggerMarkers).toBe(true);
  });

  it("setTileTriggerSource sets the explicit endpoint", () => {
    const store = makeStore();
    setTileTriggerSource(store, ipc, "tile-2", HW_TRACE_IDS.inputR);
    expect(store.get().layout.tiles["tile-2"].triggerSource).toBe(HW_TRACE_IDS.inputR);
    setTileTriggerSource(store, ipc, "tile-2", "auto");
    expect(store.get().layout.tiles["tile-2"].triggerSource).toBe("auto");
  });

  it("setTileTriggerPosition sets the % position", () => {
    const store = makeStore();
    setTileTriggerPosition(store, ipc, "tile-2", 25);
    expect(store.get().layout.tiles["tile-2"].triggerPositionPct).toBe(25);
  });

  it("setTileTriggerPosition ignores non-finite values and clamps to [0,100] (review #1)", () => {
    const store = makeStore();
    setTileTriggerPosition(store, ipc, "tile-2", 40);
    const before = store.get();
    for (const bad of [NaN, Infinity, -Infinity]) {
      setTileTriggerPosition(store, ipc, "tile-2", bad);
    }
    expect(store.get()).toBe(before); // a true no-op, not just an unclamped store
    expect(store.get().layout.tiles["tile-2"].triggerPositionPct).toBe(40);

    setTileTriggerPosition(store, ipc, "tile-2", -10);
    expect(store.get().layout.tiles["tile-2"].triggerPositionPct).toBe(0);
    setTileTriggerPosition(store, ipc, "tile-2", 150);
    expect(store.get().layout.tiles["tile-2"].triggerPositionPct).toBe(100);
  });

  it("setTileTriggerPosition opts.sync = false skips the stream sync (review #10)", () => {
    const store = makeStore();
    store.update("test/stream-on", (s) => withRun(s, { streaming: true }));
    const calls: unknown[] = [];
    const syncingIpc: Ipc = {
      call: (method: string, args?: unknown) => {
        calls.push([method, args]);
        return Promise.resolve(null as never);
      },
    };
    setTileTriggerPosition(store, syncingIpc, "tile-2", 33, { sync: false });
    expect(store.get().layout.tiles["tile-2"].triggerPositionPct).toBe(33);
    expect(calls).toHaveLength(0);
    setTileTriggerPosition(store, syncingIpc, "tile-2", 34, { sync: true });
    expect(calls).toHaveLength(1);
  });

  it("setTileShowTriggerMarkers toggles the marker display, no stream sync", () => {
    const store = makeStore();
    setTileShowTriggerMarkers(store, "tile-2", false);
    expect(store.get().layout.tiles["tile-2"].showTriggerMarkers).toBe(false);
    setTileShowTriggerMarkers(store, "tile-2", true);
    expect(store.get().layout.tiles["tile-2"].showTriggerMarkers).toBe(true);
  });

  it("a non-existent tile id is a no-op", () => {
    const store = makeStore();
    const before = store.get();
    setTileTriggerSource(store, ipc, "tile-nope", HW_TRACE_IDS.inputL);
    setTileTriggerPosition(store, ipc, "tile-nope", 10);
    setTileShowTriggerMarkers(store, "tile-nope", false);
    expect(store.get().layout.tiles).toBe(before.layout.tiles);
  });
});

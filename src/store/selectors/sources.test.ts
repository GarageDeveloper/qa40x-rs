/**
 * Source-routing selectors (issue #25 lot F2): the device × channel matrix
 * resolved against the live bench — who plays where, coalesced per session.
 * The mixer-slot half of the story is pinned in actions/stream.test.ts
 * ("buildStreamConfig — the device × channel matrix").
 */
import { describe, expect, it } from "vitest";
import type { AppState, SourceMeta, SourceTarget } from "../state";
import { initialSession, initialState, SLOT0 } from "../state";
import { sessionHasSources, sessionsForSource, sourcesForSession, targetSessionKey } from "./sources";

function sine(id: string, over: Partial<SourceMeta> = {}): SourceMeta {
  return {
    id,
    label: id,
    kind: "sine",
    frequencyHz: 1000,
    levelDbv: -12,
    extraTones: [],
    route: "left",
    targets: [],
    playing: true,
    ...over,
  } as SourceMeta;
}

function bench(sources: SourceMeta[], slots: number[] = [0]): AppState {
  const s = initialState();
  for (const slot of slots) {
    if (slot === 0) continue;
    s.devices.sessions = {
      ...s.devices.sessions,
      [`slot-${slot}`]: initialSession(slot),
    };
  }
  s.sources = {
    order: sources.map((x) => x.id),
    byId: Object.fromEntries(sources.map((x) => [x.id, x])),
  };
  return s;
}

describe("targetSessionKey", () => {
  it("slot null resolves to the FOCUSED session, a number to its own slot key", () => {
    const s = bench([]);
    expect(targetSessionKey(s, { slot: null, route: "left" })).toBe(SLOT0);
    expect(targetSessionKey(s, { slot: 3, route: "left" })).toBe("slot-3");
  });
});

describe("sourcesForSession", () => {
  it("default targets resolve onto the focused session only — pool order, own route, playing filter", () => {
    const s = bench(
      [sine("a"), sine("b", { route: "both" }), sine("paused", { playing: false })],
      [0, 1]
    );
    expect(sourcesForSession(s, SLOT0).map((r) => [r.src.id, r.route])).toEqual([
      ["a", "left"],
      ["b", "both"],
    ]);
    expect(sourcesForSession(s, "slot-1")).toEqual([]);
  });

  it("a pinned target is focus-independent", () => {
    const targets: SourceTarget[] = [{ slot: 1, route: "right" }];
    const s = bench([sine("a", { targets })], [0, 1]);
    expect(sourcesForSession(s, SLOT0)).toEqual([]);
    expect(sourcesForSession(s, "slot-1").map((r) => [r.src.id, r.route])).toEqual([
      ["a", "right"],
    ]);
    // Move the focus onto slot 1: the pinned resolution is unchanged, and
    // nothing appears on the now-unfocused slot 0.
    const moved = { ...s, devices: { ...s.devices, focus: "slot-1" } };
    expect(sourcesForSession(moved, "slot-1").map((r) => r.src.id)).toEqual(["a"]);
    expect(sourcesForSession(moved, SLOT0)).toEqual([]);
  });

  it("duplicate resolution coalesces into ONE entry with the union route (the +6 dB mixer-sum pin)", () => {
    const s = bench([
      sine("a", {
        targets: [
          { slot: null, route: "left" },
          { slot: 0, route: "right" },
        ],
      }),
    ]);
    expect(sourcesForSession(s, SLOT0)).toHaveLength(1);
    expect(sourcesForSession(s, SLOT0)[0].route).toBe("both");
  });

  it("a dormant-slot target resolves nowhere — no throw, no phantom", () => {
    const s = bench([sine("a", { targets: [{ slot: 5, route: "both" }] })]);
    expect(sourcesForSession(s, SLOT0)).toEqual([]);
  });
});

describe("sessionHasSources", () => {
  it("counts route:'off' targets — an Off slot is a silent DAC program, not an absent one", () => {
    const s = bench([sine("a", { route: "off" })]);
    expect(sessionHasSources(s, SLOT0)).toBe(true);
  });

  it("false with nothing playing, or nothing routed here", () => {
    const s = bench([sine("a", { playing: false })], [0, 1]);
    expect(sessionHasSources(s, SLOT0)).toBe(false);
    const t = bench([sine("a")], [0, 1]);
    expect(sessionHasSources(t, "slot-1")).toBe(false);
  });
});

describe("sessionsForSource", () => {
  it("returns LIVE target sessions only, deduped — dormant slots drop out", () => {
    const s = bench(
      [
        sine("a", {
          targets: [
            { slot: null, route: "left" }, // focus = slot-0
            { slot: 0, route: "right" }, // same session, deduped
            { slot: 1, route: "both" }, // live
            { slot: 5, route: "both" }, // dormant: dropped
          ],
        }),
      ],
      [0, 1]
    );
    expect(sessionsForSource(s, "a")).toEqual([SLOT0, "slot-1"]);
    expect(sessionsForSource(s, "nope")).toEqual([]);
  });

  it("includes a PAUSED source's targets — play/pause fan-out needs where it WOULD play", () => {
    const s = bench([sine("a", { playing: false })]);
    expect(sessionsForSource(s, "a")).toEqual([SLOT0]);
  });
});

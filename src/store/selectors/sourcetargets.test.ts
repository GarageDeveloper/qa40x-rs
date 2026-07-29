/**
 * Per-target routing view-model (issue #25 lot F3) — what the sources-panel
 * row editor renders. The load-bearing pins: readouts snap on the TARGET
 * session's rate (#14 class), a dormant target never prints a confident
 * grid value (the deviceForTrace lesson in frequency form), errors are
 * attributed to THEIR session, and the coalescing tell shows on both rows.
 */
import { describe, expect, it } from "vitest";
import type { DeviceConfig } from "../../gen";
import type { AppState, SourceMeta, SourceTarget } from "../state";
import { initialSession, initialState } from "../state";
import { withDevice, withRun } from "../actions/sessions.fixtures";
import {
  hasLiveTarget,
  routingSummary,
  rowErrorText,
  snappedReadout,
  sourceRowMode,
  sourceTargetVMs,
  tagOfSlot,
} from "./sourcetargets";

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

function config(sampleRate: number): DeviceConfig {
  return { input_gain: 0, output_gain: 18, sample_rate: sampleRate };
}

/** A bench with the given sources; slot 0 connected at 48 kHz. Extra slots
 * are minted connected + adopted (routable) at their given rate. */
function bench(
  sources: SourceMeta[],
  extra: Array<{ slot: number; rate: number }> = []
): AppState {
  let s = initialState();
  s.sources = {
    order: sources.map((x) => x.id),
    byId: Object.fromEntries(sources.map((x) => [x.id, x])),
  };
  s = withDevice(s, { status: "connected", config: config(48000) });
  for (const { slot, rate } of extra) {
    const key = `slot-${slot}`;
    s = {
      ...s,
      devices: {
        ...s.devices,
        sessions: {
          ...s.devices.sessions,
          [key]: { ...initialSession(slot), deviceId: `usb/UNIT-${slot}` },
        },
      },
    };
    s = withDevice(s, { status: "connected", config: config(rate) }, key);
  }
  return s;
}

describe("tagOfSlot", () => {
  it("maps the focus pseudo-target and slots to their testid tags", () => {
    expect(tagOfSlot(null)).toBe("focus");
    expect(tagOfSlot(0)).toBe("0");
    expect(tagOfSlot(3)).toBe("3");
  });
});

describe("sourceTargetVMs — row list and per-target state", () => {
  it("orders rows focus first, live sessions by slot, then dormant matrix slots", () => {
    const s = bench(
      [sine("a", { targets: [{ slot: 5, route: "both" }] })],
      [{ slot: 1, rate: 48000 }]
    );
    expect(sourceTargetVMs(s, "a").map((v) => v.tag)).toEqual(["focus", "0", "1", "5"]);
  });

  it("an unknown source id yields no rows", () => {
    expect(sourceTargetVMs(bench([]), "nope")).toEqual([]);
  });

  it("the implicit focus-following matrix checks the focus row with the legacy route", () => {
    const s = bench([sine("a", { route: "both" })]);
    const [focus, slot0] = sourceTargetVMs(s, "a");
    expect(focus.present).toBe(true);
    expect(focus.left).toBe(true);
    expect(focus.right).toBe(true);
    // The explicit slot-0 row carries NO cell: only the pseudo-target does.
    expect(slot0.present).toBe(false);
    expect(slot0.left).toBe(false);
  });

  it("a dormant target has playedHz null and says 'not connected' — never the 48 kHz fallback", () => {
    const s = bench([sine("a", { targets: [{ slot: 2, route: "left" }] })]);
    const dormant = sourceTargetVMs(s, "a").find((v) => v.tag === "2")!;
    expect(dormant.status).toBe("absent");
    expect(dormant.live).toBe(false);
    expect(dormant.playedHz).toBeNull();
    expect(dormant.note).toBe("not connected");
    expect(dormant.label).toBe("#3 — not connected");
  });

  it("readouts snap on the TARGET session's rate — two rates, two values (#14 class)", () => {
    const targets: SourceTarget[] = [
      { slot: null, route: "left" },
      { slot: 1, route: "right" },
    ];
    const s = bench([sine("a", { targets })], [{ slot: 1, rate: 192000 }]);
    const vms = sourceTargetVMs(s, "a");
    const focus = vms.find((v) => v.tag === "focus")!;
    const slot1 = vms.find((v) => v.tag === "1")!;
    expect(focus.playedHz).toBeCloseTo(1000.48828125, 9);
    expect(slot1.playedHz).toBeCloseTo(1001.953125, 9);
    expect(focus.playedHz).not.toBe(slot1.playedHz);
  });

  it("an unadopted live slot ≥ 1 reads 'device id not adopted yet'", () => {
    let s = bench([sine("a", { targets: [{ slot: 1, route: "left" }] })], [
      { slot: 1, rate: 48000 },
    ]);
    s = {
      ...s,
      devices: {
        ...s.devices,
        sessions: {
          ...s.devices.sessions,
          "slot-1": { ...s.devices.sessions["slot-1"], deviceId: null },
        },
      },
    };
    const slot1 = sourceTargetVMs(s, "a").find((v) => v.tag === "1")!;
    expect(slot1.routable).toBe(false);
    expect(slot1.note).toBe("device id not adopted yet");
  });

  it("errors come from the TARGET's own session, never the focused one", () => {
    const targets: SourceTarget[] = [
      { slot: null, route: "left" },
      { slot: 1, route: "right" },
    ];
    let s = bench([sine("a", { targets })], [{ slot: 1, rate: 48000 }]);
    s = withRun(s, { slotErrors: [{ id: "a", error: "bad script" }] }, "slot-1");
    const vms = sourceTargetVMs(s, "a");
    expect(vms.find((v) => v.tag === "focus")!.error).toBeNull();
    const slot1 = vms.find((v) => v.tag === "1")!;
    expect(slot1.error).toBe("bad script");
    expect(slot1.note).toBe("bad script");
    expect(slot1.noteErr).toBe(true);
  });

  it("a focus cell plus an explicit cell for the focused slot flags BOTH rows as combined", () => {
    const targets: SourceTarget[] = [
      { slot: null, route: "left" },
      { slot: 0, route: "right" },
    ];
    const s = bench([sine("a", { targets })]);
    const vms = sourceTargetVMs(s, "a");
    const focus = vms.find((v) => v.tag === "focus")!;
    const slot0 = vms.find((v) => v.tag === "0")!;
    expect(focus.sameAsFocus).toBe(true);
    expect(slot0.sameAsFocus).toBe(true);
    expect(focus.note).toMatch(/channels are combined/);
    expect(slot0.note).toMatch(/channels are combined/);
    // An explicit cell for a NON-focused slot is not combined.
    const t = bench(
      [sine("b", { targets: [{ slot: null, route: "left" }, { slot: 1, route: "right" }] })],
      [{ slot: 1, rate: 48000 }]
    );
    for (const v of sourceTargetVMs(t, "b")) expect(v.sameAsFocus).toBe(false);
  });

  it("an off cell on a connected target reads 'off (no channel)'", () => {
    const s = bench([sine("a", { targets: [{ slot: 0, route: "off" }] })]);
    const slot0 = sourceTargetVMs(s, "a").find((v) => v.tag === "0")!;
    expect(slot0.present).toBe(true);
    expect(slot0.left).toBe(false);
    expect(slot0.right).toBe(false);
    expect(slot0.note).toBe("off (no channel)");
  });
});

describe("routingSummary", () => {
  it("reads focus first then slots ascending, glyphs per route, ⚠ on a dead target", () => {
    const s = bench(
      [
        sine("a", {
          targets: [
            { slot: 5, route: "left" },
            { slot: null, route: "both" },
            { slot: 1, route: "right" },
          ],
        }),
      ],
      [{ slot: 1, rate: 48000 }]
    );
    const { text, title } = routingSummary(sourceTargetVMs(s, "a"));
    expect(text).toBe("→ focus LR · #2 R · #6 L ⚠");
    expect(title).toMatch(/#6: not connected — nothing plays there/);
    expect(title).toMatch(/Click to edit where this source plays\./);
  });

  it("an off-routed focus cell still summarizes (– glyph), an empty matrix cannot occur", () => {
    const s = bench([sine("a", { route: "off" })]);
    expect(routingSummary(sourceTargetVMs(s, "a")).text).toBe("→ focus –");
  });
});

describe("snappedReadout", () => {
  it("one shared grid value keeps the byte-identical legacy wording", () => {
    const s = bench([sine("a")]);
    const r = snappedReadout(sourceTargetVMs(s, "a"), 1000);
    expect(r.text).toBe("→ 1000.4883 Hz");
    expect(r.title).toMatch(/rounded onto the FFT bin/);
  });

  it("two live targets at different rates read '→ 2 values' with the per-device title", () => {
    const s = bench(
      [
        sine("a", {
          targets: [
            { slot: null, route: "left" },
            { slot: 1, route: "right" },
          ],
        }),
      ],
      [{ slot: 1, rate: 192000 }]
    );
    const r = snappedReadout(sourceTargetVMs(s, "a"), 1000);
    expect(r.text).toBe("→ 2 values");
    expect(r.title).toMatch(/#1 1000\.4883 Hz · #2 1001\.9531 Hz/);
  });

  it("no live target is an honest — (never a substituted grid)", () => {
    const s = bench([sine("a", { targets: [{ slot: 4, route: "both" }] })]);
    const r = snappedReadout(sourceTargetVMs(s, "a"), 1000);
    expect(r.text).toBe("→ —");
    expect(r.title).toBe("Not routed to any connected device");
  });
});

describe("sourceRowMode", () => {
  it("legacy exactly at one live session with an empty matrix", () => {
    const one = bench([sine("a")]);
    expect(sourceRowMode(one, one.sources.byId["a"])).toBe("legacy");
  });

  it("matrix at ≥ 2 live sessions, or whenever the matrix is explicit", () => {
    const two = bench([sine("a")], [{ slot: 1, rate: 48000 }]);
    expect(sourceRowMode(two, two.sources.byId["a"])).toBe("matrix");
    const pinned = bench([sine("a", { targets: [{ slot: 0, route: "left" }] })]);
    expect(sourceRowMode(pinned, pinned.sources.byId["a"])).toBe("matrix");
  });
});

describe("hasLiveTarget", () => {
  it("true for a connected target — an off cell counts (silent DAC program)", () => {
    const s = bench([sine("a", { targets: [{ slot: 0, route: "off" }] })]);
    expect(hasLiveTarget(sourceTargetVMs(s, "a"))).toBe(true);
  });

  it("false when every cell points at something dead", () => {
    const s = bench([sine("a", { targets: [{ slot: 3, route: "both" }] })]);
    expect(hasLiveTarget(sourceTargetVMs(s, "a"))).toBe(false);
    const disc = withDevice(bench([sine("b")]), { status: "disconnected" });
    expect(hasLiveTarget(sourceTargetVMs(disc, "b"))).toBe(false);
  });
});

describe("rowErrorText", () => {
  it("bare at one session (the pre-F3 byte-identical badge), #n-prefixed at ≥ 2", () => {
    let s = bench([sine("a")]);
    s = withRun(s, { slotErrors: [{ id: "a", error: "unknown waveform" }] });
    const vms = sourceTargetVMs(s, "a");
    expect(rowErrorText(vms, false)).toBe("unknown waveform");
    expect(rowErrorText(vms, true)).toBe("#1: unknown waveform");
    expect(rowErrorText(sourceTargetVMs(bench([sine("b")]), "b"), false)).toBeNull();
  });
});

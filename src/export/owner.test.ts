/**
 * Per-device export headers (issue #25 lot F5): the bench block describes
 * the device OWNING the exported data — the fix for "slot-0 export under a
 * slot-1 focus" stamping the wrong model/serial/ranges/OFFSETS (the
 * four-offsets bug class in header form) — plus the owner-keyed emit gate
 * and the tile anchor's owner selection.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { DeviceMeta } from "../gen";
import {
  DEFAULT_SWEEP_PARAMS,
  defaultTile,
  HW_TRACE_IDS,
  hwTraceIds,
  initialState,
  sessionKeyForSlot,
  type AppState,
  type CaptureProvenance,
  type TileConfig,
} from "../store/state";
import { mintSession } from "../store/actions/devices";
import { reconcileHwTraces } from "../store/actions/traces";
import { withDevice } from "../store/actions/sessions.fixtures";
import { exportOwnerDevice, traceExportOwner } from "../store/selectors/provenance";
import { clearAllFrames, putFrames } from "../data/frames";
import { provenanceComments, traceProvenance } from "./csv";
import { tileAnchor, tileImageText, tileProvenanceContext } from "./export";

const SLOT1 = sessionKeyForSlot(1);

function info(model: string, serial: string): DeviceMeta {
  return {
    model,
    firmware_version: 61,
    serial,
    product: `${model} Audio Analyzer`,
    sample_rates: [48000],
    supports_flash: false,
    capabilities: {} as never,
    is_virtual: false,
  };
}

/** Capture snapshot MATCHING the given session's live bench below. */
function captureFor(which: "A" | "B"): CaptureProvenance {
  return which === "A"
    ? {
        device: { model: "QA403", serial: "A_SER", firmware: 61, isVirtual: false },
        sampleRateHz: 48000,
        inputRangeDbv: 42,
        outputRangeDbv: 18,
        offsets: { input_l: 10, input_r: 11, output_l: 12, output_r: 13, calibrated: true },
        fftSize: 4096,
        window: "hann",
        averaging: { mode: "off", count: 1 },
        capturedAt: null,
      }
    : {
        device: { model: "QA402", serial: "B_SER", firmware: 61, isVirtual: false },
        sampleRateHz: 192000,
        inputRangeDbv: 6,
        outputRangeDbv: 8,
        offsets: { input_l: 20, input_r: 21, output_l: 22, output_r: 23, calibrated: true },
        fftSize: 4096,
        window: "hann",
        averaging: { mode: "off", count: 1 },
        capturedAt: null,
      };
}

/** Slot 0 = QA403 A_SER at 48 k, slot 1 = QA402 B_SER at 192 k; both live.
 * Acquisition matches the captures (fft 4096 / hann / avg off) so a trace
 * matching its OWN bench has nothing to say. */
function twoDeviceState(): AppState {
  let s = initialState();
  s = {
    ...s,
    acquisition: { ...s.acquisition, fftSize: 4096, window: "hann" },
  };
  s = withDevice(s, {
    status: "connected",
    info: info("QA403", "A_SER"),
    config: { input_gain: 42, output_gain: 18, sample_rate: 48000 },
    offsets: { input_l: 10, input_r: 11, output_l: 12, output_r: 13, calibrated: true },
  });
  s = mintSession(s, 1, "usb/B_SER");
  s = reconcileHwTraces(s);
  s = withDevice(
    s,
    {
      status: "connected",
      info: info("QA402", "B_SER"),
      config: { input_gain: 6, output_gain: 8, sample_rate: 192000 },
      offsets: { input_l: 20, input_r: 21, output_l: 22, output_r: 23, calibrated: true },
    },
    SLOT1
  );
  return s;
}

const focusOn = (s: AppState, key: string): AppState => ({
  ...s,
  devices: { ...s.devices, focus: key },
});

function withCapture(s: AppState, id: string, c: CaptureProvenance | null): AppState {
  const t = s.traces.byId[id];
  return {
    ...s,
    traces: { ...s.traces, byId: { ...s.traces.byId, [id]: { ...t, capture: c } } },
  };
}

/** The full header lines for one trace export, owner resolved like
 * exportTraceCsv does. */
function headerFor(s: AppState, id: string): string[] {
  const owner = exportOwnerDevice(s, traceExportOwner(s, id));
  return provenanceComments(
    traceProvenance(s, s.traces.byId[id]?.capture ?? null, "0.0.0-test", "2026-07-31T00:00:00.000Z", owner)
  );
}

describe("per-device bench header (lot F5)", () => {
  it("slot-0 export under a slot-1 FOCUS carries slot 0's identity and offsets", () => {
    let s = focusOn(twoDeviceState(), SLOT1);
    s = withCapture(s, "hw-in-left", captureFor("A"));
    const lines = headerFor(s, "hw-in-left");
    expect(lines).toContain("# device_serial=A_SER");
    expect(lines).toContain("# sample_rate_hz=48000");
    expect(lines).toContain("# input_range_dbv=42");
    expect(lines).toContain("# offset_input_l_db=10");
    // And nothing of the focused slot-1 converter leaks in.
    expect(lines.some((l) => l.includes("B_SER") || l.includes("192000"))).toBe(false);
  });

  it("slot-1 export under a slot-0 focus carries slot 1's identity and offsets (mirror)", () => {
    let s = twoDeviceState();
    s = withCapture(s, hwTraceIds(1).inputL, captureFor("B"));
    const lines = headerFor(s, hwTraceIds(1).inputL);
    expect(lines).toContain("# device_serial=B_SER");
    expect(lines).toContain("# sample_rate_hz=192000");
    expect(lines).toContain("# offset_input_l_db=20");
    expect(lines.some((l) => l.includes("A_SER") || l.includes("=48000"))).toBe(false);
  });

  it("dormant owner: device_model=none, no rates/ranges/offsets — the capture_* block carries the identity", () => {
    let s = withCapture(twoDeviceState(), hwTraceIds(1).inputL, captureFor("B"));
    const sessions = { ...s.devices.sessions };
    delete sessions[SLOT1];
    s = { ...s, devices: { ...s.devices, sessions } };
    const lines = headerFor(s, hwTraceIds(1).inputL);
    expect(lines).toContain("# device_model=none");
    // No claims at all about a converter nobody can see — including the
    // calibration line ("false" would assert an uncalibrated device that
    // does not exist; the capture_calibrated rule).
    for (const gone of [
      "# device_serial",
      "# sample_rate_hz",
      "# input_range_dbv",
      "# offset_input_l_db",
      "# calibrated",
    ]) {
      expect(lines.some((l) => l.startsWith(gone))).toBe(false);
    }
    expect(lines).toContain("# capture_device_serial=B_SER");
    expect(lines).toContain("# capture_sample_rate_hz=192000");
    expect(lines).toContain("# capture_offset_input_l_db=20");
    // The note explains device_model=none exactly when it appears…
    expect(
      lines.some((l) => l.startsWith("# note=") && l.includes("no longer on the bench"))
    ).toBe(true);
  });

  it("a live owner's capture_* note does NOT carry the device_model=none clause", () => {
    let s = twoDeviceState();
    s = withCapture(s, hwTraceIds(1).inputL, {
      ...captureFor("B"),
      capturedAt: "2026-07-30T00:00:00.000Z", // pinned instant → block emits
    });
    const lines = headerFor(s, hwTraceIds(1).inputL);
    expect(lines.some((l) => l.startsWith("# capture_"))).toBe(true);
    expect(lines.some((l) => l.includes("no longer on the bench"))).toBe(false);
  });

  it("a foreign-stamped trace on a SINGLE-device bench: the local converter is never substituted (deliberate post-F5 change)", () => {
    // A colleague's workspace: hw-in-left captured on a bench this one has
    // never seen. Pre-F5 the header stamped the LOCAL device's serial and
    // offsets above that data; the slot is treated as recycled now.
    let s = initialState();
    s = withDevice(s, {
      status: "connected",
      info: info("QA403", "LOCAL"),
      config: { input_gain: 42, output_gain: 18, sample_rate: 48000 },
      offsets: { input_l: 1, input_r: 2, output_l: 3, output_r: 4, calibrated: true },
    });
    const t = s.traces.byId["hw-in-left"];
    s = {
      ...s,
      traces: {
        ...s.traces,
        byId: { ...s.traces.byId, "hw-in-left": { ...t, capture: captureFor("B") } },
      },
    };
    const lines = headerFor(s, "hw-in-left");
    expect(lines).toContain("# device_model=none");
    expect(lines.some((l) => l.includes("LOCAL"))).toBe(false);
    expect(lines).toContain("# capture_device_serial=B_SER");
  });

  it("two live TWINS (same model+serial) make identity revival ambiguous — dormant, never lowest-slot-wins", () => {
    // Two virtual units launched independently can both present the same
    // pinned serial; a frozen copy whose origin is gone must not borrow
    // twin #1's converter for twin #2's data.
    let s = twoDeviceState();
    s = withDevice(s, { info: info("QA403", "A_SER") }, SLOT1); // twin of slot 0
    const mem: (typeof s.traces.byId)[string] = {
      id: "mem-1",
      label: "mem-1",
      color: "#fff",
      source: { kind: "memory", frozenFrom: "gone" },
      domains: ["fd"],
      seq: 1,
      offsetDb: null,
      capture: captureFor("A"),
    };
    s = {
      ...s,
      traces: { order: [...s.traces.order, "mem-1"], byId: { ...s.traces.byId, "mem-1": mem } },
    };
    const lines = headerFor(s, "mem-1");
    expect(lines).toContain("# device_model=none");
    expect(lines.some((l) => l.startsWith("# offset_input_l_db"))).toBe(false);
  });

  it("the emit gate keys on the OWNER's bench: a slot-1 trace matching ITS bench adds no capture_* under a differing slot-0 focus", () => {
    let s = twoDeviceState(); // focus = slot 0, whose bench differs from B's
    s = withCapture(s, hwTraceIds(1).inputL, captureFor("B"));
    const lines = headerFor(s, hwTraceIds(1).inputL);
    expect(lines.some((l) => l.startsWith("# capture_"))).toBe(false);
  });

  it("the gate never COINCIDENCE-matches the focused bench: a moved slot-1 capture emits even if it equals slot 0's bench", () => {
    let s = twoDeviceState();
    // Pre-F5 the gate compared against the FOCUSED bench — a slot-1 capture
    // could coincidence-match it and lose the only honest identity in the
    // file. Pin the owner-keyed gate through a moved slot-1 bench: same
    // unit, different range at capture time.
    s = withCapture(s, hwTraceIds(1).inputL, {
      ...captureFor("B"),
      inputRangeDbv: 0, // the bench has moved since capture
    });
    const lines = headerFor(s, hwTraceIds(1).inputL);
    expect(lines).toContain("# capture_input_range_dbv=0");
    expect(lines).toContain("# device_serial=B_SER"); // owner's live bench, unprefixed
  });
});

describe("tileAnchor (lot F5)", () => {
  beforeEach(() => clearAllFrames());

  function stateWithData(caps: Partial<Record<string, CaptureProvenance | null>>): AppState {
    const s = initialState();
    for (const id of [HW_TRACE_IDS.inputL, HW_TRACE_IDS.inputR]) {
      putFrames(id, 1, {
        fd: { freqs: Float64Array.from([100]), magDb: Float64Array.from([-6]) },
      });
      s.traces.byId[id] = { ...s.traces.byId[id], seq: 1, domains: ["fd"], capture: caps[id] ?? null };
    }
    return s;
  }

  function tile(over: Partial<TileConfig> = {}): TileConfig {
    return { ...defaultTile("t", "spectrum", [HW_TRACE_IDS.inputL, HW_TRACE_IDS.inputR]), ...over };
  }

  it("anchors on the chip source when drawn with a capture — capture and owner agree", () => {
    const s = stateWithData({
      [HW_TRACE_IDS.inputL]: captureFor("A"),
      [HW_TRACE_IDS.inputR]: captureFor("B"),
    });
    const a = tileAnchor(s, tile({ chipSource: HW_TRACE_IDS.inputR }));
    expect(a.id).toBe(HW_TRACE_IDS.inputR);
    expect(a.capture?.device?.serial).toBe("B_SER");
    expect(a.mixed).toBe(true);
  });

  it("a hidden chip source anchors on the first drawn member WITH a capture", () => {
    // chipSource = inputR (hidden, stamped B): its bench must not sign the
    // file (the #40 review-finding-#2 rule) — the drawn, stamped inputL
    // names BOTH blocks.
    const s = stateWithData({
      [HW_TRACE_IDS.inputL]: captureFor("A"),
      [HW_TRACE_IDS.inputR]: captureFor("B"),
    });
    const a = tileAnchor(
      s,
      tile({ chipSource: HW_TRACE_IDS.inputR, hidden: [HW_TRACE_IDS.inputR] })
    );
    expect(a.id).toBe(HW_TRACE_IDS.inputL);
    expect(a.capture?.device?.serial).toBe("A_SER");
  });

  it("a hidden chip source with NOTHING drawn stamped: capture null, owner still the first drawn member", () => {
    const s = stateWithData({ [HW_TRACE_IDS.inputR]: captureFor("A") });
    const a = tileAnchor(
      s,
      tile({ chipSource: HW_TRACE_IDS.inputR, hidden: [HW_TRACE_IDS.inputR] })
    );
    expect(a.capture).toBeNull();
    expect(a.id).toBe(HW_TRACE_IDS.inputL);
  });

  it("no member stamped: the anchor still names a drawn member so the owner resolves structurally", () => {
    const s = stateWithData({});
    const a = tileAnchor(s, tile());
    expect(a.capture).toBeNull();
    expect(a.id).toBe(HW_TRACE_IDS.inputL);
    expect(a.mixed).toBe(false);
  });
});

describe("tile owner wiring (lot F5 review round)", () => {
  beforeEach(() => clearAllFrames());

  /** Two-device state with slot-1's Input L carrying fd data. */
  function slot1DataState(cap: CaptureProvenance | null): AppState {
    let s = twoDeviceState();
    const id = hwTraceIds(1).inputL;
    putFrames(id, 1, {
      fd: { freqs: Float64Array.from([100]), magDb: Float64Array.from([-6]) },
    });
    const t = s.traces.byId[id];
    s = {
      ...s,
      traces: {
        ...s.traces,
        byId: { ...s.traces.byId, [id]: { ...t, seq: 1, domains: ["fd"], capture: cap } },
      },
    };
    return s;
  }

  function slot1Tile(over: Partial<TileConfig> = {}): TileConfig {
    return { ...defaultTile("tile-1", "spectrum", [hwTraceIds(1).inputL]), ...over };
  }

  it("tileProvenanceContext: the anchor's OWNER is the non-focused device, not the focus", () => {
    const s = slot1DataState(captureFor("B")); // focus = slot 0
    const ctx = tileProvenanceContext(s, slot1Tile());
    expect(ctx.owner?.info?.serial).toBe("B_SER");
    expect(ctx.capture?.device?.serial).toBe("B_SER");
  });

  it("tileProvenanceContext: a held trigger snapshot's owner is the TRIGGER SOURCE's device", () => {
    const s = slot1DataState(null);
    const held = { ...captureFor("B"), capturedAt: "2026-07-30T00:00:00.000Z" };
    const ctx = tileProvenanceContext(
      s,
      slot1Tile({ kind: "scope", triggerSource: hwTraceIds(1).inputL }),
      held
    );
    expect(ctx.capture).toBe(held);
    expect(ctx.owner?.info?.serial).toBe("B_SER");
  });

  it("tileImageText: the footer's no-capture device and rate are the OWNER's, not the focused session's", () => {
    let s = slot1DataState(null);
    s = { ...s, layout: { ...s.layout, tiles: { ...s.layout.tiles, "tile-1": slot1Tile() } } };
    const { footer } = tileImageText(s, "tile-1");
    expect(footer[0]).toContain("B_SER");
    expect(footer[0]).toContain("192000 Hz");
    expect(footer[0].includes("A_SER")).toBe(false);
  });

  it("tileImageText: a capture WITHOUT a rate (sweep results) falls back to the OWNER's rate — the pre-F5 focused-rate lie", () => {
    let s = slot1DataState({ ...captureFor("B"), sampleRateHz: null });
    s = { ...s, layout: { ...s.layout, tiles: { ...s.layout.tiles, "tile-1": slot1Tile() } } };
    const { footer } = tileImageText(s, "tile-1");
    expect(footer[0]).toContain("192000 Hz"); // slot 1's rate, focus is slot 0 at 48k
  });

  it("tileImageText: a dormant owner with no capture reads 'no device'", () => {
    let s = slot1DataState(null);
    const sessions = { ...s.devices.sessions };
    delete sessions[SLOT1];
    s = { ...s, devices: { ...s.devices, sessions } };
    s = { ...s, layout: { ...s.layout, tiles: { ...s.layout.tiles, "tile-1": slot1Tile() } } };
    const { footer } = tileImageText(s, "tile-1");
    expect(footer[0]).toContain("no device");
  });
});

/**
 * A program bound to a device by `runKey` (mid-run — F4) or `deviceSlot`
 * (idle pin), drawn in a tile while the FOCUS sits elsewhere: the tile-level
 * wiring (tileProvenanceContext / tileImageText) must follow the same
 * structural binding traceExportOwner already proves at the selector level
 * — nothing in the tile-anchor/roll-call layer re-derives ownership from
 * the focus instead.
 */
describe("tile export: a program bound to a non-focused device (lot F5)", () => {
  beforeEach(() => clearAllFrames());

  /** Program `p1`'s result trace carries fd data; `binding` is either a
   * live runKey (mid-run, no landing-stamp capture yet) or an idle
   * deviceSlot pin — both structural, neither reads the focus. */
  function stateWithProgram(binding: { runKey?: string; deviceSlot?: number }): AppState {
    let s = twoDeviceState(); // focus stays slot 0 (the default)
    putFrames("p1", 1, {
      fd: { freqs: Float64Array.from([100]), magDb: Float64Array.from([-6]) },
    });
    s = {
      ...s,
      traces: {
        order: [...s.traces.order, "p1"],
        byId: {
          ...s.traces.byId,
          p1: {
            id: "p1",
            label: "Sweep 1",
            color: "#fff",
            source: { kind: "program" },
            domains: ["fd"],
            seq: 1,
            offsetDb: null,
            capture: null,
          },
        },
      },
      programs: {
        order: ["p1"],
        byId: {
          p1: {
            id: "p1",
            kind: "sweep",
            run: binding.runKey ? "running" : "idle",
            progress: binding.runKey ? "1/2" : null,
            startedAtMs: binding.runKey ? 1000 : null,
            deviceSlot: binding.deviceSlot ?? null,
            runKey: binding.runKey ?? null,
            params: DEFAULT_SWEEP_PARAMS,
          },
        },
      },
    };
    return s;
  }

  function programTile(): TileConfig {
    return defaultTile("tile-p", "sweep", ["p1"]);
  }

  it("tileProvenanceContext: a RUNNING program (runKey) anchors on its bound device, not the focus", () => {
    const s = stateWithProgram({ runKey: SLOT1 });
    const ctx = tileProvenanceContext(s, programTile());
    expect(ctx.owner?.info?.serial).toBe("B_SER");
  });

  it("tileProvenanceContext: an IDLE pinned program (deviceSlot) anchors on its pin, not the focus", () => {
    const s = stateWithProgram({ deviceSlot: 1 });
    const ctx = tileProvenanceContext(s, programTile());
    expect(ctx.owner?.info?.serial).toBe("B_SER");
  });

  it("tileImageText: a running program's footer names its bound device while the focus sits on slot 0", () => {
    let s = stateWithProgram({ runKey: SLOT1 });
    s = { ...s, layout: { ...s.layout, tiles: { ...s.layout.tiles, "tile-p": programTile() } } };
    const { footer } = tileImageText(s, "tile-p");
    expect(footer[0]).toContain("B_SER");
    expect(footer[0]).toContain("192000 Hz");
    expect(footer[0].includes("A_SER")).toBe(false);
  });
});

/**
 * The single-device bench is the common case F5 must leave untouched: no
 * slot-1 session exists at all, so every trace's owner resolves to
 * "unknown" and falls back to the focused device — exactly the pre-F5
 * shape. Pinned here at the export.ts wiring level (ownerDeviceFor via
 * tileProvenanceContext/tileImageText), not just the selector
 * (traceExportOwner's own "unknown -> focused" pin already lives in
 * provenance.test.ts).
 */
describe("single-device bench: byte-identical to the pre-F5 focused path (lot F5)", () => {
  beforeEach(() => clearAllFrames());

  function oneDeviceState(): AppState {
    let s = initialState();
    s = withDevice(s, {
      status: "connected",
      info: info("QA403", "SOLO_SER"),
      config: { input_gain: 42, output_gain: 18, sample_rate: 48000 },
      offsets: { input_l: 1, input_r: 2, output_l: 3, output_r: 4, calibrated: true },
    });
    putFrames(HW_TRACE_IDS.inputL, 1, {
      fd: { freqs: Float64Array.from([100]), magDb: Float64Array.from([-6]) },
    });
    s.traces.byId[HW_TRACE_IDS.inputL] = {
      ...s.traces.byId[HW_TRACE_IDS.inputL],
      seq: 1,
      domains: ["fd"],
      capture: null, // no capture yet — the "unknown owner" path
    };
    return s;
  }

  it("tileProvenanceContext's owner is exactly the focused device (no slot-1 to disagree with it)", () => {
    const s = oneDeviceState();
    const tile = defaultTile("tile-solo", "spectrum", [HW_TRACE_IDS.inputL]);
    const ctx = tileProvenanceContext(s, tile);
    expect(ctx.owner?.info?.serial).toBe("SOLO_SER");
  });

  it("tileImageText's footer is unchanged from the focused-device wording", () => {
    let s = oneDeviceState();
    const tile = defaultTile("tile-solo", "spectrum", [HW_TRACE_IDS.inputL]);
    s = { ...s, layout: { ...s.layout, tiles: { ...s.layout.tiles, "tile-solo": tile } } };
    const { footer } = tileImageText(s, "tile-solo");
    expect(footer[0]).toContain("SOLO_SER");
    expect(footer[0]).toContain("48000 Hz");
  });
});

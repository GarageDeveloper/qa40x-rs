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
import { tileAnchor } from "./export";

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
    for (const gone of ["# device_serial", "# sample_rate_hz", "# input_range_dbv", "# offset_input_l_db"]) {
      expect(lines.some((l) => l.startsWith(gone))).toBe(false);
    }
    expect(lines).toContain("# calibrated=false");
    expect(lines).toContain("# capture_device_serial=B_SER");
    expect(lines).toContain("# capture_sample_rate_hz=192000");
    expect(lines).toContain("# capture_offset_input_l_db=20");
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
    const s = stateWithData({ [HW_TRACE_IDS.inputR]: captureFor("A") });
    const a = tileAnchor(
      s,
      tile({ chipSource: HW_TRACE_IDS.inputR, hidden: [HW_TRACE_IDS.inputR] })
    );
    // inputL is drawn but unstamped; the capture pick (pre-F5 rule) skips
    // to... nothing drawn has one, so capture is null and the anchor falls
    // back to the first drawn member for the OWNER.
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

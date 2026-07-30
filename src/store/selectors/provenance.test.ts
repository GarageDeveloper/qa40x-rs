/**
 * Export-owner resolution (issue #25 lot F5): the device an export header
 * describes for a trace — structural slot/program/origin resolution,
 * identity revival, the dormant honesty rule and the unknown→focused
 * compatibility pin (single-device benches stay byte-identical).
 */
import { describe, expect, it } from "vitest";
import type { DeviceMeta } from "../../gen";
import type { AppState, CaptureProvenance, TraceMeta } from "../state";
import {
  DEFAULT_SWEEP_PARAMS,
  hwTraceIds,
  initialState,
  sessionKeyForSlot,
  SLOT0,
} from "../state";
import { mintSession } from "../actions/devices";
import { reconcileHwTraces } from "../actions/traces";
import { withDevice } from "../actions/sessions.fixtures";
import { applyWorkspaceDoc } from "../actions/workspace";
import { migrate, snapshotWorkspace } from "../persist";
import { Store } from "../store";
import type { Ipc } from "../../ipc/ipc";
import { focusedDevice } from "./session";
import { exportDeviceRollCall, exportOwnerDevice, traceExportOwner } from "./provenance";

const stubIpc: Ipc = { call: () => Promise.resolve(null as never) };

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

function capture(model: string, serial: string): CaptureProvenance {
  return {
    device: { model, serial, firmware: 61, isVirtual: false },
    sampleRateHz: 48000,
    inputRangeDbv: 42,
    outputRangeDbv: 18,
    offsets: { input_l: 1, input_r: 2, output_l: 3, output_r: 4, calibrated: true },
    fftSize: 32768,
    window: "flattop",
    averaging: { mode: "off", count: 1 },
    capturedAt: null,
  };
}

/** Two live sessions: slot 0 = QA403 A_SER, slot 1 = QA402 B_SER. */
function twoDeviceState(): AppState {
  let s = initialState();
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

function withCapture(s: AppState, id: string, c: CaptureProvenance | null): AppState {
  const t = s.traces.byId[id];
  return {
    ...s,
    traces: { ...s.traces, byId: { ...s.traces.byId, [id]: { ...t, capture: c } } },
  };
}

function addTrace(s: AppState, meta: TraceMeta): AppState {
  return {
    ...s,
    traces: {
      order: [...s.traces.order, meta.id],
      byId: { ...s.traces.byId, [meta.id]: meta },
    },
  };
}

function trace(id: string, source: TraceMeta["source"], over: Partial<TraceMeta> = {}): TraceMeta {
  return {
    id,
    label: id,
    color: "#fff",
    source,
    domains: ["fd"],
    seq: 1,
    offsetDb: null,
    capture: null,
    ...over,
  };
}

const focusOn = (s: AppState, key: string): AppState => ({
  ...s,
  devices: { ...s.devices, focus: key },
});

describe("traceExportOwner — structural resolution", () => {
  it("a slot-0 endpoint resolves to slot 0 under a slot-1 focus (the F5 headline)", () => {
    const s = focusOn(withCapture(twoDeviceState(), "hw-in-left", capture("QA403", "A_SER")), SLOT1);
    const o = traceExportOwner(s, "hw-in-left");
    expect(o).toMatchObject({ kind: "session", key: SLOT0 });
    expect(exportOwnerDevice(s, o)?.info?.serial).toBe("A_SER");
  });

  it("a slot-1 endpoint resolves to slot 1 under a slot-0 focus", () => {
    const s = withCapture(twoDeviceState(), hwTraceIds(1).inputL, capture("QA402", "B_SER"));
    const o = traceExportOwner(s, hwTraceIds(1).inputL);
    expect(o).toMatchObject({ kind: "session", key: SLOT1 });
    expect(exportOwnerDevice(s, o)?.info?.serial).toBe("B_SER");
  });

  it("an endpoint with no capture still resolves to its LIVE slot session", () => {
    const s = twoDeviceState();
    expect(traceExportOwner(s, hwTraceIds(1).inputL)).toMatchObject({
      kind: "session",
      key: SLOT1,
    });
  });

  it("a dormant slot (session dropped, capture kept) is DORMANT — never a substituted device", () => {
    // Evict-on-disconnect drops the session but keeps rows + captures (F2).
    let s = withCapture(twoDeviceState(), hwTraceIds(1).inputL, capture("QA402", "B_SER"));
    const sessions = { ...s.devices.sessions };
    delete sessions[SLOT1];
    s = { ...s, devices: { ...s.devices, sessions } };
    const o = traceExportOwner(s, hwTraceIds(1).inputL);
    expect(o).toMatchObject({ kind: "dormant", key: SLOT1 });
    expect(exportOwnerDevice(s, o)).toBeNull();
  });

  it("a slot-keyed endpoint with neither session nor capture is dormant, not focused", () => {
    const s = addTrace(twoDeviceState(), trace("hw-in-left@3", { kind: "hw_input", channel: "left" }));
    const o = traceExportOwner(s, "hw-in-left@3");
    expect(o).toMatchObject({ kind: "dormant" });
    expect(exportOwnerDevice(s, o)).toBeNull();
  });

  it("a RECYCLED slot (live unit contradicts the capture) never lends its converter", () => {
    // hw-in-left@1 captured on QA402 OLD_SER; slot 1 now holds B_SER.
    const s = withCapture(twoDeviceState(), hwTraceIds(1).inputL, capture("QA402", "OLD_SER"));
    const o = traceExportOwner(s, hwTraceIds(1).inputL);
    expect(o).toMatchObject({ kind: "dormant", key: SLOT1 });
    expect(exportOwnerDevice(s, o)).toBeNull();
  });

  it("a recycled slot's data follows its device to the session NOW holding it", () => {
    // Slot-1 endpoint captured on QA403 A_SER — the unit now open on slot 0.
    const s = withCapture(twoDeviceState(), hwTraceIds(1).inputL, capture("QA403", "A_SER"));
    const o = traceExportOwner(s, hwTraceIds(1).inputL);
    expect(o).toMatchObject({ kind: "session", key: SLOT0 });
  });

  it("a recycled slot whose identity matches TWO live twins stays dormant (ambiguity guard, structural branch)", () => {
    // hw-in-left@1 captured on QA403 A_SER; slot 1 now holds B_SER (declines
    // structurally), and A_SER is live on slots 0 AND 2 — ambiguous, so no
    // twin's converter may sign the header (re-review N2: this pins the
    // guard's structural-key branch, the frozen-copy test pins the other).
    let s = withCapture(twoDeviceState(), hwTraceIds(1).inputL, capture("QA403", "A_SER"));
    s = mintSession(s, 2, "usb/A_TWIN");
    s = reconcileHwTraces(s);
    s = withDevice(
      s,
      { status: "connected", info: info("QA403", "A_SER") },
      sessionKeyForSlot(2)
    );
    const o = traceExportOwner(s, hwTraceIds(1).inputL);
    expect(o).toMatchObject({ kind: "dormant", key: SLOT1 });
    expect(exportOwnerDevice(s, o)).toBeNull();
  });

  it("a disconnected slot-0 session (info nulled) goes dormant, not model=none-with-stale-config", () => {
    let s = twoDeviceState();
    s = withDevice(s, { status: "disconnected", info: null, config: null, offsets: null });
    const o = traceExportOwner(s, "hw-in-left");
    expect(o).toMatchObject({ kind: "dormant", key: SLOT0 });
    expect(exportOwnerDevice(s, o)).toBeNull();
  });
});

describe("traceExportOwner — origin walk & identity revival", () => {
  it("a frozen copy of a slot-1 endpoint resolves through frozenFrom", () => {
    const s = addTrace(
      twoDeviceState(),
      trace("mem1", { kind: "memory", frozenFrom: hwTraceIds(1).inputL })
    );
    expect(traceExportOwner(s, "mem1")).toMatchObject({ kind: "session", key: SLOT1 });
  });

  it("a transform of a slot-1 endpoint resolves through input", () => {
    const s = addTrace(
      twoDeviceState(),
      trace("tr1", { kind: "transform", input: hwTraceIds(1).inputL, steps: [] })
    );
    expect(traceExportOwner(s, "tr1")).toMatchObject({ kind: "session", key: SLOT1 });
  });

  it("a transform of a FROZEN COPY of a slot-1 endpoint resolves through TWO hops", () => {
    // transform -> input -> memory -> frozenFrom -> the slot-1 endpoint: the
    // walk must not stop after the first hop (a user routinely freezes a
    // curve, then applies a weighting/derivative transform on top of the
    // freeze — both hops have to survive to name the right device).
    let s = twoDeviceState();
    s = addTrace(s, trace("mem1", { kind: "memory", frozenFrom: hwTraceIds(1).inputL }));
    s = addTrace(s, trace("tr1", { kind: "transform", input: "mem1", steps: [] }));
    expect(traceExportOwner(s, "tr1")).toMatchObject({ kind: "session", key: SLOT1 });
  });

  it("a copy whose origin was deleted revives by IDENTITY (capture rides the copy)", () => {
    const s = addTrace(
      twoDeviceState(),
      trace("mem1", { kind: "memory", frozenFrom: "gone" }, { capture: capture("QA402", "B_SER") })
    );
    expect(traceExportOwner(s, "mem1")).toMatchObject({ kind: "session", key: SLOT1 });
  });

  it("identity known but its unit gone from the bench ⇒ dormant (device_model=none)", () => {
    const s = addTrace(
      twoDeviceState(),
      trace("mem1", { kind: "memory", frozenFrom: "gone" }, { capture: capture("QA402", "ZZ_99") })
    );
    const o = traceExportOwner(s, "mem1");
    expect(o).toMatchObject({ kind: "dormant", key: null });
    expect(exportOwnerDevice(s, o)).toBeNull();
  });

  it("a cyclic frozenFrom chain terminates as unknown", () => {
    let s = twoDeviceState();
    s = addTrace(s, trace("mem1", { kind: "memory", frozenFrom: "mem2" }));
    s = addTrace(s, trace("mem2", { kind: "memory", frozenFrom: "mem1" }));
    expect(traceExportOwner(s, "mem1")).toEqual({ kind: "unknown" });
  });
});

describe("traceExportOwner — program bindings", () => {
  function withProgram(
    s: AppState,
    id: string,
    over: { runKey?: string | null; deviceSlot?: number | null; capture?: CaptureProvenance | null }
  ): AppState {
    s = addTrace(s, trace(id, { kind: "program" }, { capture: over.capture ?? null }));
    return {
      ...s,
      programs: {
        order: [...s.programs.order, id],
        byId: {
          ...s.programs.byId,
          [id]: {
            id,
            kind: "sweep",
            run: "idle",
            progress: null,
            startedAtMs: null,
            deviceSlot: over.deviceSlot ?? null,
            runKey: over.runKey ?? null,
            params: DEFAULT_SWEEP_PARAMS,
          },
        },
      },
    };
  }

  it("a running program binds by runKey, whatever the focus", () => {
    const s = withProgram(twoDeviceState(), "p1", { runKey: SLOT1 });
    expect(traceExportOwner(s, "p1")).toMatchObject({ kind: "session", key: SLOT1 });
  });

  it("an idle pinned program binds by deviceSlot", () => {
    const s = withProgram(twoDeviceState(), "p1", { deviceSlot: 1 });
    expect(traceExportOwner(s, "p1")).toMatchObject({ kind: "session", key: SLOT1 });
  });

  it("an idle follows-focus program revives by its landed capture's identity", () => {
    // The F4 programCapture stamp: the curve knows which device ran it even
    // after the focus moved back to slot 0.
    const s = withProgram(twoDeviceState(), "p1", { capture: capture("QA402", "B_SER") });
    expect(traceExportOwner(s, "p1")).toMatchObject({ kind: "session", key: SLOT1 });
  });

  it("an idle follows-focus program with no capture stays unknown → focused (compatibility)", () => {
    const s = withProgram(twoDeviceState(), "p1", {});
    const o = traceExportOwner(s, "p1");
    expect(o).toEqual({ kind: "unknown" });
    expect(exportOwnerDevice(s, o)).toBe(focusedDevice(s));
  });
});

describe("exportOwnerDevice / exportDeviceRollCall", () => {
  it("unknown ids fall back to the focused session — the pre-F5 shape", () => {
    const s = twoDeviceState();
    expect(exportOwnerDevice(s, traceExportOwner(s, null))).toBe(focusedDevice(s));
    expect(exportOwnerDevice(s, traceExportOwner(s, "no-such-trace"))).toBe(focusedDevice(s));
  });

  it("roll call names each distinct identity once, in column order", () => {
    let s = twoDeviceState();
    s = withCapture(s, "hw-in-left", capture("QA403", "A_SER"));
    s = withCapture(s, "hw-in-right", capture("QA403", "A_SER"));
    s = withCapture(s, hwTraceIds(1).inputL, capture("QA402", "B_SER"));
    expect(
      exportDeviceRollCall(s, ["hw-in-left", "hw-in-right", hwTraceIds(1).inputL])
    ).toEqual(["QA403 A_SER", "QA402 B_SER"]);
  });

  it("an unstamped member borrows its resolved LIVE owner's identity; unknowns drop out", () => {
    const s = twoDeviceState(); // endpoints live, no captures yet
    expect(exportDeviceRollCall(s, ["hw-in-left", hwTraceIds(1).inputL, "no-such"])).toEqual([
      "QA403 A_SER",
      "QA402 B_SER",
    ]);
  });
});

/**
 * A saved-then-reloaded doc is the one path none of the above exercises:
 * `snapshotWorkspace` zeroes most captures with their data (persist.ts) and
 * `applyWorkspaceDoc` never touches `devices.sessions` (a load replaces the
 * BENCH, not the session) — so these confirm the SURVIVING identity still
 * resolves correctly against the (unchanged) live sessions after a reload,
 * not just before one.
 */
describe("traceExportOwner — after a save/reload round trip (persist.ts)", () => {
  it("a slot-1 endpoint's capture survives snapshot -> JSON -> migrate -> applyWorkspaceDoc and still resolves its LIVE session", () => {
    const s = withCapture(twoDeviceState(), hwTraceIds(1).inputL, capture("QA402", "B_SER"));
    const doc = migrate(JSON.parse(JSON.stringify(snapshotWorkspace(s))))!;
    // Reload onto the SAME two live sessions (a load replaces the bench,
    // never device state) — a fresh Store, not the one that was saved.
    const dest = new Store(twoDeviceState(), { freeze: true });
    expect(applyWorkspaceDoc(dest, stubIpc, doc)).toBe(true);
    const reloaded = dest.get();
    expect(reloaded.traces.byId[hwTraceIds(1).inputL].capture).toEqual(capture("QA402", "B_SER"));
    expect(traceExportOwner(reloaded, hwTraceIds(1).inputL)).toMatchObject({
      kind: "session",
      key: SLOT1,
    });
  });

  it("a frozen copy's identity survives reload and still revives by IDENTITY once its origin is gone", () => {
    let s = twoDeviceState();
    s = addTrace(
      s,
      trace("mem1", { kind: "memory", frozenFrom: "gone" }, { capture: capture("QA402", "B_SER") })
    );
    const doc = migrate(JSON.parse(JSON.stringify(snapshotWorkspace(s))))!;
    const dest = new Store(twoDeviceState(), { freeze: true });
    expect(applyWorkspaceDoc(dest, stubIpc, doc)).toBe(true);
    const reloaded = dest.get();
    expect(reloaded.traces.byId["mem1"].capture).toEqual(capture("QA402", "B_SER"));
    expect(traceExportOwner(reloaded, "mem1")).toMatchObject({ kind: "session", key: SLOT1 });
  });

  it("a program pinned to deviceSlot survives reload (runKey and its trace's capture both zeroed) and still resolves to that slot", () => {
    let s = twoDeviceState();
    s = addTrace(s, trace("p1", { kind: "program" }, { capture: capture("QA402", "B_SER") }));
    s = {
      ...s,
      programs: {
        order: ["p1"],
        byId: {
          p1: {
            id: "p1",
            kind: "sweep",
            run: "running",
            progress: "1/2",
            startedAtMs: 1000,
            deviceSlot: 1,
            runKey: SLOT1,
            params: DEFAULT_SWEEP_PARAMS,
          },
        },
      },
    };
    const doc = migrate(JSON.parse(JSON.stringify(snapshotWorkspace(s))))!;
    // The doc sheds every live-run fact...
    expect(doc.programs.byId["p1"].runKey).toBeNull();
    expect(doc.programs.byId["p1"].run).toBe("idle");
    expect(doc.traces.byId["p1"].capture).toBeNull();
    // ...but the user's PIN is not a live-run fact — it persists, and is
    // exactly what traceExportOwner needs once runKey/capture are gone.
    expect(doc.programs.byId["p1"].deviceSlot).toBe(1);

    const dest = new Store(twoDeviceState(), { freeze: true }); // focus stays slot 0
    expect(applyWorkspaceDoc(dest, stubIpc, doc)).toBe(true);
    expect(traceExportOwner(dest.get(), "p1")).toMatchObject({ kind: "session", key: SLOT1 });
  });
});

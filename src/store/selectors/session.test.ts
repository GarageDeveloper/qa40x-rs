/**
 * The per-device SESSION seam (issue #25 lot E2) — tester-gate pins for the
 * shape (`initialState` seeds exactly one session), the reference-identity
 * contract `updateDevice`/`updateRun` promise panels (device/run stay
 * separate sub-objects so a run-only write never re-fires a device
 * selection), the absent-key no-op guard, the bench-global vs focused split
 * (`anyProgramLock` vs `focusedRun`), the e2e debug projection, and
 * `sessionArgs`'s slot-0-stays-arg-less / slot≥1-routes-by-id split (E4's
 * flip point).
 */
import { describe, expect, it } from "vitest";
import type { AppState, DeviceSession } from "../state";
import { initialSession, initialState, SLOT0 } from "../state";
import {
  anyBusy,
  anyProgramLock,
  debugState,
  focusedDevice,
  focusedRun,
  isRoutable,
  sessionArgs,
  updateDevice,
  updateRun,
  updateSession,
} from "./session";

/** `s` with a second session at slot 1 (E4 mints these; E2 only ever hand-
 * builds one for a bench-global pin). */
function withSlot1(s: AppState, patch: Partial<DeviceSession> = {}): AppState {
  return {
    ...s,
    devices: {
      ...s.devices,
      sessions: { ...s.devices.sessions, "slot-1": { ...initialSession(1), ...patch } },
    },
  };
}

describe("initialState — the SLOT0 session seam", () => {
  it("holds exactly one session at boot: key 'slot-0', slot 0, deviceId null, focus 'slot-0'", () => {
    const s = initialState();
    expect(Object.keys(s.devices.sessions)).toEqual([SLOT0]);
    expect(s.devices.sessions[SLOT0]).toMatchObject({ key: SLOT0, slot: 0, deviceId: null });
    expect(s.devices.focus).toBe(SLOT0);
  });
});

describe("focusedDevice/focusedRun — reference identity (the shallowEq contract)", () => {
  it("return the focused session's own device/run sub-objects", () => {
    const s = initialState();
    expect(focusedDevice(s)).toBe(s.devices.sessions[SLOT0].device);
    expect(focusedRun(s)).toBe(s.devices.sessions[SLOT0].run);
  });

  it("an updateRun-only change leaves focusedDevice's reference untouched (a run-only write must not re-fire a device selection)", () => {
    const s0 = initialState();
    const deviceBefore = focusedDevice(s0);
    const s1 = updateRun(s0, SLOT0, (r) => ({ ...r, streaming: true }));
    expect(focusedDevice(s1)).toBe(deviceBefore);
    expect(focusedRun(s1)).not.toBe(focusedRun(s0)); // the run itself DID change
  });

  it("an updateDevice-only change leaves focusedRun's reference untouched (the mirror case: a device-only write must not re-fire a run/status selection)", () => {
    const s0 = initialState();
    const runBefore = focusedRun(s0);
    const s1 = updateDevice(s0, SLOT0, (d) => ({ ...d, present: true }));
    expect(focusedRun(s1)).toBe(runBefore);
    expect(focusedDevice(s1)).not.toBe(focusedDevice(s0));
  });
});

describe("updateSession/updateRun/updateDevice — absent key is a true no-op", () => {
  it("return the SAME state object (Object.is) for a key naming no session — no phantom session is minted", () => {
    const s = initialState();
    expect(updateSession(s, "slot-99", (x) => x)).toBe(s);
    expect(updateRun(s, "slot-99", (r) => ({ ...r, streaming: true }))).toBe(s);
    expect(updateDevice(s, "slot-99", (d) => ({ ...d, present: true }))).toBe(s);
    // And no session was created on the side either.
    expect(Object.keys(s.devices.sessions)).toEqual([SLOT0]);
  });
});

describe("anyProgramLock — bench-global, unlike focusedRun", () => {
  it("sees a lock held by a NON-focused session; focusedRun does not", () => {
    const s = withSlot1(initialState(), {
      run: { ...initialSession(1).run, programLock: "prog-xyz" },
    });
    expect(s.devices.focus).toBe(SLOT0); // still focused on slot-0
    expect(anyProgramLock(s)).toBe("prog-xyz");
    expect(focusedRun(s).programLock).toBeNull();
  });
});

describe("debugState — the e2e/console debug projection (tests/e2e/adapter/app.ts's 4 accessors: fittedOutputRange ~L349, frameCount ~L365, generatorRunning ~L397, streaming ~L409)", () => {
  it("exposes .run.streaming/.stats.frames/.generatorRunning/.fittedOutputRangeDbv and .device from the FOCUSED session", () => {
    let s = updateRun(initialState(), SLOT0, (r) => ({
      ...r,
      streaming: true,
      stats: { fps: 30, frameMs: 33, frames: 42 },
      generatorRunning: true,
      fittedOutputRangeDbv: 8,
    }));
    s = updateDevice(s, SLOT0, (d) => ({ ...d, status: "connected" }));

    const dbg = debugState(s);
    expect(dbg.run.streaming).toBe(true);
    expect(dbg.run.stats.frames).toBe(42);
    expect(dbg.run.generatorRunning).toBe(true);
    expect(dbg.run.fittedOutputRangeDbv).toBe(8);
    expect(dbg.device.status).toBe("connected");
    // Not a copy — the SAME sub-objects the focused session carries.
    expect(dbg.device).toBe(focusedDevice(s));
    expect(dbg.run).toBe(focusedRun(s));
  });
});

describe("sessionArgs — the wire deviceId projection (E4's flip point)", () => {
  it("slot-0 is always arg-less, even once it has an adopted id (the backend default runtime IS slot 0)", () => {
    const s = updateSession(initialState(), SLOT0, (x) => ({ ...x, deviceId: "usb/A" }));
    expect(sessionArgs(s, SLOT0)).toEqual({});
  });

  it("a slot-1 session with an adopted id routes by that id", () => {
    const s = withSlot1(initialState(), { deviceId: "usb/B" });
    expect(sessionArgs(s, "slot-1")).toEqual({ deviceId: "usb/B" });
  });

  it("a slot-1 session with deviceId still null stays arg-less too (pre-E4 fallback — watched here so E4's flip to id-routing is a visible diff)", () => {
    const s = withSlot1(initialState()); // deviceId defaults to null via initialSession
    expect(sessionArgs(s, "slot-1")).toEqual({});
  });
});

describe("isRoutable — the wire-safety gate over sessionArgs (E2 review #2)", () => {
  it("slot-0 is always routable (arg-less by contract)", () => {
    expect(isRoutable(initialState(), SLOT0)).toBe(true);
  });

  it("a slot-1 session is routable only once its registry id is adopted — an unadopted {} would drive the DEFAULT runtime (the other device)", () => {
    const unadopted = withSlot1(initialState());
    expect(isRoutable(unadopted, "slot-1")).toBe(false);
    const adopted = withSlot1(initialState(), { deviceId: "usb/B" });
    expect(isRoutable(adopted, "slot-1")).toBe(true);
  });

  it("an absent session is not routable", () => {
    expect(isRoutable(initialState(), "slot-7")).toBe(false);
  });
});

describe("anyBusy — the bench-global enumeration gate (E2 review #9: pinned so dropping a clause is a visible diff)", () => {
  it("false on a fresh idle bench", () => {
    expect(anyBusy(initialState())).toBe(false);
  });

  it("true for EACH busy flag, on a NON-focused session too (streaming / stopping / generatorRunning / outputOnly / connecting)", () => {
    const flags: Array<Partial<DeviceSession["run"]>> = [
      { streaming: true },
      { stopping: true },
      { generatorRunning: true },
      { outputOnly: true },
    ];
    for (const patch of flags) {
      const s = withSlot1(initialState(), {
        run: { ...initialSession(1).run, ...patch },
      });
      expect(anyBusy(s), JSON.stringify(patch)).toBe(true);
    }
    const connecting = withSlot1(initialState(), {
      device: { ...initialSession(1).device, status: "connecting" },
    });
    expect(anyBusy(connecting)).toBe(true);
  });
});

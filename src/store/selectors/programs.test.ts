/**
 * Program-session selectors (issue #25 lot F4): how a program resolves to
 * the session it runs (or would run) on, what disables its ▶, how progress
 * events route back, and how `deviceSlot`/`runKey` behave through the
 * persistence round trip (the pin/binding split: the PIN persists, the run
 * BINDING never does).
 */
import { describe, expect, it } from "vitest";

import type { DeviceConfig } from "../../gen";
import { Store } from "../store";
import {
  initialSession,
  initialState,
  type AppState,
  type DeviceSession,
  type ProgramMeta,
} from "../state";
import { withDevice, withRun } from "../actions/sessions.fixtures";
import { addProgram, setProgramDeviceSlot } from "../actions/programs";
import { migrate, snapshotWorkspace } from "../persist";
import {
  programBlockReason,
  programDeviceNote,
  programForDeviceId,
  programSampleRateHz,
  programSessionKey,
  runningPrograms,
  runningScriptId,
} from "./programs";

function config(sampleRate: number): DeviceConfig {
  return { input_gain: 0, output_gain: 18, sample_rate: sampleRate };
}

/** `s` with a CONNECTED, id-adopted session at slot `n`. */
function withSlot(s: AppState, n: number, deviceId: string, rate = 48000): AppState {
  const sess: DeviceSession = {
    ...initialSession(n),
    deviceId,
    device: { ...initialSession(n).device, status: "connected", config: config(rate) },
  };
  return {
    ...s,
    devices: { ...s.devices, sessions: { ...s.devices.sessions, [`slot-${n}`]: sess } },
  };
}

function prog(s: AppState, id: string): ProgramMeta {
  const p = s.programs.byId[id];
  if (!p) throw new Error(`no program ${id}`);
  return p;
}

/** Patch one program's fields directly (test-only). */
function patchProg(store: Store<AppState>, id: string, patch: Partial<ProgramMeta>): void {
  store.update("test/patch-prog", (s) => ({
    ...s,
    programs: {
      ...s.programs,
      byId: { ...s.programs.byId, [id]: { ...s.programs.byId[id], ...patch } as ProgramMeta },
    },
  }));
}

describe("selectors/programs — session resolution", () => {
  it("null deviceSlot follows the focus; a pin resolves to its slot; runKey wins over both", () => {
    const store = new Store(withSlot(initialState(), 1, "usb/B"));
    const id = addProgram(store, "thd");
    expect(programSessionKey(store.get(), prog(store.get(), id))).toBe("slot-0");

    setProgramDeviceSlot(store, id, 1);
    expect(programSessionKey(store.get(), prog(store.get(), id))).toBe("slot-1");

    // The run binding (captured at entry) outranks a later re-pin AND the
    // focus — a running program never migrates.
    patchProg(store, id, { runKey: "slot-0" });
    expect(programSessionKey(store.get(), prog(store.get(), id))).toBe("slot-0");
  });

  it("programSampleRateHz reads the PROGRAM session's rate, never the focused one's (the 8×-off progress bug)", () => {
    let s = withSlot(initialState(), 1, "usb/B", 48000);
    // Focused slot 0 runs at 384 kHz; the program is pinned to slot 1.
    s = withDevice(s, { status: "connected", config: config(384000) });
    const store = new Store(s);
    const id = addProgram(store, "thd");
    setProgramDeviceSlot(store, id, 1);
    expect(programSampleRateHz(store.get(), prog(store.get(), id))).toBe(48000);
    setProgramDeviceSlot(store, id, null);
    expect(programSampleRateHz(store.get(), prog(store.get(), id))).toBe(384000);
    // A pin onto a slot with NO live session: the historical 48 k fallback.
    setProgramDeviceSlot(store, id, 5);
    expect(programSampleRateHz(store.get(), prog(store.get(), id))).toBe(48000);
  });
});

describe("selectors/programs — block reasons (what disables ▶)", () => {
  it("a lock on the program's TARGET session blocks it; another device's lock does not", () => {
    let s = withSlot(withDevice(initialState(), { status: "connected" }), 1, "usb/B");
    const store = new Store(s);
    const a = addProgram(store, "thd");
    const b = addProgram(store, "thd");
    setProgramDeviceSlot(store, b, 1);

    // Program a holds slot 0.
    s = withRun(store.get(), { programLock: a });
    expect(programBlockReason(s, prog(s, a))).toBeNull(); // its own lock
    expect(programBlockReason(s, prog(s, b))).toBeNull(); // other device
    const c = addProgram(store, "thd");
    const s2 = withRun(store.get(), { programLock: a });
    expect(programBlockReason(s2, prog(s2, c))).toMatch(/is running on this device/);
  });

  it("a follows-focus program COLLIDES with a pinned one on the same resolved session", () => {
    let s = withSlot(withDevice(initialState(), { status: "connected" }), 1, "usb/B");
    s = { ...s, devices: { ...s.devices, focus: "slot-1" } };
    const store = new Store(s);
    const pinned = addProgram(store, "thd");
    setProgramDeviceSlot(store, pinned, 1);
    const follower = addProgram(store, "thd");
    // The pinned program runs on slot 1; the follows-focus one resolves to
    // the focused slot 1 too → blocked, with the runner's name.
    const locked = withRun(store.get(), { programLock: pinned }, "slot-1");
    expect(programBlockReason(locked, prog(locked, follower))).toMatch(/is running on this device/);
  });

  it("scripts are bench-exclusive: a running script blocks every OTHER script, on any device — sweeps stay per-device", () => {
    let s = withSlot(withDevice(initialState(), { status: "connected" }), 1, "usb/B");
    const store = new Store(s);
    const script1 = addProgram(store, "script");
    const script2 = addProgram(store, "script");
    const sweep = addProgram(store, "thd");
    setProgramDeviceSlot(store, script2, 1);
    setProgramDeviceSlot(store, sweep, 1);
    patchProg(store, script1, { run: "running", runKey: "slot-0" });
    const st = withRun(store.get(), { programLock: script1 });

    expect(runningScriptId(st)).toBe(script1);
    expect(programBlockReason(st, prog(st, script1))).toBeNull(); // itself
    expect(programBlockReason(st, prog(st, script2))).toMatch(/one script at a time/);
    expect(programBlockReason(st, prog(st, sweep))).toBeNull(); // other device, not a script
  });
});

describe("selectors/programs — progress routing", () => {
  it("programForDeviceId matches the running program whose BOUND session adopted that id", () => {
    let s = withSlot(withDevice(initialState(), { status: "connected" }), 1, "usb/B");
    const store = new Store(s);
    const a = addProgram(store, "thd");
    const b = addProgram(store, "thd");
    patchProg(store, b, { run: "running", runKey: "slot-1" });
    const st = store.get();
    expect(runningPrograms(st).map((p) => p.id)).toEqual([b]);
    expect(programForDeviceId(st, "usb/B")?.id).toBe(b);
    expect(programForDeviceId(st, "usb/OTHER")).toBeNull();
    expect(programForDeviceId(st, "usb/B")?.id).not.toBe(a);
  });
});

describe("selectors/programs — the device note (type-line annotation)", () => {
  it("null on a single-device bench with no pin — a RUNNING follows-focus program included (byte-identity)", () => {
    const store = new Store(withDevice(initialState(), { status: "connected" }));
    const id = addProgram(store, "thd");
    expect(programDeviceNote(store.get(), prog(store.get(), id))).toBeNull();
    patchProg(store, id, { run: "running", runKey: "slot-0" });
    expect(programDeviceNote(store.get(), prog(store.get(), id))).toBeNull();
  });

  it("annotates at ≥ 2 live sessions, on any pin, and for a run bound to an EVICTED session", () => {
    // Two live sessions → every program annotates.
    const two = new Store(withSlot(withDevice(initialState(), { status: "connected" }), 1, "usb/B"));
    const a = addProgram(two, "thd");
    expect(programDeviceNote(two.get(), prog(two.get(), a))?.short).toBe("#1");
    setProgramDeviceSlot(two, a, 1);
    expect(programDeviceNote(two.get(), prog(two.get(), a))?.short).toBe("#2");

    // One live session but an explicit pin → annotated (the pin is a fact
    // worth showing even before the device exists).
    const one = new Store(withDevice(initialState(), { status: "connected" }));
    const b = addProgram(one, "thd");
    setProgramDeviceSlot(one, b, 2);
    expect(programDeviceNote(one.get(), prog(one.get(), b))?.short).toBe("#3");

    // A run bound to a session that no longer exists → annotated, never
    // silently read as running on the surviving device.
    const c = addProgram(one, "thd");
    patchProg(one, c, { run: "running", runKey: "slot-4" });
    expect(programDeviceNote(one.get(), prog(one.get(), c))?.short).toBe("#5");
  });
});

describe("programs persistence (lot F4): the pin persists, the binding never does", () => {
  it("deviceSlot round-trips snapshot → JSON → migrate; runKey is zeroed; a pre-F4 doc migrates to focus-following and re-saves identically", () => {
    const store = new Store(initialState());
    const id = addProgram(store, "thd");
    setProgramDeviceSlot(store, id, 1);
    // Simulate a live run at save time — the binding must not leak.
    patchProg(store, id, { run: "running", runKey: "slot-1" });

    const doc = migrate(JSON.parse(JSON.stringify(snapshotWorkspace(store.get()))));
    expect(doc).not.toBeNull();
    expect(doc!.programs.byId[id].deviceSlot).toBe(1);
    expect(doc!.programs.byId[id].runKey).toBeNull();
    expect(doc!.programs.byId[id].run).toBe("idle");

    // A doc predating the fields (a raw v5 with neither) fills the
    // focus-following default — and re-saving it changes nothing (the
    // save→load digest rule).
    const raw = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
    const progs = (raw.programs as { byId: Record<string, Record<string, unknown>> }).byId;
    delete progs[id].deviceSlot;
    delete progs[id].runKey;
    const migrated = migrate(raw);
    expect(migrated!.programs.byId[id].deviceSlot).toBeNull();
    expect(migrated!.programs.byId[id].runKey).toBeNull();

    // A hand-edited doc with garbage degrades to focus-following, never a
    // crash or a fractional slot.
    const raw2 = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
    const progs2 = (raw2.programs as { byId: Record<string, Record<string, unknown>> }).byId;
    progs2[id].deviceSlot = "two";
    progs2[id].runKey = "slot-9";
    const migrated2 = migrate(raw2);
    expect(migrated2!.programs.byId[id].deviceSlot).toBeNull();
    expect(migrated2!.programs.byId[id].runKey).toBeNull();
  });
});

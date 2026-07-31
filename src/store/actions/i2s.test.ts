/**
 * Front-panel I2S port actions (issue #71): the per-session idempotent
 * `i2s_apply` declaration and its gates — program lock, isRoutable, the
 * nothing-to-do fast path, the stop branch — plus the status fold and the
 * disconnect reset that keeps `enabled` honest.
 */
import { describe, expect, it } from "vitest";
import type { Commands, Ipc } from "../../ipc/ipc";
import type { I2sStatus } from "../../gen";
import { Store } from "../store";
import type { AppState, SourceMeta } from "../state";
import { initialSession, initialState, SLOT0 } from "../state";
import { withDevice, withRun } from "./sessions.fixtures";
import {
  applyI2sStatus,
  i2sPortConfig,
  resetI2sOnDisconnect,
  setI2sEnabled,
  setI2sReference,
  syncAllI2s,
  syncI2s,
} from "./i2s";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function sine(id: string, over: Partial<SourceMeta> = {}): SourceMeta {
  return {
    id,
    label: id,
    kind: "sine",
    frequencyHz: 1000,
    levelDbv: -12,
    extraTones: [],
    route: "left",
    i2sRoute: "both",
    targets: [],
    playing: true,
    ...over,
  } as SourceMeta;
}

function runningStatus(over: Partial<I2sStatus> = {}): I2sStatus {
  return {
    supported: true,
    enabled: true,
    running: true,
    width_bits: 32,
    reference_dbv: 0,
    sigma_peak_dbv: -12,
    clipped: false,
    errors: [],
    blocks_written: 5,
    last_error: null,
    ...over,
  };
}

function recordingIpc(status: () => I2sStatus): {
  ipc: Ipc;
  calls: { cmd: string; args: Record<string, unknown> }[];
} {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  const ipc: Ipc = {
    async call<K extends keyof Commands>(
      cmd: K,
      args: Commands[K]["args"]
    ): Promise<Commands[K]["result"]> {
      calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
      if (cmd === "i2s_apply" || cmd === "i2s_status") {
        return status() as Commands[K]["result"];
      }
      return null as Commands[K]["result"];
    },
  };
  return { ipc, calls };
}

function connectedState(): AppState {
  let s = initialState();
  s = withDevice(s, { status: "connected" });
  return s;
}

/** Two connected sessions: slot 0 (focused) and slot 1 (adopted id). */
function twoSessionState(): AppState {
  let s = initialState();
  s = {
    ...s,
    devices: {
      ...s.devices,
      sessions: {
        ...s.devices.sessions,
        "slot-1": { ...initialSession(1), deviceId: "usb/B" },
      },
    },
  };
  s = withDevice(s, { status: "connected" });
  s = withDevice(s, { status: "connected" }, "slot-1");
  return s;
}

describe("setI2sEnabled / setI2sReference — the port declaration", () => {
  it("enabling declares the session's I2S slot set with the reference, and folds the status into run.i2s", async () => {
    const s = {
      ...connectedState(),
      sources: { order: ["a"], byId: { a: sine("a") } },
    };
    const store = new Store<AppState>(s, { freeze: true });
    const { ipc, calls } = recordingIpc(() => runningStatus());
    setI2sEnabled(store, ipc, SLOT0, true);
    await flush();
    const applies = calls.filter((c) => c.cmd === "i2s_apply");
    expect(applies).toHaveLength(1);
    expect(applies[0].args.enabled).toBe(true);
    expect(applies[0].args.referenceDbv).toBe(0);
    expect((applies[0].args.slots as { id: string }[]).map((x) => x.id)).toEqual(["a"]);
    expect(applies[0].args.deviceId).toBeUndefined(); // slot 0 = arg-less
    const run = store.get().devices.sessions[SLOT0].run;
    expect(run.i2s.running).toBe(true);
    expect(run.i2s.sigmaPeakDbv).toBe(-12);
  });

  it("disabling takes the stop branch (enabled: false, empty slots)", async () => {
    let s: AppState = {
      ...connectedState(),
      sources: { order: ["a"], byId: { a: sine("a") } },
      i2sPorts: { "0": { enabled: true, referenceDbv: 0 } },
    };
    s = withRun(s, { i2s: { running: true, sigmaPeakDbv: -12, clipped: false, blocks: 3, error: null } });
    const store = new Store<AppState>(s, { freeze: true });
    const { ipc, calls } = recordingIpc(() =>
      runningStatus({ enabled: false, running: false, sigma_peak_dbv: null })
    );
    setI2sEnabled(store, ipc, SLOT0, false);
    await flush();
    const applies = calls.filter((c) => c.cmd === "i2s_apply");
    expect(applies).toHaveLength(1);
    expect(applies[0].args.enabled).toBe(false);
    expect(applies[0].args.slots).toEqual([]);
    expect(store.get().devices.sessions[SLOT0].run.i2s.running).toBe(false);
  });

  it("an idle port with the toggle off makes NO wire call (nothing to declare, nothing to stop)", async () => {
    const store = new Store<AppState>(connectedState(), { freeze: true });
    const { ipc, calls } = recordingIpc(() => runningStatus());
    syncI2s(store, ipc, SLOT0);
    await flush();
    expect(calls).toEqual([]);
  });

  it("the reference is clamped to the sane band and re-declares a live port", async () => {
    const s = {
      ...connectedState(),
      i2sPorts: { "0": { enabled: true, referenceDbv: 0 } },
    };
    const store = new Store<AppState>(s, { freeze: true });
    const { ipc, calls } = recordingIpc(() => runningStatus());
    setI2sReference(store, ipc, SLOT0, -500);
    await flush();
    expect(i2sPortConfig(store.get(), SLOT0).referenceDbv).toBe(-60);
    const applies = calls.filter((c) => c.cmd === "i2s_apply");
    expect(applies).toHaveLength(1);
    expect(applies[0].args.referenceDbv).toBe(-60);
  });

  it("a program-locked session's sync is deferred — no register writes mid-sweep", async () => {
    let s: AppState = {
      ...connectedState(),
      i2sPorts: { "0": { enabled: true, referenceDbv: 0 } },
    };
    s = withRun(s, { programLock: "sweep-1" });
    const store = new Store<AppState>(s, { freeze: true });
    const { ipc, calls } = recordingIpc(() => runningStatus());
    syncI2s(store, ipc, SLOT0);
    await flush();
    expect(calls).toEqual([]);
  });

  it("an unroutable slot ≥ 1 session never falls through to the default runtime", async () => {
    let s = twoSessionState();
    // The adopted id vanishes (stale enumeration) — the session becomes
    // unroutable; an arg-less i2s_apply here would drive device A's port.
    s = {
      ...s,
      devices: {
        ...s.devices,
        sessions: {
          ...s.devices.sessions,
          "slot-1": { ...s.devices.sessions["slot-1"], deviceId: null },
        },
      },
      i2sPorts: { "1": { enabled: true, referenceDbv: 0 } },
    };
    const store = new Store<AppState>(s, { freeze: true });
    const { ipc, calls } = recordingIpc(() => runningStatus());
    syncI2s(store, ipc, "slot-1");
    await flush();
    expect(calls).toEqual([]);
  });

  it("syncAllI2s touches only sessions whose port is on (or still running)", async () => {
    const s = {
      ...twoSessionState(),
      sources: { order: ["a"], byId: { a: sine("a") } },
      i2sPorts: { "1": { enabled: true, referenceDbv: -6 } },
    };
    const store = new Store<AppState>(s, { freeze: true });
    const { ipc, calls } = recordingIpc(() => runningStatus());
    syncAllI2s(store, ipc);
    await flush();
    const applies = calls.filter((c) => c.cmd === "i2s_apply");
    expect(applies).toHaveLength(1);
    expect(applies[0].args.deviceId).toBe("usb/B");
  });
});

describe("applyI2sStatus — the status fold", () => {
  it("I2S slot errors merge into slotErrors tagged, replacing stale I2S entries and keeping the DAC's", () => {
    let s = connectedState();
    s = withRun(s, {
      slotErrors: [
        { id: "dac-src", error: "unknown waveform" },
        { id: "old", error: "I2S: stale entry" },
      ],
    });
    const store = new Store<AppState>(s, { freeze: true });
    applyI2sStatus(
      store,
      SLOT0,
      runningStatus({ errors: [{ id: "scr", error: "script refused" }] })
    );
    expect(store.get().devices.sessions[SLOT0].run.slotErrors).toEqual([
      { id: "dac-src", error: "unknown waveform" },
      { id: "scr", error: "I2S: script refused" },
    ]);
  });
});

describe("resetI2sOnDisconnect — enabled must never survive a teardown", () => {
  it("clears run.i2s and forces the slot's toggle off", () => {
    let s = connectedState();
    s = withRun(s, {
      i2s: { running: true, sigmaPeakDbv: -6, clipped: true, blocks: 42, error: null },
    });
    s = { ...s, i2sPorts: { "0": { enabled: true, referenceDbv: -6 } } };
    const out = resetI2sOnDisconnect(s, SLOT0);
    expect(out.devices.sessions[SLOT0].run.i2s.running).toBe(false);
    expect(out.i2sPorts["0"]).toEqual({ enabled: false, referenceDbv: -6 });
  });

  it("is a shape-preserving no-op when the port was never configured — and safe on a dropped session", () => {
    const s = connectedState();
    const out = resetI2sOnDisconnect(s, SLOT0);
    expect(out.i2sPorts).toEqual({});
    // A dropped session (slot ≥ 1 eviction): the run update no-ops, the
    // port disable still lands.
    const evicted = {
      ...s,
      i2sPorts: { "3": { enabled: true, referenceDbv: 0 } },
    };
    const out2 = resetI2sOnDisconnect(evicted, "slot-3");
    expect(out2.i2sPorts["3"].enabled).toBe(false);
  });
});

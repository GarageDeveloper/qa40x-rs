/**
 * addDevice / removeDevice (issue #25 lot E4, actions/device.ts): the
 * add-device wire flow (guards, mint-with-adopted-id, reconcile, the
 * `adding` in-flight lifecycle) and the remove-device flow (keyed
 * disconnect, eviction, endpoint purge). mintSession/dropSession's own
 * PURITY pins live in devices.test.ts (their home file, actions/devices.ts);
 * these pins exercise the higher-level actions built on top of them.
 */
import { describe, expect, it, vi } from "vitest";

// addDevice/removeDevice never reach the real Tauri runtime in these tests
// (a hand-rolled Ipc stands in — see fakeIpc below), but the module import
// graph still pulls in "@tauri-apps/api/core" transitively (via
// ipc/stream.ts's `Channel`) — mocked the same way devices.test.ts/
// stream.test.ts do it so no real Tauri context is required at import time.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: unknown;
    constructor(cb?: unknown) {
      this.onmessage = cb;
    }
  },
}));

import { Store } from "../store";
import type { AppState } from "../state";
import { initialSession, initialState, SLOT0 } from "../state";
import type { Ipc } from "../../ipc/ipc";
import type { AddedDevice } from "../../gen";
import { hwTraceIds } from "../hwtraces";
import { fakeEntry } from "./devices.fixtures";
import { addDevice, disconnect, removeDevice, setSampleRate } from "./device";
import { reconcileHwTraces, stampSlotEndpointIdentity } from "./traces";
import { snapshotWorkspace } from "../persist";
import { applyWorkspaceDoc } from "./workspace";
import { dormantGroupLabel, reviveCandidateId } from "../selectors/devices";

/** An Ipc that records every call and lets a test override specific
 * methods' behavior (reject, deferred, custom answer) — the rest answer a
 * plausible default so an untested arm of the flow never throws. */
function fakeIpc(
  overrides: Partial<Record<string, (args: unknown) => unknown>> = {}
): { ipc: Ipc; calls: [string, unknown][] } {
  const calls: [string, unknown][] = [];
  const ipc: Ipc = {
    call: (method: string, args?: unknown) => {
      calls.push([method, args]);
      const over = overrides[method];
      if (over) {
        const r = over(args);
        return (r instanceof Promise ? r : Promise.resolve(r)) as never;
      }
      switch (method) {
        case "get_device_info":
          return Promise.resolve(null as never);
        case "get_device_config":
          return Promise.resolve(
            { input_gain: 0, output_gain: 0, sample_rate: 48000 } as never
          );
        case "get_input_dbv_offset":
        case "get_output_dbv_offset":
          return Promise.resolve({ offset_db: 0, calibrated: true } as never);
        case "list_devices":
          return Promise.resolve({ devices: [], open: [] } as never);
        case "disconnect_device":
          return Promise.resolve("ok" as never);
        default:
          return Promise.resolve(null as never);
      }
    },
  };
  return { ipc, calls };
}

function withAdding(ids: string[]): AppState {
  const s = initialState();
  return { ...s, devices: { ...s.devices, adding: ids } };
}

function withHeldSession(deviceId: string): AppState {
  const s = initialState();
  return {
    ...s,
    devices: {
      ...s.devices,
      sessions: { [SLOT0]: { ...s.devices.sessions[SLOT0], deviceId } },
    },
  };
}

function withOpenEntry(id: string): AppState {
  const s = initialState();
  return {
    ...s,
    devices: { ...s.devices, byId: { ...s.devices.byId, [id]: fakeEntry(id, { open: true, slot: 0 }) } },
  };
}

describe("addDevice — guards refuse without touching the wire (issue #25 lot E4)", () => {
  it("an id already in `adding` is refused — no wire call, no toast", async () => {
    const store = new Store(withAdding(["usb/X"]), { freeze: true });
    const { ipc, calls } = fakeIpc();
    await addDevice(store, ipc, "usb/X");
    expect(calls).toEqual([]);
    expect(store.get().ui.toasts).toEqual([]);
  });

  it("an id already HELD by a session is refused with an info toast, no connect_additional_device call", async () => {
    const store = new Store(withHeldSession("usb/A"), { freeze: true });
    const { ipc, calls } = fakeIpc();
    await addDevice(store, ipc, "usb/A");
    expect(calls.some(([m]) => m === "connect_additional_device")).toBe(false);
    expect(store.get().ui.toasts).toEqual([
      expect.objectContaining({ kind: "info", message: "This device is already connected" }),
    ]);
  });

  it("an id already OPEN (entry.open), even with no session holding it, is refused the same way", async () => {
    const store = new Store(withOpenEntry("usb/A"), { freeze: true });
    const { ipc, calls } = fakeIpc();
    await addDevice(store, ipc, "usb/A");
    expect(calls.some(([m]) => m === "connect_additional_device")).toBe(false);
    expect(store.get().ui.toasts).toHaveLength(1);
    expect(store.get().ui.toasts[0].kind).toBe("info");
  });
});

describe("addDevice — backend rejection (issue #25 lot E4)", () => {
  it("a rejected connect_additional_device toasts an error, mints NO session, and empties `adding`", async () => {
    const store = new Store(initialState(), { freeze: true });
    const { ipc } = fakeIpc({
      connect_additional_device: () =>
        Promise.reject(new Error("Failed to connect: All device slots are in use")),
    });
    await addDevice(store, ipc, "usb/C");
    const s = store.get();
    expect(Object.keys(s.devices.sessions)).toEqual([SLOT0]); // no session minted
    expect(s.devices.adding).toEqual([]); // lifecycle cleaned up in `finally`
    expect(s.ui.toasts).toHaveLength(1);
    expect(s.ui.toasts[0]).toMatchObject({
      kind: "error",
      message: "Add device failed: Error: Failed to connect: All device slots are in use",
    });
  });
});

describe("addDevice — success path (issue #25 lot E4)", () => {
  it("mints the slot's session WITH the adopted id, connects it, reconciles the hw pool, and keys the follow-up reads on the adopted id", async () => {
    const store = new Store(initialState(), { freeze: true });
    const info = {
      model: "QA402",
      serial: "D-serial",
      firmware_version: 60,
      product: "QA402 Audio Analyzer",
      sample_rates: [48000],
      supports_flash: false,
      capabilities: {} as never,
      is_virtual: false,
    };
    const { ipc, calls } = fakeIpc({
      connect_additional_device: () =>
        Promise.resolve({ device_id: "usb/D", slot: 1 } as AddedDevice),
      get_device_info: () => Promise.resolve(info as never),
      get_device_config: () =>
        Promise.resolve({ input_gain: 18, output_gain: 8, sample_rate: 96000 } as never),
      // addDevice fires a fire-and-forget refreshDevices() in its `finally`
      // (never awaited by addDevice itself, but its microtask settles
      // before this test's own `await addDevice(...)` resumes) — it must
      // answer a REALISTIC post-connect enumeration (the unit open at its
      // slot), or deriveDevices's own F6 rule ("nothing open at that slot
      // clears the id") would legitimately wipe the deviceId this test is
      // checking, which is a fidelity gap in the fake, not a product bug.
      list_devices: () =>
        Promise.resolve({
          devices: [fakeEntry("usb/D", { open: true, slot: 1 })],
          open: ["usb/D"],
        } as never),
    });

    await addDevice(store, ipc, "usb/D");

    const s = store.get();
    const sess = s.devices.sessions["slot-1"];
    expect(sess).toBeDefined();
    expect(sess.deviceId).toBe("usb/D");
    expect(sess.device.status).toBe("connected");
    expect(sess.device.present).toBe(true);
    expect(sess.device.info).toEqual(info);
    expect(sess.device.config).toEqual({ input_gain: 18, output_gain: 8, sample_rate: 96000 });

    // reconcileHwTraces ran: slot-1's 4 endpoints are in the pool.
    const ids = hwTraceIds(1);
    for (const id of Object.values(ids)) {
      expect(s.traces.byId[id], id).toBeDefined();
      expect(s.traces.order, id).toContain(id);
    }

    // The follow-up reads carry the ADOPTED id, not an arg-less default.
    const infoCall = calls.find(([m]) => m === "get_device_info");
    expect(infoCall?.[1]).toEqual({ deviceId: "usb/D" });
    const configCall = calls.find(([m]) => m === "get_device_config");
    expect(configCall?.[1]).toEqual({ deviceId: "usb/D" });

    expect(s.ui.toasts).toHaveLength(1);
    expect(s.ui.toasts[0].kind).toBe("success");
  });
});

describe("addDevice — `adding` in-flight lifecycle (issue #25 lot E4)", () => {
  it("holds the id in `adding` WHILE connect_additional_device is in flight, and empties it once the whole flow settles", async () => {
    const store = new Store(initialState(), { freeze: true });
    let resolveConnect!: (v: AddedDevice) => void;
    const gate = new Promise<AddedDevice>((r) => (resolveConnect = r));
    const { ipc } = fakeIpc({ connect_additional_device: () => gate });

    const p = addDevice(store, ipc, "usb/E");
    // Synchronous prelude of an async function runs before the first
    // `await` yields — `adding` is already populated by the time we get
    // control back here, with the wire call still pending.
    expect(store.get().devices.adding).toEqual(["usb/E"]);

    resolveConnect({ device_id: "usb/E", slot: 1 });
    await p;
    expect(store.get().devices.adding).toEqual([]);
  });
});

/** `s` with a connected slot-1 session (deviceId "usb/B") whose 4 endpoint
 * traces are reconciled into the pool, plus a tile membership and a
 * trigger setting pointing at one of them — the shape removeDevice's purge
 * must clean up everywhere. */
function slot1Store(): Store<AppState> {
  const store = new Store(initialState(), { freeze: true });
  store.update("test/add-slot1", (s) => {
    const withSession: AppState = {
      ...s,
      devices: {
        ...s.devices,
        sessions: {
          ...s.devices.sessions,
          "slot-1": {
            ...initialSession(1),
            deviceId: "usb/B",
            device: { ...initialSession(1).device, status: "connected" as const },
          },
        },
      },
    };
    const reconciled = reconcileHwTraces(withSession);
    return {
      ...reconciled,
      layout: {
        ...reconciled.layout,
        tiles: {
          ...reconciled.layout.tiles,
          "tile-1": {
            ...reconciled.layout.tiles["tile-1"],
            traces: [...reconciled.layout.tiles["tile-1"].traces, "hw-in-left@1"],
          },
        },
      },
      triggers: {
        ...reconciled.triggers,
        "hw-in-left@1": { mode: "auto", edge: "rising", levelV: 0, hystV: null, armEpoch: 0 },
      },
    };
  });
  return store;
}

describe("removeDevice — keyed disconnect + eviction + purge (issue #25 lot E4)", () => {
  it("disconnects by the session's adopted id, evicts the session, and purges the slot's 4 endpoint traces from the pool, tile membership and triggers", async () => {
    const store = slot1Store();
    const { ipc, calls } = fakeIpc();
    await removeDevice(store, ipc, "slot-1");
    const s = store.get();

    expect(s.devices.sessions["slot-1"]).toBeUndefined();
    expect(calls).toContainEqual(["disconnect_device", { deviceId: "usb/B" }]);

    for (const id of Object.values(hwTraceIds(1))) {
      expect(s.traces.byId[id], id).toBeUndefined();
      expect(s.traces.order, id).not.toContain(id);
    }
    expect(s.layout.tiles["tile-1"].traces).not.toContain("hw-in-left@1");
    expect(s.triggers["hw-in-left@1"]).toBeUndefined();
  });

  it("swallows an 'Unknown device' disconnect rejection — no error toast, eviction still happens (F8 rule)", async () => {
    const store = slot1Store();
    const { ipc } = fakeIpc({
      disconnect_device: () => Promise.reject(new Error("Unknown device: usb/B")),
    });
    await removeDevice(store, ipc, "slot-1");
    const s = store.get();
    expect(s.devices.sessions["slot-1"]).toBeUndefined();
    expect(s.ui.toasts.filter((t) => t.kind === "error")).toEqual([]);
  });

  it("any OTHER disconnect rejection still toasts an error — but eviction/purge still complete (best-effort)", async () => {
    const store = slot1Store();
    const { ipc } = fakeIpc({
      disconnect_device: () => Promise.reject(new Error("USB timeout")),
    });
    await removeDevice(store, ipc, "slot-1");
    const s = store.get();
    expect(s.ui.toasts.some((t) => t.kind === "error")).toBe(true);
    expect(s.devices.sessions["slot-1"]).toBeUndefined();
    expect(s.traces.byId["hw-in-left@1"]).toBeUndefined();
  });

  it("SLOT0 is refused — no wire call, state unchanged (the default device disconnects from the top bar instead)", async () => {
    const store = new Store(initialState(), { freeze: true });
    const before = store.get();
    const { ipc, calls } = fakeIpc();
    await removeDevice(store, ipc, SLOT0);
    expect(calls).toEqual([]);
    expect(store.get()).toBe(before);
  });

  it("the DORMANT path (no live session at the key) still purges the slot's leftover trace rows, with no wire disconnect", async () => {
    const store = new Store(initialState(), { freeze: true });
    store.update("test/dormant-slot1", (s) =>
      reconcileHwTraces({
        ...s,
        devices: { ...s.devices, sessions: { ...s.devices.sessions, "slot-1": initialSession(1) } },
      })
    );
    // Drop the SESSION only (hand-built — simulates a doc loaded on a
    // smaller bench, or a session torn down some other way), leaving the
    // dormant endpoint traces behind in the pool.
    store.update("test/drop-session-only", (s) => {
      const sessions = { ...s.devices.sessions };
      delete sessions["slot-1"];
      return { ...s, devices: { ...s.devices, sessions } };
    });
    expect(store.get().traces.byId["hw-in-left@1"]).toBeDefined(); // dormant leftover present

    const { ipc, calls } = fakeIpc();
    await removeDevice(store, ipc, "slot-1");
    expect(calls.some(([m]) => m === "disconnect_device")).toBe(false); // no session ⇒ no wire disconnect
    expect(store.get().traces.byId["hw-in-left@1"]).toBeUndefined();
  });
});

/**
 * Identity from the OPEN, not just from frames (issue #25 lot F —
 * Raphaël's second F1-validation round): B6's mint fresh-slate zeroes the
 * slot's endpoint captures, and ingest only re-stamps on the first FRAME —
 * so a device added but never streamed (e.g. only sweep programs ran on
 * it, which land on their own trace) had NOTHING to persist: after a
 * save/restart its dormant group lost its model+serial, the one-click
 * revive had nothing to match ("Connect" greyed) and the header fell back
 * to the anonymous "Device #2". `stampSlotEndpointIdentity` closes it at
 * the add itself.
 */
describe("addDevice — a never-streamed device's identity survives for the revive (issue #25 lot F)", () => {
  const VIRT_ID = "virtual/0DE0_0002";
  const virtInfo = {
    model: "QA403",
    firmware_version: 60,
    serial: "0DE0_0002",
    product: "QA403 Audio Analyzer (virtual)",
    sample_rates: [48000, 96000, 192000, 384000],
    supports_flash: false,
    capabilities: {} as never,
    is_virtual: true,
  };

  function addIpc() {
    return fakeIpc({
      connect_additional_device: () =>
        ({ device_id: VIRT_ID, slot: 1 }) as AddedDevice,
      get_device_info: () => virtInfo,
    });
  }

  it("stamps an identity-only capture on the slot's endpoints at add time — nothing guessed beyond the unit itself", async () => {
    const store = new Store(initialState(), { freeze: true });
    const { ipc } = addIpc();
    await addDevice(store, ipc, VIRT_ID);

    for (const id of Object.values(hwTraceIds(1))) {
      const cap = store.get().traces.byId[id]?.capture;
      expect(cap?.device).toEqual({
        model: "QA403",
        serial: "0DE0_0002",
        firmware: 60,
        isVirtual: true,
      });
      // Identity ONLY — rate/ranges/offsets/fft/window/averaging stay null
      // (the programCapture "unknown, never guessed" rule): no frame has
      // described this bench yet, and the first ingested frame replaces
      // this with the full frame-bound snapshot.
      expect(cap?.sampleRateHz).toBeNull();
      expect(cap?.offsets).toBeNull();
      expect(cap?.capturedAt).toBeNull();
    }
  });

  it("a pre-existing (frame-bound) capture is never overwritten by the identity stamp", async () => {
    const store = new Store(initialState(), { freeze: true });
    const { ipc } = addIpc();
    await addDevice(store, ipc, VIRT_ID);
    const before = store.get().traces.byId["hw-in-left@1"]!.capture;
    stampSlotEndpointIdentity(store, 1, { ...virtInfo, serial: "OTHER" });
    expect(store.get().traces.byId["hw-in-left@1"]!.capture).toBe(before);
  });

  it("the identity survives the save/load round trip: a fresh boot resolves the revive AND names the dormant group", async () => {
    const store = new Store(initialState(), { freeze: true });
    const { ipc } = addIpc();
    await addDevice(store, ipc, VIRT_ID);
    // NO streaming happened — the endpoints have no frames, only identity.
    const doc = snapshotWorkspace(store.get());

    // A fresh boot: the unit is enumerable (the built-in virtual always
    // is) but nothing is open — the doc's group loads DORMANT.
    const bootState: AppState = (() => {
      const s = initialState();
      return {
        ...s,
        devices: {
          ...s.devices,
          available: [VIRT_ID],
          byId: { [VIRT_ID]: fakeEntry(VIRT_ID, { virtual: true, model: "QA403" }) },
        },
      };
    })();
    const boot = new Store(bootState, { freeze: true });
    expect(applyWorkspaceDoc(boot, ipc, doc)).toBe(true);

    expect(reviveCandidateId(boot.get(), 1)).toBe(VIRT_ID);
    expect(dormantGroupLabel(boot.get(), 1)).toBe("QA403 · 0DE0_0002 (virtual)");
  });
});

/* ------------------------------------------------------------------ */
/* Lot F2 (issue #25): evict-on-disconnect, program-lock guards, and    */
/* the source-target drops (decision D5).                              */
/* ------------------------------------------------------------------ */

function withSlot1Target(s: AppState): AppState {
  return {
    ...s,
    sources: {
      ...s.sources,
      byId: {
        ...s.sources.byId,
        "src-sine-1": {
          ...s.sources.byId["src-sine-1"],
          targets: [
            { slot: 1, route: "both" as const },
            { slot: null, route: "left" as const },
          ],
        },
      },
    },
  };
}

describe("disconnect of a slot ≥ 1 session EVICTS it (issue #25 lot F2) — one lifecycle for every slot", () => {
  const info = {
    model: "QA403",
    firmware_version: 60,
    serial: "0DE0_0002",
    product: "QA403 Audio Analyzer (virtual)",
    sample_rates: [48000, 96000, 192000, 384000],
    supports_flash: false,
    capabilities: {} as never,
    is_virtual: true,
  };

  it("evicts the session, keeps the dormant rows WITH their revive identity, keeps the slot's source targets", async () => {
    const store = slot1Store();
    stampSlotEndpointIdentity(store, 1, info);
    store.update("test/pin-target", withSlot1Target);
    const { ipc, calls } = fakeIpc();
    await disconnect(store, ipc, "slot-1");
    const s = store.get();
    // Session gone — the group renders dormant, like a disconnected slot 0.
    expect(s.devices.sessions["slot-1"]).toBeUndefined();
    expect(calls).toContainEqual(["disconnect_device", { deviceId: "usb/B" }]);
    // Rows survive with their identity: the one-click revive still matches.
    expect(s.traces.byId["hw-in-left@1"]).toBeDefined();
    expect(s.traces.byId["hw-in-left@1"].capture?.device?.serial).toBe("0DE0_0002");
    // Targets survive too: the revive reopens the SAME unit on the SAME slot.
    expect(s.sources.byId["src-sine-1"].targets).toContainEqual({ slot: 1, route: "both" });
  });

  it("slot 0 keeps the historic mark-disconnected shape (session stays, status flips)", async () => {
    const store = new Store(initialState(), { freeze: true });
    store.update("test/slot0-connected", (s) => ({
      ...s,
      devices: {
        ...s.devices,
        sessions: {
          [SLOT0]: {
            ...s.devices.sessions[SLOT0],
            device: { ...s.devices.sessions[SLOT0].device, status: "connected" as const },
          },
        },
      },
    }));
    const { ipc } = fakeIpc();
    await disconnect(store, ipc, SLOT0);
    const sess = store.get().devices.sessions[SLOT0];
    expect(sess).toBeDefined();
    expect(sess.device.status).toBe("disconnected");
    expect(sess.device.userDisconnected).toBe(true);
  });
});

describe("program-lock guards on the deliberate teardown paths (issue #25 lot F2 — F1 review #5)", () => {
  function lockedSlot1Store() {
    const store = slot1Store();
    store.update("test/lock-slot1", (s) => ({
      ...s,
      devices: {
        ...s.devices,
        sessions: {
          ...s.devices.sessions,
          "slot-1": {
            ...s.devices.sessions["slot-1"],
            run: { ...s.devices.sessions["slot-1"].run, programLock: "prog-1" },
          },
        },
      },
    }));
    return store;
  }

  it("disconnect refuses under the session's own lock — no wire call, session intact, info toast", async () => {
    const store = lockedSlot1Store();
    const { ipc, calls } = fakeIpc();
    await disconnect(store, ipc, "slot-1");
    expect(calls).toEqual([]);
    expect(store.get().devices.sessions["slot-1"]).toBeDefined();
    expect(
      store.get().ui.toasts.some((t) => t.kind === "info" && /measurement is running/.test(t.message))
    ).toBe(true);
  });

  it("removeDevice refuses the same way — the E4 ✕ is disabled, but REST/debug callers reach the action directly", async () => {
    const store = lockedSlot1Store();
    const { ipc, calls } = fakeIpc();
    await removeDevice(store, ipc, "slot-1");
    expect(calls).toEqual([]);
    expect(store.get().devices.sessions["slot-1"]).toBeDefined();
    expect(store.get().traces.byId["hw-in-left@1"]).toBeDefined(); // no purge either
  });
});

describe("source-target drops (issue #25 lot F2, decision D5) — the stimulus twin of the trace purge", () => {
  it("removeDevice drops the slot's pinned targets and leaves the rest of the matrix alone", async () => {
    const store = slot1Store();
    store.update("test/pin-target", withSlot1Target);
    const { ipc } = fakeIpc();
    await removeDevice(store, ipc, "slot-1");
    expect(store.get().sources.byId["src-sine-1"].targets).toEqual([
      { slot: null, route: "left" },
    ]);
  });

  const oldUnit = {
    model: "QA403",
    firmware_version: 60,
    serial: "OLD-0001",
    product: "QA403 Audio Analyzer",
    sample_rates: [48000, 96000, 192000, 384000],
    supports_flash: false,
    capabilities: {} as never,
    is_virtual: false,
  };

  /** Dormant slot-1 rows carrying OLD-0001's identity + a target pinned to
   * slot 1, no live slot-1 session — the "doc loaded, then add" shape. */
  function dormantWithIdentity(): Store<AppState> {
    const store = new Store(initialState(), { freeze: true });
    store.update("test/dormant-slot1", (s) =>
      reconcileHwTraces({
        ...s,
        devices: {
          ...s.devices,
          sessions: { ...s.devices.sessions, "slot-1": initialSession(1) },
        },
      })
    );
    stampSlotEndpointIdentity(store, 1, oldUnit);
    store.update("test/drop-session-only", (s) => {
      const sessions = { ...s.devices.sessions };
      delete sessions["slot-1"];
      return withSlot1Target({ ...s, devices: { ...s.devices, sessions } });
    });
    return store;
  }

  it("addDevice onto a slot whose persisted identity names a DIFFERENT unit drops that slot's targets", async () => {
    const store = dormantWithIdentity();
    const { ipc } = fakeIpc({
      connect_additional_device: () =>
        ({ device_id: "usb/NEW", slot: 1 }) as AddedDevice,
      get_device_info: () => ({ ...oldUnit, serial: "NEW-0002" }),
    });
    await addDevice(store, ipc, "usb/NEW", { slot: 1 });
    expect(store.get().sources.byId["src-sine-1"].targets).toEqual([
      { slot: null, route: "left" },
    ]);
  });

  it("the revive path — SAME model+serial — keeps the pinned targets", async () => {
    const store = dormantWithIdentity();
    const { ipc } = fakeIpc({
      connect_additional_device: () =>
        ({ device_id: "usb/OLD", slot: 1 }) as AddedDevice,
      get_device_info: () => oldUnit,
    });
    await addDevice(store, ipc, "usb/OLD", { slot: 1 });
    expect(store.get().sources.byId["src-sine-1"].targets).toContainEqual({
      slot: 1,
      route: "both",
    });
  });

  it("get_device_info answering null (identity UNKNOWN, not merely different) also drops the slot's targets — fail CLOSED per review SHOULD-FIX #5: an unproven identity must never let a pinned stimulus re-bind onto whatever unit took the slot", async () => {
    const store = dormantWithIdentity();
    const { ipc } = fakeIpc({
      connect_additional_device: () =>
        ({ device_id: "usb/UNKNOWN", slot: 1 }) as AddedDevice,
      get_device_info: () => null,
    });
    await addDevice(store, ipc, "usb/UNKNOWN", { slot: 1 });
    expect(store.get().sources.byId["src-sine-1"].targets).toEqual([
      { slot: null, route: "left" },
    ]);
  });
});

describe("slot-0 disconnect stays the wedged-sweep escape hatch (F2 review MUST-FIX #2)", () => {
  it("disconnects EVEN under a program lock — the backend quiesce trips the sweep cancel by design", async () => {
    const store = new Store(initialState(), { freeze: true });
    store.update("test/slot0-locked-sweep", (s) => ({
      ...s,
      devices: {
        ...s.devices,
        sessions: {
          [SLOT0]: {
            ...s.devices.sessions[SLOT0],
            device: { ...s.devices.sessions[SLOT0].device, status: "connected" as const },
            run: { ...s.devices.sessions[SLOT0].run, programLock: "prog-1" },
          },
        },
      },
    }));
    const { ipc, calls } = fakeIpc();
    await disconnect(store, ipc, SLOT0);
    expect(calls.some(([m]) => m === "disconnect_device")).toBe(true);
    expect(store.get().devices.sessions[SLOT0].device.status).toBe("disconnected");
  });
});

describe("setSampleRate — per-session generator retune (issue #25 lot F3)", () => {
  /** Slot 0 connected with a playing focus-following sine. */
  function generatorBench(run: Partial<AppState["devices"]["sessions"][string]["run"]>): Store<AppState> {
    const s = initialState();
    s.devices.sessions = {
      [SLOT0]: {
        ...s.devices.sessions[SLOT0],
        device: {
          ...s.devices.sessions[SLOT0].device,
          status: "connected",
          config: { input_gain: 0, output_gain: 18, sample_rate: 48000 },
        },
        run: { ...s.devices.sessions[SLOT0].run, ...run },
      },
    };
    // The boot source ("Sine 1", route left) plays: the generator has a mix.
    s.sources.byId["src-sine-1"] = { ...s.sources.byId["src-sine-1"], playing: true };
    return new Store<AppState>(s, { freeze: true });
  }

  const flushChain = async (): Promise<void> => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it("a rate change on a GENERATING session rebuilds its loop on the NEW grid", async () => {
    const store = generatorBench({ outputOnly: true, generatorRunning: true });
    const { ipc, calls } = fakeIpc({
      get_device_config: () => ({ input_gain: 0, output_gain: 18, sample_rate: 192000 }),
      output_only_start: () => ({
        sigma_peak_dbv: -12,
        clipped: false,
        fitted_output_range_dbv: 8,
        errors: [],
      }),
    });
    await setSampleRate(store, ipc, 192000);
    await flushChain();
    const starts = calls.filter(([m]) => m === "output_only_start");
    expect(starts).toHaveLength(1);
    const slots = (starts[0][1] as { slots: { source: { frequency_hz: number } }[] }).slots;
    // 1 kHz snapped on the NEW 192 kHz grid (32768 bins), not the old 48 k one.
    expect(slots[0].source.frequency_hz).toBeCloseTo(1001.953125, 9);
  });

  it("a rate change on a PROGRAM-LOCKED session never rebuilds the generator (the F2 gate)", async () => {
    const store = generatorBench({
      outputOnly: true,
      generatorRunning: true,
      programLock: "THD sweep running",
    });
    const { ipc, calls } = fakeIpc({
      get_device_config: () => ({ input_gain: 0, output_gain: 18, sample_rate: 192000 }),
    });
    await setSampleRate(store, ipc, 192000);
    await flushChain();
    expect(calls.filter(([m]) => m === "output_only_start")).toEqual([]);
    // The register write itself went through — only the DAC rebuild waits.
    expect(calls.some(([m]) => m === "set_sample_rate")).toBe(true);
  });

  it("a rate change on an IDLE session touches no generator (no resume-to-capture surprise)", async () => {
    const store = generatorBench({});
    const { ipc, calls } = fakeIpc({
      get_device_config: () => ({ input_gain: 0, output_gain: 18, sample_rate: 96000 }),
    });
    await setSampleRate(store, ipc, 96000);
    await flushChain();
    // Neither DAC-owner verb fires: no rebuild, and no resume-to-capture
    // surprise (the tail of outputonly's sync belongs to explicit gestures).
    expect(
      calls.filter(([m]) => m === "output_only_start" || m === "stop_generator")
    ).toEqual([]);
    expect(calls.some(([m]) => m === "set_sample_rate")).toBe(true);
  });
});

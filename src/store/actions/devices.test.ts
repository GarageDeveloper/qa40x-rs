/**
 * Devices-slice actions (issue #25 lot D): the deriveDevices fold (sticky
 * order, availability, the P1/P2 primary rules) and the tolerant refresh.
 * The P3 rule (an untouched picker must NOT turn auto-connect into
 * auto-demo) lives with the connect action's own tests.
 */
import { describe, expect, it, vi } from "vitest";

// The alias-provenance pin (below) exercises the real startRun() →
// startStream() → `new Channel()` path — mocked the same way
// stream.test.ts/programs.test.ts do it, so no real Tauri IPC runtime is
// required.
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
import type { AppState, DevicesState } from "../state";
import { initialSession, initialState, SLOT0 } from "../state";
import type { DeviceList } from "../../gen";
import type { Ipc } from "../../ipc/ipc";
import { fakeEntry, fakeList as list } from "./devices.fixtures";
import {
  deriveDevices,
  dropSession,
  mintSession,
  pickDevice,
  refreshDevices,
  setDeviceAlias,
  setFocusedSession,
} from "./devices";
import {
  autoConnectTick,
  connect,
  deviceLost,
  refreshTelemetry,
  setInputRange,
} from "./device";
import { startRun } from "./stream";
import { isRoutable } from "../selectors/session";

const empty = () => initialState().devices;

describe("deriveDevices", () => {
  it("stores entries verbatim and mirrors backend order in `available`", () => {
    const a = fakeEntry("usb/A");
    const v = fakeEntry("virtual/V", { virtual: true });
    const d = deriveDevices(empty(), list(a, v));
    expect(d.available).toEqual(["usb/A", "virtual/V"]);
    expect(d.byId["usb/A"]).toBe(a);
    expect(d.byId["virtual/V"]).toBe(v);
    expect(d.order).toEqual(["usb/A", "virtual/V"]);
    expect(d.enumerating).toBe(false);
  });

  it("keeps `order` sticky across a vanish/reappear", () => {
    let d = deriveDevices(empty(), list(fakeEntry("usb/A"), fakeEntry("usb/B")));
    // A unplugs…
    d = deriveDevices(d, list(fakeEntry("usb/B")));
    expect(d.available).toEqual(["usb/B"]);
    expect(d.order).toEqual(["usb/A", "usb/B"]);
    // …and replugs: same slot, not appended anew.
    d = deriveDevices(d, list(fakeEntry("usb/B"), fakeEntry("usb/A")));
    expect(d.order).toEqual(["usb/A", "usb/B"]);
    expect(d.available).toEqual(["usb/B", "usb/A"]);
  });

  it("an empty enumeration leaves no primary", () => {
    const d = deriveDevices(empty(), { devices: [], open: [] });
    expect(d.available).toEqual([]);
    expect(d.primary).toBeNull();
  });

  it("P1: an open unit wins the primary", () => {
    const d = deriveDevices(
      empty(),
      list(fakeEntry("usb/A"), fakeEntry("virtual/V", { virtual: true, open: true }))
    );
    expect(d.primary).toBe("virtual/V");
  });

  it("P2: with nothing open, the pick wins while available", () => {
    const picked = { ...empty(), pick: "usb/B" };
    const d = deriveDevices(picked, list(fakeEntry("usb/A"), fakeEntry("usb/B")));
    expect(d.primary).toBe("usb/B");
  });

  it("P2: a vanished pick falls back to the first available physical unit", () => {
    const picked = { ...empty(), pick: "usb/B" };
    const d = deriveDevices(
      picked,
      list(fakeEntry("virtual/V", { virtual: true }), fakeEntry("usb/A"))
    );
    // The pick is remembered (the unit may replug) but the primary must be
    // a unit that exists — and physical beats the built-in virtual.
    expect(d.pick).toBe("usb/B");
    expect(d.primary).toBe("usb/A");
  });

  it("P2: with only the virtual available, it is the primary (nothing opens by itself)", () => {
    const d = deriveDevices(empty(), list(fakeEntry("virtual/V", { virtual: true })));
    expect(d.primary).toBe("virtual/V");
  });

  it("a duplicate id within one answer keeps the LAST entry's fields (defensive — the registry already dedupes on the wire, see registry.rs list_dedupes_by_id_keeping_the_first)", () => {
    const first = fakeEntry("usb/A", { model: "QA402" });
    const second = fakeEntry("usb/A", { model: "QA403" });
    const d = deriveDevices(empty(), list(first, second));
    expect(d.byId["usb/A"]).toBe(second);
    // `available` is not locally deduped — it mirrors the answer verbatim
    // and relies on the backend invariant that this never actually happens.
    expect(d.available).toEqual(["usb/A", "usb/A"]);
    expect(d.order).toEqual(["usb/A"]);
  });

  it("a unit dropped ENTIRELY from a later answer leaves a stale byId entry that must not resurrect as primary", () => {
    // Unlike the backend's list() (which keeps an open-but-unplugged unit
    // listed, see registry.rs), this pins the fold defensively for whatever
    // answer actually arrives: derivePrimary's open-check walks `available`,
    // so a stale byId.open=true for an id no longer in `available` must be
    // inert, not resurrect the vanished unit as primary.
    let d = deriveDevices(empty(), list(fakeEntry("usb/A", { open: true })));
    expect(d.primary).toBe("usb/A");
    d = deriveDevices(d, { devices: [], open: [] });
    expect(d.available).toEqual([]);
    expect(d.byId["usb/A"].open).toBe(true);
    expect(d.primary).toBeNull();
  });
});

describe("derivePrimary — slot-awareness (issue #25 lot E1 review #9): the FOCUSED slot's open unit wins", () => {
  // Slot 1 enumerates FIRST in every case below — proving the result comes
  // from `focus`/slot, never from backend enumeration order.
  const twoOpenUnits = list(
    fakeEntry("usb/B", { open: true, slot: 1 }),
    fakeEntry("usb/A", { open: true, slot: 0 })
  );

  it("focus slot-0 → the slot-0 unit wins", () => {
    const d = deriveDevices({ ...empty(), focus: SLOT0 }, twoOpenUnits);
    expect(d.primary).toBe("usb/A");
  });

  it("focus 'slot-1' → the slot-1 unit wins", () => {
    const d = deriveDevices({ ...empty(), focus: "slot-1" }, twoOpenUnits);
    expect(d.primary).toBe("usb/B");
  });

  it("focus on a slot with nothing open → the LOWEST open slot wins (P1b), not enumeration order", () => {
    const d = deriveDevices({ ...empty(), focus: "slot-2" }, twoOpenUnits);
    expect(d.primary).toBe("usb/A"); // slot 0 < slot 1
  });
});

describe("deriveDevices — session adoption (issue #25 lot E2)", () => {
  it("adopts entry.id into the session whose slot matches — and ONLY that one", () => {
    const prev: DevicesState = {
      ...empty(),
      sessions: { [SLOT0]: initialSession(0), "slot-1": initialSession(1) },
    };
    const d = deriveDevices(prev, list(fakeEntry("usb/B", { open: true, slot: 1 })));
    expect(d.sessions["slot-1"].deviceId).toBe("usb/B");
    // The slot-0 session's deviceId is untouched by an entry at a DIFFERENT slot.
    expect(d.sessions[SLOT0].deviceId).toBeNull();
  });

  it("an answer with nothing open at slot 0 clears deviceId but leaves device.status alone", () => {
    const prev: DevicesState = {
      ...empty(),
      sessions: {
        [SLOT0]: {
          ...initialSession(0),
          deviceId: "usb/A",
          device: { ...initialSession(0).device, status: "connected" },
        },
      },
    };
    // A transiently stale scan reporting nothing open must NOT invent a
    // disconnect — only disconnect()/deviceLost()/a failed connect() may.
    const d = deriveDevices(prev, { devices: [], open: [] });
    expect(d.sessions[SLOT0].deviceId).toBeNull();
    expect(d.sessions[SLOT0].device.status).toBe("connected");
  });

  it("an alias survives its unit going unavailable and returning, even onto a DIFFERENT slot (keyed by id, not slot)", () => {
    let d: DevicesState = { ...empty(), aliases: { "usb/A": "Bench A" } };
    d = deriveDevices(d, list(fakeEntry("usb/A", { open: true, slot: 0 })));
    expect(d.aliases["usb/A"]).toBe("Bench A");
    d = deriveDevices(d, { devices: [], open: [] }); // unplugged
    expect(d.aliases["usb/A"]).toBe("Bench A");
    d = deriveDevices(d, list(fakeEntry("usb/A", { open: true, slot: 1 }))); // replugged, different slot
    expect(d.aliases["usb/A"]).toBe("Bench A");
  });
});

describe("refreshDevices", () => {
  it("folds the answer and clears the in-flight flag", async () => {
    const store = new Store(initialState(), { freeze: true });
    const ipc: Ipc = {
      call: () => Promise.resolve(list(fakeEntry("usb/A")) as never),
    };
    await refreshDevices(store, ipc);
    expect(store.get().devices.available).toEqual(["usb/A"]);
    expect(store.get().devices.primary).toBe("usb/A");
    expect(store.get().devices.enumerating).toBe(false);
  });

  it("a failed call keeps the last list (no empty-bar flicker)", async () => {
    const store = new Store(initialState(), { freeze: true });
    const good: Ipc = { call: () => Promise.resolve(list(fakeEntry("usb/A")) as never) };
    await refreshDevices(store, good);
    const bad: Ipc = { call: () => Promise.reject(new Error("transient USB")) };
    await refreshDevices(store, bad);
    expect(store.get().devices.available).toEqual(["usb/A"]);
    expect(store.get().devices.primary).toBe("usb/A");
    expect(store.get().devices.enumerating).toBe(false);
  });

  it("two overlapping refreshes: the NEWEST-STARTED request wins and a stale answer is dropped (review #1)", async () => {
    // Two refreshes overlap routinely (the 2 s tick vs a lifecycle
    // refresh). The FIRST request's answer landing last is the dangerous
    // ordering: unguarded, its stale snapshot would resurrect a unit a
    // fresher scan already saw unplugged (ghost picker entry, stale pick
    // riding connect_device into a sticky error toast). The monotonic
    // guard drops it; `enumerating` must still end false.
    const store = new Store(initialState(), { freeze: true });
    let resolveA!: (v: DeviceList) => void;
    let resolveB!: (v: DeviceList) => void;
    const answerA = new Promise<DeviceList>((r) => (resolveA = r));
    const answerB = new Promise<DeviceList>((r) => (resolveB = r));
    let n = 0;
    const ipc: Ipc = {
      call: () => (n++ === 0 ? answerA : answerB) as never,
    };

    const p1 = refreshDevices(store, ipc); // stale scan: still sees A+B
    const p2 = refreshDevices(store, ipc); // fresh scan: B was unplugged
    expect(store.get().devices.enumerating).toBe(true);

    resolveB(list(fakeEntry("usb/A")));
    await p2;
    resolveA(list(fakeEntry("usb/A"), fakeEntry("usb/B")));
    await p1;

    // The fresh answer sticks; the stale one must NOT re-list usb/B.
    expect(store.get().devices.available).toEqual(["usb/A"]);
    expect(store.get().devices.primary).toBe("usb/A");
    expect(store.get().devices.enumerating).toBe(false);
  });
});

/** An ipc whose device-lifecycle arms answer plausibly and which records
 * every call — for pinning WHAT rides the wire (P3/P4). */
function recordingIpc(devices: DeviceList): { ipc: Ipc; calls: [string, unknown][] } {
  const calls: [string, unknown][] = [];
  const ipc: Ipc = {
    call: (method: string, args?: unknown) => {
      calls.push([method, args]);
      switch (method) {
        case "list_devices":
          return Promise.resolve(devices as never);
        case "is_device_present":
          return Promise.resolve(true as never);
        case "get_device_info":
          return Promise.resolve(null as never);
        case "get_device_config":
          return Promise.resolve({ input_gain: 42, output_gain: 8, sample_rate: 48000 } as never);
        case "get_input_dbv_offset":
        case "get_output_dbv_offset":
          return Promise.resolve({ offset_db: 0, calibrated: true } as never);
        case "output_only_start":
          return Promise.resolve({
            sigma_peak_dbv: -12,
            clipped: false,
            fitted_output_range_dbv: 8,
            errors: [],
          } as never);
        default:
          return Promise.resolve(null as never);
      }
    },
  };
  return { ipc, calls };
}

function connectArgs(calls: [string, unknown][]): unknown[] {
  return calls.filter(([m]) => m === "connect_device").map(([, a]) => a);
}

describe("P3/P4 — what rides the connect wire", () => {
  it("P3: an untouched picker keeps the legacy arg-less call (never auto-demo)", async () => {
    // No hardware: only the virtual enumerates, so the PRIMARY is virtual —
    // and the call must still be {} (the backend then looks for physical).
    const store = new Store(initialState(), { freeze: true });
    const { ipc, calls } = recordingIpc(list(fakeEntry("virtual/V", { virtual: true })));
    await refreshDevices(store, ipc);
    expect(store.get().devices.primary).toBe("virtual/V");
    await connect(store, ipc);
    expect(connectArgs(calls)).toEqual([{}]);
  });

  it("P3: an explicit pick rides as deviceId (the panel passes pickedDeviceId)", async () => {
    const store = new Store(initialState(), { freeze: true });
    const { ipc, calls } = recordingIpc(list(fakeEntry("usb/A"), fakeEntry("usb/B")));
    await refreshDevices(store, ipc);
    pickDevice(store, "usb/B");
    await connect(store, ipc, { deviceId: "usb/B" });
    expect(connectArgs(calls)).toEqual([{ deviceId: "usb/B" }]);
  });

  it("P4: the auto-connect tick honors a physical pick", async () => {
    const store = new Store(initialState(), { freeze: true });
    const { ipc, calls } = recordingIpc(list(fakeEntry("usb/A"), fakeEntry("usb/B")));
    await refreshDevices(store, ipc);
    pickDevice(store, "usb/B");
    await autoConnectTick(store, ipc);
    expect(connectArgs(calls)).toEqual([{ deviceId: "usb/B" }]);
  });

  it("P4: a VIRTUAL pick never flows into the tick (no auto-demo)", async () => {
    const store = new Store(initialState(), { freeze: true });
    const { ipc, calls } = recordingIpc(
      list(fakeEntry("usb/A"), fakeEntry("virtual/V", { virtual: true }))
    );
    await refreshDevices(store, ipc);
    pickDevice(store, "virtual/V");
    await autoConnectTick(store, ipc);
    expect(connectArgs(calls)).toEqual([{}]);
  });
});

describe("pickDevice", () => {
  it("sets the pick and re-derives the primary without a new enumeration", async () => {
    const store = new Store(initialState(), { freeze: true });
    const ipc: Ipc = {
      call: () => Promise.resolve(list(fakeEntry("usb/A"), fakeEntry("usb/B")) as never),
    };
    await refreshDevices(store, ipc);
    expect(store.get().devices.primary).toBe("usb/A");
    pickDevice(store, "usb/B");
    expect(store.get().devices.pick).toBe("usb/B");
    expect(store.get().devices.primary).toBe("usb/B");
    pickDevice(store, null);
    expect(store.get().devices.pick).toBeNull();
    expect(store.get().devices.primary).toBe("usb/A");
  });

  it("picking an id that is not in the list is defensive: it is remembered but never derives a primary", async () => {
    // A stale click (unit unplugged between the picker rendering and the
    // click landing) must not crash derivePrimary or leave it pointing at
    // nothing usable — P2's `available.includes(pick)` guard must hold.
    const store = new Store(initialState(), { freeze: true });
    const ipc: Ipc = {
      call: () => Promise.resolve(list(fakeEntry("usb/A")) as never),
    };
    await refreshDevices(store, ipc);
    pickDevice(store, "usb/does-not-exist");
    expect(store.get().devices.pick).toBe("usb/does-not-exist");
    // Falls through P2's availability guard straight to the first physical.
    expect(store.get().devices.primary).toBe("usb/A");
  });
});

describe("setDeviceAlias (issue #25 lot E2, Raphaël decision 3)", () => {
  it("trims surrounding whitespace", () => {
    const store = new Store(initialState(), { freeze: true });
    setDeviceAlias(store, "usb/A", "  My Analyzer  ");
    expect(store.get().devices.aliases["usb/A"]).toBe("My Analyzer");
  });

  it("clears the alias on empty or whitespace-only input", () => {
    const store = new Store(initialState(), { freeze: true });
    setDeviceAlias(store, "usb/A", "Bench 1");
    expect(store.get().devices.aliases["usb/A"]).toBe("Bench 1");
    setDeviceAlias(store, "usb/A", "   ");
    expect("usb/A" in store.get().devices.aliases).toBe(false);
    setDeviceAlias(store, "usb/A", "Bench 2");
    setDeviceAlias(store, "usb/A", "");
    expect("usb/A" in store.get().devices.aliases).toBe(false);
  });

  it("clamps at 64 characters", () => {
    const store = new Store(initialState(), { freeze: true });
    setDeviceAlias(store, "usb/A", "x".repeat(100));
    expect(store.get().devices.aliases["usb/A"]).toBe("x".repeat(64));
  });

  it("caps at 64 entries, evicting the LEAST-recently-named unit", () => {
    const store = new Store(initialState(), { freeze: true });
    for (let i = 0; i < 64; i++) setDeviceAlias(store, `usb/${i}`, `Bench ${i}`);
    expect(Object.keys(store.get().devices.aliases)).toHaveLength(64);

    // The 65th insertion evicts the OLDEST-named unit (usb/0), no other.
    setDeviceAlias(store, "usb/64", "Bench 64");
    const aliases = store.get().devices.aliases;
    expect(Object.keys(aliases)).toHaveLength(64);
    expect("usb/0" in aliases).toBe(false);
    expect(aliases["usb/1"]).toBe("Bench 1");
    expect(aliases["usb/64"]).toBe("Bench 64");
  });

  it("re-naming an existing id moves it to the newest position, protecting it from the NEXT eviction", () => {
    const store = new Store(initialState(), { freeze: true });
    for (let i = 0; i < 64; i++) setDeviceAlias(store, `usb/${i}`, `Bench ${i}`);
    setDeviceAlias(store, "usb/0", "Bench 0 renamed"); // touched again — no longer the oldest
    setDeviceAlias(store, "usb/64", "Bench 64");
    const aliases = store.get().devices.aliases;
    expect(aliases["usb/0"]).toBe("Bench 0 renamed"); // survived the eviction
    expect("usb/1" in aliases).toBe(false); // usb/1 is now the oldest, evicted instead
  });
});

describe("aliases are app-side only — never ride the wire (issue #25 lot E2)", () => {
  it("no ipc call carries the alias string, across connect + setInputRange + startRun", async () => {
    const calls: [string, unknown][] = [];
    const ipc: Ipc = {
      call: (method: string, args?: unknown) => {
        calls.push([method, args]);
        switch (method) {
          case "list_devices":
            return Promise.resolve(list(fakeEntry("usb/A", { open: true })) as never);
          case "get_device_info":
            return Promise.resolve({
              model: "QA402",
              serial: "usb-A-serial",
              firmware_version: 60,
              product: "QA402 Audio Analyzer",
              sample_rates: [48000],
              supports_flash: false,
              capabilities: {} as never,
              is_virtual: false,
            } as never);
          case "get_device_config":
            return Promise.resolve({ input_gain: 18, output_gain: 8, sample_rate: 48000 } as never);
          case "get_input_dbv_offset":
          case "get_output_dbv_offset":
            return Promise.resolve({ offset_db: 0, calibrated: true } as never);
          default:
            return Promise.resolve(null as never);
        }
      },
    };

    const store = new Store(initialState(), { freeze: true });
    const alias = "My Very Own Analyzer";
    setDeviceAlias(store, "usb/A", alias);
    expect(store.get().devices.aliases["usb/A"]).toBe(alias);

    await connect(store, ipc, { deviceId: "usb/A" });
    await setInputRange(store, ipc, 18);
    await startRun(store, ipc);

    expect(calls.length).toBeGreaterThan(0);
    for (const [method, args] of calls) {
      expect(JSON.stringify(args), method).not.toContain(alias);
    }
  });
});

describe("deviceLost — routed by adopted deviceId (issue #25 lot E2)", () => {
  function twoAdoptedSessionsStore(): Store<AppState> {
    const store = new Store(initialState(), { freeze: true });
    store.update("test/two-sessions", (s) => ({
      ...s,
      devices: {
        ...s.devices,
        sessions: {
          [SLOT0]: {
            ...initialSession(0),
            deviceId: "usb/A",
            device: { ...initialSession(0).device, status: "connected" as const },
            run: { ...initialSession(0).run, streaming: true },
          },
          "slot-1": {
            ...initialSession(1),
            deviceId: "usb/B",
            device: { ...initialSession(1).device, status: "connected" as const },
            run: { ...initialSession(1).run, streaming: true },
          },
        },
      },
    }));
    return store;
  }

  it("deviceLost 'usb/B' EVICTS the session that adopted usb/B (lot E4 decision B4) — slot-0 (usb/A) stays streaming, and the loss is a wire-visible focus event only for survivors", () => {
    const store = twoAdoptedSessionsStore();
    const { ipc } = recordingIpc(list());
    deviceLost(store, ipc, "usb/B");
    const s = store.get();
    expect(s.devices.sessions["slot-1"]).toBeUndefined();
    expect(s.devices.focus).toBe(SLOT0);
    expect(s.devices.sessions[SLOT0].device.status).toBe("connected");
    expect(s.devices.sessions[SLOT0].run.streaming).toBe(true);
  });

  it("a duplicate loss event for an already-evicted id is a NO-OP while ≥ 2 sessions survive (the unmatched-id rule keeps covering the post-eviction echo)", () => {
    const store = twoAdoptedSessionsStore();
    store.update("test/third-session", (s) => ({
      ...s,
      devices: {
        ...s.devices,
        sessions: {
          ...s.devices.sessions,
          "slot-2": {
            ...initialSession(2),
            deviceId: "usb/C",
            device: { ...initialSession(2).device, status: "connected" as const },
            run: { ...initialSession(2).run, streaming: true },
          },
        },
      },
    }));
    const { ipc } = recordingIpc(list());
    deviceLost(store, ipc, "usb/B");
    deviceLost(store, ipc, "usb/B");
    const s = store.get();
    expect(s.devices.sessions["slot-1"]).toBeUndefined();
    expect(s.devices.sessions[SLOT0].device.status).toBe("connected");
    expect(s.devices.sessions[SLOT0].run.streaming).toBe(true);
    expect(s.devices.sessions["slot-2"].device.status).toBe("connected");
  });

  it("deviceLost(null) tears down slot 0 only (the payload-less monitor event)", () => {
    const store = twoAdoptedSessionsStore();
    const { ipc } = recordingIpc(list());
    deviceLost(store, ipc, null);
    const s = store.get();
    expect(s.devices.sessions[SLOT0].device.status).toBe("disconnected");
    expect(s.devices.sessions[SLOT0].run.streaming).toBe(false);
    expect(s.devices.sessions["slot-1"].device.status).toBe("connected");
    expect(s.devices.sessions["slot-1"].run.streaming).toBe(true);
  });

  it("with SEVERAL sessions, an id nobody adopted is a NO-OP — a stale enumeration clearing an id must not get slot 0 torn down for another unit's loss (E2 review #5)", () => {
    const store = twoAdoptedSessionsStore();
    const { ipc } = recordingIpc(list());
    deviceLost(store, ipc, "usb/never-adopted");
    const s = store.get();
    expect(s.devices.sessions[SLOT0].device.status).toBe("connected");
    expect(s.devices.sessions[SLOT0].run.streaming).toBe(true);
    expect(s.devices.sessions["slot-1"].device.status).toBe("connected");
  });

  it("a loss event for an id the registry KNOWS but no session holds is a NO-OP even at one session — device B's queued goodbye delivered after its removal must not tear down surviving device A (E4 review #3)", () => {
    const store = new Store(initialState(), { freeze: true });
    store.update("test/lone-adopted-with-known-b", (s) => ({
      ...s,
      devices: {
        ...deriveDevices(
          s.devices,
          list(fakeEntry("usb/A", { open: true, slot: 0 }), fakeEntry("usb/B"))
        ),
        sessions: {
          [SLOT0]: {
            ...initialSession(0),
            deviceId: "usb/A",
            device: { ...initialSession(0).device, status: "connected" as const },
            run: { ...initialSession(0).run, streaming: true },
          },
        },
      },
    }));
    deviceLost(store, recordingIpc(list()).ipc, "usb/B");
    expect(store.get().devices.sessions[SLOT0].device.status).toBe("connected");
    expect(store.get().devices.sessions[SLOT0].run.streaming).toBe(true);
  });

  it("an id UNKNOWN to the enumeration still falls back at one session — the smoke.pw.ts any-id ≡ payload-less contract", () => {
    const store = new Store(initialState(), { freeze: true });
    store.update("test/lone-adopted", (s) => ({
      ...s,
      devices: {
        ...deriveDevices(s.devices, list(fakeEntry("usb/A", { open: true, slot: 0 }))),
        sessions: {
          [SLOT0]: {
            ...initialSession(0),
            deviceId: "usb/A",
            device: { ...initialSession(0).device, status: "connected" as const },
            run: { ...initialSession(0).run, streaming: true },
          },
        },
      },
    }));
    deviceLost(store, recordingIpc(list()).ipc, "usb/never-seen");
    expect(store.get().devices.sessions[SLOT0].device.status).toBe("disconnected");
  });

  it("with slot 0 as the LONE session, an unmatched id still falls back to it — the pre-adoption window right after connect (unplug before the first enumeration lands)", () => {
    const store = new Store(initialState(), { freeze: true });
    store.update("test/pre-adoption", (s) => ({
      ...s,
      devices: {
        ...s.devices,
        sessions: {
          [SLOT0]: {
            ...initialSession(0),
            // deviceId still null — no enumeration answered yet.
            device: { ...initialSession(0).device, status: "connected" as const },
            run: { ...initialSession(0).run, streaming: true },
          },
        },
      },
    }));
    deviceLost(store, recordingIpc(list()).ipc, "usb/A");
    expect(store.get().devices.sessions[SLOT0].device.status).toBe("disconnected");
  });
});

describe("setFocusedSession (issue #25 lot E3 review #1) — the focus is a WIRE-VISIBLE input", () => {
  /** slot-0 plus an adopted, connected slot-1 session (streaming per arg). */
  function twoSessions(streaming: { slot0: boolean; slot1: boolean }): AppState {
    const s = initialState();
    const base = initialSession(1);
    return {
      ...s,
      devices: {
        ...s.devices,
        sessions: {
          [SLOT0]: {
            ...initialSession(0),
            device: { ...initialSession(0).device, status: "connected" as const },
            run: { ...initialSession(0).run, streaming: streaming.slot0 },
          },
          "slot-1": {
            ...base,
            deviceId: "usb/B",
            device: { ...base.device, status: "connected" as const },
            run: { ...base.run, streaming: streaming.slot1 },
          },
        },
      },
    };
  }

  it("moves the focus and re-syncs EVERY running stream in the same gesture — the DAC slot program follows the focus, so waiting for an unrelated bench edit would migrate the stimulus mid-capture", () => {
    const store = new Store(twoSessions({ slot0: true, slot1: true }), { freeze: true });
    const { ipc, calls } = recordingIpc(list());
    setFocusedSession(store, ipc, "slot-1");
    expect(store.get().devices.focus).toBe("slot-1");
    const updates = calls.filter(([m]) => m === "stream_update");
    expect(updates).toHaveLength(2); // both sessions stream → both re-synced
    // The routed update carries slot-1's adopted id; slot 0 stays arg-less.
    expect(updates.map(([, a]) => (a as { deviceId?: string }).deviceId).sort()).toEqual(
      [undefined, "usb/B"].sort()
    );
  });

  it("no-ops (store AND wire) for an unknown session key or the already-focused key", () => {
    const store = new Store(twoSessions({ slot0: true, slot1: false }), { freeze: true });
    const { ipc, calls } = recordingIpc(list());
    const before = store.get();
    setFocusedSession(store, ipc, "slot-7"); // no such session
    setFocusedSession(store, ipc, SLOT0); // already focused
    expect(store.get()).toBe(before);
    expect(calls).toHaveLength(0);
  });

  it("a focus switch under a running generator MOVES the stimulus in the same gesture (lot F2 — replaces the E4 refusal): old focus's generator stops, the new focus's stream picks up the sources, D3 clears the stranded output-only flag with one info toast", async () => {
    const base = twoSessions({ slot0: false, slot1: true });
    const store = new Store<AppState>(
      {
        ...base,
        devices: {
          ...base.devices,
          sessions: {
            ...base.devices.sessions,
            [SLOT0]: {
              ...base.devices.sessions[SLOT0],
              run: {
                ...base.devices.sessions[SLOT0].run,
                outputOnly: true,
                generatorRunning: true,
              },
            },
          },
        },
        sources: {
          order: ["src-sine-1"],
          byId: {
            "src-sine-1": {
              ...base.sources.byId["src-sine-1"],
              playing: true, // default target: follows the focus
            },
          },
        },
      },
      { freeze: true }
    );
    const { ipc, calls } = recordingIpc(list());
    setFocusedSession(store, ipc, "slot-1");
    await new Promise((r) => setTimeout(r, 0));
    // The move happened — no refusal.
    expect(store.get().devices.focus).toBe("slot-1");
    // Old focus: generator stopped (arg-less — slot 0), mode cleared (D3).
    expect(calls.some(([m]) => m === "stop_generator")).toBe(true);
    const slot0 = store.get().devices.sessions[SLOT0].run;
    expect(slot0.generatorRunning).toBe(false);
    expect(slot0.outputOnly).toBe(false);
    expect(
      store.get().ui.toasts.some(
        (t) => t.kind === "info" && t.message.includes("Output only")
      )
    ).toBe(true);
    // New focus: its running stream re-synced WITH the sources aboard.
    const upd = calls.find(([m]) => m === "stream_update");
    expect(upd).toBeDefined();
    const args = upd![1] as { deviceId?: string; config: { slots: unknown[] } };
    expect(args.deviceId).toBe("usb/B");
    expect(args.config.slots).toHaveLength(1);
  });

  it("D3 leaves output-only ALONE when a pinned target keeps feeding the outgoing session", async () => {
    const base = twoSessions({ slot0: false, slot1: false });
    const store = new Store<AppState>(
      {
        ...base,
        devices: {
          ...base.devices,
          sessions: {
            ...base.devices.sessions,
            [SLOT0]: {
              ...base.devices.sessions[SLOT0],
              run: {
                ...base.devices.sessions[SLOT0].run,
                outputOnly: true,
                generatorRunning: true,
              },
            },
          },
        },
        sources: {
          order: ["src-sine-1"],
          byId: {
            "src-sine-1": {
              ...base.sources.byId["src-sine-1"],
              playing: true,
              targets: [{ slot: 0, route: "left" }], // pinned to slot 0
            },
          },
        },
      },
      { freeze: true }
    );
    const { ipc, calls } = recordingIpc(list());
    setFocusedSession(store, ipc, "slot-1");
    await new Promise((r) => setTimeout(r, 0));
    expect(store.get().devices.focus).toBe("slot-1");
    const slot0 = store.get().devices.sessions[SLOT0].run;
    expect(slot0.outputOnly).toBe(true); // pinned stimulus: mode survives
    expect(calls.some(([m]) => m === "stop_generator")).toBe(false);
    // The generator REBUILDS on slot 0 (still its owner) rather than stop.
    expect(calls.some(([m]) => m === "output_only_start")).toBe(true);
    expect(store.get().ui.toasts).toHaveLength(0);
  });

  it("the fan-out never touches a LOCKED session elsewhere (F2 review MUST-FIX #1, reached through syncAllDacOwners) — a program owns that device exclusively, even when a pinned target routes a playing source onto it", async () => {
    const base = twoSessions({ slot0: false, slot1: false });
    const store = new Store<AppState>(
      {
        ...base,
        devices: {
          ...base.devices,
          sessions: {
            ...base.devices.sessions,
            // slot-2: a THIRD session, output-only and LOCKED by a running
            // program — output_only_start's own MUST-FIX #1 gate refuses a
            // rebuild queued against it directly (outputonly.test.ts pins
            // that unit). This test proves the same refusal holds when the
            // rebuild arrives via a focus change's bench-global fan-out.
            "slot-2": {
              ...initialSession(2),
              deviceId: "usb/C",
              device: { ...initialSession(2).device, status: "connected" as const },
              run: {
                ...initialSession(2).run,
                outputOnly: true,
                generatorRunning: false,
                programLock: "prog-1",
              },
            },
          },
        },
        sources: {
          order: ["src-sine-1"],
          byId: {
            "src-sine-1": {
              ...base.sources.byId["src-sine-1"],
              playing: true,
              targets: [{ slot: 2, route: "both" }], // pinned onto the LOCKED device
            },
          },
        },
      },
      { freeze: true }
    );
    const { ipc, calls } = recordingIpc(list());
    setFocusedSession(store, ipc, "slot-1");
    await new Promise((r) => setTimeout(r, 0));
    expect(store.get().devices.focus).toBe("slot-1");
    // No wire call of ANY kind named the locked device's id — not a rebuild
    // (output_only_start), not a stop, nothing.
    expect(calls.some(([, a]) => (a as { deviceId?: string } | undefined)?.deviceId === "usb/C")).toBe(
      false
    );
    // Store-side: the locked session's generator never flipped on.
    expect(store.get().devices.sessions["slot-2"].run.generatorRunning).toBe(false);
  });
});

describe("wire-verb isRoutable gates (E4 review #1) — an unroutable slot ≥ 1 key must never fall through to the default runtime", () => {
  /** A connected slot-1 session whose adopted id a stale enumeration just
   * cleared — the exact window where an arg-less call would land on the
   * OTHER device. */
  function unadoptedSlot1(): Store<AppState> {
    const store = new Store(initialState(), { freeze: true });
    store.update("test/unadopted-slot1", (s) => ({
      ...s,
      devices: {
        ...s.devices,
        sessions: {
          ...s.devices.sessions,
          "slot-1": {
            ...initialSession(1),
            device: { ...initialSession(1).device, status: "connected" as const },
          },
        },
      },
    }));
    return store;
  }

  it("setInputRange refuses — a range register is calibration-bearing, and moving the other device's mid-capture is the four-offsets class on the wire", async () => {
    const store = unadoptedSlot1();
    const { ipc, calls } = recordingIpc(list());
    await setInputRange(store, ipc, 18, "slot-1");
    expect(calls).toHaveLength(0);
  });

  it("refreshTelemetry refuses — the ~1 Hz poll must not take the default runtime's device mutex inside its capture, nor land device A's telemetry on device B's session", async () => {
    const store = unadoptedSlot1();
    const { ipc, calls } = recordingIpc(list());
    await refreshTelemetry(store, ipc, "slot-1");
    expect(calls).toHaveLength(0);
  });
});

describe("mintSession / dropSession — pure session mint/evict (issue #25 lot E4)", () => {
  it("mintSession is PURE: the input state is untouched, and the result holds fresh devices/sessions objects", () => {
    const before = initialState();
    const s = mintSession(before, 1, "usb/B");
    // The input is byte-for-byte untouched — no in-place mutation anywhere.
    expect(before.devices.sessions["slot-1"]).toBeUndefined();
    expect(Object.keys(before.devices.sessions)).toEqual([SLOT0]);
    // The output is a fresh object graph down to the touched sub-objects.
    expect(s).not.toBe(before);
    expect(s.devices).not.toBe(before.devices);
    expect(s.devices.sessions).not.toBe(before.devices.sessions);
    expect(s.devices.sessions[SLOT0]).toBe(before.devices.sessions[SLOT0]); // untouched sibling, same ref
  });

  it("adopts the deviceId AT MINT — isRoutable is true from the very first state, no unroutable window", () => {
    const s = mintSession(initialState(), 1, "usb/B");
    expect(s.devices.sessions["slot-1"].deviceId).toBe("usb/B");
    expect(isRoutable(s, "slot-1")).toBe(true); // bookkeeping item 1: true from instant one
    expect(s.devices.sessions["slot-1"].device.status).toBe("connecting");
    expect(s.devices.sessions["slot-1"].device.present).toBe(true);
  });

  it("leaves the focus untouched — an added device comes up in MONITOR mode (decision 1)", () => {
    const s = mintSession(initialState(), 1, "usb/B");
    expect(s.devices.focus).toBe(SLOT0);
  });

  it("dropSession moves a dropped focus to the LOWEST remaining slot and re-derives primary", () => {
    // Two open, enumerated units at slots 0/1 so derivePrimary's P1a rule
    // (the focused slot's open unit wins) has something to visibly react to.
    const enumerated = deriveDevices(
      empty(),
      list(fakeEntry("usb/A", { open: true, slot: 0 }), fakeEntry("usb/B", { open: true, slot: 1 }))
    );
    let s: AppState = { ...initialState(), devices: enumerated };
    s = mintSession(s, 1, "usb/B");
    s = { ...s, devices: { ...s.devices, focus: "slot-1", primary: "usb/B" } };
    expect(s.devices.primary).toBe("usb/B"); // focus slot-1's open unit wins (P1a)

    const next = dropSession(s, "slot-1");
    expect(next.devices.sessions["slot-1"]).toBeUndefined();
    expect(next.devices.focus).toBe(SLOT0); // fell back to the lowest remaining slot
    expect(next.devices.primary).toBe("usb/A"); // re-derived: slot-0's open unit now wins
  });

  it("dropSession(SLOT0) is IDENTITY — the default session is never dropped", () => {
    const s = initialState();
    expect(dropSession(s, SLOT0)).toBe(s);
  });

  it("dropSession on an unknown key is IDENTITY", () => {
    const s = mintSession(initialState(), 1, "usb/B");
    expect(dropSession(s, "slot-7")).toBe(s);
  });

  it("dropping a focus NOT on the evicted key leaves focus untouched", () => {
    let s = mintSession(initialState(), 1, "usb/B");
    s = mintSession(s, 2, "usb/C");
    // Focus stays on SLOT0 throughout (mintSession never moves it).
    const next = dropSession(s, "slot-2");
    expect(next.devices.focus).toBe(SLOT0);
    expect(next.devices.sessions["slot-1"]).toBeDefined(); // the OTHER added session survives
  });
});

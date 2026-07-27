/**
 * Devices-slice actions (issue #25 lot D): the deriveDevices fold (sticky
 * order, availability, the P1/P2 primary rules) and the tolerant refresh.
 * The P3 rule (an untouched picker must NOT turn auto-connect into
 * auto-demo) lives with the connect action's own tests.
 */
import { describe, expect, it } from "vitest";
import { Store } from "../store";
import { initialState } from "../state";
import type { DeviceList } from "../../gen";
import type { Ipc } from "../../ipc/ipc";
import { fakeEntry, fakeList as list } from "./devices.fixtures";
import { deriveDevices, pickDevice, refreshDevices } from "./devices";
import { autoConnectTick, connect } from "./device";

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

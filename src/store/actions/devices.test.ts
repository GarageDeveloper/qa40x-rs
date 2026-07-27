/**
 * Devices-slice actions (issue #25 lot D): the deriveDevices fold (sticky
 * order, availability, the P1/P2 primary rules) and the tolerant refresh.
 * The P3 rule (an untouched picker must NOT turn auto-connect into
 * auto-demo) lives with the connect action's own tests.
 */
import { describe, expect, it } from "vitest";
import { Store } from "../store";
import { initialState } from "../state";
import type { DeviceEntry, DeviceList } from "../../gen";
import type { Ipc } from "../../ipc/ipc";
import { deriveDevices, pickDevice, refreshDevices } from "./devices";
import { autoConnectTick, connect } from "./device";

export function fakeEntry(
  id: string,
  opts: { virtual?: boolean; open?: boolean; model?: "QA402" | "QA403" } = {}
): DeviceEntry {
  const model = opts.model ?? (opts.virtual ? "QA403" : "QA402");
  const rates =
    model === "QA403" ? [48000, 96000, 192000, 384000] : [48000, 96000, 192000];
  return {
    id,
    source_id: opts.virtual ? "virtual" : "usb",
    source_kind: opts.virtual ? "Virtual" : "Usb",
    source_label: opts.virtual ? "Built-in virtual" : "USB",
    model,
    serial: id.split("/")[1],
    serial_synthetic: false,
    product: `${model} Audio Analyzer`,
    firmware_version: opts.open ? 60 : null,
    is_virtual: opts.virtual ?? false,
    capabilities: {
      model_name: model,
      input_channels: 2,
      output_channels: 2,
      sample_rates_hz: rates,
      input_ranges_dbv: [0, 6, 12, 18, 24, 30, 36, 42],
      output_ranges_dbv: [-12, -2, 8, 18],
      min_output_vrms: 1e-6,
      max_output_vrms: 7.943,
      max_input_vrms: 89.13,
      min_measurement_hz: 5,
      max_measurement_hz: rates[rates.length - 1] / 2,
      calibration: opts.open ? { FactoryEeprom: { page_bytes: 512 } } : "Unknown",
      supports_flash: false,
      is_virtual: opts.virtual ?? false,
    },
    open: opts.open ?? false,
  };
}

function list(...devices: DeviceEntry[]): DeviceList {
  return { devices, open: devices.filter((d) => d.open).map((d) => d.id) };
}

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
});

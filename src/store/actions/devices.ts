/**
 * Devices-slice actions (issue #25 lot D): enumeration → store, and the
 * user's picker choice. Same unidirectional discipline as actions/device.ts
 * (IPC → store, never store → IPC as a render side effect).
 */
import type { Ipc } from "../../ipc/ipc";
import type { DeviceList } from "../../gen";
import type { Store } from "../store";
import type { AppState, DevicesState } from "../state";

/**
 * The primary derivation (the unit the single-device UI describes):
 *   P1  an open unit wins;
 *   P2  else the user's pick, while it is still available;
 *       else the first available PHYSICAL unit (a plugged-in QA40x must win
 *       over the built-in virtual — otherwise an empty bench would surface
 *       the simulator as "the device");
 *       else the first available unit; else null.
 */
function derivePrimary(d: Omit<DevicesState, "primary">): string | null {
  const open = d.available.find((id) => d.byId[id]?.open);
  if (open) return open;
  if (d.pick !== null && d.available.includes(d.pick)) return d.pick;
  const physical = d.available.find((id) => !d.byId[id]?.is_virtual);
  return physical ?? d.available[0] ?? null;
}

/**
 * Fold one enumeration answer into the slice (pure — the vitest target).
 * `order` is sticky: a unit keeps its slot across a vanish/reappear;
 * `available` reflects only THIS answer; entries refresh verbatim.
 */
export function deriveDevices(prev: DevicesState, list: DeviceList): DevicesState {
  const byId = { ...prev.byId };
  for (const entry of list.devices) {
    byId[entry.id] = entry;
  }
  const available = list.devices.map((d) => d.id);
  const order = [...prev.order];
  for (const id of available) {
    if (!order.includes(id)) order.push(id);
  }
  const next = { order, byId, available, pick: prev.pick, enumerating: false };
  return { ...next, primary: derivePrimary(next) };
}

/**
 * Enumerate and fold. Tolerant: a failed call keeps the last list (the bar
 * must not flicker empty on a transient USB error) and only clears the
 * in-flight flag.
 */
export async function refreshDevices(
  store: Store<AppState>,
  ipc: Ipc
): Promise<void> {
  store.update("devices/enumerating", (s) => ({
    ...s,
    devices: { ...s.devices, enumerating: true },
  }));
  try {
    const list = await ipc.call("list_devices", {});
    store.update("devices/refreshed", (s) => ({
      ...s,
      devices: deriveDevices(s.devices, list),
    }));
  } catch {
    store.update("devices/refresh-failed", (s) => ({
      ...s,
      devices: { ...s.devices, enumerating: false },
    }));
  }
}

/** The user's explicit picker choice (null = back to auto). Pure store
 * write — connecting to it is a separate, explicit Connect click. */
export function pickDevice(store: Store<AppState>, id: string | null): void {
  store.update("devices/pick", (s) => {
    const next = { ...s.devices, pick: id };
    return { ...s, devices: { ...next, primary: derivePrimary(next) } };
  });
}

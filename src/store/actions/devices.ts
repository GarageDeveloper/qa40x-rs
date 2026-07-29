/**
 * Devices-slice actions (issue #25 lot D): enumeration → store, and the
 * user's picker choice. Same unidirectional discipline as actions/device.ts
 * (IPC → store, never store → IPC as a render side effect).
 */
import type { Ipc } from "../../ipc/ipc";
import type { DeviceList } from "../../gen";
import type { Store } from "../store";
import type { AppState, DevicesState, SessionKey } from "../state";
import { SLOT0, initialSession, sessionKeyForSlot, slotOfSessionKey } from "../state";
import { sessionLabel } from "../selectors/devices";
import { sessionHasSources } from "../selectors/sources";
import { updateRun } from "../selectors/session";
import { syncAllDacOwners } from "./outputonly";
import { toast } from "./ui";

/**
 * Make `key` the FOCUSED session — the Run/Space target, the single-device
 * chrome's subject and the bench-source owner (Raphaël decisions 1–2).
 * E4's focus selector / group headers call this; dormant in E3 (nothing
 * changes the boot focus while only slot 0 exists).
 *
 * The focus is a WIRE-VISIBLE input: every source whose matrix keeps the
 * default focus-following target (`slot: null` — selectors/sources.ts)
 * resolves onto the focused session, so BOTH DAC-owner kinds must re-sync
 * IN THIS GESTURE (E3 review #1, extended to generators by lot F2) —
 * running streams re-push their config AND every session's gap-free
 * generator rebuilds or stops (`syncAllDacOwners`): the stimulus moves
 * atomically with the focus, never strands on the old device (the E4
 * refusal this replaces), and pinned targets don't move at all (R1).
 * `primary` is re-derived for the same reason it is at every refresh: the
 * chrome must describe the unit the transport now acts on (P1a).
 *
 * D3 (lot F2): a session LOSING the focus with output-only on and nothing
 * routed onto it afterwards has the mode cleared in the same update, with
 * one info toast — the footer checkbox is focus-bound, so a set flag on a
 * non-focused session would be invisible chrome silently re-arming a DAC
 * on the next source edit.
 */
export function setFocusedSession(
  store: Store<AppState>,
  ipc: Ipc,
  key: SessionKey
): void {
  const s = store.get();
  if (s.devices.focus === key || !s.devices.sessions[key]) return;
  const outgoing = s.devices.focus;
  let clearedOutputOnly = false;
  store.update("devices/focus", (st) => {
    if (!st.devices.sessions[key]) return st;
    const devices = { ...st.devices, focus: key };
    let next: AppState = {
      ...st,
      devices: { ...devices, primary: derivePrimary(devices) },
    };
    if (
      next.devices.sessions[outgoing]?.run.outputOnly &&
      !sessionHasSources(next, outgoing)
    ) {
      next = updateRun(next, outgoing, (r) => ({ ...r, outputOnly: false }));
      clearedOutputOnly = true;
    }
    return next;
  });
  if (clearedOutputOnly) {
    toast(
      store,
      "info",
      `Output only turned off on ${sessionLabel(store.get(), outgoing)} — ` +
        "no playing source routes to it anymore."
    );
  }
  syncAllDacOwners(store, ipc);
}

/**
 * The primary derivation (the unit the single-device UI describes):
 *   P1a the open unit at the FOCUSED session's slot wins — the chrome must
 *       describe the unit the transport acts on, never whichever unit
 *       happens to enumerate first (issue #25 lot E1 review #9);
 *   P1b else the LOWEST open slot (slot 0 = the target of unrouted
 *       commands, so the chrome and the wire stay in agreement);
 *   P2  else the user's pick, while it is still available;
 *       else the first available PHYSICAL unit (a plugged-in QA40x must win
 *       over the built-in virtual — otherwise an empty bench would surface
 *       the simulator as "the device");
 *       else the first available unit; else null.
 */
function derivePrimary(d: Omit<DevicesState, "primary">): string | null {
  const open = d.available.filter((id) => d.byId[id]?.open);
  if (open.length > 0) {
    const focusSlot = slotOfSessionKey(d.focus);
    const atFocus = open.find((id) => d.byId[id]?.slot === focusSlot);
    if (atFocus !== undefined) return atFocus;
    return [...open].sort(
      (a, b) => (d.byId[a]?.slot ?? Infinity) - (d.byId[b]?.slot ?? Infinity)
    )[0];
  }
  if (d.pick !== null && d.available.includes(d.pick)) return d.pick;
  const physical = d.available.find((id) => !d.byId[id]?.is_virtual);
  return physical ?? d.available[0] ?? null;
}

/**
 * Mint the session for a unit just opened on `slot` (issue #25 lot E4) —
 * PURE, with the registry id adopted AT MINT: the id comes from the
 * `connect_additional_device` answer itself, so `isRoutable` is true from
 * the first instant and no command can fall through to the default runtime
 * (bookkeeping item 1). The focus is deliberately untouched — an added
 * device comes up in MONITOR mode (Raphaël decision 1: only the focused
 * session carries the bench's sources). Status starts "connecting"; the
 * add flow flips it once `get_device_info` answers.
 */
export function mintSession(s: AppState, slot: number, deviceId: string): AppState {
  const key = sessionKeyForSlot(slot);
  const base = initialSession(slot);
  const sessions = {
    ...s.devices.sessions,
    [key]: {
      ...base,
      deviceId,
      device: { ...base.device, status: "connecting" as const, present: true },
    },
  };
  const devices = { ...s.devices, sessions };
  return { ...s, devices: { ...devices, primary: derivePrimary(devices) } };
}

/**
 * Evict a session (device removed or lost — issue #25 lot E4). PURE.
 * SLOT0 is never dropped (the connect/demo flows own it). A focus on the
 * dropped key falls back to the lowest remaining slot; the CALLER must
 * re-sync every running stream in the same gesture (the setFocusedSession
 * rationale: the DAC slot program follows the focus).
 */
export function dropSession(s: AppState, key: SessionKey): AppState {
  if (key === SLOT0 || !s.devices.sessions[key]) return s;
  const sessions = { ...s.devices.sessions };
  delete sessions[key];
  const focus =
    s.devices.focus === key
      ? (Object.values(sessions).sort((a, b) => a.slot - b.slot)[0]?.key ?? SLOT0)
      : s.devices.focus;
  const devices = { ...s.devices, sessions, focus };
  return { ...s, devices: { ...devices, primary: derivePrimary(devices) } };
}

/**
 * Fold one enumeration answer into the slice (pure — the vitest target).
 * `order` is sticky: a unit keeps its slot across a vanish/reappear;
 * `available` reflects only THIS answer; entries refresh verbatim.
 *
 * Sessions adopt their unit's REGISTRY ID here (lot E2 — the first
 * frontend consumer of `DeviceEntry.slot`/`open`): the open entry whose
 * slot matches becomes the session's `deviceId`; an answer with nothing
 * open at that slot clears the id but NEVER touches `device.status` —
 * only disconnect()/deviceLost()/a failed connect() move status, and a
 * transiently stale scan must not invent a disconnect.
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
  let sessions = prev.sessions;
  for (const sess of Object.values(prev.sessions)) {
    const entry = list.devices.find((d) => d.open && d.slot === sess.slot);
    const id = entry?.id ?? null;
    if (sess.deviceId !== id) {
      sessions = { ...sessions, [sess.key]: { ...sess, deviceId: id } };
    }
  }
  const next = {
    order,
    byId,
    available,
    pick: prev.pick,
    enumerating: false,
    adding: prev.adding,
    sessions,
    focus: prev.focus,
    aliases: prev.aliases,
  };
  return { ...next, primary: derivePrimary(next) };
}

/** Longest alias kept (UI sanity — a rename field, not a note field). */
const MAX_ALIAS_CHARS = 64;
/** Most remembered aliases; the oldest-set entry is evicted past this (a
 * long-lived install sees many units; the map must not grow unbounded). */
const MAX_ALIAS_ENTRIES = 64;

/**
 * Name (or un-name) a unit (issue #25 lot E2, Raphaël decision 3). Pure
 * store write, keyed by REGISTRY ID (see `DevicesState.aliases`); empty or
 * whitespace clears the alias. Persistence is main.ts's localStorage
 * mirror; nothing here (or anywhere) puts an alias on the wire.
 */
export function setDeviceAlias(
  store: Store<AppState>,
  deviceId: string,
  alias: string | null
): void {
  store.update("devices/alias", (s) => {
    const trimmed = (alias ?? "").trim().slice(0, MAX_ALIAS_CHARS);
    const prev = s.devices.aliases;
    if (trimmed === "") {
      if (!(deviceId in prev)) return s;
      const aliases = { ...prev };
      delete aliases[deviceId];
      return { ...s, devices: { ...s.devices, aliases } };
    }
    if (prev[deviceId] === trimmed) return s;
    // Re-inserting moves the id to the newest position (delete-then-set),
    // so the size cap below evicts the LEAST-recently-named unit.
    const aliases = { ...prev };
    delete aliases[deviceId];
    aliases[deviceId] = trimmed;
    const keys = Object.keys(aliases);
    for (let i = 0; keys.length - i > MAX_ALIAS_ENTRIES; i++) {
      delete aliases[keys[i]];
    }
    return { ...s, devices: { ...s.devices, aliases } };
  });
}

/** Monotonic enumeration sequencing (reviewer finding #1): refreshes
 * overlap routinely (the 2 s tick vs the connect/disconnect/device-lost
 * refreshes), and a STALE answer landing last must not resurrect a unit
 * that a fresher scan already saw unplugged — the picker would appear for
 * a ghost, and a stale pick would ride `connect_device` into a sticky
 * error toast. Newest-STARTED wins; older answers are dropped. */
let refreshStarted = 0;
let refreshApplied = 0;

/**
 * Enumerate and fold. Tolerant: a failed or superseded call keeps the last
 * list (the bar must not flicker empty on a transient USB error) and only
 * clears the in-flight flag.
 */
export async function refreshDevices(
  store: Store<AppState>,
  ipc: Ipc
): Promise<void> {
  const seq = ++refreshStarted;
  store.update("devices/enumerating", (s) => ({
    ...s,
    devices: { ...s.devices, enumerating: true },
  }));
  try {
    const list = await ipc.call("list_devices", {});
    if (seq <= refreshApplied) return; // superseded by a fresher answer
    refreshApplied = seq;
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

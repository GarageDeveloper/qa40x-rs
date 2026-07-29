/**
 * Devices-slice selectors (issue #25 lot D): what the device bar reads.
 * Ranges and rates come from the PRIMARY unit's backend capabilities — the
 * frontend range consts are gone (the backend register maps are the one
 * authority; `caps.rs` pins the values).
 */
import type { DeviceCapabilities, DeviceEntry } from "../../gen";
import type { AppState } from "../state";
import { hwTraceIds } from "../hwtraces";
import type { SessionKey } from "../sessionkey";
import { slotOfSessionKey } from "../sessionkey";
import { focusedDevice, session } from "./session";

/** The unit the single-device UI describes (see `DevicesState.primary`). */
export function primaryEntry(s: AppState): DeviceEntry | null {
  const id = s.devices.primary;
  return id !== null ? s.devices.byId[id] ?? null : null;
}

export function primaryCaps(s: AppState): DeviceCapabilities | null {
  return primaryEntry(s)?.capabilities ?? null;
}

/** Stable empty fallback: the panel selectors run inside `store.select`
 * with shallow equality — a fresh `[]` per evaluation would defeat the
 * guard and re-fire the callback on every store batch (review #5). */
const NO_VALUES: number[] = [];

/** Input full-scale ranges (dBV) for the range menu. Empty only before the
 * first enumeration lands (the built-in virtual source always answers) —
 * the panel renders a disabled placeholder then, never a collapsed select. */
export function inputRangesDbv(s: AppState): number[] {
  return primaryCaps(s)?.input_ranges_dbv ?? NO_VALUES;
}

/** Output full-scale ranges (dBV) for the range menu. */
export function outputRangesDbv(s: AppState): number[] {
  return primaryCaps(s)?.output_ranges_dbv ?? NO_VALUES;
}

/** Sample rates (Hz) for the rate menu — 384 kHz appears iff the unit is a
 * QA403 (the capability record carries it, not the model name). While
 * CONNECTED the open device's own metadata is authoritative (review #3): a
 * transiently stale `primary` (overlapping refreshes, the reconnect
 * bookkeeping window) must not hand the menu another model's table — a
 * QA403 running at 384 kHz would render a BLANK select if the offered list
 * lacked its current rate. */
export function sampleRatesHz(s: AppState): number[] {
  const entry = primaryEntry(s);
  const device = focusedDevice(s);
  if (device.status === "connected" && !entry?.open && device.info) {
    return device.info.sample_rates;
  }
  return entry?.capabilities.sample_rates_hz ?? device.info?.sample_rates ?? NO_VALUES;
}

/** The display name of a unit: its user alias when one is stored (issue
 * #25 lot E2, Raphaël decision 3), else the identity string the picker has
 * always rendered — byte-identical with no alias, pinned by a vitest test
 * against the historical literal. */
export function deviceLabel(s: AppState, entry: DeviceEntry): string {
  return (
    s.devices.aliases[entry.id] ??
    `${entry.model} · ${entry.serial}${entry.is_virtual ? " (virtual)" : ""}`
  );
}

/** Every available unit, in backend order (USB first, then the virtual). */
export function availableEntries(s: AppState): DeviceEntry[] {
  return s.devices.available
    .map((id) => s.devices.byId[id])
    .filter((d): d is DeviceEntry => d !== undefined);
}

/** Available PHYSICAL units, in backend order. */
export function physicalAvailable(s: AppState): DeviceEntry[] {
  return s.devices.available
    .map((id) => s.devices.byId[id])
    .filter((d): d is DeviceEntry => d !== undefined && !d.is_virtual);
}

/** Rule P3 — what the Connect BUTTON passes to `connect_device`: the user's
 * explicit pick while it is still available, else undefined (the arg-less
 * legacy call). Never the primary: with no hardware the primary is the
 * built-in virtual, and an untouched picker must not turn Connect into
 * Demo. */
export function pickedDeviceId(s: AppState): string | undefined {
  const pick = s.devices.pick;
  return pick !== null && s.devices.available.includes(pick) ? pick : undefined;
}

/** Rule P4 — what the auto-connect TICK passes: the pick, but only while it
 * names an available PHYSICAL unit (a virtual pick must not make the tick
 * auto-demo; a vanished pick falls back to the legacy first-physical). */
export function autoConnectDeviceId(s: AppState): string | undefined {
  const pick = pickedDeviceId(s);
  return pick !== undefined && !s.devices.byId[pick]?.is_virtual ? pick : undefined;
}

/** Number of live sessions: slot 0 always, plus one per added device while
 * it is open (an eviction removes its session). ≥ 2 ⇒ the bench is
 * multi-device (issue #25 lot E4). */
export function liveSessionCount(s: AppState): number {
  return Object.keys(s.devices.sessions).length;
}

/** Picker policy: shown when ≥2 physical units are enumerated (lot D) OR
 * when ≥2 sessions are live (lot E4 — the likely dev bench is demo + one
 * real unit: one physical, yet the focus must be selectable). With 0 or 1
 * QA40x on the bus and a single session, the bar is byte-for-byte the
 * pre-lot-D bar — the pixel-identity guarantee; the Demo button stays the
 * one-click no-hardware path. */
export function showDevicePicker(s: AppState): boolean {
  return physicalAvailable(s).length >= 2 || liveSessionCount(s) >= 2;
}

/** The toolbar `device-select`'s mode (issue #25 lot E4, decision B7):
 * "pick" ⇒ byte-identical lot-D picker (which unit would Connect open);
 * "focus" at ≥ 2 live sessions ⇒ the focus selector (which open device the
 * transport/chrome follow — option values are SESSION KEYS, handler is
 * setFocusedSession). Read at dispatch time, never captured. */
export function focusSelectorMode(s: AppState): "pick" | "focus" {
  return liveSessionCount(s) >= 2 ? "focus" : "pick";
}

/** Enumerated units the add-device menu offers (issue #25 lot E4): not
 * open anywhere, not held by a session (a transiently stale enumeration
 * must not re-offer a unit a session still holds), no add in flight. */
export function addableEntries(s: AppState): DeviceEntry[] {
  const held = new Set(
    Object.values(s.devices.sessions)
      .map((x) => x.deviceId)
      .filter((id): id is string => id !== null)
  );
  return availableEntries(s).filter(
    (d) => !d.open && !held.has(d.id) && !s.devices.adding.includes(d.id)
  );
}

/**
 * The addable unit a DORMANT (or disconnected) group's own capture
 * provenance names, if it is on the bus — the one-click revive target
 * (Raphaël 2026-07-28: "pourquoi ne pas le ressusciter directement ?").
 * A group only knows its SLOT (docs are bench-portable, never device-
 * bound), but its endpoint traces carry the model+serial of the device
 * that PRODUCED their frames (issue #40's snapshot, persisted with the
 * doc) — matched here against the current enumeration. Null when the
 * group never captured, or its unit is not enumerable right now: the
 * generic + device menu stays the fallback.
 */
export function reviveCandidateId(s: AppState, slot: number): string | null {
  if (slot === 0) return null;
  const addable = addableEntries(s);
  if (addable.length === 0) return null;
  for (const id of Object.values(hwTraceIds(slot))) {
    const dev = s.traces.byId[id]?.capture?.device;
    if (!dev) continue;
    const match = addable.find(
      (e) => e.serial === dev.serial && e.model === dev.model
    );
    if (match) return match.id;
  }
  return null;
}

/**
 * A DORMANT group's display identity, from its endpoints' persisted capture
 * (issue #25 lot F, Raphaël's F1-validation round): the unit that produced
 * the rows — `"QA403 · 0DE0_0002 (virtual)"` — instead of the anonymous
 * `Device #2` placeholder, so a restart leaves the group recognizable next
 * to its enabled revive. Null when the group never had an identity (the
 * slot-derived placeholder stays — never another unit's name).
 */
export function dormantGroupLabel(s: AppState, slot: number): string | null {
  for (const id of Object.values(hwTraceIds(slot))) {
    const dev = s.traces.byId[id]?.capture?.device;
    if (dev) return `${dev.model} · ${dev.serial}${dev.isVirtual ? " (virtual)" : ""}`;
  }
  return null;
}

/** A session's display name for group headers and the focus selector:
 * alias-aware unit label when the registry entry is known, else the
 * session's own DeviceMeta identity, else a slot-derived placeholder
 * (`Device #2` — never another unit's name, item 8). */
export function sessionLabel(s: AppState, key: SessionKey): string {
  const sess = session(s, key);
  const id = sess?.deviceId ?? null;
  const entry = id !== null ? s.devices.byId[id] : undefined;
  if (entry) return deviceLabel(s, entry);
  const info = sess?.device.info;
  if (info) {
    return `${info.model} · ${info.serial}${info.is_virtual ? " (virtual)" : ""}`;
  }
  return `Device #${(sess?.slot ?? slotOfSessionKey(key)) + 1}`;
}

/** The registry entry a session's unit maps to (null while unadopted). */
function sessionEntry(s: AppState, key: SessionKey): DeviceEntry | null {
  const id = session(s, key)?.deviceId;
  return id ? s.devices.byId[id] ?? null : null;
}

/* Per-session range/rate tables (issue #25 lot E4): the group-header
 * controls must offer THIS unit's registers, never the primary's — two
 * different models on one bench have different tables. Same
 * connected-unit-wins rule as sampleRatesHz (lot D review #3). */

export function sessionInputRanges(s: AppState, key: SessionKey): number[] {
  return sessionEntry(s, key)?.capabilities.input_ranges_dbv ?? NO_VALUES;
}

export function sessionOutputRanges(s: AppState, key: SessionKey): number[] {
  return sessionEntry(s, key)?.capabilities.output_ranges_dbv ?? NO_VALUES;
}

export function sessionRates(s: AppState, key: SessionKey): number[] {
  const entry = sessionEntry(s, key);
  const device = session(s, key)?.device;
  if (device?.status === "connected" && !entry?.open && device.info) {
    return device.info.sample_rates;
  }
  return entry?.capabilities.sample_rates_hz ?? device?.info?.sample_rates ?? NO_VALUES;
}

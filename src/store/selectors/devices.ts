/**
 * Devices-slice selectors (issue #25 lot D): what the device bar reads.
 * Ranges and rates come from the PRIMARY unit's backend capabilities — the
 * frontend range consts are gone (the backend register maps are the one
 * authority; `caps.rs` pins the values).
 */
import type { DeviceCapabilities, DeviceEntry } from "../../gen";
import type { AppState } from "../state";

/** The unit the single-device UI describes (see `DevicesState.primary`). */
export function primaryEntry(s: AppState): DeviceEntry | null {
  const id = s.devices.primary;
  return id !== null ? s.devices.byId[id] ?? null : null;
}

export function primaryCaps(s: AppState): DeviceCapabilities | null {
  return primaryEntry(s)?.capabilities ?? null;
}

/** Input full-scale ranges (dBV) for the range menu. Empty only before the
 * first enumeration lands (the built-in virtual source always answers) —
 * the panel renders a disabled placeholder then, never a collapsed select. */
export function inputRangesDbv(s: AppState): number[] {
  return primaryCaps(s)?.input_ranges_dbv ?? [];
}

/** Output full-scale ranges (dBV) for the range menu. */
export function outputRangesDbv(s: AppState): number[] {
  return primaryCaps(s)?.output_ranges_dbv ?? [];
}

/** Sample rates (Hz) for the rate menu — 384 kHz appears iff the primary
 * unit is a QA403 (the capability record carries it, not the model name). */
export function sampleRatesHz(s: AppState): number[] {
  return primaryCaps(s)?.sample_rates_hz ?? [];
}

/** Available PHYSICAL units, in backend order. */
export function physicalAvailable(s: AppState): DeviceEntry[] {
  return s.devices.available
    .map((id) => s.devices.byId[id])
    .filter((d): d is DeviceEntry => d !== undefined && !d.is_virtual);
}

/** Picker policy (lot D): shown only when ≥2 physical units are enumerated.
 * With 0 or 1 QA40x on the bus the bar is byte-for-byte the pre-lot-D bar —
 * the pixel-identity guarantee; the Demo button stays the one-click
 * no-hardware path. */
export function showDevicePicker(s: AppState): boolean {
  return physicalAvailable(s).length >= 2;
}

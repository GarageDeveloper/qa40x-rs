/**
 * Devices selectors (issue #25 lot D). The range pins here REPLACE the
 * deleted `INPUT_RANGES_DBV`/`OUTPUT_RANGES_DBV` consts: the menus must
 * offer exactly the register-map tables (`caps.rs` pins the same values
 * backend-side), and the QA402/QA403 rate split must survive the trip
 * through the slice.
 */
import { describe, expect, it } from "vitest";
import { initialState } from "../state";
import type { AppState } from "../state";
import { fakeEntry } from "../actions/devices.fixtures";
import { deriveDevices } from "../actions/devices";
import type { DeviceEntry } from "../../gen";
import {
  deviceLabel,
  inputRangesDbv,
  outputRangesDbv,
  physicalAvailable,
  primaryCaps,
  primaryEntry,
  sampleRatesHz,
  showDevicePicker,
} from "./devices";

function withDevices(...devices: DeviceEntry[]): AppState {
  const s = initialState();
  return {
    ...s,
    devices: deriveDevices(s.devices, {
      devices,
      open: devices.filter((d) => d.open).map((d) => d.id),
    }),
  };
}

describe("primaryEntry / primaryCaps", () => {
  it("resolves the primary unit's entry", () => {
    const s = withDevices(fakeEntry("usb/A"), fakeEntry("virtual/V", { virtual: true }));
    expect(primaryEntry(s)?.id).toBe("usb/A");
    expect(primaryCaps(s)?.model_name).toBe("QA402");
  });

  it("is null before the first enumeration", () => {
    const s = initialState();
    expect(primaryEntry(s)).toBeNull();
    expect(primaryCaps(s)).toBeNull();
  });
});

describe("range/rate menus from backend capabilities", () => {
  it("offers the register-map range tables (the deleted consts' pin)", () => {
    const s = withDevices(fakeEntry("usb/A"));
    expect(inputRangesDbv(s)).toEqual([0, 6, 12, 18, 24, 30, 36, 42]);
    expect(outputRangesDbv(s)).toEqual([-12, -2, 8, 18]);
  });

  it("a QA403 primary offers 384 kHz, a QA402 does not", () => {
    const qa403 = withDevices(fakeEntry("usb/A", { model: "QA403" }));
    expect(sampleRatesHz(qa403)).toEqual([48000, 96000, 192000, 384000]);
    const qa402 = withDevices(fakeEntry("usb/A", { model: "QA402" }));
    expect(sampleRatesHz(qa402)).toEqual([48000, 96000, 192000]);
  });

  it("empty (placeholder-rendered) menus before the first enumeration", () => {
    const s = initialState();
    expect(inputRangesDbv(s)).toEqual([]);
    expect(outputRangesDbv(s)).toEqual([]);
    expect(sampleRatesHz(s)).toEqual([]);
  });
});

describe("deviceLabel — the alias read-through (issue #25 lot E2, Raphaël decision 3)", () => {
  it("with no alias: byte-identical to the historical picker literal", () => {
    const s = initialState();
    const entry = fakeEntry("usb/A", { model: "QA402" });
    expect(deviceLabel(s, entry)).toBe(
      `${entry.model} · ${entry.serial}${entry.is_virtual ? " (virtual)" : ""}`
    );
    expect(deviceLabel(s, entry)).toBe("QA402 · A"); // fakeEntry's serial = id.split("/")[1]
  });

  it("a virtual unit's literal still carries the ' (virtual)' suffix with no alias", () => {
    const s = initialState();
    const entry = fakeEntry("virtual/V", { virtual: true });
    expect(deviceLabel(s, entry)).toBe("QA403 · V (virtual)");
  });

  it("with an alias set: returns the alias instead of the identity literal", () => {
    const entry = fakeEntry("usb/A");
    const s: AppState = {
      ...initialState(),
      devices: { ...initialState().devices, aliases: { "usb/A": "My Bench" } },
    };
    expect(deviceLabel(s, entry)).toBe("My Bench");
  });
});

describe("picker policy", () => {
  it("hidden with 0 or 1 physical unit (the pixel-identity guarantee)", () => {
    expect(showDevicePicker(initialState())).toBe(false);
    const one = withDevices(fakeEntry("usb/A"), fakeEntry("virtual/V", { virtual: true }));
    expect(showDevicePicker(one)).toBe(false);
    expect(physicalAvailable(one).map((d) => d.id)).toEqual(["usb/A"]);
  });

  it("shown with ≥2 physical units; the virtual never counts", () => {
    const two = withDevices(
      fakeEntry("usb/A"),
      fakeEntry("usb/B"),
      fakeEntry("virtual/V", { virtual: true })
    );
    expect(showDevicePicker(two)).toBe(true);
    expect(physicalAvailable(two).map((d) => d.id)).toEqual(["usb/A", "usb/B"]);
  });
});

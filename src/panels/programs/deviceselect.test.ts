// @vitest-environment jsdom
/**
 * The ⚙ dialogs' Device row (`programDeviceRow`, issue #25 lot F4) — no
 * direct test existed for this module before (only reached indirectly
 * through the full sweep/script dialog mount, and only the "hides on a
 * single-device bench, appears with the second session" shape via
 * tests/e2e/programs-per-device.pw.ts). This file pins the row builder in
 * isolation: the byte-identical single-device default, the dormant-pin
 * escape hatch ("not connected", the same rule as F3's routing editor),
 * and `sampleRateHz()`'s live re-resolution as the selection changes —
 * exactly what `sweepdialog.ts`'s Nyquist clamp depends on.
 */
import { describe, expect, it } from "vitest";

import { Store } from "../../store/store";
import { initialSession, initialState, type AppState, type DeviceSession } from "../../store/state";
import { withDevice } from "../../store/actions/sessions.fixtures";
import { addProgram, setProgramDeviceSlot } from "../../store/actions/programs";
import { programDeviceRow } from "./deviceselect";

/** `s` with a CONNECTED, id-adopted second session at slot 1, its own
 * sample rate — same shape as the other F4 suites' fixture. */
function withConnectedSlot1(s: AppState, sampleRate = 96000): AppState {
  const sess: DeviceSession = {
    ...initialSession(1),
    deviceId: "usb/B",
    device: {
      ...initialSession(1).device,
      status: "connected",
      config: { input_gain: 0, output_gain: 18, sample_rate: sampleRate },
      info: {
        model: "QA402",
        firmware_version: 55,
        serial: "B-SERIAL",
        product: "QA402 Audio Analyzer",
        sample_rates: [sampleRate],
        supports_flash: false,
        capabilities: {} as never,
        is_virtual: false,
      },
    },
  };
  return {
    ...s,
    devices: { ...s.devices, sessions: { ...s.devices.sessions, "slot-1": sess } },
  };
}

describe("panels/programs/deviceselect — programDeviceRow", () => {
  it("single-device bench, no pin: hidden, exactly 2 options, value() null (byte-identical dialog)", () => {
    const store = new Store(withDevice(initialState(), { status: "connected" }));
    const id = addProgram(store, "thd");
    const dev = programDeviceRow(store, id);

    expect(dev.row.classList.contains("u-hidden")).toBe(true);
    expect(dev.select.options.length).toBe(2);
    expect(dev.select.options[0].textContent).toContain("Follows focus");
    expect(dev.select.value).toBe("");
    expect(dev.value()).toBeNull();
  });

  it("single-device bench, but pinned to a DORMANT slot (no live session there): row stays selectable, honestly labeled 'not connected' — the F3 escape-hatch rule", () => {
    const store = new Store(withDevice(initialState(), { status: "connected" }));
    const id = addProgram(store, "thd");
    setProgramDeviceSlot(store, id, 2); // slot 2 has no live session
    const dev = programDeviceRow(store, id);

    // NOT hidden despite one live session — the pin is a fact worth
    // showing (same rationale programDeviceNote's selector test pins).
    expect(dev.row.classList.contains("u-hidden")).toBe(false);
    const labels = Array.from(dev.select.options).map((o) => o.textContent);
    expect(labels.some((l) => l?.includes("#3") && l.includes("not connected"))).toBe(true);
    expect(dev.select.value).toBe("2");
    expect(dev.value()).toBe(2);
  });

  it("two-device bench, no pin: visible, one option per live session plus 'Follows focus'", () => {
    const store = new Store(withConnectedSlot1(withDevice(initialState(), { status: "connected" })));
    const id = addProgram(store, "thd");
    const dev = programDeviceRow(store, id);

    expect(dev.row.classList.contains("u-hidden")).toBe(false);
    expect(dev.select.options.length).toBe(3); // follows-focus + slot 0 + slot 1
    const labels = Array.from(dev.select.options).map((o) => o.textContent ?? "");
    expect(labels.some((l) => l.includes("#2") && l.includes("B-SERIAL"))).toBe(true);
    expect(dev.value()).toBeNull(); // no pin yet
  });

  it("sampleRateHz(): 'Follows focus' reads the FOCUSED session's rate; selecting a live slot reads THAT slot's rate live", () => {
    const s = withConnectedSlot1(
      withDevice(initialState(), {
        status: "connected",
        config: { input_gain: 0, output_gain: 18, sample_rate: 48000 },
      }),
      96000
    );
    const store = new Store(s);
    const id = addProgram(store, "thd");
    const dev = programDeviceRow(store, id);

    // Focus is slot 0 by default — "Follows focus" reads 48 kHz.
    expect(dev.sampleRateHz()).toBe(48000);

    // Selecting slot 1 live (no re-construction) reads ITS rate, 96 kHz.
    dev.select.value = "1";
    expect(dev.value()).toBe(1);
    expect(dev.sampleRateHz()).toBe(96000);

    // Back to "Follows focus".
    dev.select.value = "";
    expect(dev.sampleRateHz()).toBe(48000);
  });

  it("sampleRateHz() falls back to 48 kHz when the selection names a slot with NO live session (a bigger bench's doc, pre-connect)", () => {
    const store = new Store(withDevice(initialState(), { status: "connected" }));
    const id = addProgram(store, "thd");
    setProgramDeviceSlot(store, id, 3);
    const dev = programDeviceRow(store, id);

    expect(dev.value()).toBe(3);
    expect(dev.sampleRateHz()).toBe(48000);
  });
});

/**
 * Devices selectors (issue #25 lot D). The range pins here REPLACE the
 * deleted `INPUT_RANGES_DBV`/`OUTPUT_RANGES_DBV` consts: the menus must
 * offer exactly the register-map tables (`caps.rs` pins the same values
 * backend-side), and the QA402/QA403 rate split must survive the trip
 * through the slice.
 */
import { describe, expect, it } from "vitest";
import { hwTraceMetas, initialSession, initialState, SLOT0 } from "../state";
import type { AppState } from "../state";
import { fakeEntry } from "../actions/devices.fixtures";
import { deriveDevices } from "../actions/devices";
import type { DeviceEntry } from "../../gen";
import {
  addableEntries,
  deviceLabel,
  focusSelectorMode,
  inputRangesDbv,
  outputRangesDbv,
  physicalAvailable,
  primaryCaps,
  reviveCandidateId,
  primaryEntry,
  sampleRatesHz,
  sessionLabel,
  sessionRates,
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

describe("showDevicePicker — extended for live SESSIONS (issue #25 lot E4, decision B7)", () => {
  it("still hidden at 1 physical unit and exactly one (the boot) session — byte-identical to the lot-D pin above", () => {
    const one = withDevices(fakeEntry("usb/A"), fakeEntry("virtual/V", { virtual: true }));
    expect(showDevicePicker(one)).toBe(false);
  });

  it("shown at ≥2 LIVE sessions even with only 1 physical unit enumerated (the likely dev bench: demo + one real unit)", () => {
    const s = withDevices(fakeEntry("usb/A"));
    const twoSessions: AppState = {
      ...s,
      devices: {
        ...s.devices,
        sessions: { ...s.devices.sessions, "slot-1": { ...initialSession(1), deviceId: "usb/A" } },
      },
    };
    expect(physicalAvailable(twoSessions)).toHaveLength(1); // still only 1 physical unit
    expect(showDevicePicker(twoSessions)).toBe(true); // but 2 sessions flip it
  });
});

describe("focusSelectorMode — the toolbar device-select's dual mode (issue #25 lot E4, decision B7)", () => {
  it("'pick' at the boot single session, 'focus' once a second session goes live", () => {
    expect(focusSelectorMode(initialState())).toBe("pick");
    const s = initialState();
    const twoSessions: AppState = {
      ...s,
      devices: { ...s.devices, sessions: { ...s.devices.sessions, "slot-1": initialSession(1) } },
    };
    expect(focusSelectorMode(twoSessions)).toBe("focus");
  });
});

describe("addableEntries — the add-device menu offer (issue #25 lot E4)", () => {
  it("excludes an OPEN entry, an entry HELD by a session, and an entry currently ADDING — offers every other enumerated unit", () => {
    const s = withDevices(
      fakeEntry("usb/A", { open: true, slot: 0 }), // open (elsewhere)
      fakeEntry("usb/B"), // held by a session below
      fakeEntry("usb/C"), // an add is in flight for this one
      fakeEntry("usb/D") // free — offered
    );
    const withState: AppState = {
      ...s,
      devices: {
        ...s.devices,
        sessions: {
          ...s.devices.sessions,
          "slot-1": { ...initialSession(1), deviceId: "usb/B" },
        },
        adding: ["usb/C"],
      },
    };
    expect(addableEntries(withState).map((d) => d.id)).toEqual(["usb/D"]);
  });

  it("offers everything when nothing is open/held/adding", () => {
    const s = withDevices(fakeEntry("usb/A"), fakeEntry("usb/B"));
    expect(addableEntries(s).map((d) => d.id)).toEqual(["usb/A", "usb/B"]);
  });
});

describe("sessionRates — connected-unit-wins PER SESSION (issue #25 lot E4, the sampleRatesHz rule keyed by session)", () => {
  it("a CONNECTED session's own device.info table wins over a transiently-stale registry entry (lot D review #3, per-key)", () => {
    const s = withDevices(fakeEntry("usb/B", { model: "QA402" })); // registry entry: not open (stale)
    const key = "slot-1";
    const withSession: AppState = {
      ...s,
      devices: {
        ...s.devices,
        sessions: {
          ...s.devices.sessions,
          [key]: {
            ...initialSession(1),
            deviceId: "usb/B",
            device: {
              ...initialSession(1).device,
              status: "connected",
              info: {
                model: "QA402",
                serial: "B",
                firmware_version: 60,
                product: "QA402 Audio Analyzer",
                sample_rates: [48000, 96000], // the OPEN unit's own live table
                supports_flash: false,
                capabilities: {} as never,
                is_virtual: false,
              },
            },
          },
        },
      },
    };
    expect(sessionRates(withSession, key)).toEqual([48000, 96000]);
  });

  it("falls back to the registry capabilities table while the session is not connected", () => {
    const s = withDevices(fakeEntry("usb/B", { model: "QA403" }));
    const key = "slot-1";
    const withSession: AppState = {
      ...s,
      devices: {
        ...s.devices,
        sessions: { ...s.devices.sessions, [key]: { ...initialSession(1), deviceId: "usb/B" } },
      },
    };
    expect(sessionRates(withSession, key)).toEqual([48000, 96000, 192000, 384000]);
  });

  it("two different-model LIVE sessions offer their OWN tables independently — never the other's", () => {
    const s = withDevices(fakeEntry("usb/A", { model: "QA402" }), fakeEntry("usb/B", { model: "QA403" }));
    const twoSessions: AppState = {
      ...s,
      devices: {
        ...s.devices,
        sessions: {
          [SLOT0]: { ...s.devices.sessions[SLOT0], deviceId: "usb/A" },
          "slot-1": { ...initialSession(1), deviceId: "usb/B" },
        },
      },
    };
    expect(sessionRates(twoSessions, SLOT0)).toEqual([48000, 96000, 192000]);
    expect(sessionRates(twoSessions, "slot-1")).toEqual([48000, 96000, 192000, 384000]);
  });
});

describe("sessionLabel — group header / focus selector display name (issue #25 lot E4, item 8)", () => {
  it("the alias wins when the registry entry is known and aliased", () => {
    const s = withDevices(fakeEntry("usb/B", { model: "QA402" }));
    const withAlias: AppState = {
      ...s,
      devices: {
        ...s.devices,
        aliases: { "usb/B": "Bench 2" },
        sessions: { ...s.devices.sessions, "slot-1": { ...initialSession(1), deviceId: "usb/B" } },
      },
    };
    expect(sessionLabel(withAlias, "slot-1")).toBe("Bench 2");
  });

  it("falls back to the identity literal when the registry entry is known but UNaliased", () => {
    const s = withDevices(fakeEntry("usb/B", { model: "QA402" }));
    const withSession: AppState = {
      ...s,
      devices: {
        ...s.devices,
        sessions: { ...s.devices.sessions, "slot-1": { ...initialSession(1), deviceId: "usb/B" } },
      },
    };
    expect(sessionLabel(withSession, "slot-1")).toBe("QA402 · B");
  });

  it("falls back to the session's OWN DeviceMeta identity when the adopted id isn't in the registry yet (pre-enumeration window)", () => {
    const s = initialState();
    const withSession: AppState = {
      ...s,
      devices: {
        ...s.devices,
        sessions: {
          ...s.devices.sessions,
          "slot-1": {
            ...initialSession(1),
            deviceId: "usb/not-yet-enumerated",
            device: {
              ...initialSession(1).device,
              info: {
                model: "QA403",
                serial: "Z9",
                firmware_version: 1,
                product: "QA403 Audio Analyzer",
                sample_rates: [48000],
                supports_flash: false,
                capabilities: {} as never,
                is_virtual: false,
              },
            },
          },
        },
      },
    };
    expect(sessionLabel(withSession, "slot-1")).toBe("QA403 · Z9");
  });

  it("falls back to 'Device #n' (never another unit's name) when nothing is known yet at all", () => {
    const s = initialState();
    const withSession: AppState = {
      ...s,
      devices: { ...s.devices, sessions: { ...s.devices.sessions, "slot-1": initialSession(1) } },
    };
    expect(sessionLabel(withSession, "slot-1")).toBe("Device #2");
  });
});

describe("reviveCandidateId — one-click dormant-group revival (issue #25 lot E4, Raphaël 2026-07-28)", () => {
  /** A bench with `entry` enumerated and a slot-1 endpoint trace whose
   * capture provenance names (model, serial). */
  function dormantSlot1(
    entry: DeviceEntry,
    provenance: { model: string; serial: string } | null
  ): AppState {
    const s = withDevices(fakeEntry("usb/A", { open: true, slot: 0 }), entry);
    const meta = hwTraceMetas(1)[0];
    return {
      ...s,
      traces: {
        order: [...s.traces.order, meta.id],
        byId: {
          ...s.traces.byId,
          [meta.id]: provenance
            ? {
                ...meta,
                capture: {
                  device: { ...provenance, firmware: null, isVirtual: false },
                  sampleRateHz: 48000,
                  inputRangeDbv: 42,
                  outputRangeDbv: 8,
                  offsets: null,
                  fftSize: 32768,
                  window: "hann",
                  averaging: { mode: "off", count: 1 },
                  capturedAt: "2026-07-28T23:00:00.000Z",
                },
              }
            : meta,
        },
      },
    };
  }

  it("matches the dormant slot's capture provenance (model+serial) against the addable units", () => {
    const s = dormantSlot1(fakeEntry("usb/B"), { model: "QA402", serial: "B" });
    expect(reviveCandidateId(s, 1)).toBe("usb/B");
  });

  it("null when the provenance-named unit is not enumerated, or the serial/model differ", () => {
    const wrongSerial = dormantSlot1(fakeEntry("usb/B"), { model: "QA402", serial: "OTHER" });
    expect(reviveCandidateId(wrongSerial, 1)).toBeNull();
    const wrongModel = dormantSlot1(fakeEntry("usb/B"), { model: "QA403", serial: "B" });
    expect(reviveCandidateId(wrongModel, 1)).toBeNull();
  });

  it("null when the rows never captured (no provenance) — slot 0 included", () => {
    const noProvenance = dormantSlot1(fakeEntry("usb/B"), null);
    expect(reviveCandidateId(noProvenance, 1)).toBeNull();
    // Slot 0's rows carry no capture in this state (and never do at boot —
    // slot-0 captures are deliberately not persisted): no candidate.
    const s = dormantSlot1(fakeEntry("usb/B"), { model: "QA402", serial: "B" });
    expect(reviveCandidateId(s, 0)).toBeNull();
  });

  it("slot 0 QUALIFIES once its rows carry an identity (issue #25 lot F, Raphaël 2026-07-29 — the E4 'never slot 0' rule reversed: a disconnected default device left only the anonymous top-bar Connect)", () => {
    // usb/A was slot 0's unit, now disconnected (not open, not held) but
    // still enumerated; its identity sits on slot 0's endpoint rows (the
    // in-session connect stamp).
    const base = withDevices(fakeEntry("usb/A"), fakeEntry("usb/B"));
    const meta = hwTraceMetas(0)[0];
    const s: AppState = {
      ...base,
      traces: {
        ...base.traces,
        byId: {
          ...base.traces.byId,
          [meta.id]: {
            ...base.traces.byId[meta.id],
            capture: {
              device: { model: "QA402", serial: "A", firmware: 60, isVirtual: false },
              sampleRateHz: null,
              inputRangeDbv: null,
              outputRangeDbv: null,
              offsets: null,
              fftSize: null,
              window: null,
              averaging: null,
              capturedAt: null,
            },
          },
        },
      },
    };
    expect(reviveCandidateId(s, 0)).toBe("usb/A");
    // And the disconnected session's label names the same unit instead of
    // the anonymous placeholder (the focus selector reads sessionLabel).
    expect(sessionLabel(s, "slot-0")).toBe("QA402 · A");
  });

  it("null when the matched unit is not ADDABLE (already open — a stale doc must not offer stealing an open unit)", () => {
    const s = dormantSlot1(fakeEntry("usb/B", { open: true, slot: 1 }), {
      model: "QA402",
      serial: "B",
    });
    expect(reviveCandidateId(s, 1)).toBeNull();
  });
});

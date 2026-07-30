/**
 * resetAveraging / resetMeasureStats keying (issue #25 lot F4, the F2
 * carried note): arg-less these drove the DEFAULT runtime whatever the
 * focus — under a slot-1 focus a reset emptied slot 0's accumulators and
 * left the visible stream's untouched. The pins: slot 0 stays arg-less on
 * the wire (byte-identical), a routed focus sends ITS deviceId, an
 * unadopted slot ≥ 1 never reaches the wire.
 */
import { describe, expect, it } from "vitest";

import type { Commands, Ipc } from "../../ipc/ipc";
import { Store } from "../store";
import { initialSession, initialState, type AppState, type DeviceSession } from "../state";
import { resetAveraging, resetMeasureStats } from "./acquisition";

function recordingIpc(): { ipc: Ipc; calls: { cmd: string; args: unknown }[] } {
  const calls: { cmd: string; args: unknown }[] = [];
  const ipc: Ipc = {
    async call<K extends keyof Commands>(
      cmd: K,
      args: Commands[K]["args"]
    ): Promise<Commands[K]["result"]> {
      calls.push({ cmd, args });
      return null as Commands[K]["result"];
    },
  };
  return { ipc, calls };
}

function withSlot1(s: AppState, deviceId: string | null): AppState {
  const sess: DeviceSession = { ...initialSession(1), deviceId };
  return {
    ...s,
    devices: {
      ...s.devices,
      sessions: { ...s.devices.sessions, "slot-1": sess },
      focus: "slot-1",
    },
  };
}

describe("actions/acquisition — keyed resets (lot F4)", () => {
  it("slot-0 focus stays arg-less on the wire (byte-identical)", () => {
    const store = new Store(initialState());
    const { ipc, calls } = recordingIpc();
    resetAveraging(store, ipc);
    resetMeasureStats(store, ipc);
    expect(calls.map((c) => c.cmd)).toEqual([
      "stream_reset_averaging",
      "stream_reset_measure_stats",
    ]);
    for (const c of calls) expect(c.args).toEqual({});
  });

  it("a routed slot-1 focus sends ITS deviceId — never the default runtime's", () => {
    const store = new Store(withSlot1(initialState(), "usb/B"));
    const { ipc, calls } = recordingIpc();
    resetAveraging(store, ipc);
    resetMeasureStats(store, ipc);
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c.args).toEqual({ deviceId: "usb/B" });
  });

  it("an UNADOPTED slot-1 focus REFUSES legibly (review SHOULD-FIX #4): no wire, no half-true success, the not-adopted toast instead", () => {
    const store = new Store(withSlot1(initialState(), null));
    const { ipc, calls } = recordingIpc();
    const epoch = store.get().ui.peakHoldEpoch;
    resetAveraging(store, ipc);
    resetMeasureStats(store, ipc);
    expect(calls).toHaveLength(0);
    // Nothing pretends to have happened — the epoch stays, and the user is
    // told why (the runProgram wording, one refusal voice bench-wide).
    expect(store.get().ui.peakHoldEpoch).toBe(epoch);
    expect(
      store
        .get()
        .ui.toasts.filter((t) => t.message.includes("Device id not adopted yet"))
    ).toHaveLength(2);
  });
});

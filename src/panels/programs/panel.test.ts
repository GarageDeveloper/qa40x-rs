// @vitest-environment jsdom
//
// Regression test for issue #28 second-pass review finding #1: the
// `.programs__wow` scalar-readout line must be created UNCONDITIONALLY for
// every program row, never only for a program that is ALREADY wow &
// flutter at row-CREATION time. `keyedList` (keyed on the program id) calls
// `create()` exactly once per id and `update()` on every reconcile after —
// it never rebuilds an existing row's DOM structure. A program converted
// from "thd" to "wowflutter" via the gear dialog (`configureSweepProgram`)
// AFTER its row was already built would, under the old conditional-creation
// approach, have nowhere for its scalars to ever land.
//
// This is a real DOM test on the actual `mountProgramsPanel` →
// `keyedList` → `build()`/`update()` path — a prior fix here was proven
// correct only against the pure `wowSummary()` formatter
// (`store/actions/programs.test.ts`), which cannot see a `build()` that
// conditionally omits the DOM node in the first place. Verified by mutation
// (see the note at the bottom of this file): re-conditioning `build()`'s
// node creation on `measurement === "wowflutter"` makes this test fail.
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import type { Commands, Ipc } from "../../ipc/ipc";
import { Store } from "../../store/store";
import {
  initialSession,
  initialState,
  type AppState,
  type DeviceSession,
} from "../../store/state";
import {
  addProgram,
  configureSweepProgram,
  setProgramDeviceSlot,
} from "../../store/actions/programs";
import { withDevice, withRun } from "../../store/actions/sessions.fixtures";
import { mountProgramsPanel } from "./panel";

function connectedState(): AppState {
  return withDevice(initialState(), { status: "connected" });
}

const noopIpc: Ipc = {
  async call<K extends keyof Commands>(): Promise<Commands[K]["result"]> {
    return null as Commands[K]["result"];
  },
};

/** Store notifications are batched in a microtask (store.ts's
 * `queueMicrotask`) — one tick flushes them since it queues strictly after. */
const flush = (): Promise<void> => Promise.resolve();

describe("Programs panel (DOM) — the scalar-readout row survives a measurement conversion", () => {
  it("creates .programs__wow unconditionally and updates it IN PLACE across a thd → wowflutter conversion and a landed result", async () => {
    const store = new Store(connectedState());
    const id = addProgram(store, "thd");

    const host = document.createElement("div");
    mountProgramsPanel(host, store, noopIpc);
    await flush();

    const wowNode = host.querySelector(`[data-testid="prog-wow-${id}"]`);
    expect(wowNode).not.toBeNull();
    expect(wowNode!.textContent).toBe("—");
    expect(host.querySelectorAll(`[data-testid="prog-play-${id}"]`).length).toBe(1);

    // Convert via the SAME action the gear dialog's Apply calls.
    const prog = store.get().programs.byId[id];
    if (prog.kind !== "sweep") throw new Error("expected a sweep program");
    configureSweepProgram(store, id, {
      label: store.get().traces.byId[id].label,
      params: { ...prog.params, measurement: "wowflutter" },
    });
    await flush();

    // The SAME node — no new row, no duplicate — now reads "not run yet".
    const wowNodeAfterConvert = host.querySelector(`[data-testid="prog-wow-${id}"]`);
    expect(wowNodeAfterConvert).toBe(wowNode);
    expect(host.querySelectorAll(`[data-testid="prog-play-${id}"]`).length).toBe(1);
    expect(wowNodeAfterConvert!.textContent).toBe("not run yet");

    // Land a result (the same shape `runSweep`'s `patchProgram` writes).
    store.update("test/land-wow-result", (s) => {
      const p = s.programs.byId[id];
      if (p.kind !== "sweep") return s;
      return {
        ...s,
        programs: {
          ...s.programs,
          byId: {
            ...s.programs.byId,
            [id]: {
              ...p,
              wowResult: {
                weightedPercent: 0.098,
                unweightedPercent: 0.106,
                peakPercent: 0.138,
                staticOffsetHz: 0,
                referenceFreqUsed: p.params.wowReferenceHz,
              },
            },
          },
        },
      };
    });
    await flush();

    const finalNode = host.querySelector(`[data-testid="prog-wow-${id}"]`);
    expect(finalNode).toBe(wowNode);
    expect(finalNode!.textContent).toContain("weighted 0.098%");
    expect(finalNode!.textContent).not.toBe("not run yet");
  });
});

describe("Programs panel (DOM) — per-device rows (issue #25 lot F4)", () => {
  /** Two live sessions: slot 0 (focused) + an adopted slot 1. */
  function twoDeviceState(): AppState {
    let s = withDevice(initialState(), { status: "connected" });
    const sess: DeviceSession = {
      ...initialSession(1),
      deviceId: "usb/B",
      device: { ...initialSession(1).device, status: "connected" },
    };
    s = {
      ...s,
      devices: { ...s.devices, sessions: { ...s.devices.sessions, "slot-1": sess } },
    };
    return s;
  }

  it("two RUNNING programs on two devices render independent type lines and neither greys the other; a third on a busy device carries ITS runner's name", async () => {
    const store = new Store(twoDeviceState());
    const a = addProgram(store, "thd");
    const b = addProgram(store, "thd");
    const c = addProgram(store, "thd");
    setProgramDeviceSlot(store, b, 1);

    const host = document.createElement("div");
    mountProgramsPanel(host, store, noopIpc);
    await flush();

    // The multi-device header note (the single-device wording is the
    // historical string, asserted by its absence of "per device").
    const note = host.querySelector(".programs__note")!;
    expect(note.textContent).toBe("exclusive per device · one script at a time");

    // a runs on slot 0, b runs on slot 1 — locks written the way
    // runProgram's start update does.
    store.update("test/two-running", (s) => {
      const byId = { ...s.programs.byId };
      byId[a] = { ...byId[a], run: "running" as const, runKey: "slot-0" };
      byId[b] = { ...byId[b], run: "running" as const, runKey: "slot-1" };
      return { ...s, programs: { ...s.programs, byId } };
    });
    store.update("test/locks", (s) =>
      withRun(withRun(s, { programLock: a }), { programLock: b }, "slot-1")
    );
    await flush();

    const typeA = host.querySelector(`[data-testid="prog-type-${a}"]`)!;
    const typeB = host.querySelector(`[data-testid="prog-type-${b}"]`)!;
    expect(typeA.textContent).toContain("on #1");
    expect(typeB.textContent).toContain("on #2");
    expect(typeA.textContent).toContain("running");
    expect(typeB.textContent).toContain("running");

    // Neither running row is disabled by the other.
    const playA = host.querySelector<HTMLButtonElement>(`[data-testid="prog-play-${a}"]`)!;
    const playB = host.querySelector<HTMLButtonElement>(`[data-testid="prog-play-${b}"]`)!;
    expect(playA.disabled).toBe(false); // it's a ⏹ now
    expect(playB.disabled).toBe(false);
    expect(playA.textContent).toBe("⏹");
    expect(playB.textContent).toBe("⏹");

    // The third (follows-focus → slot 0) greys with slot 0's runner.
    const playC = host.querySelector<HTMLButtonElement>(`[data-testid="prog-play-${c}"]`)!;
    expect(playC.disabled).toBe(true);
    expect(playC.title).toContain("is running on this device");
  });
});

/**
 * Mutation check performed by hand while writing this test (not executed by
 * CI — a permanent inline record instead): temporarily changing panel.ts's
 * `build()` back to
 *
 *   if (isWowFlutterProgram(vm.prog)) {
 *     rowChildren.push(el("div.programs__wow", { "data-testid": ... }));
 *   }
 *
 * (the pre-fix, conditional-on-CURRENT-measurement creation) makes the
 * FIRST assertion above (`expect(wowNode).not.toBeNull()`) fail outright —
 * a fresh "thd" program never satisfies `isWowFlutterProgram` at row
 * creation, so the node never exists at all, let alone survives a
 * conversion. Restored immediately after confirming the failure.
 */

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
import { initialState, type AppState } from "../../store/state";
import { addProgram, configureSweepProgram } from "../../store/actions/programs";
import { withDevice } from "../../store/actions/sessions.fixtures";
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

/**
 * Transform-chain scheduling (M4): the pool.ts:159-223 semantics, ported.
 * The fake backend adds +1 dB per chain step and records calls, so these
 * tests assert PLUMBING (what ran, with what, what landed) — the DSP values
 * are the Rust tests' job (src-tauri/src/dashboard.rs).
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Frame, TransformStep } from "../gen";
import type { Commands, Ipc } from "../ipc/ipc";
import { Store } from "../store/store";
import { initialState, HW_TRACE_IDS, type AppState } from "../store/state";
import { addTransformTrace, configureTransform } from "../store/actions/traces";
import {
  clearAllFrames,
  getFrames,
  putFrames,
} from "./frames";
import { resetAllChains, syncChains, watchChains } from "./chains";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface ChainCall {
  steps: TransformStep[];
  refs: Record<string, Frame>;
  fdMag0: number | null;
}

/** A fake backend: +1 dB per step on the spectrum, records every call. */
function fakeIpc(): { ipc: Ipc; calls: ChainCall[]; block: () => () => void } {
  const calls: ChainCall[] = [];
  let gate: Promise<void> | null = null;
  let release: (() => void) | null = null;
  const ipc: Ipc = {
    async call<K extends keyof Commands>(
      cmd: K,
      args: Commands[K]["args"]
    ): Promise<Commands[K]["result"]> {
      if (cmd !== "apply_transform_chain") {
        return null as Commands[K]["result"];
      }
      const a = args as Commands["apply_transform_chain"]["args"];
      calls.push({
        steps: a.steps,
        refs: a.refs,
        fdMag0: a.fd?.domain === "fd" ? a.fd.mag_db[0] : null,
      });
      if (gate) await gate;
      const fd: Frame | null =
        a.fd?.domain === "fd"
          ? { ...a.fd, mag_db: a.fd.mag_db.map((v) => v + a.steps.length) }
          : null;
      return {
        td: a.td,
        fd,
        script_error: null,
      } as Commands[K]["result"];
    },
  };
  return {
    ipc,
    calls,
    block: () => {
      gate = new Promise((r) => (release = r));
      return () => {
        release?.();
        gate = null;
      };
    },
  };
}

let hwSeq = 0;

/** Simulate one stream ingest on Input L: cache first, then the seq bump. */
function ingest(store: Store<AppState>, magDb: number[], offsetDb = 20.81): void {
  const seq = ++hwSeq;
  putFrames(HW_TRACE_IDS.inputL, seq, {
    fd: { freqs: Float64Array.from([100, 1000]), magDb: Float64Array.from(magDb) },
  });
  store.update("test/ingest", (s) => ({
    ...s,
    traces: {
      ...s.traces,
      byId: {
        ...s.traces.byId,
        [HW_TRACE_IDS.inputL]: {
          ...s.traces.byId[HW_TRACE_IDS.inputL],
          seq,
          offsetDb,
          domains: ["fd"],
        },
      },
    },
  }));
}

describe("data/chains — transform endpoint scheduling", () => {
  beforeEach(() => {
    clearAllFrames();
    resetAllChains();
    hwSeq = 0;
  });

  it("an identity chain copies the input synchronously (no backend trip)", () => {
    const store = new Store(initialState());
    const { ipc, calls } = fakeIpc();
    const id = addTransformTrace(store, HW_TRACE_IDS.inputL, []);
    ingest(store, [-40, -3]);
    syncChains(store, ipc);
    expect(calls).toHaveLength(0);
    expect(Array.from(getFrames(id)!.fd!.magDb)).toEqual([-40, -3]);
    expect(store.get().traces.byId[id].domains).toEqual(["fd"]);
    expect(store.get().traces.byId[id].offsetDb).toBe(20.81);
  });

  it("schedules the chain and lands the result on the endpoint", async () => {
    const store = new Store(initialState());
    const { ipc, calls } = fakeIpc();
    const steps: TransformStep[] = [{ type: "weighting", mode: "a" }];
    const id = addTransformTrace(store, HW_TRACE_IDS.inputL, steps);
    syncChains(store, ipc);
    expect(getFrames(id)).toBeUndefined(); // input empty → endpoint empty
    ingest(store, [-40, -3]);
    syncChains(store, ipc);
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].steps).toEqual(steps);
    expect(Array.from(getFrames(id)!.fd!.magDb)).toEqual([-39, -2]); // +1 dB/step
    // The endpoint's freshness mirrors its input's (cycle-safe by design).
    expect(store.get().traces.byId[id].seq).toBe(
      store.get().traces.byId[HW_TRACE_IDS.inputL].seq
    );
    // Re-sync with nothing new: deduped, no second run.
    syncChains(store, ipc);
    await flush();
    expect(calls).toHaveLength(1);
  });

  it("drops frames while busy, then re-runs from the freshest input", async () => {
    const store = new Store(initialState());
    const { ipc, calls, block } = fakeIpc();
    const id = addTransformTrace(store, HW_TRACE_IDS.inputL, [
      { type: "weighting", mode: "a" },
    ]);
    const release = block();
    ingest(store, [-40, -3]);
    syncChains(store, ipc); // starts run #1 (blocked)
    ingest(store, [-50, -5]);
    syncChains(store, ipc); // busy → dropped
    expect(calls).toHaveLength(1);
    release();
    await flush();
    await flush();
    // The finally-reschedule re-ran from the fresh input — never left stale.
    expect(calls.map((c) => c.fdMag0)).toEqual([-40, -50]);
    expect(Array.from(getFrames(id)!.fd!.magDb)).toEqual([-49, -4]);
  });

  it("a reconfigure recomputes the SAME input frame under the new chain", async () => {
    const store = new Store(initialState());
    const { ipc, calls } = fakeIpc();
    const id = addTransformTrace(store, HW_TRACE_IDS.inputL, [
      { type: "weighting", mode: "a" },
    ]);
    ingest(store, [-40, -3]);
    syncChains(store, ipc);
    await flush();
    expect(calls).toHaveLength(1);
    configureTransform(store, ipc, id, {
      label: "fx",
      input: HW_TRACE_IDS.inputL,
      steps: [
        { type: "weighting", mode: "a" },
        { type: "notch", freq: 60, q: 8 },
      ],
    });
    await flush();
    expect(calls).toHaveLength(2);
    expect(Array.from(getFrames(id)!.fd!.magDb)).toEqual([-38, -1]); // 2 steps
  });

  it("discards a result whose chain was rewired while it ran", async () => {
    const store = new Store(initialState());
    const { ipc, calls, block } = fakeIpc();
    const id = addTransformTrace(store, HW_TRACE_IDS.inputL, [
      { type: "weighting", mode: "a" },
    ]);
    const release = block();
    ingest(store, [-40, -3]);
    syncChains(store, ipc); // in flight, blocked
    configureTransform(store, ipc, id, {
      label: "fx",
      input: HW_TRACE_IDS.inputL,
      steps: [
        { type: "weighting", mode: "a" },
        { type: "notch", freq: 60, q: 8 },
      ],
    }); // clears cache + reschedules once the flight lands
    release();
    await flush();
    await flush();
    // The 1-step result was discarded; the 2-step rerun landed.
    expect(calls).toHaveLength(2);
    expect(Array.from(getFrames(id)!.fd!.magDb)).toEqual([-38, -1]);
  });

  it("a missing input clears the endpoint (derived, never stale)", async () => {
    const store = new Store(initialState());
    const { ipc } = fakeIpc();
    const id = addTransformTrace(store, "mem-99", []); // input doesn't exist
    // Seed data as if it had once computed.
    putFrames(id, 1, {
      fd: { freqs: Float64Array.from([1]), magDb: Float64Array.from([-1]) },
    });
    store.update("test/fake-domains", (s) => ({
      ...s,
      traces: {
        ...s.traces,
        byId: { ...s.traces.byId, [id]: { ...s.traces.byId[id], domains: ["fd"] } },
      },
    }));
    syncChains(store, ipc);
    expect(getFrames(id)).toBeUndefined();
    expect(store.get().traces.byId[id].domains).toEqual([]);
  });

  it("passes resolved deconvolve references to the backend", async () => {
    const store = new Store(initialState());
    const { ipc, calls } = fakeIpc();
    // A reference with a cached spectrum (e.g. a frozen memory trace).
    putFrames("mem-1", 1, {
      fd: { freqs: Float64Array.from([100, 1000]), magDb: Float64Array.from([-10, -10]) },
    });
    store.update("test/add-ref", (s) => ({
      ...s,
      traces: {
        order: [...s.traces.order, "mem-1"],
        byId: {
          ...s.traces.byId,
          "mem-1": {
            id: "mem-1",
            label: "ref",
            color: "#888888",
            source: { kind: "memory", frozenFrom: HW_TRACE_IDS.inputL },
            domains: ["fd"],
            seq: 1,
            offsetDb: null,
          },
        },
      },
    }));
    addTransformTrace(store, HW_TRACE_IDS.inputL, [
      { type: "deconvolve", ref: "mem-1" },
    ]);
    ingest(store, [-40, -3]);
    syncChains(store, ipc);
    await flush();
    expect(calls).toHaveLength(1);
    const ref = calls[0].refs["mem-1"];
    expect(ref.domain === "fd" && ref.mag_db).toEqual([-10, -10]);
  });

  it("a chain feeding a chain refreshes recursively; a cycle settles", async () => {
    const store = new Store(initialState());
    const { ipc, calls } = fakeIpc();
    watchChains(store, ipc); // the real trigger: land → watcher → dependents
    const a = addTransformTrace(store, HW_TRACE_IDS.inputL, [
      { type: "weighting", mode: "a" },
    ]);
    const b = addTransformTrace(store, a, [{ type: "weighting", mode: "a" }]);
    ingest(store, [-40, -3]);
    for (let i = 0; i < 6; i++) await flush();
    expect(Array.from(getFrames(b)!.fd!.magDb)).toEqual([-38, -1]); // +1 per endpoint
    const settled = calls.length;
    // A cycle (a rewired onto b) must settle, not ping-pong forever.
    configureTransform(store, ipc, a, { label: "a", input: b, steps: [] });
    for (let i = 0; i < 8; i++) await flush();
    const after = calls.length;
    for (let i = 0; i < 8; i++) await flush();
    expect(calls.length).toBe(after); // no further runs once settled
    expect(after - settled).toBeLessThan(6);
  });
});

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
import {
  initialState,
  HW_TRACE_IDS,
  type AppState,
  type CaptureProvenance,
} from "../store/state";
import { addTransformTrace, configureTransform } from "../store/actions/traces";
import {
  clearAllFrames,
  getFrames,
  putFrames,
} from "./frames";
import { derivedCapture, resetAllChains, syncChains, watchChains } from "./chains";

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
            capture: null,
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

  describe("watchChains signature — user weighting curve identity (issue #29 review finding #2)", () => {
    // The watcher's signature must NEVER re-stringify a user curve's whole
    // point array on every store batch (a ~20k-row import would otherwise
    // cost real CPU on every live frame) — it swaps in a cheap WeakMap
    // identity instead (chains.ts's `curveIdentity`/`lightStep`). These
    // tests guard the OBSERVABLE contract that swap must preserve: a
    // genuinely different curve still triggers a recompute, an unchanged
    // one (same object OR a harmless unrelated store batch) does not.

    it("a user-weighting transform recomputes when the curve is swapped for a DIFFERENT one", async () => {
      const store = new Store(initialState());
      const { ipc, calls } = fakeIpc();
      watchChains(store, ipc);
      const curveA = { freqs: [100, 1000], gains: [0, 6] };
      const id = addTransformTrace(store, HW_TRACE_IDS.inputL, [
        { type: "weighting", mode: "user", curve: curveA },
      ]);
      ingest(store, [-40, -3]);
      await flush();
      await flush();
      expect(calls).toHaveLength(1);
      expect(calls[0].steps[0]).toEqual({ type: "weighting", mode: "user", curve: curveA });

      // A DIFFERENT curve object (same shape, different values) must still
      // be detected as a real change and re-run the chain.
      const curveB = { freqs: [100, 1000], gains: [3, 9] };
      configureTransform(store, ipc, id, {
        label: "fx",
        input: HW_TRACE_IDS.inputL,
        steps: [{ type: "weighting", mode: "user", curve: curveB }],
      });
      await flush();
      await flush();
      expect(calls).toHaveLength(2);
      expect(calls[1].steps[0]).toEqual({ type: "weighting", mode: "user", curve: curveB });
    });

    it("an unrelated store batch does not re-run the chain (the curve identity is stable)", async () => {
      const store = new Store(initialState());
      const { ipc, calls } = fakeIpc();
      watchChains(store, ipc);
      const curve = { freqs: [100, 1000], gains: [0, 6] };
      addTransformTrace(store, HW_TRACE_IDS.inputL, [
        { type: "weighting", mode: "user", curve },
      ]);
      ingest(store, [-40, -3]);
      await flush();
      await flush();
      expect(calls).toHaveLength(1);

      // An unrelated batch (e.g. a UI toast) must not re-trigger the chain —
      // the SAME curve object still maps to the SAME identity number.
      store.update("test/unrelated", (s) => ({ ...s, ui: { ...s.ui, peakHoldEpoch: 1 } }));
      await flush();
      await flush();
      expect(calls).toHaveLength(1);
    });
  });
});

describe("capture provenance inheritance (issue #40)", () => {
  beforeEach(() => {
    clearAllFrames();
    resetAllChains();
    hwSeq = 0;
  });

  const capture = (serial: string): CaptureProvenance => ({
    device: { model: "QA403", serial, firmware: 61, isVirtual: false },
    sampleRateHz: 48000,
    inputRangeDbv: 42,
    outputRangeDbv: 18,
    offsets: { input_l: 32.1, input_r: 32.2, output_l: 8.1, output_r: 8.2, calibrated: true },
    fftSize: 32768,
    window: "flattop",
    averaging: { mode: "off", count: 1 },
    capturedAt: null,
  });

  function stampCapture(store: Store<AppState>, id: string, cap: CaptureProvenance): void {
    store.update("test/capture", (s) => ({
      ...s,
      traces: {
        ...s.traces,
        byId: { ...s.traces.byId, [id]: { ...s.traces.byId[id], capture: cap } },
      },
    }));
  }

  it("an identity chain inherits its input's snapshot, marked derived", () => {
    const store = new Store(initialState());
    const { ipc } = fakeIpc();
    const id = addTransformTrace(store, HW_TRACE_IDS.inputL, []);
    ingest(store, [-40, -3]);
    stampCapture(store, HW_TRACE_IDS.inputL, capture("AB12_CD34"));
    syncChains(store, ipc);
    const cap = store.get().traces.byId[id].capture!;
    expect(cap.device!.serial).toBe("AB12_CD34");
    expect(cap.derived).toBe(true);
    expect(cap.mixed).toBeUndefined();
  });

  it("derivedCapture flags `mixed` when a deconvolve ref was captured on another bench", () => {
    const store = new Store(initialState());
    stampCapture(store, HW_TRACE_IDS.inputL, capture("AB12_CD34"));
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
            capture: capture("ZZ99_XX00"), // ANOTHER unit
          },
        },
      },
    }));
    const s = store.get();
    const input = s.traces.byId[HW_TRACE_IDS.inputL];
    const steps: TransformStep[] = [{ type: "deconvolve", ref: "mem-1" }];
    const cap = derivedCapture(s, input, steps)!;
    expect(cap.mixed).toBe(true);
    expect(cap.derived).toBe(true);
    // The snapshot itself stays the PRIMARY input's.
    expect(cap.device!.serial).toBe("AB12_CD34");

    // Same-bench ref: no mixed flag.
    const sameBench = derivedCapture(
      s,
      { ...input, capture: capture("ZZ99_XX00") },
      steps
    )!;
    expect(sameBench.mixed).toBeUndefined();
  });

  it("an input without a snapshot derives none", () => {
    const store = new Store(initialState());
    const s = store.get();
    expect(derivedCapture(s, s.traces.byId[HW_TRACE_IDS.inputL], [])).toBeNull();
  });
});

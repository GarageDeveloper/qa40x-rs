/**
 * Trigger actions (Lot A, issue #26) — the choke-point input sanitization
 * (review #1: a non-finite/negative value must never reach the wire, since
 * `validate_config` rejects the WHOLE stream config on one bad trigger
 * field, silently killing every LATER `stream_update` — including play/stop
 * — until fixed), SINGLE re-arm on mode re-selection (review #8), and the
 * drag-friendly `sync` option (review #10).
 */
import { describe, expect, it } from "vitest";
import { Store } from "../store";
import { HW_TRACE_IDS, initialState } from "../state";
import type { AppState } from "../state";
import type { Ipc } from "../../ipc/ipc";
import { focusedRun } from "../selectors/session";
import { withRun } from "./sessions.fixtures";
import {
  armSingle,
  setTriggerHystV,
  setTriggerLevelV,
  setTriggerMode,
} from "./trigger";

function makeStreamingStore(): { store: Store<AppState>; ipc: Ipc; calls: unknown[] } {
  const store = new Store(initialState(), { freeze: true });
  store.update("test/stream-on", (s) => withRun(s, { streaming: true }));
  const calls: unknown[] = [];
  const ipc: Ipc = {
    call: (method: string, args?: unknown) => {
      calls.push([method, args]);
      return Promise.resolve(null as never);
    },
  };
  return { store, ipc, calls };
}

describe("setTriggerLevelV (review #1)", () => {
  it("ignores non-finite values: no store update, no stream sync", () => {
    const { store, ipc, calls } = makeStreamingStore();
    setTriggerLevelV(store, ipc, HW_TRACE_IDS.inputL, 0.25);
    const before = store.get();
    expect(calls).toHaveLength(1);

    for (const bad of [NaN, Infinity, -Infinity]) {
      setTriggerLevelV(store, ipc, HW_TRACE_IDS.inputL, bad);
    }
    expect(store.get()).toBe(before); // true no-op — not even a re-render
    expect(calls).toHaveLength(1); // no additional stream_update calls
    expect(store.get().triggers[HW_TRACE_IDS.inputL]?.levelV).toBe(0.25);
  });

  it("a finite value still syncs by default", () => {
    const { store, ipc, calls } = makeStreamingStore();
    setTriggerLevelV(store, ipc, HW_TRACE_IDS.inputL, 1.5);
    expect(store.get().triggers[HW_TRACE_IDS.inputL]?.levelV).toBe(1.5);
    expect(calls).toHaveLength(1);
  });

  it("opts.sync = false updates the store but skips the stream sync", () => {
    const { store, ipc, calls } = makeStreamingStore();
    setTriggerLevelV(store, ipc, HW_TRACE_IDS.inputL, 0.75, { sync: false });
    expect(store.get().triggers[HW_TRACE_IDS.inputL]?.levelV).toBe(0.75);
    expect(calls).toHaveLength(0);
  });
});

describe("setTriggerHystV (review #1)", () => {
  it("ignores non-finite values", () => {
    const { store, ipc } = makeStreamingStore();
    setTriggerHystV(store, ipc, HW_TRACE_IDS.inputL, 0.1);
    const before = store.get();
    setTriggerHystV(store, ipc, HW_TRACE_IDS.inputL, NaN);
    expect(store.get()).toBe(before);
  });

  it("clamps a negative value to 0", () => {
    const { store, ipc } = makeStreamingStore();
    setTriggerHystV(store, ipc, HW_TRACE_IDS.inputL, -0.5);
    expect(store.get().triggers[HW_TRACE_IDS.inputL]?.hystV).toBe(0);
  });

  it("null (auto) stays null", () => {
    const { store, ipc } = makeStreamingStore();
    setTriggerHystV(store, ipc, HW_TRACE_IDS.inputL, 0.2);
    setTriggerHystV(store, ipc, HW_TRACE_IDS.inputL, null);
    expect(store.get().triggers[HW_TRACE_IDS.inputL]?.hystV).toBeNull();
  });
});

describe("setTriggerMode (review #8)", () => {
  it("re-selecting SINGLE bumps armEpoch so a stale `fired` latch can't report Stopped immediately", () => {
    const { store, ipc } = makeStreamingStore();
    setTriggerMode(store, ipc, HW_TRACE_IDS.inputL, "single");
    const first = store.get().triggers[HW_TRACE_IDS.inputL]!.armEpoch;

    setTriggerMode(store, ipc, HW_TRACE_IDS.inputL, "normal");
    setTriggerMode(store, ipc, HW_TRACE_IDS.inputL, "single");
    const second = store.get().triggers[HW_TRACE_IDS.inputL]!.armEpoch;

    expect(second).toBeGreaterThan(first);
    expect(store.get().triggers[HW_TRACE_IDS.inputL]?.mode).toBe("single");
  });

  it("arming raises trigArmPending so the highlight covers the in-flight-frame gap", () => {
    const { store, ipc } = makeStreamingStore();
    setTriggerMode(store, ipc, HW_TRACE_IDS.inputL, "single");
    expect(focusedRun(store.get()).trigArmPending[HW_TRACE_IDS.inputL]).toBe(true);

    // Clear it by hand (the ingestFrame side is pinned in stream.test.ts),
    // then a plain Arm click must raise it again.
    store.update("test/settle", (s) => withRun(s, { trigArmPending: {} }));
    armSingle(store, ipc, HW_TRACE_IDS.inputL);
    expect(focusedRun(store.get()).trigArmPending[HW_TRACE_IDS.inputL]).toBe(true);
  });

  it("switching between non-single modes never touches armEpoch", () => {
    const { store, ipc } = makeStreamingStore();
    setTriggerMode(store, ipc, HW_TRACE_IDS.inputL, "auto");
    const before = store.get().triggers[HW_TRACE_IDS.inputL]!.armEpoch;
    setTriggerMode(store, ipc, HW_TRACE_IDS.inputL, "normal");
    expect(store.get().triggers[HW_TRACE_IDS.inputL]!.armEpoch).toBe(before);
  });

  it("a genuine no-op (same mode) is a true no-op", () => {
    const { store, ipc } = makeStreamingStore();
    setTriggerMode(store, ipc, HW_TRACE_IDS.inputL, "single");
    const before = store.get();
    setTriggerMode(store, ipc, HW_TRACE_IDS.inputL, "single");
    expect(store.get()).toBe(before);
  });
});

describe("armSingle", () => {
  it("bumps armEpoch and syncs the stream", () => {
    const { store, ipc, calls } = makeStreamingStore();
    armSingle(store, ipc, HW_TRACE_IDS.inputL);
    expect(store.get().triggers[HW_TRACE_IDS.inputL]?.armEpoch).toBe(1);
    armSingle(store, ipc, HW_TRACE_IDS.inputL);
    expect(store.get().triggers[HW_TRACE_IDS.inputL]?.armEpoch).toBe(2);
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});


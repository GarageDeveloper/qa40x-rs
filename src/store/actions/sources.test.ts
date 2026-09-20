/**
 * Matrix write actions (issue #25 lot F3): the row editor's two verbs reach
 * the DAC only through the full fan-out — the session that LOST a source
 * re-syncs too, a program-locked session is never touched mid-sweep (the F2
 * MUST-FIX-1 gate, re-pinned from this new caller), and an unroutable
 * slot ≥ 1 target reaches no wire at all (sessionArgs never runs).
 */
import { describe, expect, it, vi } from "vitest";

// The auto-start pin below reaches the real startStream() → `new Channel()`
// path — mocked the same way stream.test.ts does it, so no Tauri runtime
// is required.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: unknown;
    constructor(cb?: unknown) {
      this.onmessage = cb;
    }
  },
}));

import type { Commands, Ipc } from "../../ipc/ipc";
import { Store } from "../store";
import type { AppState, SourceMeta } from "../state";
import { initialSession, initialState, SLOT0 } from "../state";
import { withDevice, withRun } from "./sessions.fixtures";
import { removeSourceTarget, setSourcePlaying, setSourceTargetRoute } from "./sources";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function sine(id: string, over: Partial<SourceMeta> = {}): SourceMeta {
  return {
    id,
    label: id,
    kind: "sine",
    frequencyHz: 1000,
    levelDbv: -12,
    extraTones: [],
    route: "left",
    i2sRoute: "off",
    targets: [],
    playing: true,
    ...over,
  } as SourceMeta;
}

function recordingIpc(): {
  ipc: Ipc;
  calls: { cmd: string; args: Record<string, unknown> }[];
} {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  const ipc: Ipc = {
    async call<K extends keyof Commands>(
      cmd: K,
      args: Commands[K]["args"]
    ): Promise<Commands[K]["result"]> {
      calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
      if (cmd === "output_only_start") {
        return {
          sigma_peak_dbv: -12,
          clipped: false,
          fitted_output_range_dbv: 8,
          errors: [],
        } as Commands[K]["result"];
      }
      return null as Commands[K]["result"];
    },
  };
  return { ipc, calls };
}

/** Slot 0 (focused) + slot 1 (adopted as usb/B), both connected. */
function twoSessionState(): AppState {
  let s = initialState();
  s = {
    ...s,
    devices: {
      ...s.devices,
      sessions: {
        ...s.devices.sessions,
        "slot-1": { ...initialSession(1), deviceId: "usb/B" },
      },
    },
  };
  s = withDevice(s, { status: "connected" });
  s = withDevice(s, { status: "connected" }, "slot-1");
  return s;
}

function lastStreamSlots(
  calls: { cmd: string; args: Record<string, unknown> }[],
  deviceId: string | undefined
): string[] | null {
  const updates = calls.filter(
    (c) => c.cmd === "stream_update" && c.args.deviceId === deviceId
  );
  if (updates.length === 0) return null;
  const config = updates[updates.length - 1].args.config as {
    slots: { id: string }[];
  };
  return config.slots.map((x) => x.id);
}

describe("setSourceTargetRoute / removeSourceTarget — the fan-out (issue #25 lot F3)", () => {
  it("a retarget re-syncs BOTH the gaining and the losing streaming session", async () => {
    let s = twoSessionState();
    s = withRun(s, { streaming: true });
    s = withRun(s, { streaming: true }, "slot-1");
    s.sources = { order: ["a"], byId: { a: sine("a") } };
    const store = new Store<AppState>(s, { freeze: true });
    const { ipc, calls } = recordingIpc();

    setSourceTargetRoute(store, ipc, "a", 1, "left");
    await flush();
    // Focus cell still present: both sessions carry the source.
    expect(lastStreamSlots(calls, undefined)).toEqual(["a"]);
    expect(lastStreamSlots(calls, "usb/B")).toEqual(["a"]);
    expect(store.get().sources.byId["a"].targets).toEqual([
      { slot: null, route: "left", i2sRoute: "off" },
      { slot: 1, route: "left", i2sRoute: "off" },
    ]);

    removeSourceTarget(store, ipc, "a", null);
    await flush();
    // Slot 0 LOST the source — its running stream must hear about it.
    expect(lastStreamSlots(calls, undefined)).toEqual([]);
    expect(lastStreamSlots(calls, "usb/B")).toEqual(["a"]);
    expect(store.get().sources.byId["a"].targets).toEqual([{ slot: 1, route: "left", i2sRoute: "off" }]);
  });

  it("the wire carries the CELL's route, not the legacy field", async () => {
    let s = twoSessionState();
    s = withRun(s, { streaming: true }, "slot-1");
    s.sources = { order: ["a"], byId: { a: sine("a", { route: "left" }) } };
    const store = new Store<AppState>(s, { freeze: true });
    const { ipc, calls } = recordingIpc();
    setSourceTargetRoute(store, ipc, "a", 1, "right");
    await flush();
    const upd = calls.find(
      (c) => c.cmd === "stream_update" && c.args.deviceId === "usb/B"
    )!;
    const config = upd.args.config as { slots: { id: string; route: string }[] };
    expect(config.slots).toEqual([expect.objectContaining({ id: "a", route: "right" })]);
  });

  it("a retarget onto a program-locked session emits NO output_only_start (the F2 gate holds from this caller)", async () => {
    let s = twoSessionState();
    s = withRun(s, { outputOnly: true, programLock: "THD sweep running" }, "slot-1");
    s.sources = { order: ["a"], byId: { a: sine("a") } };
    const store = new Store<AppState>(s, { freeze: true });
    const { ipc, calls } = recordingIpc();
    setSourceTargetRoute(store, ipc, "a", 1, "both");
    await flush();
    expect(calls.filter((c) => c.cmd === "output_only_start")).toEqual([]);
    // The intent LANDED in the matrix — it plays once the program releases.
    expect(store.get().sources.byId["a"].targets).toContainEqual({
      slot: 1,
      route: "both",
      i2sRoute: "off",
    });
  });

  it("routing a PLAYING source onto a connected-but-IDLE session STARTS its capture — route-then-play parity (review MUST-FIX 1)", async () => {
    let s = twoSessionState();
    s = withRun(s, { streaming: true }); // slot 0 carries the focus cell
    s.sources = { order: ["a"], byId: { a: sine("a") } }; // playing: true
    const store = new Store<AppState>(s, { freeze: true });
    const { ipc, calls } = recordingIpc();
    setSourceTargetRoute(store, ipc, "a", 1, "left");
    await flush();
    expect(
      calls.some((c) => c.cmd === "stream_start" && c.args.deviceId === "usb/B")
    ).toBe(true);
    expect(store.get().devices.sessions["slot-1"].run.streaming).toBe(true);
  });

  it("…but a PAUSED source never starts anything on a retarget", async () => {
    const s = twoSessionState();
    s.sources = { order: ["a"], byId: { a: sine("a", { playing: false }) } };
    const store = new Store<AppState>(s, { freeze: true });
    const { ipc, calls } = recordingIpc();
    setSourceTargetRoute(store, ipc, "a", 1, "left");
    await flush();
    expect(calls.filter((c) => c.cmd === "stream_start")).toEqual([]);
  });

  it("the auto-start is scoped to the EDITED cell's session — an edit aimed at B never resurrects A's stopped capture (re-review a)", async () => {
    const s = twoSessionState(); // both connected, NEITHER streaming
    s.sources = { order: ["a"], byId: { a: sine("a") } }; // playing, focus cell
    const store = new Store<AppState>(s, { freeze: true });
    const { ipc, calls } = recordingIpc();
    setSourceTargetRoute(store, ipc, "a", 1, "left");
    await flush();
    const starts = calls.filter((c) => c.cmd === "stream_start");
    expect(starts.map((c) => c.args.deviceId)).toEqual(["usb/B"]);
    expect(store.get().devices.sessions[SLOT0].run.streaming).toBe(false);
  });

  it("an 'off' write never auto-starts — de-routing means the same as ✕ (re-review b)", async () => {
    const s = twoSessionState();
    s.sources = {
      order: ["a"],
      byId: {
        a: sine("a", {
          targets: [
            { slot: null, route: "left", i2sRoute: "off" },
            { slot: 1, route: "right", i2sRoute: "off" },
          ],
        }),
      },
    };
    const store = new Store<AppState>(s, { freeze: true });
    const { ipc, calls } = recordingIpc();
    setSourceTargetRoute(store, ipc, "a", 1, "off");
    await flush();
    expect(calls.filter((c) => c.cmd === "stream_start")).toEqual([]);
  });

  it("two quick cell writes (the L-then-R 'both' gesture) start one unit ONCE (re-review c)", async () => {
    const s = twoSessionState();
    s.sources = { order: ["a"], byId: { a: sine("a") } };
    const store = new Store<AppState>(s, { freeze: true });
    const { ipc, calls } = recordingIpc();
    setSourceTargetRoute(store, ipc, "a", 1, "left");
    setSourceTargetRoute(store, ipc, "a", 1, "both"); // same tick, still !streaming
    await flush();
    expect(
      calls.filter((c) => c.cmd === "stream_start" && c.args.deviceId === "usb/B")
    ).toHaveLength(1);
  });

  it("the play guard ignores a STALE lock on a disconnected session — the enabled button must not click into a silent refusal (review #2)", async () => {
    let s = twoSessionState();
    // An unplug mid-sweep keeps programLock set until the in-flight command
    // rejects (runStoppedByDisconnect leaves it) — the focused session can
    // be disconnected AND locked at once.
    s = withDevice(s, { status: "disconnected" });
    s = withRun(s, { programLock: "stale-prog" });
    s = withRun(s, { streaming: true }, "slot-1");
    s.sources = {
      order: ["a"],
      byId: { a: sine("a", { playing: false, targets: [{ slot: 1, route: "right", i2sRoute: "off" }] }) },
    };
    const store = new Store<AppState>(s, { freeze: true });
    const { ipc } = recordingIpc();
    setSourcePlaying(store, ipc, "a", true);
    await flush();
    expect(store.get().sources.byId["a"].playing).toBe(true);
  });

  it("the play guard is scoped to the source's LIVE TARGETS (step 8): a lock on the FOCUSED device no longer blocks a source pinned elsewhere", async () => {
    let s = twoSessionState();
    s = withRun(s, { programLock: "prog-on-A" }); // slot 0, the focus
    s = withRun(s, { streaming: true }, "slot-1");
    s.sources = {
      order: ["a"],
      byId: { a: sine("a", { playing: false, targets: [{ slot: 1, route: "left", i2sRoute: "off" }] }) },
    };
    const store = new Store<AppState>(s, { freeze: true });
    const { ipc, calls } = recordingIpc();
    setSourcePlaying(store, ipc, "a", true);
    await flush();
    expect(store.get().sources.byId["a"].playing).toBe(true);
    expect(calls.some((c) => c.cmd === "stream_update" && c.args.deviceId === "usb/B")).toBe(
      true
    );
  });

  it("…while a lock on the TARGET's own session still refuses (display and guard agree)", async () => {
    let s = twoSessionState();
    s = withRun(s, { streaming: true, programLock: "prog-on-B" }, "slot-1");
    s.sources = {
      order: ["a"],
      byId: { a: sine("a", { playing: false, targets: [{ slot: 1, route: "left", i2sRoute: "off" }] }) },
    };
    const store = new Store<AppState>(s, { freeze: true });
    const { ipc, calls } = recordingIpc();
    setSourcePlaying(store, ipc, "a", true);
    await flush();
    expect(store.get().sources.byId["a"].playing).toBe(false);
    expect(calls).toEqual([]);
  });

  it("an unroutable slot ≥ 1 target reaches no wire call and throws nothing", async () => {
    let s = twoSessionState();
    s = {
      ...s,
      devices: {
        ...s.devices,
        sessions: {
          ...s.devices.sessions,
          "slot-1": { ...s.devices.sessions["slot-1"], deviceId: null },
        },
      },
    };
    s = withRun(s, { outputOnly: true, streaming: true }, "slot-1");
    s.sources = { order: ["a"], byId: { a: sine("a") } };
    const store = new Store<AppState>(s, { freeze: true });
    const { ipc, calls } = recordingIpc();
    expect(() => setSourceTargetRoute(store, ipc, "a", 1, "left")).not.toThrow();
    await flush();
    // Nothing reaches the wire at all: the unadopted slot-1 is unroutable
    // (sessionArgs never runs), and the cell-scoped auto-start targets the
    // EDITED session only — startRun's own isRoutable gate refuses it.
    expect(calls).toEqual([]);
  });
});

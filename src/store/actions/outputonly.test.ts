/**
 * Output-only / generator ownership per SESSION (issue #25 lot F2): each
 * session's gap-free generator follows what the routing matrix resolves
 * onto THAT session — independent starts with disjoint slot sets, the stop
 * branch when nothing routes here (never `output_only_start` with an empty
 * slot set, which the backend rejects), and the post-await re-gate on an
 * unroutable slot ≥ 1.
 */
import { describe, expect, it } from "vitest";
import type { Commands, Ipc } from "../../ipc/ipc";
import { Store } from "../store";
import type { AppState, SourceMeta } from "../state";
import { initialSession, initialState, SLOT0 } from "../state";
import { withDevice, withRun } from "./sessions.fixtures";
import { setOutputOnly, syncAllOutputOnly, syncOutputOnly } from "./outputonly";
import { setSourceLevel } from "./sources";
import { disposeSession } from "./stream";

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
    targets: [],
    playing: true,
    ...over,
  } as SourceMeta;
}

/** Records every call with its args; canned results for the two generator
 * verbs, null for the rest. */
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
      if (cmd === "stop_generator") return "stopped" as Commands[K]["result"];
      return null as Commands[K]["result"];
    },
  };
  return { ipc, calls };
}

/** Two connected sessions: slot 0 (focused) and slot 1 (adopted id). */
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

describe("per-session generator ownership (issue #25 lot F2)", () => {
  it("two sessions in output-only start two independent generators with DISJOINT slot sets", async () => {
    let s = twoSessionState();
    s = withRun(s, { outputOnly: true });
    s = withRun(s, { outputOnly: true }, "slot-1");
    s.sources = {
      order: ["a", "b"],
      byId: {
        a: sine("a", { targets: [{ slot: 0, route: "left" }] }),
        b: sine("b", { targets: [{ slot: 1, route: "both" }] }),
      },
    };
    const store = new Store<AppState>(s, { freeze: true });
    const { ipc, calls } = recordingIpc();
    syncOutputOnly(store, ipc, SLOT0);
    syncOutputOnly(store, ipc, "slot-1");
    await flush();
    const starts = calls.filter((c) => c.cmd === "output_only_start");
    expect(starts).toHaveLength(2);
    const bySession = Object.fromEntries(
      starts.map((c) => [
        (c.args.deviceId as string | undefined) ?? "slot0",
        (c.args.slots as { id: string }[]).map((x) => x.id),
      ])
    );
    expect(bySession).toEqual({ slot0: ["a"], "usb/B": ["b"] });
    expect(store.get().devices.sessions[SLOT0].run.generatorRunning).toBe(true);
    expect(store.get().devices.sessions["slot-1"].run.generatorRunning).toBe(true);
  });

  it("a session in output-only with NOTHING routed onto it never calls output_only_start (the backend rejects an empty slot set)", async () => {
    let s = twoSessionState();
    s = withRun(s, { outputOnly: true }, "slot-1");
    // A playing source, but focus-following → slot 0 only.
    s.sources = { order: ["a"], byId: { a: sine("a") } };
    const store = new Store<AppState>(s, { freeze: true });
    const { ipc, calls } = recordingIpc();
    syncOutputOnly(store, ipc, "slot-1");
    await flush();
    expect(calls.filter((c) => c.cmd === "output_only_start")).toHaveLength(0);
    expect(store.get().devices.sessions["slot-1"].run.generatorRunning).toBe(false);
  });

  it("that same session STOPS its running generator once its last source is unrouted", async () => {
    let s = twoSessionState();
    s = withRun(s, { outputOnly: true, generatorRunning: true }, "slot-1");
    s.sources = { order: ["a"], byId: { a: sine("a") } }; // routes to slot 0
    const store = new Store<AppState>(s, { freeze: true });
    const { ipc, calls } = recordingIpc();
    syncOutputOnly(store, ipc, "slot-1");
    await flush();
    expect(calls.map((c) => c.cmd)).toEqual(["stop_generator"]);
    expect(calls[0].args.deviceId).toBe("usb/B");
    expect(store.get().devices.sessions["slot-1"].run.generatorRunning).toBe(false);
  });

  it("the stop branch re-gates on isRoutable — an unadopted slot ≥ 1 makes NO wire call (never the default runtime's generator)", async () => {
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
    s = withRun(s, { outputOnly: false, generatorRunning: true }, "slot-1");
    const store = new Store<AppState>(s, { freeze: true });
    const { ipc, calls } = recordingIpc();
    syncOutputOnly(store, ipc, "slot-1");
    await flush();
    expect(calls).toHaveLength(0);
    expect(store.get().ui.toasts).toHaveLength(0); // silent, not an error
  });

  it("setOutputOnly takes an explicit session key and flips THAT session's mode", async () => {
    let s = twoSessionState();
    s.sources = {
      order: ["b"],
      byId: { b: sine("b", { targets: [{ slot: 1, route: "both" }] }) },
    };
    const store = new Store<AppState>(s, { freeze: true });
    const { ipc, calls } = recordingIpc();
    setOutputOnly(store, ipc, true, "slot-1");
    await flush();
    expect(store.get().devices.sessions["slot-1"].run.outputOnly).toBe(true);
    expect(store.get().devices.sessions[SLOT0].run.outputOnly).toBe(false);
    expect(calls.filter((c) => c.cmd === "output_only_start")).toHaveLength(1);
  });

  it("syncAllOutputOnly skips idle sessions — no resume-to-capture side effects from a bench-global sweep", async () => {
    let s = twoSessionState();
    // Both sessions idle (no output-only, no generator), a source playing.
    s.sources = { order: ["a"], byId: { a: sine("a") } };
    const store = new Store<AppState>(s, { freeze: true });
    const { ipc, calls } = recordingIpc();
    syncAllOutputOnly(store, ipc);
    await flush();
    expect(calls).toHaveLength(0);
  });
});

describe("syncSourcesEverywhere — the fan-out (issue #25 lot F2)", () => {
  it("one session streaming ⇒ exactly ONE stream_update (the pre-F2 single call, byte-identity)", async () => {
    let s = initialState();
    s = withDevice(s, { status: "connected" });
    s = withRun(s, { streaming: true });
    s.sources = { order: ["a"], byId: { a: sine("a") } };
    const store = new Store<AppState>(s, { freeze: true });
    const { ipc, calls } = recordingIpc();
    setSourceLevel(store, ipc, "a", -20);
    await flush();
    expect(calls.map((c) => c.cmd)).toEqual(["stream_update"]);
  });

  it("N streaming sessions ⇒ one wire call EACH, each on its own owner branch", async () => {
    let s = twoSessionState();
    s = withRun(s, { streaming: true });
    s = withRun(s, { outputOnly: true, generatorRunning: true }, "slot-1");
    s.sources = {
      order: ["a", "b"],
      byId: {
        a: sine("a", { targets: [{ slot: 0, route: "left" }] }),
        b: sine("b", { targets: [{ slot: 1, route: "both" }] }),
      },
    };
    const store = new Store<AppState>(s, { freeze: true });
    const { ipc, calls } = recordingIpc();
    setSourceLevel(store, ipc, "b", -20);
    await flush();
    expect(calls.map((c) => c.cmd).sort()).toEqual(["output_only_start", "stream_update"]);
    const upd = calls.find((c) => c.cmd === "stream_update")!;
    expect(upd.args.deviceId).toBeUndefined(); // slot 0 stays arg-less
    const start = calls.find((c) => c.cmd === "output_only_start")!;
    expect(start.args.deviceId).toBe("usb/B");
  });
});

describe("program lock vs the generator path (F2 review MUST-FIX #1)", () => {
  it("a rebuild queued against a LOCKED session never calls output_only_start — the program owns the DAC and the range register", async () => {
    let s = twoSessionState();
    // The runProgram shape: outputOnly stays on for the whole run, the
    // generator is already stopped, the lock names the program.
    s = withRun(
      s,
      { outputOnly: true, generatorRunning: false, programLock: "prog-1" },
      "slot-1"
    );
    s.sources = {
      order: ["b"],
      byId: { b: sine("b", { targets: [{ slot: 1, route: "both" }] }) },
    };
    const store = new Store<AppState>(s, { freeze: true });
    const { ipc, calls } = recordingIpc();
    // Both the direct rebuild and the bench-global sweep must no-op.
    syncOutputOnly(store, ipc, "slot-1");
    syncAllOutputOnly(store, ipc);
    await flush();
    expect(calls).toHaveLength(0);
  });

  it("the keyed resume AFTER the lock clears still rebuilds (runProgram releases before it resumes)", async () => {
    let s = twoSessionState();
    s = withRun(s, { outputOnly: true, programLock: null }, "slot-1");
    s.sources = {
      order: ["b"],
      byId: { b: sine("b", { targets: [{ slot: 1, route: "both" }] }) },
    };
    const store = new Store<AppState>(s, { freeze: true });
    const { ipc, calls } = recordingIpc();
    syncOutputOnly(store, ipc, "slot-1");
    await flush();
    expect(calls.map((c) => c.cmd)).toEqual(["output_only_start"]);
  });
});

describe("disposeSession clears THIS module's rebuild-chain entry (issue #25 lot F2 review note #8 — the 'per-session module maps get disposed' rule)", () => {
  it("a session re-minted on the SAME key starts its OWN fresh chain — it is not queued behind the evicted session's still-pending rebuild", async () => {
    let s = twoSessionState();
    s = withRun(s, { outputOnly: true }, SLOT0);
    s.sources = { order: ["a"], byId: { a: sine("a") } }; // default target -> SLOT0

    const store = new Store<AppState>(s, { freeze: true });

    // A rebuild whose wire call never settles — simulates an in-flight
    // output_only_start still on the wire the instant the session is torn
    // down (device removed / lost mid-rebuild). Without the disposer this
    // chain entry lives forever, and every future syncOutputOnly(SLOT0)
    // would queue silently behind it.
    const hangingIpc: Ipc = { call: () => new Promise(() => {}) };
    syncOutputOnly(store, hangingIpc, SLOT0);
    await flush(); // the chain now holds a promise that will NEVER resolve

    disposeSession(SLOT0);

    // The re-mint's first rebuild, on a NORMAL (resolving) ipc — if the
    // disposer had not cleared the chain entry, this would queue behind the
    // hanging promise above and never fire; it must complete within one
    // flush.
    const { ipc, calls } = recordingIpc();
    syncOutputOnly(store, ipc, SLOT0);
    await flush();
    expect(calls.map((c) => c.cmd)).toEqual(["output_only_start"]);
  });
});

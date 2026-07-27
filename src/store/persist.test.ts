/**
 * Workspace persistence (M5): the v5 document round-trips through JSON and
 * `applyWorkspaceDoc`, the v4 importer maps a REAL legacy blob (captured
 * from the v1 template code — tests/e2e/fixtures/workspace-v4.json)
 * without losing anything the user can see, and a v1-era blob walks the
 * whole chain v1 → v4 → v5.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import v4Blob from "../../tests/e2e/fixtures/workspace-v4.json";
import { Store } from "./store";
import type { AppState, SweepProgram } from "./state";
import { DEFAULT_SWEEP_PARAMS, HW_TRACE_IDS, initialState } from "./state";
import {
  isQuotaExceeded,
  migrate,
  saveCurrent,
  saveNamed,
  snapshotWorkspace,
  WS_VERSION,
} from "./persist";
import { applyWorkspaceDoc } from "./actions/workspace";
import { addProgram, removeProgram } from "./actions/programs";
import { freezeTrace } from "./actions/traces";
import { sweepVM } from "./selectors/chartvm";
import { getTriggerSnapshot, putTriggerSnapshot } from "../data/triggered";
import { clearAllFrames, getFrames, putFrames } from "../data/frames";
import { templates } from "./templates";
import type { Ipc } from "../ipc/ipc";

const stubIpc: Ipc = {
  call: () => Promise.resolve(null as never),
};

function freshStore(): Store<AppState> {
  return new Store(initialState(), { freeze: true });
}

describe("v5 document", () => {
  it("snapshot → JSON → migrate → apply round-trips the bench", () => {
    const store = freshStore();
    // A bench with something in every slice: rename, collapse, tile tweak.
    store.update("test/seed", (s) => ({
      ...s,
      workspace: { name: "Bench A", collapsed: ["programs"] },
      layout: {
        ...s.layout,
        tiles: {
          ...s.layout.tiles,
          "tile-1": { ...s.layout.tiles["tile-1"], fdUnit: "dbu" as const },
        },
      },
    }));

    const doc = migrate(JSON.parse(JSON.stringify(snapshotWorkspace(store.get()))));
    expect(doc).not.toBeNull();

    const dest = freshStore();
    expect(applyWorkspaceDoc(dest, stubIpc, doc!)).toBe(true);
    const s = dest.get();
    expect(s.workspace).toEqual({ name: "Bench A", collapsed: ["programs"] });
    expect(s.layout.tiles["tile-1"].fdUnit).toBe("dbu");
    // The restored snapshot is identical to the saved one (stability: the
    // auto-save must not thrash on load).
    expect(snapshotWorkspace(s)).toEqual(doc);
  });

  it("normalizes transients: nothing plays or runs after a load", () => {
    const store = freshStore();
    store.update("test/play", (s) => ({
      ...s,
      sources: {
        ...s.sources,
        byId: {
          "src-sine-1": { ...s.sources.byId["src-sine-1"], playing: true },
        },
      },
    }));
    const doc = snapshotWorkspace(store.get());
    expect(doc.sources.byId["src-sine-1"].playing).toBe(false);
  });

  it("carries trigger settings through the round trip, armEpoch reset to 0", () => {
    const store = freshStore();
    store.update("test/trigger", (s) => ({
      ...s,
      triggers: {
        ...s.triggers,
        [HW_TRACE_IDS.inputL]: {
          mode: "single",
          edge: "falling",
          levelV: -0.2,
          hystV: 0.05,
          armEpoch: 7, // a live SINGLE arm — must NOT survive the snapshot
        },
      },
    }));
    const doc = migrate(JSON.parse(JSON.stringify(snapshotWorkspace(store.get()))));
    expect(doc).not.toBeNull();
    expect(doc!.triggers[HW_TRACE_IDS.inputL]).toEqual({
      mode: "single",
      edge: "falling",
      levelV: -0.2,
      hystV: 0.05,
      armEpoch: 0,
    });

    const dest = freshStore();
    expect(applyWorkspaceDoc(dest, stubIpc, doc!)).toBe(true);
    expect(dest.get().triggers[HW_TRACE_IDS.inputL]?.armEpoch).toBe(0);
    expect(dest.get().triggers[HW_TRACE_IDS.inputL]?.mode).toBe("single");
  });

  it("clears any HELD trigger snapshot on load (review #3: a stale picture must not survive under a reused trace id)", () => {
    putTriggerSnapshot(HW_TRACE_IDS.inputL, {
      seq: 1,
      state: "triggered",
      index: 10,
      frac: 0,
      sampleRate: 48000,
      samples: { [HW_TRACE_IDS.inputL]: Float64Array.from([0, 1, 2]) },
      offsetDb: { [HW_TRACE_IDS.inputL]: 0 },
    });
    expect(getTriggerSnapshot(HW_TRACE_IDS.inputL)).toBeDefined();

    const dest = freshStore();
    const doc = migrate(JSON.parse(JSON.stringify(snapshotWorkspace(dest.get()))))!;
    expect(applyWorkspaceDoc(dest, stubIpc, doc)).toBe(true);
    expect(getTriggerSnapshot(HW_TRACE_IDS.inputL)).toBeUndefined();
  });

  it("every built-in template survives JSON + migrate and references real traces", () => {
    for (const t of templates()) {
      const doc = migrate(JSON.parse(JSON.stringify(t.make())));
      expect(doc, t.name).not.toBeNull();
      for (const tileId of doc!.layout.order) {
        for (const traceId of doc!.layout.tiles[tileId].traces) {
          expect(doc!.traces.byId[traceId], `${t.name}/${tileId}/${traceId}`).toBeDefined();
        }
      }
      // Loadable onto a live store without throwing.
      expect(applyWorkspaceDoc(freshStore(), stubIpc, doc!)).toBe(true);
    }
  });
});

describe("v5 in-version hook: trigger additions (Lot A, issue #26)", () => {
  // A v5 doc predating the trigger fields — no `triggers` key, no per-tile
  // triggerSource/triggerPositionPct/showTriggerMarkers (additions only, so
  // WS_VERSION did NOT bump — the v5 in-version hook must fill these in).
  function oldV5Doc(): Record<string, unknown> {
    const raw = JSON.parse(JSON.stringify(snapshotWorkspace(freshStore().get())));
    delete raw.triggers;
    for (const tile of Object.values(raw.layout.tiles as Record<string, Record<string, unknown>>)) {
      delete tile.triggerSource;
      delete tile.triggerPositionPct;
      delete tile.showTriggerMarkers;
    }
    return raw;
  }

  it("a doc without new fields loads with defaults", () => {
    const doc = migrate(oldV5Doc());
    expect(doc).not.toBeNull();
    expect(doc!.triggers).toEqual({});
    for (const tile of Object.values(doc!.layout.tiles)) {
      expect(tile.triggerSource).toBe("auto");
      expect(tile.triggerPositionPct).toBe(50);
      expect(tile.showTriggerMarkers).toBe(true);
    }
  });

  it("round-trips: loading an old doc then re-snapshotting is stable", () => {
    const doc = migrate(oldV5Doc())!;
    const dest = freshStore();
    expect(applyWorkspaceDoc(dest, stubIpc, doc)).toBe(true);
    expect(snapshotWorkspace(dest.get())).toEqual(doc);
  });

  it("a doc with a stale non-zero armEpoch is normalized to 0", () => {
    const raw = oldV5Doc();
    raw.triggers = {
      [HW_TRACE_IDS.inputL]: {
        mode: "single",
        edge: "rising",
        levelV: 0,
        hystV: null,
        armEpoch: 42, // e.g. a hand-edited blob, or a future format quirk
      },
    };
    const doc = migrate(raw);
    expect(doc!.triggers[HW_TRACE_IDS.inputL].armEpoch).toBe(0);
  });
});

describe("v5 in-version hook: THD level-axis additions (issue #27)", () => {
  // A v5 doc predating the level axis: a "thd" sweep program whose params
  // have no `axis`/`toneHz`/`startDbfs`/`endDbfs` keys at all (additions
  // only, so WS_VERSION did NOT bump — same shape as the Lot A trigger
  // hook above). Every sweep such a doc could have saved WAS a
  // frequency-axis one.
  function oldV5DocWithSweep(): { raw: Record<string, unknown>; progId: string } {
    const store = freshStore();
    const progId = addProgram(store, "thd");
    const raw = JSON.parse(JSON.stringify(snapshotWorkspace(store.get()))) as Record<
      string,
      unknown
    >;
    const programs = raw.programs as { byId: Record<string, { params: Record<string, unknown> }> };
    const params = programs.byId[progId].params;
    delete params.axis;
    delete params.toneHz;
    delete params.startDbfs;
    delete params.endDbfs;
    return { raw, progId };
  }

  it("picks up frequency-axis defaults — no crash, no undefined leaking through", () => {
    const { raw, progId } = oldV5DocWithSweep();
    const doc = migrate(raw);
    expect(doc).not.toBeNull();
    const params = (doc!.programs.byId[progId] as SweepProgram).params;
    expect(params.axis).toBe("frequency");
    expect(params.toneHz).toBe(DEFAULT_SWEEP_PARAMS.toneHz);
    expect(params.startDbfs).toBe(DEFAULT_SWEEP_PARAMS.startDbfs);
    expect(params.endDbfs).toBe(DEFAULT_SWEEP_PARAMS.endDbfs);

    // Loadable onto a live store without throwing (the exact failure mode
    // a missing-field crash would show up as).
    const dest = freshStore();
    expect(applyWorkspaceDoc(dest, stubIpc, doc!)).toBe(true);
  });

  it("round-trips: loading the old doc then re-snapshotting is stable", () => {
    const { raw } = oldV5DocWithSweep();
    const doc = migrate(raw)!;
    const dest = freshStore();
    expect(applyWorkspaceDoc(dest, stubIpc, doc)).toBe(true);
    expect(snapshotWorkspace(dest.get())).toEqual(doc);
  });
});

describe("v5 in-version hook: user weighting curve (issue #29)", () => {
  it("carries the loaded curve through the round trip", () => {
    const store = freshStore();
    store.update("test/curve", (s) => ({
      ...s,
      weighting: {
        userCurve: { freqs: [100, 1000], gains: [0, 6] },
        userCurveName: "my-curve.csv",
      },
    }));
    const doc = migrate(JSON.parse(JSON.stringify(snapshotWorkspace(store.get()))));
    expect(doc!.userWeightingCurve).toEqual({ freqs: [100, 1000], gains: [0, 6] });
    expect(doc!.userWeightingCurveName).toBe("my-curve.csv");

    const dest = freshStore();
    expect(applyWorkspaceDoc(dest, stubIpc, doc!)).toBe(true);
    expect(dest.get().weighting).toEqual({
      userCurve: { freqs: [100, 1000], gains: [0, 6] },
      userCurveName: "my-curve.csv",
    });
  });

  it("a doc predating the curve (no key at all) loads with none", () => {
    const raw = JSON.parse(JSON.stringify(snapshotWorkspace(freshStore().get())));
    delete raw.userWeightingCurve;
    delete raw.userWeightingCurveName;
    const doc = migrate(raw);
    expect(doc).not.toBeNull();
    expect(doc!.userWeightingCurve).toBeNull();
    expect(doc!.userWeightingCurveName).toBeNull();
  });

  // Review finding #5: migrate() must actually VALIDATE the curve's shape
  // (typeof-checks, like every other in-version-hook sibling), not just an
  // `=== undefined` check — a hand-edited or corrupted blob must degrade to
  // "no curve" instead of poisoning `describeUserCurve`/the transform
  // dialog with garbage later.
  it("a malformed userWeightingCurve degrades to null instead of surviving the round trip", () => {
    const bad = [
      { freqs: "not-an-array", gains: [0, 12] },
      { freqs: [100, 1000], gains: [0] }, // mismatched length
      { freqs: [0, 1000], gains: [0, 12] }, // freq 0 -> ln() NaN
      { freqs: [1000, 100], gains: [0, 12] }, // not ascending
      "just a string",
      42,
      {},
    ];
    for (const value of bad) {
      const raw = JSON.parse(JSON.stringify(snapshotWorkspace(freshStore().get())));
      raw.userWeightingCurve = value;
      const doc = migrate(raw);
      expect(doc, JSON.stringify(value)).not.toBeNull();
      expect(doc!.userWeightingCurve, JSON.stringify(value)).toBeNull();
    }
  });

  it("a non-string userWeightingCurveName degrades to null", () => {
    const raw = JSON.parse(JSON.stringify(snapshotWorkspace(freshStore().get())));
    raw.userWeightingCurveName = 42;
    const doc = migrate(raw);
    expect(doc!.userWeightingCurveName).toBeNull();
  });

  it("applyWorkspaceDoc re-sanitizes even a doc that skipped migrate() (e.g. a template)", () => {
    const dest = freshStore();
    const doc = {
      ...migrate(JSON.parse(JSON.stringify(snapshotWorkspace(freshStore().get()))))!,
      userWeightingCurve: { freqs: [0, 1000], gains: [0, 12] }, // invalid, bypassing migrate()
      userWeightingCurveName: 42 as unknown as string,
    };
    expect(applyWorkspaceDoc(dest, stubIpc, doc)).toBe(true);
    expect(dest.get().weighting.userCurve).toBeNull();
    expect(dest.get().weighting.userCurveName).toBeNull();
  });
});

describe("v4 importer (real legacy blob)", () => {
  // The fixture is EXACTLY what the v1 frontend wrote for saveNamed("Amp /
  // DAC bench") — generated by src/dashboard/store.ts, not hand-written.
  const doc = migrate(JSON.parse(JSON.stringify(v4Blob)))!;

  it("accepts the blob", () => {
    expect(doc).not.toBeNull();
    expect(doc.version).toBe(WS_VERSION);
    expect(doc.name).toBe("Amp / DAC bench");
  });

  it("maps the generator to a sine source with its params and route", () => {
    expect(doc.sources.order).toContain("t-gen");
    const gen = doc.sources.byId["t-gen"];
    expect(gen).toMatchObject({
      kind: "sine",
      route: "both",
      playing: false,
      frequencyHz: 1000,
      levelDbv: -12,
    });
  });

  it("maps the sweeps to programs + result traces", () => {
    expect(doc.programs.order).toEqual(["t-thd", "t-fr"]);
    const thd = doc.programs.byId["t-thd"] as SweepProgram;
    expect(thd.kind).toBe("sweep");
    expect(thd.params).toMatchObject({
      measurement: "thd",
      channel: "left",
      startHz: 20,
      endHz: 20000,
      levelDbfs: -6,
    });
    // The legacy (v4, pre-issue-#27) format has no axis concept at all —
    // every sweep it could have saved was a frequency sweep — so the
    // importer must default it explicitly, not leave it undefined.
    expect(thd.params.axis).toBe("frequency");
    const fr = doc.programs.byId["t-fr"] as SweepProgram;
    expect(fr.params.measurement).toBe("fr");
    expect(doc.traces.byId["t-thd"]?.source.kind).toBe("program");
    expect(doc.traces.byId["t-fr"]?.source.kind).toBe("program");
    expect(doc.traces.byId["t-thd"]?.label).toBe("THD vs freq");
  });

  it("maps graphs to tiles: kind, membership, chips, pattern", () => {
    expect(doc.layout.pattern).toBe("2x2");
    expect(doc.layout.order).toEqual(["g-spec", "g-thd", "g-fr", "g-scope"]);
    expect(doc.layout.tiles["g-spec"]).toMatchObject({
      kind: "spectrum",
      traces: [HW_TRACE_IDS.inputL],
      measures: ["thd", "thddb", "thdn", "sinad"],
    });
    expect(doc.layout.tiles["g-thd"].kind).toBe("sweep");
    expect(doc.layout.tiles["g-thd"].traces).toEqual(["t-thd"]);
    expect(doc.layout.tiles["g-fr"]).toMatchObject({
      kind: "sweep",
      showPhase: true,
      traces: ["t-fr"],
    });
    expect(doc.layout.tiles["g-scope"]).toMatchObject({
      kind: "scope",
      traces: [HW_TRACE_IDS.inputL],
      measures: ["rms", "peak", "crest"],
    });
  });

  it("loads onto a live store", () => {
    const store = freshStore();
    expect(applyWorkspaceDoc(store, stubIpc, doc)).toBe(true);
    expect(store.get().programs.order).toHaveLength(2);
    // The 4 hardware endpoints are still there.
    for (const id of Object.values(HW_TRACE_IDS)) {
      expect(store.get().traces.byId[id]).toBeDefined();
    }
  });
});

describe("v1 → v5 chain", () => {
  // A v1 blob as the v1-era app wrote it (from the legacy e2e spec): the
  // generator still has the retired analyze/capture flags and no
  // extraTones; the script has no role yet.
  const v1 = {
    version: 1,
    name: "Legacy v1",
    layout: { pattern: "1", slots: ["g1"] },
    graphs: [
      {
        id: "g1",
        title: "Spectrum",
        domain: "fd",
        series: [{ traceId: "hw-in-left", domain: "fd" }],
        x: { log: true },
        y: { autoscale: true },
      },
    ],
    traces: [
      { id: "hw-in-left", source: { kind: "hw_input", channel: "left" }, label: "Input L" },
      {
        id: "gen-legacy",
        label: "Old Sine",
        source: {
          kind: "generator",
          params: {
            waveform: "sine",
            frequency: 1000,
            level: -12,
            output: "both",
            window: 8192,
            analyze: "left",
            capture: false,
          },
        },
      },
      {
        id: "script-legacy",
        label: "Old Meas",
        source: {
          kind: "script",
          params: { name: "Old Meas", source: "let c = acquire();\nprint(c.rms);" },
        },
      },
    ],
  };

  it("migrates without losing traces and classifies the script", () => {
    const doc = migrate(JSON.parse(JSON.stringify(v1)));
    expect(doc).not.toBeNull();
    // The generator became a sine source (tone list empty), retired flags
    // gone by construction of the v2 shape.
    expect(doc!.sources.byId["gen-legacy"]).toMatchObject({
      kind: "sine",
      route: "both",
      levelDbv: -12,
      extraTones: [],
    });
    // The acquire() script is a measurement PROGRAM (v1→v2 classification).
    expect(doc!.programs.byId["script-legacy"]).toMatchObject({
      kind: "script",
      role: "measurement",
    });
    expect(doc!.traces.byId["script-legacy"]?.label).toBe("Old Meas");
    // The graph landed as a spectrum tile on Input L.
    expect(doc!.layout.tiles["g1"]).toMatchObject({
      kind: "spectrum",
      traces: ["hw-in-left"],
    });
  });

  it("rejects garbage", () => {
    expect(migrate(null)).toBeNull();
    expect(migrate({ version: 99 })).toBeNull();
    expect(migrate({ version: 4 })).toBeNull(); // no layout/graphs/traces
  });
});

describe("issue #27 review finding #1: a level sweep's x-axis survives freeze + save/reload", () => {
  beforeEach(() => clearAllFrames());

  it("freeze ❄ → delete the ORIGINAL program → snapshot → JSON → reload: the frozen trace still reports dBFS, not a NaN Hz axis", () => {
    const store = freshStore();
    const progId = addProgram(store, "thd");
    store.update("test/level-axis", (s) => {
      const p = s.programs.byId[progId];
      if (p.kind !== "sweep") return s;
      return {
        ...s,
        programs: {
          ...s.programs,
          byId: {
            ...s.programs.byId,
            [progId]: { ...p, params: { ...p.params, axis: "level" as const } },
          },
        },
      };
    });

    // Land a level-axis sweep result exactly as runSweep would (the frame
    // carries xUnit "dBFS", derived from the backend's `swept` field).
    putFrames(progId, 1, {
      sweep: {
        freqs: Float64Array.from([-60, -30, 0]),
        curves: [{ label: "Left", values: Float64Array.from([-120, -100, -80]), phaseDeg: null }],
        xUnit: "dBFS",
      },
    });
    store.update("test/land", (s) => ({
      ...s,
      traces: {
        ...s.traces,
        byId: {
          ...s.traces.byId,
          [progId]: { ...s.traces.byId[progId], seq: 1, domains: ["sweep"] },
        },
      },
    }));

    const memId = freezeTrace(store, progId);
    expect(memId).not.toBeNull();

    // Delete the ORIGINAL program — the frozen copy must not depend on it
    // still existing (the exact regression: the old code read the axis
    // from `programs.byId`, which a memory trace never has an entry in,
    // and which this delete removes for the source program too).
    removeProgram(store, stubIpc, progId);
    expect(store.get().programs.byId[progId]).toBeUndefined();

    const doc = migrate(JSON.parse(JSON.stringify(snapshotWorkspace(store.get()))));
    expect(doc).not.toBeNull();

    const dest = freshStore();
    expect(applyWorkspaceDoc(dest, stubIpc, doc!)).toBe(true);

    // The frame itself still knows its axis post-reload...
    expect(getFrames(memId!)?.sweep?.xUnit).toBe("dBFS");
    // ...and a sweep tile showing it renders a dBFS axis, not a log-Hz one
    // fed negative dBFS values (which used to plot as NaN).
    const t = dest.get().layout.tiles["tile-1"];
    const vm = sweepVM(dest.get(), { ...t, kind: "sweep", traces: [memId!] });
    expect(vm.xUnit).toBe("dBFS");
    expect(Array.from(vm.series[0].x)).toEqual([-60, -30, 0]);
  });
});

describe("saveCurrent / saveNamed — quota-exceeded is reported, not swallowed (issue #29 review finding #2)", () => {
  // Stubs the WHOLE global rather than spying on the runtime's own
  // `Storage.prototype` — this suite doesn't rely on (or fight with)
  // whatever localStorage backing the current Node/Vitest environment
  // happens to provide.
  function fakeLocalStorage(setItem: (k: string, v: string) => void): Storage {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem,
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
      key: (i: number) => Array.from(map.keys())[i] ?? null,
      get length() {
        return map.size;
      },
    } as Storage;
  }

  function quotaError(): DOMException {
    return new DOMException("The quota has been exceeded.", "QuotaExceededError");
  }

  afterEach(() => vi.unstubAllGlobals());

  it("saveCurrent returns true and calls no error callback on a normal write", () => {
    const written = new Map<string, string>();
    vi.stubGlobal(
      "localStorage",
      fakeLocalStorage((k, v) => void written.set(k, v))
    );
    const onError = vi.fn();
    const doc = migrate(JSON.parse(JSON.stringify(snapshotWorkspace(new Store(initialState()).get()))))!;
    expect(saveCurrent(doc, onError)).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    expect(written.size).toBe(1);
  });

  it("saveCurrent returns false and reports the error when localStorage throws", () => {
    vi.stubGlobal(
      "localStorage",
      fakeLocalStorage(() => {
        throw quotaError();
      })
    );
    const onError = vi.fn();
    const doc = migrate(JSON.parse(JSON.stringify(snapshotWorkspace(new Store(initialState()).get()))))!;
    expect(saveCurrent(doc, onError)).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(isQuotaExceeded(onError.mock.calls[0][0])).toBe(true);
  });

  it("saveNamed also reports (never throws uncaught) on a quota failure", () => {
    vi.stubGlobal(
      "localStorage",
      fakeLocalStorage(() => {
        throw quotaError();
      })
    );
    const onError = vi.fn();
    const doc = migrate(JSON.parse(JSON.stringify(snapshotWorkspace(new Store(initialState()).get()))))!;
    expect(() => saveNamed("bench", doc, onError)).not.toThrow();
    expect(saveNamed("bench", doc, onError)).toBe(false);
    expect(isQuotaExceeded(onError.mock.calls[0][0])).toBe(true);
  });

  it("isQuotaExceeded is false for an unrelated error", () => {
    expect(isQuotaExceeded(new Error("network down"))).toBe(false);
    expect(isQuotaExceeded("not even an Error")).toBe(false);
  });
});

describe("v5 in-version hook: capture provenance (issue #40)", () => {
  const capture = {
    device: { model: "QA403", serial: "AB12_CD34", firmware: 61, isVirtual: false },
    sampleRateHz: 48000,
    inputRangeDbv: 42,
    outputRangeDbv: 18,
    offsets: { input_l: 32.1, input_r: 32.2, output_l: 8.1, output_r: 8.2, calibrated: true },
    fftSize: 32768,
    window: "flattop" as const,
    averaging: { mode: "power" as const, count: 8 },
    capturedAt: "2026-07-26T08:00:00.000Z",
  };

  it("a doc predating the field loads with capture=null on every trace", () => {
    const doc = JSON.parse(JSON.stringify(snapshotWorkspace(freshStore().get())));
    for (const t of Object.values(doc.traces.byId) as Record<string, unknown>[]) {
      delete t.capture;
    }
    const migrated = migrate(doc);
    expect(migrated).not.toBeNull();
    for (const t of Object.values(migrated!.traces.byId)) {
      expect(t.capture).toBeNull();
    }
    // Round-trip stability: loading the old doc then re-snapshotting digests
    // identically (the same rule as every other in-version hook).
    const dest = freshStore();
    expect(applyWorkspaceDoc(dest, stubIpc, migrated!)).toBe(true);
    expect(snapshotWorkspace(dest.get())).toEqual(migrated);
  });

  it("a frozen ❄ trace's capture snapshot survives the save/reload round trip", () => {
    clearAllFrames();
    const store = freshStore();
    putFrames(HW_TRACE_IDS.inputL, 1, {
      fd: { freqs: Float64Array.from([100]), magDb: Float64Array.from([-6]) },
    });
    store.update("test/stamp", (s) => ({
      ...s,
      traces: {
        ...s.traces,
        byId: {
          ...s.traces.byId,
          [HW_TRACE_IDS.inputL]: {
            ...s.traces.byId[HW_TRACE_IDS.inputL],
            seq: 1,
            domains: ["fd" as const],
            offsetDb: 32.1,
            capture,
          },
        },
      },
    }));
    const memId = freezeTrace(store, HW_TRACE_IDS.inputL);
    expect(memId).not.toBeNull();

    const doc = migrate(JSON.parse(JSON.stringify(snapshotWorkspace(store.get()))));
    expect(doc).not.toBeNull();
    // The ❄ copy keeps the snapshot; the LIVE endpoint sheds it with its
    // data (it re-acquires on load, like offsetDb).
    expect(doc!.traces.byId[memId!].capture).toEqual(capture);
    expect(doc!.traces.byId[HW_TRACE_IDS.inputL].capture).toBeNull();

    const dest = freshStore();
    expect(applyWorkspaceDoc(dest, stubIpc, doc!)).toBe(true);
    expect(dest.get().traces.byId[memId!].capture).toEqual(capture);
  });
});

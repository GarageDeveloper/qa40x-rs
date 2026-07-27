/**
 * Workspace storage seam (issue #44 lot 1): IndexedDB records round-trip
 * the document with frames stored as BINARY typed arrays (Float32 for
 * td/fd — exact for 24-bit converter samples — Float64 for sweep results),
 * and the one-shot localStorage import moves every old `qa40x-v2-ws-*`
 * blob into IndexedDB then removes its key (freeing the ~5 MB quota that
 * motivated the whole issue). Runs against fake-indexeddb — the real IDB
 * state machine, in-memory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { Store } from "./store";
import { initialState } from "./state";
import { snapshotWorkspace, type WorkspaceDoc } from "./persist";
import { createMemoryWorkspaceStore, createWorkspaceStore } from "./wsstore";

function fakeLocalStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

function baseDoc(name = "Bench"): WorkspaceDoc {
  const doc = snapshotWorkspace(new Store(initialState()).get());
  doc.name = name;
  return doc;
}

/** A doc carrying one frozen ❄ trace's frames in every domain. The td
 * samples are 24-bit converter values (k/2^23) — exact in Float32. */
function docWithFrames(name = "Frozen bench"): WorkspaceDoc {
  const doc = baseDoc(name);
  doc.refFrames["mem-1"] = {
    td: {
      domain: "td",
      sample_rate: 48000,
      t0: 0,
      samples: [0, 1 / 8388608, -4321 / 8388608, 0.5, -1],
    },
    fd: {
      domain: "fd",
      freqs: [93.75, 187.5, 20000.125],
      mag_db: [-100.123, -3.01, -140.7],
      phase_deg: null,
    },
    sweep: {
      domain: "sweep",
      freqs: [-60, -30, 0],
      curves: [
        { label: "THD L", values: [-88.123456789, -90.1, -92.2], phase_deg: null },
      ],
    },
    sweepXUnit: "dBFS",
    sweepYUnit: "dB",
  };
  return doc;
}

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("localStorage", fakeLocalStorage());
});
afterEach(() => vi.unstubAllGlobals());

describe("IndexedDB WorkspaceStore — named saves", () => {
  it("save → list → load round-trips, and the record takes the save name", async () => {
    const ws = createWorkspaceStore();
    await ws.save("A bench", baseDoc("stale name"));
    expect(await ws.list()).toEqual(["A bench"]);
    const loaded = await ws.load("A bench");
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe("A bench");
    expect(loaded!.version).toBe(5);
  });

  it("frozen ❄ frames survive the binary round trip", async () => {
    const ws = createWorkspaceStore();
    await ws.save("frozen", docWithFrames());
    const loaded = (await ws.load("frozen"))!;
    const f = loaded.refFrames["mem-1"];
    if (f.td?.domain !== "td" || f.fd?.domain !== "fd" || f.sweep?.domain !== "sweep") {
      throw new Error("round trip lost a domain");
    }

    // td: 24-bit sample values are EXACT through Float32.
    expect(f.td.sample_rate).toBe(48000);
    expect(f.td.samples).toEqual([0, 1 / 8388608, -4321 / 8388608, 0.5, -1]);

    // fd: Float32 — bit-identical is not promised, 7 significant digits are.
    expect(f.fd.freqs[0]).toBeCloseTo(93.75, 4);
    expect(f.fd.freqs[2]).toBeCloseTo(20000.125, 2);
    expect(f.fd.mag_db[0]).toBeCloseTo(-100.123, 4);

    // sweep: Float64 — a measurement record keeps full precision.
    expect(f.sweep.freqs).toEqual([-60, -30, 0]);
    expect(f.sweep.curves[0].values).toEqual([-88.123456789, -90.1, -92.2]);
    expect(f.sweep.curves[0].label).toBe("THD L");
    expect(f.sweepXUnit).toBe("dBFS");
    expect(f.sweepYUnit).toBe("dB");
  });

  it("delete removes the record; loading a missing name is null, not a throw", async () => {
    const ws = createWorkspaceStore();
    await ws.save("gone soon", baseDoc());
    await ws.delete("gone soon");
    expect(await ws.list()).toEqual([]);
    expect(await ws.load("gone soon")).toBeNull();
    expect(await ws.load("never existed")).toBeNull();
  });

  it("a corrupted record degrades to null instead of crashing the load", async () => {
    const ws = createWorkspaceStore();
    await ws.save("ok", baseDoc());
    // Vandalize the record behind the seam's back.
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("qa40x-v2", 1);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction("ws-named", "readwrite");
        tx.objectStore("ws-named").put({ version: 999, nonsense: true }, "ok");
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    });
    expect(await ws.load("ok")).toBeNull();
  });
});

describe("IndexedDB WorkspaceStore — current doc", () => {
  it("saveCurrent → loadCurrent round-trips; empty store yields null", async () => {
    const ws = createWorkspaceStore();
    expect(await ws.loadCurrent()).toBeNull();
    await ws.saveCurrent(baseDoc("Live bench"));
    expect((await ws.loadCurrent())?.name).toBe("Live bench");
    // The current doc is not a named save.
    expect(await ws.list()).toEqual([]);
  });
});

describe("one-shot localStorage → IndexedDB import", () => {
  const LS_CURRENT = "qa40x-v2-ws-current";
  const SAVED = "qa40x-v2-ws:";

  it("imports the current + named blobs, then removes their keys", async () => {
    localStorage.setItem(LS_CURRENT, JSON.stringify(baseDoc("Auto bench")));
    localStorage.setItem(SAVED + "Old bench", JSON.stringify(baseDoc("Old bench")));
    localStorage.setItem(SAVED + "Frozen", JSON.stringify(docWithFrames("Frozen")));
    localStorage.setItem("qa40x-v2-theme", "dark"); // unrelated key: untouched
    localStorage.setItem("qa40x-dash-ws:Legacy", "{}"); // v1 legacy: untouched

    const ws = createWorkspaceStore();
    expect((await ws.loadCurrent())?.name).toBe("Auto bench");
    expect(await ws.list()).toEqual(["Frozen", "Old bench"]);
    expect((await ws.load("Frozen"))?.refFrames["mem-1"]?.td?.domain).toBe("td");

    expect(localStorage.getItem(LS_CURRENT)).toBeNull();
    expect(localStorage.getItem(SAVED + "Old bench")).toBeNull();
    expect(localStorage.getItem(SAVED + "Frozen")).toBeNull();
    expect(localStorage.getItem("qa40x-v2-theme")).toBe("dark");
    expect(localStorage.getItem("qa40x-dash-ws:Legacy")).toBe("{}");
  });

  it("an existing IndexedDB record wins over a stale localStorage blob (and the key still goes)", async () => {
    // First run: the doc lands in IndexedDB.
    const first = createWorkspaceStore();
    const idbDoc = baseDoc("Bench");
    idbDoc.collapsed = ["programs"];
    await first.save("Bench", idbDoc);
    await first.saveCurrent(idbDoc);

    // A stale localStorage twin appears (e.g. an older app version wrote it).
    const stale = baseDoc("Bench");
    stale.collapsed = ["sources"];
    localStorage.setItem(SAVED + "Bench", JSON.stringify(stale));
    localStorage.setItem(LS_CURRENT, JSON.stringify(stale));

    // Second run (fresh seam instance, same DB): import must not roll back.
    const second = createWorkspaceStore();
    expect((await second.load("Bench"))?.collapsed).toEqual(["programs"]);
    expect((await second.loadCurrent())?.collapsed).toEqual(["programs"]);
    expect(localStorage.getItem(SAVED + "Bench")).toBeNull();
    expect(localStorage.getItem(LS_CURRENT)).toBeNull();
  });

  it("an unparsable blob is left in place (never destroy what we could not read)", async () => {
    localStorage.setItem(SAVED + "Broken", "{not json");
    const ws = createWorkspaceStore();
    expect(await ws.list()).toEqual([]);
    expect(localStorage.getItem(SAVED + "Broken")).toBe("{not json");
  });
});

describe("memory fallback store", () => {
  it("implements the same seam (used when IndexedDB is unavailable)", async () => {
    const ws = createMemoryWorkspaceStore();
    await ws.save("m", docWithFrames("m"));
    expect(await ws.list()).toEqual(["m"]);
    const sweep = (await ws.load("m"))?.refFrames["mem-1"]?.sweep;
    if (sweep?.domain !== "sweep") throw new Error("round trip lost the sweep");
    expect(sweep.freqs).toEqual([-60, -30, 0]);
    await ws.delete("m");
    expect(await ws.list()).toEqual([]);
    await ws.saveCurrent(baseDoc("cur"));
    expect((await ws.loadCurrent())?.name).toBe("cur");
  });
});

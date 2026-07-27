/**
 * Workspace storage seam (issue #44 lot 1) — IndexedDB behind a small
 * async `WorkspaceStore { list / load / save / delete }` interface.
 *
 * Why not localStorage: a single frozen ❄ trace at FFT 32768 serialized as
 * decimal JSON weighs ~1.2 MB, the document is stored twice (auto-save
 * "current" + the named save), and the WebKit/Tauri localStorage quota is
 * ~5 MB per origin — two frozen traces and every save fails. IndexedDB
 * quotas are measured in gigabytes, the API is async (no UI jank on
 * multi-MB writes), and records go through structured clone, so typed
 * arrays are stored as BINARY, not decimal text.
 *
 * Record shape: the v5 `WorkspaceDoc` with `refFrames` swapped for a
 * binary twin — td/fd sample data as `Float32Array` (exact for 24-bit
 * converter samples: a 24-bit mantissa holds k/2^23 exactly; ~4× smaller
 * than Float64 and ~9× smaller than decimal JSON), sweep results kept
 * `Float64Array` (a sweep is ~10²/point-sized — negligible — and it is a
 * *measurement record*, so it keeps full precision). The JSON `Frame`
 * shape exists only at the seam boundary: `load()` rebuilds it and runs
 * the same `migrate()` every other ingest path uses.
 *
 * Migration: on first open, any `qa40x-v2-ws-*` localStorage blob is
 * imported into IndexedDB and the localStorage key is REMOVED (that frees
 * the quota — the whole point). The legacy v1 frontend keys
 * (`qa40x-dash-*`) stay untouched and read-only, exactly as before
 * (persist.ts). After the import, workspace documents never touch
 * localStorage again.
 */
import type { TraceId } from "../core/model";
import { migrate, type PersistedFrames, type WorkspaceDoc } from "./persist";

/** The storage seam. All methods reject with the underlying storage error
 * (e.g. a `QuotaExceededError` DOMException) — callers surface it. */
export interface WorkspaceStore {
  /** Names of saved workspaces, sorted. */
  list(): Promise<string[]>;
  load(name: string): Promise<WorkspaceDoc | null>;
  save(name: string, doc: WorkspaceDoc): Promise<void>;
  delete(name: string): Promise<void>;
  /** The auto-saved current workspace (restored on reload). */
  loadCurrent(): Promise<WorkspaceDoc | null>;
  saveCurrent(doc: WorkspaceDoc): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Binary record encoding                                              */
/* ------------------------------------------------------------------ */

interface StoredFrames {
  td?: { sampleRate: number; samples: Float32Array };
  fd?: { freqs: Float32Array; magDb: Float32Array };
  sweep?: {
    freqs: Float64Array;
    curves: { label: string; values: Float64Array; phaseDeg: Float64Array | null }[];
  };
  sweepXUnit?: PersistedFrames["sweepXUnit"];
  sweepYUnit?: PersistedFrames["sweepYUnit"];
}

/** The IndexedDB record: the document with binary frames. */
type StoredDoc = Omit<WorkspaceDoc, "refFrames"> & {
  refFrames: Record<TraceId, StoredFrames>;
};

function encodeFrames(p: PersistedFrames): StoredFrames {
  const out: StoredFrames = {};
  if (p.td?.domain === "td") {
    out.td = {
      sampleRate: p.td.sample_rate,
      samples: Float32Array.from(p.td.samples),
    };
  }
  if (p.fd?.domain === "fd") {
    out.fd = {
      freqs: Float32Array.from(p.fd.freqs),
      magDb: Float32Array.from(p.fd.mag_db),
    };
  }
  if (p.sweep?.domain === "sweep") {
    out.sweep = {
      freqs: Float64Array.from(p.sweep.freqs),
      curves: p.sweep.curves.map((c) => ({
        label: c.label,
        values: Float64Array.from(c.values),
        phaseDeg: c.phase_deg ? Float64Array.from(c.phase_deg) : null,
      })),
    };
    if (p.sweepXUnit) out.sweepXUnit = p.sweepXUnit;
    if (p.sweepYUnit) out.sweepYUnit = p.sweepYUnit;
  }
  return out;
}

function decodeFrames(s: StoredFrames): PersistedFrames {
  const out: PersistedFrames = {};
  if (s.td) {
    out.td = {
      domain: "td",
      sample_rate: s.td.sampleRate,
      t0: 0,
      samples: Array.from(s.td.samples),
    };
  }
  if (s.fd) {
    out.fd = {
      domain: "fd",
      freqs: Array.from(s.fd.freqs),
      mag_db: Array.from(s.fd.magDb),
      phase_deg: null,
    };
  }
  if (s.sweep) {
    out.sweep = {
      domain: "sweep",
      freqs: Array.from(s.sweep.freqs),
      curves: s.sweep.curves.map((c) => ({
        label: c.label,
        values: Array.from(c.values),
        phase_deg: c.phaseDeg ? Array.from(c.phaseDeg) : null,
      })),
    };
    if (s.sweepXUnit) out.sweepXUnit = s.sweepXUnit;
    if (s.sweepYUnit) out.sweepYUnit = s.sweepYUnit;
  }
  return out;
}

export function encodeDoc(doc: WorkspaceDoc): StoredDoc {
  const refFrames: Record<TraceId, StoredFrames> = {};
  for (const [id, p] of Object.entries(doc.refFrames)) {
    refFrames[id] = encodeFrames(p);
  }
  return { ...doc, refFrames };
}

/** Rebuild the JSON document shape and run it through `migrate()` — a
 * corrupt or hand-tampered record degrades to null / field defaults, the
 * same contract as every other document ingest path. */
export function decodeDoc(raw: unknown): WorkspaceDoc | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as StoredDoc;
  const refFrames: Record<TraceId, PersistedFrames> = {};
  if (rec.refFrames && typeof rec.refFrames === "object") {
    for (const [id, s] of Object.entries(rec.refFrames)) {
      if (s && typeof s === "object") refFrames[id] = decodeFrames(s);
    }
  }
  return migrate({ ...rec, refFrames });
}

/* ------------------------------------------------------------------ */
/* IndexedDB implementation                                            */
/* ------------------------------------------------------------------ */

const DB_NAME = "qa40x-v2";
const DB_VERSION = 1;
/** Named saves, out-of-line key = workspace name. */
const NAMED_STORE = "ws-named";
/** The auto-saved current doc, single fixed key. */
const CURRENT_STORE = "ws-current";
const CURRENT_KEY = "current";

/** The localStorage keys workspaces lived under before this seam
 * (persist.ts) — read once at migration, then removed. */
const LS_CURRENT_KEY = "qa40x-v2-ws-current";
const LS_SAVED_PREFIX = "qa40x-v2-ws:";

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB request failed"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
  });
}

class IdbWorkspaceStore implements WorkspaceStore {
  /** Open + one-shot localStorage import, memoized. A failed open is NOT
   * cached — the next call retries. */
  private dbPromise: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    const p = (async () => {
      const openReq = indexedDB.open(DB_NAME, DB_VERSION);
      openReq.onupgradeneeded = () => {
        const db = openReq.result;
        if (!db.objectStoreNames.contains(NAMED_STORE)) {
          db.createObjectStore(NAMED_STORE);
        }
        if (!db.objectStoreNames.contains(CURRENT_STORE)) {
          db.createObjectStore(CURRENT_STORE);
        }
      };
      const db = await req(openReq as IDBRequest<IDBDatabase>);
      // If a version rollback or an externally-created empty DB left the
      // stores missing, fail loudly rather than throwing on every tx.
      if (
        !db.objectStoreNames.contains(NAMED_STORE) ||
        !db.objectStoreNames.contains(CURRENT_STORE)
      ) {
        db.close();
        throw new Error("workspace DB is missing its object stores");
      }
      await importFromLocalStorage(db);
      return db;
    })();
    this.dbPromise = p;
    p.catch(() => {
      if (this.dbPromise === p) this.dbPromise = null;
    });
    return p;
  }

  async list(): Promise<string[]> {
    const db = await this.open();
    const keys = await req(
      db.transaction(NAMED_STORE, "readonly").objectStore(NAMED_STORE).getAllKeys()
    );
    return keys.map(String).sort();
  }

  async load(name: string): Promise<WorkspaceDoc | null> {
    const db = await this.open();
    const rec = await req(
      db.transaction(NAMED_STORE, "readonly").objectStore(NAMED_STORE).get(name)
    );
    return rec === undefined ? null : decodeDoc(rec);
  }

  async save(name: string, doc: WorkspaceDoc): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(NAMED_STORE, "readwrite");
    tx.objectStore(NAMED_STORE).put(encodeDoc({ ...doc, name }), name);
    await txDone(tx);
  }

  async delete(name: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(NAMED_STORE, "readwrite");
    tx.objectStore(NAMED_STORE).delete(name);
    await txDone(tx);
  }

  async loadCurrent(): Promise<WorkspaceDoc | null> {
    const db = await this.open();
    const rec = await req(
      db.transaction(CURRENT_STORE, "readonly").objectStore(CURRENT_STORE).get(CURRENT_KEY)
    );
    return rec === undefined ? null : decodeDoc(rec);
  }

  async saveCurrent(doc: WorkspaceDoc): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(CURRENT_STORE, "readwrite");
    tx.objectStore(CURRENT_STORE).put(encodeDoc(doc), CURRENT_KEY);
    await txDone(tx);
  }
}

/* ------------------------------------------------------------------ */
/* One-shot localStorage → IndexedDB import                            */
/* ------------------------------------------------------------------ */

function parseDoc(raw: string | null): WorkspaceDoc | null {
  if (!raw) return null;
  try {
    return migrate(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Import every `qa40x-v2-ws-*` localStorage blob, then remove its key —
 * freeing the 5 MB quota is the point. Rules:
 *  - a key is removed only once its document verifiably sits in IndexedDB
 *    (imported now, or already there from a previous partial run);
 *  - an existing IndexedDB record always wins over the localStorage blob
 *    (IndexedDB is the newer store — a re-import must not roll it back);
 *  - an unparsable blob is left in place (never destroy user data we
 *    could not read; it costs a few KB, not the quota).
 * Idempotent by construction: after one full pass there is nothing left
 * to import.
 */
async function importFromLocalStorage(db: IDBDatabase): Promise<void> {
  let ls: Storage;
  try {
    ls = localStorage;
  } catch {
    return; // no localStorage in this context — nothing to import
  }

  // Current doc.
  const rawCurrent = ls.getItem(LS_CURRENT_KEY);
  if (rawCurrent !== null) {
    const doc = parseDoc(rawCurrent);
    if (doc) {
      const tx = db.transaction(CURRENT_STORE, "readwrite");
      const store = tx.objectStore(CURRENT_STORE);
      const existing = await req(store.count(CURRENT_KEY));
      if (existing === 0) store.put(encodeDoc(doc), CURRENT_KEY);
      await txDone(tx);
      ls.removeItem(LS_CURRENT_KEY);
    }
  }

  // Named saves.
  const names: string[] = [];
  for (let i = 0; i < ls.length; i++) {
    const k = ls.key(i);
    if (k && k.startsWith(LS_SAVED_PREFIX)) names.push(k.slice(LS_SAVED_PREFIX.length));
  }
  for (const name of names) {
    const key = LS_SAVED_PREFIX + name;
    const doc = parseDoc(ls.getItem(key));
    if (!doc) continue;
    const tx = db.transaction(NAMED_STORE, "readwrite");
    const store = tx.objectStore(NAMED_STORE);
    const existing = await req(store.count(name));
    if (existing === 0) store.put(encodeDoc({ ...doc, name }), name);
    await txDone(tx);
    ls.removeItem(key);
  }
}

/* ------------------------------------------------------------------ */
/* Construction                                                        */
/* ------------------------------------------------------------------ */

/** In-memory fallback (and test double): same seam, no persistence. The
 * `structuredClone` round trip mirrors what IndexedDB does — records are
 * detached from both the caller's document and the loaded one (`migrate()`
 * mutates in place, and the store deep-freezes what it is handed). */
export function createMemoryWorkspaceStore(): WorkspaceStore {
  const named = new Map<string, StoredDoc>();
  let current: StoredDoc | null = null;
  return {
    list: async () => [...named.keys()].sort(),
    load: async (name) => {
      const rec = named.get(name);
      return rec === undefined ? null : decodeDoc(structuredClone(rec));
    },
    save: async (name, doc) => void named.set(name, structuredClone(encodeDoc({ ...doc, name }))),
    delete: async (name) => void named.delete(name),
    loadCurrent: async () => (current === null ? null : decodeDoc(structuredClone(current))),
    saveCurrent: async (doc) => void (current = structuredClone(encodeDoc(doc))),
  };
}

/**
 * The app's workspace store: IndexedDB, with an in-memory fallback if the
 * webview somehow has none (the bench still runs; saves just don't
 * survive the session). Also asks the browser to exempt the origin from
 * storage eviction — best-effort, ignored where unsupported.
 */
export function createWorkspaceStore(): WorkspaceStore {
  try {
    void navigator.storage?.persist?.().catch(() => {});
  } catch {
    /* navigator absent (tests) — ignore */
  }
  if (typeof indexedDB === "undefined") {
    console.warn("qa40x: IndexedDB unavailable — workspace saves are session-only.");
    return createMemoryWorkspaceStore();
  }
  return new IdbWorkspaceStore();
}

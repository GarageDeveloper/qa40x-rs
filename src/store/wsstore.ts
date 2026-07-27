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
 * than Float64 and ~9× smaller than decimal JSON — a frozen TRANSFORM
 * output's arbitrary doubles do quantize, ~1.2e-7 relative ≈ a −138 dBFS
 * floor, ~20 dB under the QA403's own residual), sweep results kept
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

/** NaN/±Infinity pin to 0 — exactly what the localStorage era did
 * (`JSON.stringify` → `null` → `Number(null)` = 0): a frozen frame with a
 * −Inf magnitude must not start poisoning the y-autoscale `Math.min` just
 * because the serialization changed (adversarial review #10 of this lot). */
function f32(a: ArrayLike<number>): Float32Array {
  return Float32Array.from(a, (v) => (Number.isFinite(v) ? v : 0));
}
function f64(a: ArrayLike<number>): Float64Array {
  return Float64Array.from(a, (v) => (Number.isFinite(v) ? v : 0));
}

function encodeFrames(p: PersistedFrames): StoredFrames {
  const out: StoredFrames = {};
  if (p.td?.domain === "td") {
    out.td = {
      sampleRate: p.td.sample_rate,
      samples: f32(p.td.samples),
    };
  }
  if (p.fd?.domain === "fd") {
    out.fd = {
      freqs: f32(p.fd.freqs),
      magDb: f32(p.fd.mag_db),
    };
  }
  if (p.sweep?.domain === "sweep") {
    out.sweep = {
      freqs: f64(p.sweep.freqs),
      curves: p.sweep.curves.map((c) => ({
        label: c.label,
        values: f64(c.values),
        phaseDeg: c.phase_deg ? f64(c.phase_deg) : null,
      })),
    };
    if (p.sweepXUnit) out.sweepXUnit = p.sweepXUnit;
    if (p.sweepYUnit) out.sweepYUnit = p.sweepYUnit;
  }
  return out;
}

/** A stored numeric array back to plain numbers, or null if the field is
 * not an array at all (a hand-tampered or corrupted record — adversarial
 * review #5 of this lot: a malformed sub-frame must DEGRADE, not throw). */
function nums(v: unknown): number[] | null {
  if (Array.isArray(v)) return v.map(Number);
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
    return Array.from(v as unknown as ArrayLike<number>);
  }
  return null;
}

function decodeFrames(s: StoredFrames): PersistedFrames {
  const out: PersistedFrames = {};
  if (s.td && typeof s.td === "object") {
    const samples = nums(s.td.samples);
    if (samples && typeof s.td.sampleRate === "number") {
      out.td = { domain: "td", sample_rate: s.td.sampleRate, t0: 0, samples };
    }
  }
  if (s.fd && typeof s.fd === "object") {
    const freqs = nums(s.fd.freqs);
    const magDb = nums(s.fd.magDb);
    if (freqs && magDb) {
      out.fd = { domain: "fd", freqs, mag_db: magDb, phase_deg: null };
    }
  }
  if (s.sweep && typeof s.sweep === "object") {
    const freqs = nums(s.sweep.freqs);
    if (freqs && Array.isArray(s.sweep.curves)) {
      const curves: { label: string; values: number[]; phase_deg: number[] | null }[] = [];
      for (const c of s.sweep.curves) {
        const values = c && typeof c === "object" ? nums(c.values) : null;
        if (!values) continue;
        curves.push({
          label: typeof c.label === "string" ? c.label : "",
          values,
          phase_deg: c.phaseDeg ? nums(c.phaseDeg) : null,
        });
      }
      out.sweep = { domain: "sweep", freqs, curves };
      if (s.sweepXUnit) out.sweepXUnit = s.sweepXUnit;
      if (s.sweepYUnit) out.sweepYUnit = s.sweepYUnit;
    }
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
  try {
    if (!raw || typeof raw !== "object") return null;
    const rec = raw as StoredDoc;
    const refFrames: Record<TraceId, PersistedFrames> = {};
    if (rec.refFrames && typeof rec.refFrames === "object") {
      for (const [id, s] of Object.entries(rec.refFrames)) {
        if (s && typeof s === "object") refFrames[id] = decodeFrames(s);
      }
    }
    return migrate({ ...rec, refFrames });
  } catch {
    // Whatever slipped past the field guards: an unreadable record IS
    // "no record", never a crash (same contract as migrate()).
    return null;
  }
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
      // NOTE an open can stay pending (blocked by another connection, or a
      // webview storage stall) — mountApp races the boot restore against a
      // timeout so a hung open degrades to "mount anyway, restore when it
      // lands" instead of a blank window (adversarial review #4).
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
      // Best-effort: a failing import must never brick the store — every
      // method funnels through open(), so a rejection here would take
      // list/load/save/delete down with it, INCLUDING the "delete an old
      // workspace to free space" recovery path (adversarial review #3).
      try {
        await importFromLocalStorage(db);
      } catch {
        /* keys stay in place; retried at next boot */
      }
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
 *  - a key is removed only when ITS document was imported into IndexedDB
 *    just now — never on a skip: if an IndexedDB record already exists we
 *    cannot know which of the two is newer (a downgrade/upgrade cycle can
 *    make the localStorage one newer), so the loser's blob is left in
 *    place rather than destroyed (adversarial review #11 of this lot);
 *  - an existing IndexedDB record wins for what the app LOADS (IndexedDB
 *    is the store of record going forward — a re-import must not roll it
 *    back), the localStorage twin just stops being read;
 *  - an unparsable blob is left in place (never destroy user data we
 *    could not read; it costs a few KB, not the quota);
 *  - per-key best-effort: one blob failing to import (e.g. its put hits a
 *    full disk) must not stop the others, and never rejects open().
 * Idempotent: after one clean pass there is nothing left to import.
 */
async function importFromLocalStorage(db: IDBDatabase): Promise<void> {
  let ls: Storage;
  try {
    ls = localStorage;
  } catch {
    return; // no localStorage in this context — nothing to import
  }

  // Current doc.
  try {
    const doc = parseDoc(ls.getItem(LS_CURRENT_KEY));
    if (doc) {
      const tx = db.transaction(CURRENT_STORE, "readwrite");
      const store = tx.objectStore(CURRENT_STORE);
      const existing = await req(store.count(CURRENT_KEY));
      if (existing === 0) {
        store.put(encodeDoc(doc), CURRENT_KEY);
        await txDone(tx);
        ls.removeItem(LS_CURRENT_KEY);
      } else {
        await txDone(tx);
      }
    }
  } catch {
    /* key stays; retried at next boot */
  }

  // Named saves.
  const names: string[] = [];
  for (let i = 0; i < ls.length; i++) {
    const k = ls.key(i);
    if (k && k.startsWith(LS_SAVED_PREFIX)) names.push(k.slice(LS_SAVED_PREFIX.length));
  }
  for (const name of names) {
    try {
      const key = LS_SAVED_PREFIX + name;
      const doc = parseDoc(ls.getItem(key));
      if (!doc) continue;
      const tx = db.transaction(NAMED_STORE, "readwrite");
      const store = tx.objectStore(NAMED_STORE);
      const existing = await req(store.count(name));
      if (existing === 0) {
        store.put(encodeDoc({ ...doc, name }), name);
        await txDone(tx);
        ls.removeItem(key);
      } else {
        await txDone(tx);
      }
    } catch {
      continue; // this blob stays; the others still get their chance
    }
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
 * survive the session — but the pre-#44 localStorage blobs are still
 * READ, so an upgrading user's benches stay reachable; their keys are
 * never removed on this path). Also asks the browser to exempt the origin
 * from storage eviction — best-effort, ignored where unsupported.
 */
export function createWorkspaceStore(): WorkspaceStore {
  try {
    void navigator.storage?.persist?.().catch(() => {});
  } catch {
    /* navigator absent (tests) — ignore */
  }
  if (typeof indexedDB === "undefined") {
    console.warn("qa40x: IndexedDB unavailable — workspace saves are session-only.");
    const mem = createMemoryWorkspaceStore();
    try {
      const cur = parseDoc(localStorage.getItem(LS_CURRENT_KEY));
      if (cur) void mem.saveCurrent(cur);
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(LS_SAVED_PREFIX)) continue;
        const doc = parseDoc(localStorage.getItem(k));
        if (doc) void mem.save(k.slice(LS_SAVED_PREFIX.length), doc);
      }
    } catch {
      /* no localStorage either — start empty */
    }
    return mem;
  }
  return new IdbWorkspaceStore();
}

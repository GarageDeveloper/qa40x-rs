/**
 * Workspace save paths (issue #29 review finding #2, reworked for the
 * issue #44 lot 1 storage seam): a quota-exceeded write must surface a
 * toast, not vanish into an empty catch. The seam is injected, so the
 * failure mode is a store whose writes reject with the same
 * `QuotaExceededError` DOMException IndexedDB produces.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { Store } from "../store";
import { initialState } from "../state";
import type { Ipc } from "../../ipc/ipc";
import { createMemoryWorkspaceStore, type WorkspaceStore } from "../wsstore";
import {
  initAutoSave,
  loadWorkspaceNamed,
  restoreWorkspaceAtBoot,
  saveWorkspaceAs,
} from "./workspace";

const stubIpc: Ipc = {
  call: () => Promise.resolve(null as never),
};

function quotaError(): DOMException {
  return new DOMException("The quota has been exceeded.", "QuotaExceededError");
}

/** A minimal, functional localStorage double (same shape used by
 * wsstore.test.ts) — installed via `vi.stubGlobal` so `persist.ts`'s legacy
 * readers see it. */
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

/** A localStorage double whose `getItem` throws — the disabled/blocked-
 * storage case `main.ts`'s theme/REST-token reads and `wsstore.ts`'s
 * importer already guard against. */
function throwingLocalStorage(): Storage {
  return {
    getItem: () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    },
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  } as Storage;
}

/** The memory seam with every WRITE rejecting like a full IndexedDB. */
function fullStore(): WorkspaceStore {
  const mem = createMemoryWorkspaceStore();
  return {
    ...mem,
    save: () => Promise.reject(quotaError()),
    saveCurrent: () => Promise.reject(quotaError()),
  };
}

describe("initAutoSave — quota failures toast instead of vanishing", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("toasts once when the debounced save hits a quota error", async () => {
    const store = new Store(initialState());
    initAutoSave(store, fullStore());
    store.update("test/touch", (s) => ({ ...s, workspace: { ...s.workspace, name: "Bench A" } }));
    await vi.advanceTimersByTimeAsync(600);

    const errors = store.get().ui.toasts.filter((t) => t.kind === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/storage is full/i);
  });

  it("does not toast again on the NEXT tick while still failing (one warning per session)", async () => {
    const store = new Store(initialState());
    initAutoSave(store, fullStore());
    store.update("test/touch-1", (s) => ({ ...s, workspace: { ...s.workspace, name: "A" } }));
    await vi.advanceTimersByTimeAsync(600);
    store.update("test/touch-2", (s) => ({ ...s, workspace: { ...s.workspace, name: "B" } }));
    await vi.advanceTimersByTimeAsync(600);

    const errors = store.get().ui.toasts.filter((t) => t.kind === "error");
    expect(errors).toHaveLength(1);
  });

  it("never toasts on a normal (successful) auto-save, and the doc lands", async () => {
    const ws = createMemoryWorkspaceStore();
    const store = new Store(initialState());
    initAutoSave(store, ws);
    store.update("test/touch", (s) => ({ ...s, workspace: { ...s.workspace, name: "Bench A" } }));
    await vi.advanceTimersByTimeAsync(600);

    expect(store.get().ui.toasts.filter((t) => t.kind === "error")).toHaveLength(0);
    expect((await ws.loadCurrent())?.name).toBe("Bench A");
  });
});

describe("saveWorkspaceAs — quota failures toast a clear message", () => {
  it("toasts success on a normal save and the doc is listed", async () => {
    const ws = createMemoryWorkspaceStore();
    const store = new Store(initialState());
    await saveWorkspaceAs(store, ws, "My Bench");
    const toasts = store.get().ui.toasts;
    expect(toasts.some((t) => t.kind === "success" && t.message.includes("My Bench"))).toBe(true);
    expect(await ws.list()).toEqual(["My Bench"]);
  });

  it("toasts an error (not a silent no-op) when the write hits a quota error", async () => {
    const store = new Store(initialState());
    await saveWorkspaceAs(store, fullStore(), "Huge Bench");
    const toasts = store.get().ui.toasts;
    expect(toasts.some((t) => t.kind === "success")).toBe(false);
    const error = toasts.find((t) => t.kind === "error");
    expect(error?.message).toMatch(/storage is full/i);
  });
});

describe("loadWorkspaceNamed — a rejecting store toasts, it never crashes silently", () => {
  it('toasts "Could not load" (not a silent no-op) when ws.load() rejects', async () => {
    const store = new Store(initialState());
    const ws: WorkspaceStore = {
      ...createMemoryWorkspaceStore(),
      load: () => Promise.reject(new Error("IDB read failed")),
    };
    await loadWorkspaceNamed(store, stubIpc, ws, "Missing Bench", "saved");
    const toasts = store.get().ui.toasts;
    expect(toasts.some((t) => t.kind === "success")).toBe(false);
    const error = toasts.find((t) => t.kind === "error");
    expect(error?.message).toBe('Could not load workspace "Missing Bench".');
  });

  it("a missing name (load resolves null, not a throw) toasts the same message, no crash", async () => {
    const store = new Store(initialState());
    const ws = createMemoryWorkspaceStore();
    await loadWorkspaceNamed(store, stubIpc, ws, "Never Saved", "saved");
    const error = store.get().ui.toasts.find((t) => t.kind === "error");
    expect(error?.message).toBe('Could not load workspace "Never Saved".');
  });
});

describe("restoreWorkspaceAtBoot — boot must never block on a broken store", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("falls back to the legacy v1 current when IndexedDB (the memory store here) is empty", async () => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    localStorage.setItem(
      "qa40x-dash-current",
      JSON.stringify({
        version: 1,
        name: "Legacy current",
        layout: { pattern: "1", slots: ["g1"] },
        graphs: [],
        traces: [],
      })
    );
    const store = new Store(initialState());
    const ws = createMemoryWorkspaceStore(); // loadCurrent() resolves null — nothing saved
    // "null current" is a PROVEN read — auto-save may arm (returns true).
    await expect(restoreWorkspaceAtBoot(store, stubIpc, ws)).resolves.toBe(true);
    expect(store.get().workspace.name).toBe("Legacy current");
  });

  it("never blocks boot when the store's loadCurrent() rejects (a broken DB) and there is no legacy fallback either", async () => {
    vi.stubGlobal("localStorage", fakeLocalStorage()); // present, functional, empty
    const store = new Store(initialState());
    const ws: WorkspaceStore = {
      ...createMemoryWorkspaceStore(),
      loadCurrent: () => Promise.reject(new Error("IDB open failed")),
    };
    // A FAILED read returns false — mountApp must NOT arm the auto-save
    // (its first tick would overwrite the unreadable record with the empty
    // initial bench — issue #44 review #1).
    await expect(restoreWorkspaceAtBoot(store, stubIpc, ws)).resolves.toBe(false);
    // initialState() stands — no doc was ever applied.
    expect(store.get().workspace.name).toBe(initialState().workspace.name);
  });

  it("never blocks boot even if the legacy fallback's localStorage access itself throws (disabled/blocked storage)", async () => {
    // `mountApp` awaits this call (issue #44 lot 1) — an uncaught rejection
    // here would leave the whole app unmounted, not just the workspace
    // unrestored. Every OTHER localStorage read in this codebase (main.ts's
    // theme/REST-token reads, wsstore.ts's importer) already guards against
    // exactly this; `loadLegacyCurrent()` must degrade the same way.
    vi.stubGlobal("localStorage", throwingLocalStorage());
    const store = new Store(initialState());
    const ws: WorkspaceStore = {
      ...createMemoryWorkspaceStore(),
      loadCurrent: () => Promise.reject(new Error("IDB open failed")),
    };
    await expect(restoreWorkspaceAtBoot(store, stubIpc, ws)).resolves.toBe(false);
    expect(store.get().workspace.name).toBe(initialState().workspace.name);
  });
});

describe("initAutoSave — writes are chained: overlapping debounce ticks never overlap in flight", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("two rapid distinct edits both land, in order, and the later edit wins", async () => {
    const store = new Store(initialState());
    const calls: string[] = [];
    let inFlight = 0;
    let maxConcurrent = 0;
    const backing = createMemoryWorkspaceStore();
    const ws: WorkspaceStore = {
      ...backing,
      saveCurrent: (doc) => {
        inFlight++;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        calls.push(doc.name);
        return new Promise((resolve) =>
          setTimeout(() => {
            inFlight--;
            void backing.saveCurrent(doc).then(resolve);
          }, 1000)
        );
      },
    };
    initAutoSave(store, ws);

    store.update("test/edit-1", (s) => ({ ...s, workspace: { ...s.workspace, name: "First" } }));
    // The debounce fires and starts the FIRST save, still in flight (1000 ms).
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toEqual(["First"]);

    store.update("test/edit-2", (s) => ({ ...s, workspace: { ...s.workspace, name: "Second" } }));
    // The SECOND debounce fires 500 ms later (t=1010 relative) — well before
    // the first save's 1000 ms completes (t=1500 relative) — but the chain
    // must not let the second write start until the first one resolves.
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toEqual(["First"]); // "Second" queued behind the chain, not started
    expect(maxConcurrent).toBe(1); // never ran concurrently

    // Let the first save's 1000 ms finish — unblocking the chain.
    await vi.advanceTimersByTimeAsync(600);
    expect(calls).toEqual(["First", "Second"]);
    expect(maxConcurrent).toBe(1);

    // Let the second save finish too — the last edit is what actually lands.
    await vi.advanceTimersByTimeAsync(1000);
    expect((await backing.loadCurrent())?.name).toBe("Second");
  });

  it("A → B → A while B's write is in flight still persists A (issue #44 review #2)", async () => {
    // The dedupe must compare against the last ENQUEUED doc, not the last
    // COMMITTED one: at the third tick the committed json is still A (B is
    // in flight), so a committed-compare would skip the corrective write
    // and a reload would restore B while the live bench shows A.
    const store = new Store(initialState());
    const backing = createMemoryWorkspaceStore();
    const ws: WorkspaceStore = {
      ...backing,
      saveCurrent: (doc) =>
        new Promise((resolve) =>
          setTimeout(() => void backing.saveCurrent(doc).then(resolve), 1000)
        ),
    };
    initAutoSave(store, ws);

    store.update("test/a1", (s) => ({ ...s, workspace: { ...s.workspace, name: "A" } }));
    await vi.advanceTimersByTimeAsync(1600); // A committed (tick at 500 + write 1000)
    expect((await backing.loadCurrent())?.name).toBe("A");

    store.update("test/b", (s) => ({ ...s, workspace: { ...s.workspace, name: "B" } }));
    await vi.advanceTimersByTimeAsync(500); // B's write starts (in flight for 1000)
    store.update("test/a2", (s) => ({ ...s, workspace: { ...s.workspace, name: "A" } }));
    await vi.advanceTimersByTimeAsync(500); // A's tick fires while B is in flight

    await vi.advanceTimersByTimeAsync(3000); // drain the chain completely
    expect((await backing.loadCurrent())?.name).toBe("A");
  });
});

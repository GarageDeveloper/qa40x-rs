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
import { createMemoryWorkspaceStore, type WorkspaceStore } from "../wsstore";
import { initAutoSave, saveWorkspaceAs } from "./workspace";

function quotaError(): DOMException {
  return new DOMException("The quota has been exceeded.", "QuotaExceededError");
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

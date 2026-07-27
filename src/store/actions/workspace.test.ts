/**
 * Workspace save paths (issue #29 review finding #2): a quota-exceeded
 * write must surface a toast, not vanish into an empty catch — a huge
 * imported user weighting curve is the realistic trigger (~20k CSV rows
 * embedded in a transform step, re-stringified on every auto-save).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "../store";
import { initialState } from "../state";
import { initAutoSave, saveWorkspaceAs } from "./workspace";

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

describe("initAutoSave — quota failures toast instead of vanishing", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("toasts once when the debounced save hits a quota error", async () => {
    vi.stubGlobal(
      "localStorage",
      fakeLocalStorage(() => {
        throw quotaError();
      })
    );
    const store = new Store(initialState());
    initAutoSave(store);
    store.update("test/touch", (s) => ({ ...s, workspace: { ...s.workspace, name: "Bench A" } }));
    await vi.advanceTimersByTimeAsync(600);

    const errors = store.get().ui.toasts.filter((t) => t.kind === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/local storage is full/i);
  });

  it("does not toast again on the NEXT tick while still failing (one warning per session)", async () => {
    vi.stubGlobal(
      "localStorage",
      fakeLocalStorage(() => {
        throw quotaError();
      })
    );
    const store = new Store(initialState());
    initAutoSave(store);
    store.update("test/touch-1", (s) => ({ ...s, workspace: { ...s.workspace, name: "A" } }));
    await vi.advanceTimersByTimeAsync(600);
    store.update("test/touch-2", (s) => ({ ...s, workspace: { ...s.workspace, name: "B" } }));
    await vi.advanceTimersByTimeAsync(600);

    const errors = store.get().ui.toasts.filter((t) => t.kind === "error");
    expect(errors).toHaveLength(1);
  });

  it("never toasts on a normal (successful) auto-save", async () => {
    vi.stubGlobal(
      "localStorage",
      fakeLocalStorage(() => {
        /* accepted */
      })
    );
    const store = new Store(initialState());
    initAutoSave(store);
    store.update("test/touch", (s) => ({ ...s, workspace: { ...s.workspace, name: "Bench A" } }));
    await vi.advanceTimersByTimeAsync(600);

    expect(store.get().ui.toasts.filter((t) => t.kind === "error")).toHaveLength(0);
  });
});

describe("saveWorkspaceAs — quota failures toast a clear message", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("toasts success on a normal save", () => {
    vi.stubGlobal(
      "localStorage",
      fakeLocalStorage(() => {
        /* accepted */
      })
    );
    const store = new Store(initialState());
    saveWorkspaceAs(store, "My Bench");
    const toasts = store.get().ui.toasts;
    expect(toasts.some((t) => t.kind === "success" && t.message.includes("My Bench"))).toBe(true);
  });

  it("toasts an error (not a silent no-op) when the write hits a quota error", () => {
    vi.stubGlobal(
      "localStorage",
      fakeLocalStorage(() => {
        throw quotaError();
      })
    );
    const store = new Store(initialState());
    saveWorkspaceAs(store, "Huge Bench");
    const toasts = store.get().ui.toasts;
    expect(toasts.some((t) => t.kind === "success")).toBe(false);
    const error = toasts.find((t) => t.kind === "error");
    expect(error?.message).toMatch(/local storage is full/i);
  });
});

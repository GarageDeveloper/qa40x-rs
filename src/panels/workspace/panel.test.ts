// @vitest-environment jsdom
//
// Regression test for issue #44 lot 1's async Load menu: `rebuildMenu()`
// lists the saved names BEFORE tearing down the menu's children specifically
// so a rejecting storage seam (`ws.list()` throwing) can't leave the menu
// half-built (see the comment on `rebuildMenu` in panel.ts). This proves the
// resilience actually holds against a real DOM mount, not just the try/catch
// existing in isolation.
import { describe, expect, it } from "vitest";
import { Store } from "../../store/store";
import { initialState } from "../../store/state";
import type { Ipc } from "../../ipc/ipc";
import type { WorkspaceStore } from "../../store/wsstore";
import { mountWorkspaceBar } from "./panel";

const noopIpc: Ipc = {
  call: () => Promise.resolve(null as never),
};

/** Flush the microtask queue (rebuildMenu's `await ws.list()` chain) without
 * relying on fake timers — a real setTimeout(0) macrotask runs after every
 * pending microtask. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("Workspace bar — Load menu resilience against a broken storage seam", () => {
  it("still lists Templates (and skips Saved) when ws.list() rejects, instead of leaving the menu half-built or throwing", async () => {
    const store = new Store(initialState());
    const ws: WorkspaceStore = {
      list: () => Promise.reject(new Error("IDB down")),
      load: async () => null,
      save: async () => {},
      delete: async () => {},
      loadCurrent: async () => null,
      saveCurrent: async () => {},
    };
    const host = document.createElement("div");
    mountWorkspaceBar(host, store, noopIpc, ws);

    host.querySelector<HTMLButtonElement>('[data-testid="ws-load"]')!.click();
    await flush();

    const menu = host.querySelector<HTMLElement>('[data-testid="ws-menu"]')!;
    expect(menu.hidden).toBe(false);
    expect(menu.textContent).toContain("Templates");
    expect(menu.textContent).not.toContain("Saved");
    // At least one template item actually rendered (not an empty shell).
    expect(menu.querySelectorAll(".wsbar__menu-item").length).toBeGreaterThan(0);
  });

  it("lists Saved names normally when ws.list() resolves", async () => {
    const store = new Store(initialState());
    const ws: WorkspaceStore = {
      list: async () => ["My Bench"],
      load: async () => null,
      save: async () => {},
      delete: async () => {},
      loadCurrent: async () => null,
      saveCurrent: async () => {},
    };
    const host = document.createElement("div");
    mountWorkspaceBar(host, store, noopIpc, ws);

    host.querySelector<HTMLButtonElement>('[data-testid="ws-load"]')!.click();
    await flush();

    const menu = host.querySelector<HTMLElement>('[data-testid="ws-menu"]')!;
    expect(menu.textContent).toContain("Saved");
    expect(menu.querySelector('[data-testid="ws-saved-My Bench"]')).not.toBeNull();
  });
});

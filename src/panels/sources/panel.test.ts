// @vitest-environment jsdom
/**
 * Signal Sources panel (DOM) — the routing-matrix checkbox pin (issue #25
 * lot F2): a source carrying an EXPLICIT `targets` matrix (only reachable
 * today via a loaded workspace — F3 ships the row editor) must render its
 * legacy Out L / Out R checkboxes DISABLED and UNCHECKED, never lying about
 * what plays. Follows the DOM-test harness already used for the traces /
 * programs / workspace panels (mount into a bare host, no framework).
 */
import { describe, expect, it } from "vitest";
import type { Commands, Ipc } from "../../ipc/ipc";
import { Store } from "../../store/store";
import { initialState, type AppState } from "../../store/state";
import { mountSourcesPanel } from "./panel";

const noopIpc: Ipc = {
  async call<K extends keyof Commands>(): Promise<Commands[K]["result"]> {
    return null as Commands[K]["result"];
  },
};

/** Store notifications are batched in a microtask (store.ts's
 * `queueMicrotask`) — one tick flushes them, though `select`'s own initial
 * call already renders synchronously at mount. */
const flush = (): Promise<void> => Promise.resolve();

function mount(state: AppState = initialState()): { host: HTMLElement; store: Store<AppState> } {
  const store = new Store(state);
  const host = document.createElement("div");
  mountSourcesPanel(host, store, noopIpc);
  return { host, store };
}

/** The boot workspace's one ready-made source (state.ts::initialSources). */
const SRC_ID = "src-sine-1";

describe("Sources panel (DOM) — routing-matrix checkboxes (issue #25 lot F2)", () => {
  it("a source with the default (empty) matrix keeps the legacy checkboxes ENABLED, reflecting `route`", async () => {
    const { host } = mount(); // boot source: route "left", targets []
    await flush();
    const l = host.querySelector<HTMLInputElement>(`[data-testid="src-route-l-${SRC_ID}"]`)!;
    const r = host.querySelector<HTMLInputElement>(`[data-testid="src-route-r-${SRC_ID}"]`)!;
    expect(l.disabled).toBe(false);
    expect(r.disabled).toBe(false);
    expect(l.checked).toBe(true); // route: "left"
    expect(r.checked).toBe(false);
    expect(l.title).toBe("");
    expect(r.title).toBe("");
  });

  it("a source with an EXPLICIT matrix renders both checkboxes DISABLED and UNCHECKED — never a stale read of the legacy `route` field", async () => {
    const s = initialState();
    s.sources.byId[SRC_ID] = {
      ...s.sources.byId[SRC_ID],
      // route says "left" (would check L), but the matrix is authoritative
      // once non-empty (core/routing.ts::sourceRouting) — the checkboxes
      // must not show a route nothing reads.
      route: "left",
      targets: [{ slot: 0, route: "both" }],
    };
    const { host } = mount(s);
    await flush();
    const l = host.querySelector<HTMLInputElement>(`[data-testid="src-route-l-${SRC_ID}"]`)!;
    const r = host.querySelector<HTMLInputElement>(`[data-testid="src-route-r-${SRC_ID}"]`)!;
    expect(l.disabled).toBe(true);
    expect(r.disabled).toBe(true);
    expect(l.checked).toBe(false);
    expect(r.checked).toBe(false);
    // Legible, never silently inert (v1 invariant C): both boxes carry the
    // SAME explanatory title.
    expect(l.title).toMatch(/per-device routing/);
    expect(r.title).toMatch(/per-device routing/);
  });

  it("clearing the matrix back to `[]` re-enables the checkboxes and restores the `route` reading (round trip)", async () => {
    const s = initialState();
    s.sources.byId[SRC_ID] = {
      ...s.sources.byId[SRC_ID],
      route: "right",
      targets: [{ slot: 0, route: "both" }],
    };
    const { host, store } = mount(s);
    await flush();
    const l = host.querySelector<HTMLInputElement>(`[data-testid="src-route-l-${SRC_ID}"]`)!;
    const r = host.querySelector<HTMLInputElement>(`[data-testid="src-route-r-${SRC_ID}"]`)!;
    expect(l.disabled).toBe(true);

    store.update("test/clear-matrix", (st) => ({
      ...st,
      sources: {
        ...st.sources,
        byId: { ...st.sources.byId, [SRC_ID]: { ...st.sources.byId[SRC_ID], targets: [] } },
      },
    }));
    await flush();
    expect(l.disabled).toBe(false);
    expect(r.disabled).toBe(false);
    expect(l.checked).toBe(false); // route: "right"
    expect(r.checked).toBe(true);
    expect(l.title).toBe("");
  });
});

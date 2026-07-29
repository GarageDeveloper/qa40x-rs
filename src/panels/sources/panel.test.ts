// @vitest-environment jsdom
/**
 * Signal Sources panel (DOM) — the dual-mode row (issue #25 lot F3): the
 * byte-identical legacy Out L / Out R pair at one session with an implicit
 * matrix, the per-device routing editor otherwise (≥ 2 live sessions or an
 * explicit matrix — the F2 disabled-with-reason checkboxes are REPLACED by
 * the editor, deliberately). Follows the DOM-test harness already used for
 * the traces / programs / workspace panels (mount into a bare host).
 */
import { describe, expect, it } from "vitest";
import type { Commands, Ipc } from "../../ipc/ipc";
import { Store } from "../../store/store";
import { initialSession, initialState, type AppState } from "../../store/state";
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

/** Slot 0 (focused, connected @ 48 k) + slot 1 (adopted usb/B, connected
 * @ 192 k) — the minimal multi-device bench. */
function twoSessionState(): AppState {
  const s = initialState();
  const slot0 = s.devices.sessions["slot-0"];
  s.devices.sessions = {
    "slot-0": {
      ...slot0,
      device: {
        ...slot0.device,
        status: "connected",
        config: { input_gain: 0, output_gain: 18, sample_rate: 48000 },
      },
    },
    "slot-1": (() => {
      const sess = { ...initialSession(1), deviceId: "usb/B" };
      return {
        ...sess,
        device: {
          ...sess.device,
          status: "connected",
          config: { input_gain: 0, output_gain: 18, sample_rate: 192000 },
        },
      };
    })(),
  };
  return s;
}

const q = <T extends HTMLElement>(host: HTMLElement, testid: string): T | null =>
  host.querySelector<T>(`[data-testid="${testid}"]`);

describe("Sources panel (DOM) — legacy mode (one session, implicit matrix)", () => {
  it("keeps the legacy checkboxes ENABLED, reflecting `route`, with no routing editor", async () => {
    const { host } = mount(); // boot source: route "left", targets []
    await flush();
    const l = q<HTMLInputElement>(host, `src-route-l-${SRC_ID}`)!;
    const r = q<HTMLInputElement>(host, `src-route-r-${SRC_ID}`)!;
    expect(l.disabled).toBe(false);
    expect(r.disabled).toBe(false);
    expect(l.checked).toBe(true); // route: "left"
    expect(r.checked).toBe(false);
    expect(l.title).toBe("");
    expect(q(host, `src-routing-${SRC_ID}`)).toBeNull();
    expect(q(host, `src-routing-panel-${SRC_ID}`)).toBeNull();
  });

  it("clearing an explicit matrix returns the legacy pair, reflecting `route` (round trip)", async () => {
    const s = initialState();
    s.sources.byId[SRC_ID] = {
      ...s.sources.byId[SRC_ID],
      route: "right",
      targets: [{ slot: 0, route: "both" }],
    };
    const { host, store } = mount(s);
    await flush();
    expect(q(host, `src-route-l-${SRC_ID}`)).toBeNull(); // matrix mode
    store.update("test/clear-matrix", (st) => ({
      ...st,
      sources: {
        ...st.sources,
        byId: { ...st.sources.byId, [SRC_ID]: { ...st.sources.byId[SRC_ID], targets: [] } },
      },
    }));
    await flush();
    const l = q<HTMLInputElement>(host, `src-route-l-${SRC_ID}`)!;
    const r = q<HTMLInputElement>(host, `src-route-r-${SRC_ID}`)!;
    expect(l.disabled).toBe(false);
    expect(l.checked).toBe(false); // route: "right"
    expect(r.checked).toBe(true);
    expect(q(host, `src-routing-${SRC_ID}`)).toBeNull();
  });
});

describe("Sources panel (DOM) — matrix mode (issue #25 lot F3)", () => {
  it("an explicit matrix renders the per-device editor instead of the legacy pair, whatever the session count", async () => {
    const s = initialState();
    s.sources.byId[SRC_ID] = {
      ...s.sources.byId[SRC_ID],
      route: "left",
      targets: [{ slot: 0, route: "both" }],
    };
    const { host } = mount(s);
    await flush();
    expect(q(host, `src-route-l-${SRC_ID}`)).toBeNull();
    const sum = q<HTMLButtonElement>(host, `src-routing-${SRC_ID}`)!;
    expect(sum.textContent).toContain("#1");
    // One session, but the matrix names slot 0 explicitly: the editor shows
    // the focus pseudo-row plus the slot-0 row carrying the cell.
    expect(q(host, `src-tgt-l-${SRC_ID}-focus`)).not.toBeNull();
    expect(q<HTMLInputElement>(host, `src-tgt-l-${SRC_ID}-0`)!.checked).toBe(true);
    expect(q<HTMLInputElement>(host, `src-tgt-r-${SRC_ID}-0`)!.checked).toBe(true);
  });

  it("two live sessions flip a default source into matrix mode with a focus-checked editor", async () => {
    const { host } = mount(twoSessionState());
    await flush();
    expect(q(host, `src-route-l-${SRC_ID}`)).toBeNull();
    const sum = q<HTMLButtonElement>(host, `src-routing-${SRC_ID}`)!;
    expect(sum.textContent).toBe("→ focus L"); // route "left", implicit
    const focusL = q<HTMLInputElement>(host, `src-tgt-l-${SRC_ID}-focus`)!;
    expect(focusL.checked).toBe(true);
    // The slot-1 row exists, unchecked — no cell yet.
    expect(q<HTMLInputElement>(host, `src-tgt-l-${SRC_ID}-1`)!.checked).toBe(false);
    expect(q<HTMLButtonElement>(host, `src-tgt-del-${SRC_ID}-1`)!.disabled).toBe(true);
  });

  it("checking a channel on the slot-1 row writes the cell; the focus row is untouched", async () => {
    const { host, store } = mount(twoSessionState());
    await flush();
    const r1 = q<HTMLInputElement>(host, `src-tgt-r-${SRC_ID}-1`)!;
    r1.checked = true;
    r1.dispatchEvent(new Event("change"));
    await flush();
    expect(store.get().sources.byId[SRC_ID].targets).toEqual([
      { slot: null, route: "left" },
      { slot: 1, route: "right" },
    ]);
    expect(q<HTMLInputElement>(host, `src-tgt-l-${SRC_ID}-focus`)!.checked).toBe(true);
    expect(q<HTMLButtonElement>(host, `src-tgt-del-${SRC_ID}-1`)!.disabled).toBe(false);
  });

  it("unchecking both channels KEEPS the cell as off (silent DAC program) with the note", async () => {
    const s = twoSessionState();
    s.sources.byId[SRC_ID] = {
      ...s.sources.byId[SRC_ID],
      targets: [
        { slot: null, route: "left" },
        { slot: 1, route: "right" },
      ],
    };
    const { host, store } = mount(s);
    await flush();
    const r1 = q<HTMLInputElement>(host, `src-tgt-r-${SRC_ID}-1`)!;
    r1.checked = false;
    r1.dispatchEvent(new Event("change"));
    await flush();
    expect(store.get().sources.byId[SRC_ID].targets).toContainEqual({
      slot: 1,
      route: "off",
    });
    expect(q(host, `src-tgt-note-${SRC_ID}-1`)!.textContent).toBe("off (no channel)");
    expect(q<HTMLButtonElement>(host, `src-tgt-del-${SRC_ID}-1`)!.disabled).toBe(false);
  });

  it("✕ on the last cell compacts back to the silent legacy form and the legacy pair returns", async () => {
    const s = initialState();
    s.sources.byId[SRC_ID] = {
      ...s.sources.byId[SRC_ID],
      targets: [{ slot: 0, route: "both" }],
    };
    const { host, store } = mount(s);
    await flush();
    q<HTMLButtonElement>(host, `src-tgt-del-${SRC_ID}-0`)!.click();
    await flush();
    expect(store.get().sources.byId[SRC_ID].targets).toEqual([]);
    expect(store.get().sources.byId[SRC_ID].route).toBe("off");
    // One session + empty matrix ⇒ back to legacy mode.
    expect(q(host, `src-route-l-${SRC_ID}`)).not.toBeNull();
    expect(q(host, `src-routing-${SRC_ID}`)).toBeNull();
  });

  it("per-target played readouts snap on each TARGET's rate; the params readout says '2 values'", async () => {
    const s = twoSessionState();
    s.sources.byId[SRC_ID] = {
      ...s.sources.byId[SRC_ID],
      targets: [
        { slot: null, route: "left" },
        { slot: 1, route: "right" },
      ],
    };
    const { host } = mount(s);
    await flush();
    expect(q(host, `src-tgt-played-${SRC_ID}-focus`)!.textContent).toBe("1000.4883 Hz");
    expect(q(host, `src-tgt-played-${SRC_ID}-1`)!.textContent).toBe("1001.9531 Hz");
    expect(q(host, `src-snapped-${SRC_ID}`)!.textContent).toBe("→ 2 values");
  });

  it("presence audit: played and note cells exist in EVERY state (empty text, never absent)", async () => {
    const { host } = mount(twoSessionState());
    await flush();
    for (const tag of ["focus", "0", "1"]) {
      const played = q(host, `src-tgt-played-${SRC_ID}-${tag}`);
      const note = q(host, `src-tgt-note-${SRC_ID}-${tag}`);
      expect(played, `played cell for ${tag}`).not.toBeNull();
      expect(note, `note cell for ${tag}`).not.toBeNull();
    }
    // Unconfigured rows show empty text — rendered, not missing.
    expect(q(host, `src-tgt-played-${SRC_ID}-1`)!.textContent).toBe("");
  });

  it("a dormant-only matrix disables Play with the reason, but never blocks Pause", async () => {
    const s = initialState();
    s.sources.byId[SRC_ID] = {
      ...s.sources.byId[SRC_ID],
      targets: [{ slot: 3, route: "both" }],
    };
    const { host, store } = mount(s);
    await flush();
    const play = q<HTMLButtonElement>(host, `src-play-${SRC_ID}`)!;
    expect(play.disabled).toBe(true);
    expect(play.title).toMatch(/not connected — open Routing/);
    // The same matrix already playing: pausing stays available.
    store.update("test/playing", (st) => ({
      ...st,
      sources: {
        ...st.sources,
        byId: {
          ...st.sources.byId,
          [SRC_ID]: { ...st.sources.byId[SRC_ID], playing: true },
        },
      },
    }));
    await flush();
    expect(play.disabled).toBe(false);
    expect(play.title).toBe("Pause this source");
    // The dormant row says why it is silent.
    expect(q(host, `src-tgt-note-${SRC_ID}-3`)!.textContent).toBe("not connected");
  });

  it("the routing editor opens and closes from the summary button", async () => {
    const { host } = mount(twoSessionState());
    await flush();
    const panel = q<HTMLElement>(host, `src-routing-panel-${SRC_ID}`)!;
    expect(panel.classList.contains("sources__detail--open")).toBe(false);
    q<HTMLButtonElement>(host, `src-routing-${SRC_ID}`)!.click();
    await flush();
    expect(panel.classList.contains("sources__detail--open")).toBe(true);
    q<HTMLButtonElement>(host, `src-routing-${SRC_ID}`)!.click();
    await flush();
    expect(panel.classList.contains("sources__detail--open")).toBe(false);
  });

  it("the footer names the focused device at ≥ 2 sessions, empty (hidden) at one, and follows the focus", async () => {
    const { host: one } = mount();
    await flush();
    expect(one.querySelector('[data-testid="sources-footer-device"]')!.textContent).toBe("");

    const { host, store } = mount(twoSessionState());
    await flush();
    const footDev = host.querySelector('[data-testid="sources-footer-device"]')!;
    expect(footDev.textContent).toBe("#1 Device #1");
    store.update("test/focus", (st) => ({
      ...st,
      devices: { ...st.devices, focus: "slot-1" },
    }));
    await flush();
    expect(footDev.textContent).toBe("#2 Device #2");
  });

  it("errors are attributed to their target's session and #n-prefixed at ≥ 2 sessions", async () => {
    const s = twoSessionState();
    s.sources.byId[SRC_ID] = {
      ...s.sources.byId[SRC_ID],
      targets: [
        { slot: null, route: "left" },
        { slot: 1, route: "right" },
      ],
    };
    s.devices.sessions["slot-1"] = {
      ...s.devices.sessions["slot-1"],
      run: {
        ...s.devices.sessions["slot-1"].run,
        slotErrors: [{ id: SRC_ID, error: "render failed" }],
      },
    };
    const { host } = mount(s);
    await flush();
    expect(q(host, `src-error-${SRC_ID}`)!.textContent).toBe("#2: render failed");
    const note = q(host, `src-tgt-note-${SRC_ID}-1`)!;
    expect(note.textContent).toBe("render failed");
    expect(note.classList.contains("sources__tgt-note--err")).toBe(true);
  });
});

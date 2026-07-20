/** Bootstrap: store + IPC facade + app composition. Kept intentionally
 * tiny — all wiring lives in app.ts / panels, never here (the legacy
 * main.ts god-object must not recur). */
import "./styles/tokens.css";
import "./styles/base.css";
import { Store } from "./store/store";
import { initialState } from "./store/state";
import { tauriIpc } from "./ipc/ipc";
import { scopeVM, spectrumVM, sweepVM } from "./store/selectors/chartvm";
import { visibleTiles } from "./store/selectors/layout";
import { mountApp } from "./app";
import { setRestToken } from "./store/actions/rest";

const store = new Store(initialState());

// Read-only debug hook (e2e + console): the state snapshot and the exact
// view-models the renderers are fed — values in DISPLAY units, so a spec
// asserts what the user sees, never a chart internal. `spectrumVM()` with
// no argument keeps the M1 shape: the first displayed spectrum tile.
(window as unknown as { qa40xV2Debug: unknown }).qa40xV2Debug = {
  state: () => store.get(),
  spectrumVM: (tileId?: string) => {
    const s = store.get();
    const tile = tileId
      ? s.layout.tiles[tileId]
      : visibleTiles(s).find((t) => t.kind === "spectrum");
    return tile ? spectrumVM(s, tile) : { series: [], unitLabel: "" };
  },
  scopeVM: (tileId?: string) => {
    const s = store.get();
    const tile = tileId
      ? s.layout.tiles[tileId]
      : visibleTiles(s).find((t) => t.kind === "scope");
    return tile ? scopeVM(s, tile) : { series: [], unitLabel: "" };
  },
  sweepVM: (tileId?: string) => {
    const s = store.get();
    const tile = tileId
      ? s.layout.tiles[tileId]
      : visibleTiles(s).find((t) => t.kind === "sweep");
    return tile ? sweepVM(s, tile) : { series: [], unitLabel: "" };
  },
};

// Resolve the startup theme before first paint: stored choice, else OS.
let theme: "dark" | "light" = "dark";
try {
  const stored = localStorage.getItem("qa40x-v2-theme");
  if (stored === "light" || stored === "dark") theme = stored;
  else if (window.matchMedia("(prefers-color-scheme: light)").matches)
    theme = "light";
} catch {
  /* no storage — dark default */
}
store.update("ui/theme-init", (s) => ({ ...s, ui: { ...s.ui, theme } }));
store.select(
  (s) => s.ui.theme,
  (t) => {
    try {
      localStorage.setItem("qa40x-v2-theme", t);
    } catch {
      /* ignore */
    }
  }
);

// Re-apply the user's fixed REST bearer token (App drawer choice) so it is
// already in force if the server starts exposed (QA40X_REST_EXPOSE).
try {
  const restToken = localStorage.getItem("qa40x-v2-rest-token");
  if (restToken) void setRestToken(store, tauriIpc, restToken, true);
} catch {
  /* no storage */
}

mountApp(document.getElementById("app")!, store, tauriIpc);

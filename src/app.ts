/**
 * Top-level composition: top bar (device panel) + left column (Signal
 * Sources / Traces / Programs) + the graph grid (M3) + toasts.
 * Also owns the theme stamp and global keyboard.
 */
import "./app.css";
import { listen } from "@tauri-apps/api/event";
import type { Store } from "./store/store";
import type { AppState } from "./store/state";
import type { Ipc } from "./ipc/ipc";
import {
  autoConnectTick,
  deviceLost,
  refreshTelemetry,
} from "./store/actions/device";
import { mountDevicePanel } from "./panels/device/panel";
import { mountStatusBar } from "./panels/status/panel";
import { mountSourcesPanel } from "./panels/sources/panel";
import { mountTracesPanel } from "./panels/traces/panel";
import { mountProgramsPanel } from "./panels/programs/panel";
import { mountGridPanel } from "./panels/grid/panel";
import { mountWorkspaceBar } from "./panels/workspace/panel";
import { watchChains } from "./data/chains";
import { initProgramEvents } from "./store/actions/programs";
import {
  initAutoSave,
  restoreWorkspaceAtBoot,
} from "./store/actions/workspace";
import { startRun, stopRun } from "./store/actions/stream";
import { refreshRest } from "./store/actions/rest";
import { mountToasts } from "./ui/toast";
import { el } from "./ui/dom";

const TELEMETRY_POLL_MS = 1000;
const AUTOCONNECT_POLL_MS = 2000;

export function mountApp(
  root: HTMLElement,
  store: Store<AppState>,
  ipc: Ipc
): void {
  const topbar = el("header.app__topbar");
  const sidebar = el("aside.app__sidebar", { "data-testid": "sidebar" });
  const main = el("main.app__main", { "data-testid": "graph-area" });

  const statusbar = el("div");
  root.replaceChildren(
    el(
      "div.app",
      {},
      topbar,
      el("div.app__body", {}, sidebar, main),
      statusbar
    )
  );

  // Restore the auto-saved workspace BEFORE panels mount, so their initial
  // render is the restored bench (M5; falls back to the first-run state).
  restoreWorkspaceAtBoot(store, ipc);

  mountDevicePanel(topbar, store, ipc);
  // The workspace names the BENCH, so it heads the bench column (the v1
  // placement) — and the topbar stays a single, static device line.
  mountWorkspaceBar(sidebar, store, ipc);
  mountSourcesPanel(sidebar, store, ipc);
  mountTracesPanel(sidebar, store, ipc);
  mountProgramsPanel(sidebar, store, ipc);
  mountGridPanel(main, store, ipc);
  mountStatusBar(statusbar, store, ipc);
  mountToasts(root, store);

  // Transform endpoints recompute from their inputs (M4, data/chains.ts).
  watchChains(store, ipc);
  // Measurement-script runs stream log lines / frames / completion as
  // backend events (M4, actions/programs.ts).
  initProgramEvents(store);

  // Theme: stamp <html data-theme> from state; state is the single owner.
  store.select(
    (s) => s.ui.theme,
    (theme) => document.documentElement.setAttribute("data-theme", theme)
  );

  // Auto-save the workspace on every edit (debounced, M5).
  initAutoSave(store);

  // The status-bar REST indicator needs the truth from boot (the drawer
  // refreshes it again on open).
  void refreshRest(store, ipc);

  // Spacebar = global Run/Stop (v1 parity), mirroring the Run button.
  // Skipped while typing or when a control is focused (space activates it).
  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || e.repeat) return;
    const t = e.target as HTMLElement | null;
    const tag = t?.tagName;
    if (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      tag === "BUTTON" ||
      t?.isContentEditable ||
      t?.getAttribute("role") === "button"
    ) {
      return;
    }
    e.preventDefault();
    const s = store.get();
    if (s.run.streaming) void stopRun(store, ipc);
    else if (
      !s.run.stopping &&
      s.run.programLock === null &&
      s.device.status === "connected"
    ) {
      void startRun(store, ipc, { playAllIfIdle: true });
    }
  });

  // Backend-pushed disconnect (USB monitor).
  void listen("device-disconnected", () => deviceLost(store));

  // Telemetry poll while connected (cached read — no register I/O).
  setInterval(() => void refreshTelemetry(store, ipc), TELEMETRY_POLL_MS);

  // Auto-connect (v1 parity): at startup and after a replug, connect as
  // soon as a device is present — unless the user disconnected by hand.
  void autoConnectTick(store, ipc);
  setInterval(() => void autoConnectTick(store, ipc), AUTOCONNECT_POLL_MS);
}

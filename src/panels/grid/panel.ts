/**
 * Graph grid (M3): global transport + acquisition controls, the layout
 * preset picker, and the multi-tile grid (drag-reorder, focus). Tiles are
 * retained TileView instances keyed by id — per-frame work touches chart
 * data and chip text, never structure.
 */
import "./panel.css";
import type { Store } from "../../store/store";
import { shallowEq } from "../../store/store";
import type { AppState, LayoutPattern, WindowKind } from "../../store/state";
import { LAYOUT_PATTERNS } from "../../store/state";
import type { Ipc } from "../../ipc/ipc";
import { startRun, stopRun } from "../../store/actions/stream";
import { programLockReason } from "../../store/actions/programs";
import { moveTile, setPattern } from "../../store/actions/layout";
import { visibleTiles } from "../../store/selectors/layout";
import {
  resetAveraging,
  setAveraging,
  setPeakHold,
  setWindow,
} from "../../store/actions/acquisition";
import { acquisitionProgress } from "./progress";
import { createTile, type TileView } from "./tile";
import { el } from "../../ui/dom";

const PATTERN_NAMES: Record<LayoutPattern, string> = {
  "1": "1",
  "1x2": "1×2",
  "2x1": "2×1",
  "1x3": "1×3",
  "2x2": "2×2",
  "2x3": "2×3",
};

export function mountGridPanel(
  host: HTMLElement,
  store: Store<AppState>,
  ipc: Ipc
): void {
  /* ---- global toolbar (transport + acquisition) ----------------------- */
  const runBtn = el(
    "button.btn.btn--primary",
    {
      "data-testid": "btn-run",
      onclick: () => {
        if (store.get().run.streaming) void stopRun(store, ipc);
        else void startRun(store, ipc, { playAllIfIdle: true });
      },
    },
    "Run"
  );
  const fpsNode = el("span.graph__fps", { "data-testid": "run-fps" }, "");

  const patternSel = el("select.field", {
    "data-testid": "layout-pattern",
    title: "Grid layout",
    onchange: (e: Event) =>
      setPattern(store, ipc, (e.target as HTMLSelectElement).value as LayoutPattern),
  });
  patternSel.append(
    ...(Object.keys(LAYOUT_PATTERNS) as LayoutPattern[]).map((p) =>
      el("option", { value: p }, PATTERN_NAMES[p])
    )
  );

  const windowSel = el("select.field", {
    "data-testid": "window-sel",
    onchange: (e: Event) =>
      setWindow(store, ipc, (e.target as HTMLSelectElement).value as WindowKind),
  });
  windowSel.append(
    el("option", { value: "hann" }, "Hann"),
    el("option", { value: "rect" }, "Rect"),
    el("option", { value: "flattop" }, "Flattop")
  );

  const avgSel = el("select.field", {
    "data-testid": "avg-sel",
    onchange: (e: Event) => {
      const count = Number((e.target as HTMLSelectElement).value);
      const coherent = store.get().acquisition.averaging.mode === "coherent";
      setAveraging(
        store, ipc,
        count <= 1 ? "off" : coherent ? "coherent" : "power",
        count
      );
    },
  });
  avgSel.append(
    el("option", { value: "1" }, "Avg off"),
    ...[2, 4, 8, 16, 32, 64].map((n) =>
      el("option", { value: String(n) }, `Avg ×${n}`)
    )
  );
  const cohBtn = el(
    "button.btn",
    {
      "data-testid": "btn-coherent",
      onclick: () => {
        const { mode, count } = store.get().acquisition.averaging;
        if (mode === "off") return;
        setAveraging(store, ipc, mode === "coherent" ? "power" : "coherent", count);
      },
    },
    "COH"
  );
  const pkBtn = el(
    "button.btn",
    {
      "data-testid": "btn-peak-hold",
      onclick: () => setPeakHold(store, !store.get().acquisition.peakHold),
    },
    "PK"
  );
  const avgResetBtn = el(
    "button.btn",
    {
      "data-testid": "btn-avg-reset",
      title:
        "Reset avg & peak: restart the averaging window (backend) and clear " +
        "the peak-hold overlays — after changing something on the bench",
      onclick: () => resetAveraging(store, ipc),
    },
    "↺"
  );

  const gridHost = el("div.grid", { "data-testid": "graph-grid" });

  host.append(
    el(
      "div.graph",
      {},
      el(
        "div.graph__toolbar",
        {},
        runBtn,
        fpsNode,
        el("span.graph__spacer"),
        el("label.graph__ctl", {}, el("span.graph__ctl-label", {}, "Layout"), patternSel),
        el("label.graph__ctl", {}, el("span.graph__ctl-label", {}, "Win"), windowSel),
        avgSel,
        cohBtn,
        pkBtn,
        avgResetBtn
      ),
      gridHost
    )
  );

  /* ---- transport + cadence readout ------------------------------------ */
  let lastFrameAt = performance.now();
  store.select(
    (s) => ({
      streaming: s.run.streaming,
      stopping: s.run.stopping,
      fps: s.run.stats.fps,
      frames: s.run.stats.frames,
      connected: s.device.status === "connected",
      lock: programLockReason(s),
    }),
    ({ streaming, stopping, fps, connected, lock }) => {
      lastFrameAt = performance.now();
      runBtn.textContent = streaming ? "Stop" : "Run";
      // Disabled while a stop drains (a double-click on Stop must never
      // read as "Run" and restart the stream) — and while a measurement
      // program holds the device (M4, with the reason on the tooltip).
      runBtn.toggleAttribute(
        "disabled",
        stopping || lock !== null || (!connected && !streaming)
      );
      runBtn.title = lock ?? "Run/stop the capture stream";
      fpsNode.textContent = streaming ? `${fps.toFixed(1)} fps` : "";
    },
    shallowEq
  );

  // While a long acquisition is in flight (big FFT — nothing on screen
  // moves for seconds), show an estimated progress of the current frame.
  setInterval(() => {
    const s = store.get();
    if (!s.run.streaming) return;
    const pct = acquisitionProgress(
      performance.now() - lastFrameAt,
      s.acquisition.fftSize,
      s.device.config?.sample_rate ?? 48000
    );
    if (pct !== null) fpsNode.textContent = `acquiring… ${pct}%`;
  }, 250);

  store.select(
    (s) => s.acquisition.peakHold,
    (on) => pkBtn.classList.toggle("btn--primary", on)
  );
  store.select(
    (s) => s.acquisition.window,
    (w) => {
      windowSel.value = w;
    }
  );
  store.select(
    (s) => s.acquisition.averaging,
    ({ mode, count }) => {
      avgSel.value = String(mode === "off" ? 1 : count);
      cohBtn.classList.toggle("btn--primary", mode === "coherent");
      cohBtn.toggleAttribute("disabled", mode === "off");
    },
    shallowEq
  );

  /* ---- the tile grid --------------------------------------------------- */
  const views = new Map<string, TileView>();
  const onDragMove = (from: number, to: number): void => moveTile(store, from, to);

  // One selector drives both structure and data: its signature includes the
  // layout, every tile's config and every trace's freshness stamp — so it
  // fires exactly when a reconcile or a re-feed is due, once per batch.
  store.select(
    (s) =>
      JSON.stringify([
        s.layout,
        s.acquisition.peakHold,
        s.ui.peakHoldEpoch,
        s.traces.order.map((id) => {
          const t = s.traces.byId[id];
          return t ? [id, t.label, t.color, t.seq, t.offsetDb] : id;
        }),
      ]),
    () => {
      const s = store.get();
      const tiles = visibleTiles(s);
      const { pattern, focus } = s.layout;

      // Reconcile tile views against the visible set.
      const seen = new Set<string>();
      tiles.forEach((tile, index) => {
        seen.add(tile.id);
        let view = views.get(tile.id);
        if (!view) {
          view = createTile(tile.id, store, ipc, onDragMove);
          views.set(tile.id, view);
        }
        // Keep DOM order aligned with layout order.
        const at = gridHost.children[index];
        if (at !== view.root) gridHost.insertBefore(view.root, at ?? null);
        view.root.classList.toggle("tile--focused", focus === tile.id);
        view.root.classList.toggle("tile--hidden", focus !== null && focus !== tile.id);
        view.update(tile, s, index);
        view.feed(tile, s);
      });
      for (const [id, view] of views) {
        if (!seen.has(id)) {
          view.destroy();
          views.delete(id);
        }
      }

      // Grid geometry: rows×cols preset, or single cell under focus.
      const { rows, cols } = LAYOUT_PATTERNS[pattern];
      gridHost.style.gridTemplateColumns = focus
        ? "1fr"
        : `repeat(${cols}, minmax(0, 1fr))`;
      gridHost.style.gridTemplateRows = focus
        ? "1fr"
        : `repeat(${rows}, minmax(0, 1fr))`;
      if (patternSel.value !== pattern) patternSel.value = pattern;
    }
  );
}

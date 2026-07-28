/**
 * One graph tile (M3): header (drag handle, kind + unit selectors, add-trace,
 * freeze ❄, focus ⛶, gear ⚙), measure-chip strip, trace legend, and the
 * wrapped chart. The tile renders a per-tile view-model (selectors/chartvm)
 * — display-unit values only; the chart never sees a converter.
 */
import type { Store } from "../../store/store";
import type { AppState, TileConfig } from "../../store/state";
import type { Ipc } from "../../ipc/ipc";
import type { FdUnit, TdUnit, TraceId } from "../../core/model";
import type { TriggerState } from "../../gen";
import {
  addTraceToTile,
  removeTraceFromTile,
  setFocusTile,
  setTileChipSource,
  setTileFdUnit,
  setTileKind,
  setTileMeasures,
  setTileShowHarmonics,
  setTileShowPhase,
  setTileTdUnit,
  setTileTimeWindow,
  setTileTriggerPosition,
  toggleCurveHidden,
  toggleTraceHidden,
} from "../../store/actions/layout";
import {
  armSingle,
  setTriggerEdge,
  setTriggerLevelV,
  setTriggerMode,
} from "../../store/actions/trigger";
import { shownTraces } from "../../store/selectors/layout";
import { focusedDevice, focusedRun } from "../../store/selectors/session";
import { tileTriggerSourceId } from "../../store/selectors/trigger";
import { freezeTile } from "../../store/actions/traces";
import { programProgressText } from "../../store/actions/programs";
import {
  DEFAULT_TRIGGER,
  traceCurveColor,
  type GraphKind,
  type TriggerEdge,
  type TriggerMode,
} from "../../store/state";
import {
  chipSourceTraceId,
  scopeVM,
  spectrumVM,
  sweepVM,
  triggerLevelFromDisplay,
  triggerSourceOffsetDb,
} from "../../store/selectors/chartvm";
import type { ScopeRenderer, SpectrumRenderer, SweepRenderer } from "../../chart/renderer";
import { WrappedSpectrumChart } from "../../chart/spectrum";
import { WrappedScopeChart } from "../../chart/scope";
import { WrappedSweepChart } from "../../chart/sweep";
import { MEASURES, measureByKey } from "../../core/measure";
import { getFrames } from "../../data/frames";
import { measuresFor } from "../../data/measures";
import { copyTilePng, exportTileCsv, exportTilePng, exportTileSvg } from "../../export/export";
import { openTileGearDialog } from "./gear";
import { addTraceCandidates } from "./addtrace";
import { el, keyedList } from "../../ui/dom";

const FD_UNITS: { value: FdUnit; label: string }[] = [
  { value: "dbfs", label: "dBFS" },
  { value: "dbv", label: "dBV" },
  { value: "dbu", label: "dBu" },
];
const TD_UNITS: { value: TdUnit; label: string }[] = [
  { value: "v", label: "V" },
  { value: "mv", label: "mV" },
  { value: "pctfs", label: "%FS" },
];

/** The trigger chip's text (Lot A, issue #26): mode+edge+state, never DOM
 * presence, change (no-layout-shift invariant). `state` is `undefined`
 * before any frame has landed for the resolved endpoint — treated like
 * "waiting" (a normal/single trigger with nothing latched yet). Single's
 * "STOP" label covers BOTH `triggered` (the firing frame) and `stopped`
 * (every frame after) — from the user's view the shot has already landed. */
function triggerChipText(mode: TriggerMode, edge: TriggerEdge, state: TriggerState | undefined): string {
  if (mode === "off") return "T off";
  const arrow = edge === "rising" ? "▲" : "▼";
  if (mode === "auto") return `T ${arrow} AUTO`;
  if (mode === "normal") {
    return state === "triggered" ? `T ${arrow} NORM · TRIG'D` : `T ${arrow} WAIT`;
  }
  return state === "triggered" || state === "stopped" ? `T ${arrow} SINGLE · STOP` : `T ${arrow} WAIT`;
}

export interface TileView {
  readonly root: HTMLElement;
  /** Sync controls/legend/chips structure with the tile's config. */
  update(tile: TileConfig, s: AppState, index: number): void;
  /** Push the current frames into the chart + chip values. */
  feed(tile: TileConfig, s: AppState): void;
  destroy(): void;
}

export function createTile(
  tileId: string,
  store: Store<AppState>,
  ipc: Ipc,
  onDragMove: (from: number, to: number) => void
): TileView {
  /* ---- header controls ------------------------------------------------ */
  const handle = el(
    "span.tile__handle",
    { "data-testid": `tile-handle-${tileId}`, title: "Drag to reorder" },
    "⠿"
  );
  const kindSel = el("select.field.field--small.tile__col1", {
    "data-testid": `tile-kind-${tileId}`,
    onchange: (e: Event) =>
      setTileKind(store, ipc, tileId, (e.target as HTMLSelectElement).value as GraphKind),
  });
  kindSel.append(
    el("option", { value: "spectrum" }, "Spectrum"),
    el("option", { value: "scope" }, "Scope"),
    el("option", { value: "sweep" }, "Sweep")
  );
  const unitSel = el("select.field.field--small.tile__col2", {
    "data-testid": `tile-unit-${tileId}`,
    onchange: (e: Event) => {
      const v = (e.target as HTMLSelectElement).value;
      const tile = store.get().layout.tiles[tileId];
      if (!tile) return;
      if (tile.kind === "spectrum") setTileFdUnit(store, tileId, v as FdUnit);
      else setTileTdUnit(store, tileId, v as TdUnit);
    },
  });
  const addSel = el("select.field.field--small.tile__add.tile__col1", {
    "data-testid": `tile-add-trace-${tileId}`,
    title: "Add a trace to this graph",
    onchange: (e: Event) => {
      const v = (e.target as HTMLSelectElement).value;
      if (v) addTraceToTile(store, ipc, tileId, v);
      (e.target as HTMLSelectElement).value = "";
    },
  });
  // Scope time window, directly on the tile (the ⚙ keeps its field too).
  const TIME_WINDOWS_MS = [1, 2, 5, 10, 20, 50, 100, 200, 500];
  const timeSel = el("select.field.field--small.tile__col3", {
    "data-testid": `tile-time-${tileId}`,
    title: "Displayed time window",
    onchange: (e: Event) => {
      const v = (e.target as HTMLSelectElement).value;
      setTileTimeWindow(store, tileId, v === "" ? null : Number(v));
    },
  });
  // Scope trigger chip + Arm (Lot A, issue #26): ALWAYS in the DOM (hidden
  // for non-scope kinds via tile__hidden on the wrapper, same mechanism as
  // timeSel) — only the chip's text and the Arm button's disabled state
  // change with the resolved endpoint's mode/edge/state (no-layout-shift
  // invariant). The chip is a control: click opens the quick trigger menu,
  // right-click jumps straight to the ⚙ Trigger tab.
  const TRIG_MODES: { value: TriggerMode; label: string }[] = [
    { value: "off", label: "Off" },
    { value: "auto", label: "Auto" },
    { value: "normal", label: "Normal" },
    { value: "single", label: "Single" },
  ];
  const TRIG_EDGES: { value: TriggerEdge; label: string }[] = [
    { value: "rising", label: "Rising ▲" },
    { value: "falling", label: "Falling ▼" },
  ];
  const trigMenu = el("div.tile__trigmenu", {
    "data-testid": `tile-trigmenu-${tileId}`,
  });
  trigMenu.hidden = true;
  // Rebuilt on every open: mode/edge belong to the RESOLVED endpoint (shared
  // by every tile showing it), so the checkmarks must reflect the store, not
  // a build-time snapshot.
  const rebuildTrigMenu = (): void => {
    const s = store.get();
    const tile = s.layout.tiles[tileId];
    if (!tile) return;
    const sourceId = tileTriggerSourceId(s, tile);
    const cur = (sourceId ? s.triggers[sourceId] : undefined) ?? DEFAULT_TRIGGER;
    const item = (
      testid: string,
      label: string,
      active: boolean,
      onPick: () => void
    ): HTMLElement => {
      const btn = el(
        "button.tile__trigmenu-item",
        {
          type: "button",
          "data-testid": testid,
          disabled: !sourceId,
          onclick: () => {
            trigMenu.hidden = true;
            onPick();
          },
        },
        (active ? "✓ " : "") + label
      );
      btn.classList.toggle("tile__trigmenu-item--active", active);
      return btn;
    };
    trigMenu.replaceChildren(
      el("div.tile__trigmenu-head", {}, "Mode"),
      ...TRIG_MODES.map((m) =>
        item(`tile-trigmenu-${tileId}-mode-${m.value}`, m.label, cur.mode === m.value, () => {
          if (sourceId) setTriggerMode(store, ipc, sourceId, m.value);
        })
      ),
      el("div.tile__trigmenu-head", {}, "Edge"),
      ...TRIG_EDGES.map((e2) =>
        item(`tile-trigmenu-${tileId}-edge-${e2.value}`, e2.label, cur.edge === e2.value, () => {
          if (sourceId) setTriggerEdge(store, ipc, sourceId, e2.value);
        })
      ),
      el(
        "button.tile__trigmenu-item",
        {
          type: "button",
          "data-testid": `tile-trigmenu-${tileId}-settings`,
          onclick: () => {
            trigMenu.hidden = true;
            openTileGearDialog(store, ipc, tileId, "trigger");
          },
        },
        "Settings…"
      )
    );
  };
  const trigChip = el(
    "button.tile__trig",
    {
      type: "button",
      "data-testid": `tile-trigger-${tileId}`,
      title: "Scope trigger — click: quick menu, right-click: settings",
      onclick: (e: Event) => {
        e.stopPropagation();
        const willOpen = trigMenu.hidden;
        if (willOpen) rebuildTrigMenu();
        trigMenu.hidden = !willOpen;
        if (willOpen) {
          document.addEventListener("click", () => (trigMenu.hidden = true), {
            once: true,
            capture: true,
          });
        }
      },
      oncontextmenu: (e: Event) => {
        e.preventDefault();
        trigMenu.hidden = true;
        openTileGearDialog(store, ipc, tileId, "trigger");
      },
    },
    "T off"
  );
  const trigWrap = el("span.tile__trigwrap", {}, trigChip, trigMenu);
  const armBtn = el(
    "button.btn.btn--small",
    {
      "data-testid": `tile-trigger-arm-${tileId}`,
      title: "Arm a SINGLE shot",
      onclick: () => {
        const s = store.get();
        const tile = s.layout.tiles[tileId];
        if (!tile) return;
        const sourceId = tileTriggerSourceId(s, tile);
        if (sourceId) armSingle(store, ipc, sourceId);
      },
    },
    "Arm"
  );
  const phaseBtn = el(
    "button.btn.btn--small",
    {
      "data-testid": `tile-phase-${tileId}`,
      title: "Show the phase overlay (FR sweeps)",
      onclick: () => {
        const tile = store.get().layout.tiles[tileId];
        if (tile) setTileShowPhase(store, tileId, !tile.showPhase);
      },
    },
    "∠"
  );
  const harmBtn = el(
    "button.btn.btn--small",
    {
      "data-testid": `tile-harmonics-${tileId}`,
      title:
        "Harmonic markers: mark H1..H10 of the chip-source trace on the " +
        "spectrum (backend-located; also in the ⚙ Graph tab)",
      onclick: () => {
        const tile = store.get().layout.tiles[tileId];
        if (tile) setTileShowHarmonics(store, tileId, !tile.showHarmonics);
      },
    },
    "Hₙ"
  );
  // Export (issue #30): select-as-menu, the tile header's idiom (＋/Σ) —
  // data as CSV (provenance header), image as PNG file or clipboard copy.
  const exportSel = el("select.field.field--small.tile__add.tile__col3", {
    "data-testid": `tile-export-${tileId}`,
    title:
      "Export this graph — data as CSV (provenance header), image as " +
      "PNG (file / clipboard) or vector SVG",
    onchange: (e: Event) => {
      const sel = e.target as HTMLSelectElement;
      const v = sel.value;
      sel.value = "";
      if (v === "csv") void exportTileCsv(store, ipc, tileId);
      else if (v === "png") void exportTilePng(store, ipc, tileId);
      else if (v === "svg") void exportTileSvg(store, ipc, tileId);
      else if (v === "copy") void copyTilePng(store, ipc, tileId);
    },
  });
  exportSel.append(
    el("option", { value: "" }, "⤓"),
    el("option", { value: "csv" }, "Data (CSV)…"),
    el("option", { value: "png" }, "Image (PNG)…"),
    el("option", { value: "svg" }, "Vector (SVG)…"),
    el("option", { value: "copy" }, "Copy image")
  );
  const freezeBtn = el(
    "button.btn.btn--small",
    {
      "data-testid": `tile-freeze-${tileId}`,
      title: "Freeze the shown traces as memory overlays",
      onclick: () => freezeTile(store, tileId),
    },
    "❄"
  );
  const focusBtn = el(
    "button.btn.btn--small",
    {
      "data-testid": `tile-focus-${tileId}`,
      title: "Focus (fill the grid)",
      onclick: () =>
        setFocusTile(store, store.get().layout.focus === tileId ? null : tileId),
    },
    "⛶"
  );
  const gearBtn = el(
    "button.btn.btn--small",
    {
      "data-testid": `tile-gear-${tileId}`,
      title: "Tile settings",
      onclick: () => openTileGearDialog(store, ipc, tileId),
    },
    "⚙"
  );

  /* ---- chips strip ---------------------------------------------------- */
  const chipsHost = el("div.tile__chips", { "data-testid": `tile-chips-${tileId}` });
  const chipSrcSel = el("select.field.field--small", {
    "data-testid": `tile-chip-src-${tileId}`,
    title: "Which trace the readouts measure",
    onchange: (e: Event) =>
      setTileChipSource(
        store,
        ipc,
        tileId,
        (e.target as HTMLSelectElement).value as "auto" | TraceId
      ),
  });
  const chipAddSel = el("select.field.field--small.tile__add.tile__col2", {
    "data-testid": `tile-chip-add-${tileId}`,
    title: "Add a measurement readout (Σ)",
    onchange: (e: Event) => {
      const key = (e.target as HTMLSelectElement).value;
      const tile = store.get().layout.tiles[tileId];
      if (tile && key === "__all__") {
        setTileMeasures(
          store,
          ipc,
          tileId,
          // Every chip, keeping the already-shown ones' order first.
          [...tile.measures, ...MEASURES.map((m) => m.key).filter((k) => !tile.measures.includes(k))]
        );
      } else if (tile && key && !tile.measures.includes(key)) {
        setTileMeasures(store, ipc, tileId, [...tile.measures, key]);
      }
      (e.target as HTMLSelectElement).value = "";
    },
  });

  /* ---- chart + legend (legend sits UNDER the graph, v1 style) --------- */
  const chartHost = el("div.tile__chart", { "data-testid": `tile-chart-${tileId}` });
  const legend = el("div.tile__legend", { "data-testid": `tile-legend-${tileId}` });

  // Progress overlay: while the EXCLUSIVE measurement program runs and its
  // result trace is drawn on this tile, its progress floats over the chart
  // (a transient DOM pill — the renderer stays blind to it). Exclusivity
  // means at most one program runs, so a multi-sweep tile shows at most one
  // overlay, labeled with the running program's name.
  const progressEl = el("div.tile__progress", {
    "data-testid": `tile-progress-${tileId}`,
  });
  progressEl.hidden = true;
  const updateProgress = (): void => {
    const s = store.get();
    const tile = s.layout.tiles[tileId];
    const lockId = focusedRun(s).programLock;
    const prog = lockId ? s.programs.byId[lockId] : undefined;
    const show =
      !!tile &&
      !!prog &&
      prog.run === "running" &&
      tile.traces.includes(prog.id) &&
      !tile.hidden.includes(prog.id);
    progressEl.hidden = !show;
    if (show && prog) {
      const label = s.traces.byId[prog.id]?.label ?? "measurement";
      const sr = focusedDevice(s).config?.sample_rate ?? 48000;
      progressEl.textContent = `▶ ${label} · ${programProgressText(prog, sr, performance.now())}`;
    }
  };
  const progressTimer = setInterval(updateProgress, 300);

  // v1 notation (maintainer M4 review): "+" adds a trace, "Σ" adds a
  // measurement — side by side in the header; the strip keeps the chips
  // and their source picker.
  const strip = el("div.tile__strip", {}, chipsHost, chipSrcSel);
  // Two DELIBERATE header rows (maintainer feedback on PR #41 — the
  // flex-wrap fallback broke ⚙/❄/⛶ onto a second line at random points,
  // differently per tile): row 1 drives the VIEW (kind/unit/scope
  // controls, display toggles, freeze/focus/gear stay top-right where
  // they always were), row 2 COMPOSES it (add trace ＋, add measurement
  // Σ, export ⤓). Wrap stays on both rows as a narrow-window backstop.
  const root = el(
    "section.tile",
    { "data-testid": `tile-${tileId}` },
    el(
      "div.tile__head",
      {},
      handle,
      kindSel,
      unitSel,
      timeSel,
      trigWrap,
      armBtn,
      // Display toggles (∠ phase, Hₙ harmonics) belong to the LEFT view
      // group (maintainer pass 3) — only ❄ ⛶ ⚙ anchor right.
      phaseBtn,
      harmBtn,
      el("span.tile__spacer"),
      freezeBtn,
      focusBtn,
      gearBtn
    ),
    // Tools row: compose on the LEFT (＋ trace, Σ measurement, aligned
    // under kind/unit), export ⤓ anchored RIGHT under ❄ ⛶ ⚙ (maintainer
    // pass 4 — output actions live on the right on both rows).
    el(
      "div.tile__head.tile__head--tools",
      {},
      addSel,
      chipAddSel,
      el("span.tile__spacer"),
      exportSel
    ),
    strip,
    chartHost,
    legend
  );

  /* ---- drag reorder (pointer events — NOT HTML5 DnD: the Tauri macOS
   * webview swallows native drags, so a real mouse never delivered
   * dragover/drop; pointer capture works everywhere). Feedback: a floating
   * clone of the tile follows the pointer ("moving the window"), the
   * original dims in place, the swap target gets the dashed outline. ---- */
  let pressed = false;
  let pressX = 0;
  let pressY = 0;
  let ghost: HTMLElement | null = null;
  let grabDX = 0;
  let grabDY = 0;
  let dragTarget: HTMLElement | null = null;

  const tileUnder = (e: PointerEvent): HTMLElement | null => {
    const hit = document
      .elementFromPoint(e.clientX, e.clientY)
      ?.closest(".tile") as HTMLElement | null;
    return hit && hit !== root && !hit.classList.contains("tile--ghost")
      ? hit
      : null;
  };

  const makeGhost = (e: PointerEvent): void => {
    const rect = root.getBoundingClientRect();
    grabDX = e.clientX - rect.left;
    grabDY = e.clientY - rect.top;
    ghost = root.cloneNode(true) as HTMLElement;
    ghost.classList.add("tile--ghost");
    // The clone is pure feedback: strip every testid so selectors (e2e or
    // ours) can never hit the ghost, and copy the canvas PIXELS (cloneNode
    // yields blank canvases).
    ghost.removeAttribute("data-testid");
    for (const n of Array.from(ghost.querySelectorAll("[data-testid]"))) {
      n.removeAttribute("data-testid");
    }
    const src = Array.from(root.querySelectorAll("canvas"));
    Array.from(ghost.querySelectorAll("canvas")).forEach((d, i) => {
      const s = src[i];
      if (!s) return;
      d.width = s.width;
      d.height = s.height;
      d.style.width = s.style.width;
      d.style.height = s.style.height;
      if (s.width > 0 && s.height > 0) d.getContext("2d")?.drawImage(s, 0, 0);
    });
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    document.body.append(ghost);
    root.classList.add("tile--dragging");
  };

  const moveGhost = (e: PointerEvent): void => {
    if (ghost) {
      ghost.style.transform = `translate(${e.clientX - grabDX}px, ${e.clientY - grabDY}px)`;
    }
  };

  const clearDrag = (): void => {
    pressed = false;
    ghost?.remove();
    ghost = null;
    root.classList.remove("tile--dragging");
    dragTarget?.classList.remove("tile--drop");
    dragTarget = null;
  };

  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointers (tests) have no capturable id */
    }
    pressed = true;
    pressX = e.clientX;
    pressY = e.clientY;
  });
  handle.addEventListener("pointermove", (e) => {
    if (!pressed) return;
    // A ~4 px threshold keeps a plain click on the handle from flashing a
    // ghost.
    if (!ghost && Math.hypot(e.clientX - pressX, e.clientY - pressY) < 4) return;
    if (!ghost) makeGhost(e);
    moveGhost(e);
    const t = tileUnder(e);
    if (t !== dragTarget) {
      dragTarget?.classList.remove("tile--drop");
      dragTarget = t;
      dragTarget?.classList.add("tile--drop");
    }
  });
  handle.addEventListener("pointerup", (e) => {
    if (!pressed) return;
    const dropped = ghost ? tileUnder(e) : null;
    clearDrag();
    if (dropped) {
      onDragMove(
        Number(root.dataset.index ?? "0"),
        Number(dropped.dataset.index ?? "0")
      );
    }
  });
  handle.addEventListener("pointercancel", clearDrag);

  /* ---- renderer (swapped on kind change) ------------------------------ */
  let kind: GraphKind = "spectrum";
  let spectrum: SpectrumRenderer | null = new WrappedSpectrumChart(chartHost);
  // "Reset avg & peak" epoch already consumed by this tile's chart.
  let lastPeakEpoch = 0;
  let scope: ScopeRenderer | null = null;
  let sweep: SweepRenderer | null = null;

  function ensureRenderer(next: GraphKind, showPhase: boolean): void {
    const alive =
      next === "spectrum" ? spectrum : next === "scope" ? scope : sweep;
    if (next === kind && alive) return;
    spectrum?.destroy();
    scope?.destroy();
    sweep?.destroy();
    spectrum = null;
    scope = null;
    sweep = null;
    chartHost.replaceChildren();
    kind = next;
    if (next === "spectrum") spectrum = new WrappedSpectrumChart(chartHost);
    else if (next === "scope") {
      scope = new WrappedScopeChart(chartHost);
      // Wired ONCE per chart instance (renderer.ts's ScopeTriggerHandlers
      // contract) — the drag reports display-unit level / 0..1 position,
      // resolved here against the CURRENT store (not captured at wiring
      // time) since the tile's trigger source can change afterward.
      scope.setTriggerHandlers({
        onLevel: (displayValue, done) => {
          const s = store.get();
          const tile = s.layout.tiles[tileId];
          const sourceId = tile ? tileTriggerSourceId(s, tile) : null;
          if (!tile || !sourceId) return;
          // The SAME offset scopeVM used to build the marker being dragged
          // (snapshot-baked when a picture is held) — not the trace's live
          // offset, which can differ after a range change and make the
          // level jump on drop (review #5).
          const offsetDb = triggerSourceOffsetDb(s, sourceId);
          setTriggerLevelV(
            store,
            ipc,
            sourceId,
            triggerLevelFromDisplay(displayValue, tile.tdUnit, offsetDb),
            { sync: done }
          );
        },
        onPosition: (position, done) => {
          setTileTriggerPosition(store, ipc, tileId, position * 100, { sync: done });
        },
      });
    } else {
      sweep = new WrappedSweepChart(chartHost);
      sweep.setShowPhase(showPhase);
    }
    // The renderer swap emptied the host — the overlay rides on top of
    // whichever chart is current.
    chartHost.append(progressEl);
  }

  /* ---- chip source resolution ----------------------------------------- */
  // Auto: the first DRAWN trace with data (a legend-hidden curve isn't
  // what the user is reading).
  function autoChipSourceId(tile: TileConfig): TraceId | null {
    const drawn = shownTraces(tile);
    for (const id of drawn) {
      const f = getFrames(id);
      if (f && (f.td || f.fd)) return id;
    }
    return drawn[0] ?? tile.traces[0] ?? null;
  }

  // Shared with the VM (chartvm.chipSourceTraceId) so chips and harmonic
  // markers always follow the same trace.
  const chipSourceId = chipSourceTraceId;

  // A landed async measurement re-feeds the tile with the CURRENT state.
  let feedQueued = false;
  const refeed = (): void => {
    if (feedQueued) return;
    feedQueued = true;
    queueMicrotask(() => {
      feedQueued = false;
      const s = store.get();
      const tile = s.layout.tiles[tileId];
      if (tile && root.isConnected) view.feed(tile, s);
    });
  };

  const view: TileView = {
    root,

    update(tile, s, index) {
      root.dataset.index = String(index);
      kindSel.value = tile.kind;
      updateProgress();

      // Unit options follow the kind; a sweep's Y unit is the measurement's
      // own (dB / %), not a choice — the selector hides, ∠ phase appears.
      const isSweep = tile.kind === "sweep";
      unitSel.classList.toggle("tile__hidden", isSweep);
      phaseBtn.classList.toggle("tile__hidden", !isSweep);
      phaseBtn.classList.toggle("btn--primary", tile.showPhase);
      harmBtn.classList.toggle("tile__hidden", tile.kind !== "spectrum");
      harmBtn.classList.toggle("btn--primary", tile.showHarmonics);
      sweep?.setShowPhase(tile.showPhase);
      strip.classList.toggle("tile__hidden", isSweep);
      chipAddSel.classList.toggle("tile__hidden", isSweep);

      // Scope-only: the time-window picker (mirrors the ⚙ field; a custom
      // gear value joins the preset list as its own option).
      const isScope = tile.kind === "scope";
      timeSel.classList.toggle("tile__hidden", !isScope);
      trigWrap.classList.toggle("tile__hidden", !isScope);
      armBtn.classList.toggle("tile__hidden", !isScope);
      if (isScope) {
        const win = tile.timeWindowMs;
        const values = TIME_WINDOWS_MS.includes(win ?? -1) || win === null
          ? TIME_WINDOWS_MS
          : [...TIME_WINDOWS_MS, win].sort((a, b) => a - b);
        const timeSig = values.join(",");
        if (timeSel.dataset.sig !== timeSig) {
          timeSel.replaceChildren(
            ...values.map((ms) => el("option", { value: String(ms) }, `${ms} ms`)),
            el("option", { value: "" }, "Full")
          );
          timeSel.dataset.sig = timeSig;
        }
        timeSel.value = win === null ? "" : String(win);
      }
      if (!isSweep) {
        const units = tile.kind === "spectrum" ? FD_UNITS : TD_UNITS;
        const current = tile.kind === "spectrum" ? tile.fdUnit : tile.tdUnit;
        const sig = units.map((u) => u.value).join(",");
        if (unitSel.dataset.sig !== sig) {
          unitSel.replaceChildren(
            ...units.map((u) => el("option", { value: u.value }, u.label))
          );
          unitSel.dataset.sig = sig;
        }
        unitSel.value = current;
      }

      // Add-trace candidates: pool traces not already on the tile AND whose
      // KNOWN domains (if any) are compatible with this tile's kind (issue
      // #28 second-pass review finding #9) — a sweep-only trace (e.g. the
      // wow & flutter program) offered on a scope/spectrum tile just draws
      // nothing.
      const candidates = addTraceCandidates(s.traces.order, s.traces.byId, tile.traces, tile.kind);
      const addSig = candidates
        .map((id) => `${id}:${s.traces.byId[id]?.label}`)
        .join("|");
      if (addSel.dataset.sig !== addSig) {
        addSel.replaceChildren(
          el("option", { value: "" }, "＋"),
          ...candidates.map((id) =>
            el("option", { value: id }, s.traces.byId[id]?.label ?? id)
          )
        );
        addSel.dataset.sig = addSig;
        addSel.value = "";
      }
      addSel.toggleAttribute("disabled", candidates.length === 0);

      // Legend (under the chart): one chip per member trace — click toggles
      // whether the curve is drawn (v1 behavior), ✕ removes membership. A
      // multi-curve sweep trace (L + R) gets ONE CHIP PER CURVE, each with
      // its own color and an independent toggle (v1 parity, M4 review);
      // its ✕ still removes the whole trace.
      const members = tile.traces
        .map((id) => s.traces.byId[id])
        .filter((t): t is NonNullable<typeof t> => !!t);
      interface LegendItem {
        key: string;
        traceId: TraceId;
        /** Non-null = this chip is one curve of a multi-curve sweep. */
        curveLabel: string | null;
        label: string;
        color: string;
        off: boolean;
        /** This trace's OWN sweep axis (Hz/dBFS) differs from the tile's —
         * excluded from the plot entirely (issue #27 review finding #3), not
         * just legend-hidden. A discreet chip marker, no layout shift. */
        axisMismatch: boolean;
      }
      // Sweep tiles only: traces sweepVM omitted for an axis clash (a
      // frequency sweep and a level sweep can't share one x-axis scale).
      const sweepOmitted =
        tile.kind === "sweep" ? new Set(sweepVM(s, tile).omitted) : new Set<TraceId>();
      const legendItems: LegendItem[] = [];
      for (const t of members) {
        const sweepFrames = tile.kind === "sweep" ? getFrames(t.id)?.sweep : undefined;
        if (sweepFrames && sweepFrames.curves.length > 1) {
          sweepFrames.curves.forEach((c, i) => {
            legendItems.push({
              key: `${t.id}#${c.label}`,
              traceId: t.id,
              curveLabel: c.label,
              label: `${t.label} ${c.label}`,
              color: traceCurveColor(t, i),
              off:
                tile.hidden.includes(t.id) ||
                (tile.hiddenCurves[t.id] ?? []).includes(c.label),
              axisMismatch: sweepOmitted.has(t.id),
            });
          });
        } else {
          legendItems.push({
            key: t.id,
            traceId: t.id,
            curveLabel: null,
            label: t.label,
            color: t.color,
            off: tile.hidden.includes(t.id),
            axisMismatch: sweepOmitted.has(t.id),
          });
        }
      }
      keyedList(legend, legendItems, (it) => it.key, {
        create: (it) =>
          el(
            "span.tile__trace",
            {
              "data-testid":
                it.curveLabel === null
                  ? `tile-trace-${tileId}-${it.traceId}`
                  : `tile-curve-${tileId}-${it.traceId}-${it.curveLabel}`,
              title: "Click to show/hide this curve",
              onclick: () =>
                it.curveLabel === null
                  ? toggleTraceHidden(store, ipc, tileId, it.traceId)
                  : toggleCurveHidden(store, tileId, it.traceId, it.curveLabel),
            },
            el("span.tile__dot"),
            el("span.tile__trace-label"),
            el(
              "button.tile__trace-x",
              {
                title:
                  it.curveLabel === null
                    ? "Remove from this graph"
                    : "Remove this trace (all its curves) from this graph",
                "data-testid": `tile-trace-x-${tileId}-${it.traceId}`,
                onclick: (e: Event) => {
                  e.stopPropagation(); // never also toggle on remove
                  removeTraceFromTile(store, ipc, tileId, it.traceId);
                },
              },
              "✕"
            )
          ),
        update(node, it) {
          (node.children[0] as HTMLElement).style.backgroundColor = it.color;
          node.children[1].textContent = it.label;
          node.classList.toggle("tile__trace--off", it.off);
          node.classList.toggle("tile__trace--axis-mismatch", it.axisMismatch);
          const title = it.axisMismatch
            ? "Different sweep axis (Hz vs dBFS) on this tile — not drawn"
            : "Click to show/hide this curve";
          if (node.title !== title) node.title = title;
        },
      });

      // Chip-source options: Auto + the member traces.
      const srcSig = `${tile.chipSource}|${members.map((t) => `${t.id}:${t.label}`).join(",")}`;
      if (chipSrcSel.dataset.sig !== srcSig) {
        chipSrcSel.replaceChildren(
          el("option", { value: "auto" }, "Auto"),
          ...members.map((t) => el("option", { value: t.id }, t.label))
        );
        chipSrcSel.dataset.sig = srcSig;
      }
      chipSrcSel.value = tile.chipSource;
      chipSrcSel.classList.toggle("tile__hidden", members.length < 2);

      // Chip add candidates: measures not already shown, plus "All".
      const chipSig = tile.measures.join(",");
      if (chipAddSel.dataset.sig !== chipSig) {
        const remaining = MEASURES.filter((m) => !tile.measures.includes(m.key));
        chipAddSel.replaceChildren(
          el("option", { value: "" }, "Σ"),
          ...(remaining.length > 0
            ? [el("option", { value: "__all__", title: "Add every measurement" }, "All")]
            : []),
          ...remaining.map((m) => el("option", { value: m.key, title: m.desc }, m.label))
        );
        chipAddSel.dataset.sig = chipSig;
        chipAddSel.value = "";
      }
      chipAddSel.toggleAttribute(
        "disabled",
        tile.measures.length === MEASURES.length
      );

      // Chip nodes (values are filled by feed()).
      keyedList(
        chipsHost,
        tile.measures
          .map((key) => measureByKey(key))
          .filter((m): m is NonNullable<typeof m> => !!m),
        (m) => m.key,
        {
          create: (m) =>
            el(
              "span.tile__chip",
              {
                "data-testid": `tile-chip-${tileId}-${m.key}`,
                title: `${m.desc} — click to remove`,
                onclick: () => {
                  const cur = store.get().layout.tiles[tileId];
                  if (cur) {
                    setTileMeasures(
                      store,
                      ipc,
                      tileId,
                      cur.measures.filter((k) => k !== m.key)
                    );
                  }
                },
              },
              el("span.tile__chip-label", {}, m.label),
              el("span.tile__chip-value", {}, "—")
            ),
          update() {
            /* values land in feed() */
          },
        }
      );
    },

    feed(tile, s) {
      ensureRenderer(tile.kind, tile.showPhase);
      if (tile.kind === "spectrum" && spectrum) {
        const vm = spectrumVM(s, tile);
        spectrum.setAxis({
          xLog: tile.axis.xLog,
          yAuto: tile.axis.yAuto,
          yMin: tile.axis.yMin,
          yMax: tile.axis.yMax,
        });
        spectrum.setUnitLabel(vm.unitLabel);
        spectrum.setSeries(vm.series);
        spectrum.setHarmonics(vm.harmonics);
        spectrum.setPeakHold(s.acquisition.peakHold);
        if (s.ui.peakHoldEpoch !== lastPeakEpoch) {
          lastPeakEpoch = s.ui.peakHoldEpoch;
          spectrum.resetPeakHold();
        }
      } else if (tile.kind === "scope" && scope) {
        const vm = scopeVM(s, tile);
        scope.setTimeWindow(tile.timeWindowMs);
        scope.setUnitLabel(vm.unitLabel);
        scope.setSeries(vm.series);
        // Markers toggle is display-only (plan §3.2): off draws nothing even
        // with a live trigger, on draws the VM's trigger verbatim.
        scope.setTrigger(tile.showTriggerMarkers ? vm.trigger : null);
      } else if (tile.kind === "sweep" && sweep) {
        const vm = sweepVM(s, tile);
        sweep.setUnitLabel(vm.unitLabel);
        sweep.setXUnit(vm.xUnit);
        sweep.setSeries(vm.series);
      }

      // Trigger chip + Arm (always computed — hidden via CSS for non-scope
      // kinds, never absent from the DOM). `trigState` is read straight from
      // `run.triggers`, the live per-endpoint mirror ingestFrame writes every
      // frame, so the chip tracks the CURRENT frame even when scopeVM's
      // `vm.trigger` is null (e.g. no snapshot latched yet).
      const trigSourceId = tileTriggerSourceId(s, tile);
      const trigSettings = trigSourceId ? (s.triggers[trigSourceId] ?? DEFAULT_TRIGGER) : DEFAULT_TRIGGER;
      const trigState = trigSourceId ? focusedRun(s).triggers[trigSourceId]?.state : undefined;
      trigChip.textContent = triggerChipText(trigSettings.mode, trigSettings.edge, trigState);
      armBtn.toggleAttribute("disabled", trigSettings.mode !== "single");
      // Armed = SINGLE still waiting for its shot: state `waiting` (or none
      // latched yet), OR a re-arm still in flight (trigArmPending — the
      // frame captured under the pre-arm config still reports `stopped`).
      // Highlight clears the moment the shot lands (`triggered` on the
      // firing frame, `stopped` after).
      armBtn.classList.toggle(
        "btn--primary",
        trigSettings.mode === "single" &&
          ((trigSourceId !== null && focusedRun(s).trigArmPending[trigSourceId] === true) ||
            (trigState !== "triggered" && trigState !== "stopped"))
      );

      // The Auto option names the trace it currently resolves to — "Auto
      // (Input L)" — so the readouts are never ambiguous (maintainer ask).
      const autoOpt = chipSrcSel.options[0] as HTMLOptionElement | undefined;
      if (autoOpt) {
        const autoId = autoChipSourceId(tile);
        const label = autoId ? (s.traces.byId[autoId]?.label ?? autoId) : null;
        const text = label ? `Auto (${label})` : "Auto";
        if (autoOpt.textContent !== text) autoOpt.textContent = text;
      }

      // Chip values: backend measures (memoized by seq) + stream metrics,
      // formatted in the TILE's unit through the measured trace's OWN
      // converter offset.
      const srcId = chipSourceId(tile);
      const frames = srcId ? getFrames(srcId) : undefined;
      const ctx = {
        measures:
          srcId && frames ? measuresFor(ipc, srcId, frames.seq, refeed) : null,
        metrics: frames?.metrics ?? null,
        scope: frames?.scope ?? null,
        offsetDb: (srcId ? s.traces.byId[srcId]?.offsetDb : null) ?? null,
        tdUnit: tile.tdUnit,
        fdUnit: tile.fdUnit,
      };
      for (const chip of Array.from(chipsHost.children)) {
        const key = (chip as HTMLElement).dataset.key;
        const def = key ? measureByKey(key) : undefined;
        const valueNode = chip.querySelector(".tile__chip-value");
        if (def && valueNode) valueNode.textContent = def.format(ctx);
        // Sliding-window stats ride the tooltip (issue #26 lot B) — text
        // only, the chip itself never changes size (no-layout-shift rule).
        // Assigned only on change: rewriting `title` every frame could
        // dismiss an open native tooltip mid-read (webview-dependent).
        if (def?.statsTooltip) {
          const stats = def.statsTooltip(ctx);
          const title = stats
            ? `${def.desc}\n${stats}\n— click to remove`
            : `${def.desc} — click to remove`;
          if ((chip as HTMLElement).title !== title) (chip as HTMLElement).title = title;
        }
      }
    },

    destroy() {
      clearDrag();
      clearInterval(progressTimer);
      spectrum?.destroy();
      scope?.destroy();
      sweep?.destroy();
      root.remove();
    },
  };
  return view;
}

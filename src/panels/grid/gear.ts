/**
 * Per-tile ⚙ settings dialog (M3): Graph / Traces / Axis tabs. Every
 * control dispatches its store action immediately (live-apply — the dialog
 * is a view over the same state the tile renders from). The transfer-ref
 * (per-bin division by a reference trace) is DSP and lands with the M4
 * backend transform chains — noted in the Axis tab, not half-built here.
 */
import type { Store } from "../../store/store";
import type { TraceId } from "../../core/model";
import type { AppState, GraphKind, TriggerEdge, TriggerMode } from "../../store/state";
import { DEFAULT_TRIGGER } from "../../store/state";
import type { Ipc } from "../../ipc/ipc";
import {
  setTileAxis,
  setTileKind,
  setTileShowHarmonics,
  setTileShowTriggerMarkers,
  setTileTimeWindow,
  setTileTraces,
  setTileTriggerPosition,
  setTileTriggerSource,
} from "../../store/actions/layout";
import {
  armSingle,
  setTriggerEdge,
  setTriggerHystV,
  setTriggerLevelV,
  setTriggerMode,
} from "../../store/actions/trigger";
import { tileTriggerSourceId } from "../../store/selectors/trigger";
import {
  TD_UNIT_LABELS,
  triggerLevelFromDisplay,
  triggerLevelToDisplay,
  triggerSourceOffsetDb,
} from "../../store/selectors/chartvm";
import { openDialog } from "../../ui/dialog";
import { el } from "../../ui/dom";

export type GearTab = "graph" | "traces" | "axis" | "trigger";

export function openTileGearDialog(
  store: Store<AppState>,
  ipc: Ipc,
  tileId: string,
  initialTab: GearTab = "graph"
): void {
  const s0 = store.get();
  const tile = s0.layout.tiles[tileId];
  if (!tile) return;

  /* ---- Graph tab ------------------------------------------------------ */
  const kindSel = el("select.field", {
    "data-testid": "gear-kind",
    onchange: (e: Event) =>
      setTileKind(store, ipc, tileId, (e.target as HTMLSelectElement).value as GraphKind),
  });
  kindSel.append(
    el("option", { value: "spectrum" }, "Spectrum"),
    el("option", { value: "scope" }, "Scope"),
    el("option", { value: "sweep" }, "Sweep")
  );
  kindSel.value = tile.kind;

  const windowInput = el("input.field", {
    type: "number",
    min: "0",
    step: "1",
    placeholder: "full capture",
    "data-testid": "gear-time-window",
    onchange: (e: Event) => {
      const raw = (e.target as HTMLInputElement).value;
      const ms = raw === "" ? null : Math.max(0, Number(raw));
      setTileTimeWindow(store, tileId, ms === 0 ? null : ms);
    },
  });
  if (tile.timeWindowMs !== null) windowInput.value = String(tile.timeWindowMs);

  const harmonicsBox = el("input", {
    type: "checkbox",
    "data-testid": "gear-harmonics",
    onchange: (e: Event) =>
      setTileShowHarmonics(store, tileId, (e.target as HTMLInputElement).checked),
  }) as HTMLInputElement;
  harmonicsBox.checked = tile.showHarmonics;

  const graphTab = el(
    "div.gear__tab",
    {},
    el("label.gear__row", {}, el("span.gear__label", {}, "Graph type"), kindSel),
    el(
      "label.gear__row",
      {},
      el("span.gear__label", {}, "Scope window (ms)"),
      windowInput
    ),
    el(
      "label.gear__row",
      {
        title:
          "Mark the harmonic series (H1..H10) of the chip-source trace on a " +
          "spectrum tile — positions and levels located by the backend analysis",
      },
      el("span.gear__label", {}, "Harmonic markers"),
      harmonicsBox
    )
  );

  /* ---- Traces tab ----------------------------------------------------- */
  const traceRows = s0.traces.order.map((id) => {
    const t = s0.traces.byId[id];
    const box = el("input", {
      type: "checkbox",
      "data-testid": `gear-trace-${id}`,
      onchange: () => {
        const cur = store.get().layout.tiles[tileId];
        if (!cur) return;
        const next = box.checked
          ? [...cur.traces, id]
          : cur.traces.filter((x) => x !== id);
        setTileTraces(store, ipc, tileId, next);
      },
    });
    box.checked = tile.traces.includes(id);
    return el(
      "label.gear__row",
      {},
      box,
      el("span.gear__dot", { style: `background-color:${t?.color ?? "#888"}` }),
      el("span", {}, t?.label ?? id)
    );
  });
  const tracesTab = el("div.gear__tab", {}, ...traceRows);

  /* ---- Axis tab ------------------------------------------------------- */
  const xLogBox = el("input", {
    type: "checkbox",
    "data-testid": "gear-x-log",
    onchange: () => setTileAxis(store, tileId, { xLog: xLogBox.checked }),
  });
  xLogBox.checked = tile.axis.xLog;

  const yMinInput = el("input.field", {
    type: "number",
    "data-testid": "gear-y-min",
    onchange: () => setTileAxis(store, tileId, { yMin: Number(yMinInput.value) }),
  });
  yMinInput.value = String(tile.axis.yMin);
  const yMaxInput = el("input.field", {
    type: "number",
    "data-testid": "gear-y-max",
    onchange: () => setTileAxis(store, tileId, { yMax: Number(yMaxInput.value) }),
  });
  yMaxInput.value = String(tile.axis.yMax);

  const yAutoBox = el("input", {
    type: "checkbox",
    "data-testid": "gear-y-auto",
    onchange: () => {
      setTileAxis(store, tileId, { yAuto: yAutoBox.checked });
      yMinInput.toggleAttribute("disabled", yAutoBox.checked);
      yMaxInput.toggleAttribute("disabled", yAutoBox.checked);
    },
  });
  yAutoBox.checked = tile.axis.yAuto;
  yMinInput.toggleAttribute("disabled", tile.axis.yAuto);
  yMaxInput.toggleAttribute("disabled", tile.axis.yAuto);

  const dbrRefInput = el("input.field", {
    type: "number",
    placeholder: "auto (peak)",
    "data-testid": "gear-dbr-ref",
    onchange: () => {
      const raw = dbrRefInput.value;
      setTileAxis(store, tileId, { dbrRefDb: raw === "" ? null : Number(raw) });
    },
  });
  if (tile.axis.dbrRefDb !== null) dbrRefInput.value = String(tile.axis.dbrRefDb);

  const dbrBox = el("input", {
    type: "checkbox",
    "data-testid": "gear-dbr",
    onchange: () => {
      setTileAxis(store, tileId, { dbrEnabled: dbrBox.checked });
      dbrRefInput.toggleAttribute("disabled", !dbrBox.checked);
    },
  });
  dbrBox.checked = tile.axis.dbrEnabled;
  dbrRefInput.toggleAttribute("disabled", !tile.axis.dbrEnabled);

  const axisTab = el(
    "div.gear__tab",
    {},
    el("label.gear__row", {}, xLogBox, el("span", {}, "Logarithmic frequency axis")),
    el("label.gear__row", {}, yAutoBox, el("span", {}, "Autoscale level axis")),
    el(
      "div.gear__row",
      {},
      el("span.gear__label", {}, "Y min / max"),
      yMinInput,
      yMaxInput
    ),
    el(
      "label.gear__row",
      {},
      dbrBox,
      el("span", {}, "dBr — level axis relative to a reference")
    ),
    el(
      "div.gear__row",
      {},
      el("span.gear__label", {}, "dBr reference (dB)"),
      dbrRefInput
    ),
    el(
      "p.gear__note",
      {},
      "Transfer function: add a ÷-by-reference trace in the Traces panel (+ transform → Deconvolve) — the ratio is computed backend-side and can join any tile."
    )
  );

  /* ---- Trigger tab (Lot A, issue #26) ---------------------------------
   * Mode/edge/level/hysteresis are per ENDPOINT (`AppState.triggers`, plan
   * §3.2 — shared by every tile whose trigger resolves to the same hw
   * endpoint); source/position/markers are per TILE. Every control resolves
   * the CURRENT endpoint at dispatch time (`tileTriggerSourceId`), not the
   * one captured when the dialog opened — a source change must retarget
   * the mode/edge/level/hyst controls without reopening the dialog. */
  const trigSourceId0 = tileTriggerSourceId(s0, tile);
  const trigSettings0 = trigSourceId0 ? (s0.triggers[trigSourceId0] ?? DEFAULT_TRIGGER) : DEFAULT_TRIGGER;

  const currentSourceId = (): TraceId | null => {
    const t = store.get().layout.tiles[tileId];
    return t ? tileTriggerSourceId(store.get(), t) : null;
  };

  // Only the 4 hw endpoints can ever trigger (the wire's `TriggerRequest` is
  // keyed by `HW_TRACE_IDS.*` alone) — a memory/program/transform trace in
  // this list would store dead settings the backend never reads, and the
  // chip would lie forever ("T ▲ AUTO", never triggering) — issue #26
  // review #9.
  const trigSourceSel = el("select.field", {
    "data-testid": "gear-trigger-source",
    onchange: (e: Event) =>
      setTileTriggerSource(store, ipc, tileId, (e.target as HTMLSelectElement).value as "auto" | TraceId),
  });
  trigSourceSel.append(
    el("option", { value: "auto" }, "Auto"),
    ...tile.traces
      .map((id) => s0.traces.byId[id])
      .filter(
        (t): t is NonNullable<typeof t> =>
          !!t && (t.source.kind === "hw_input" || t.source.kind === "hw_output")
      )
      .map((t) => el("option", { value: t.id }, t.label))
  );
  trigSourceSel.value = tile.triggerSource;

  const trigModeSel = el("select.field", {
    "data-testid": "gear-trigger-mode",
    onchange: (e: Event) => {
      const sourceId = currentSourceId();
      if (sourceId) setTriggerMode(store, ipc, sourceId, (e.target as HTMLSelectElement).value as TriggerMode);
    },
  });
  trigModeSel.append(
    el("option", { value: "off" }, "Off"),
    el("option", { value: "auto" }, "Auto"),
    el("option", { value: "normal" }, "Normal"),
    el("option", { value: "single" }, "Single")
  );
  trigModeSel.value = trigSettings0.mode;

  const trigEdgeSel = el("select.field", {
    "data-testid": "gear-trigger-edge",
    onchange: (e: Event) => {
      const sourceId = currentSourceId();
      if (sourceId) setTriggerEdge(store, ipc, sourceId, (e.target as HTMLSelectElement).value as TriggerEdge);
    },
  });
  trigEdgeSel.append(
    el("option", { value: "rising" }, "Rising"),
    el("option", { value: "falling" }, "Falling")
  );
  trigEdgeSel.value = trigSettings0.edge;

  // Level travels in the tile's OWN display unit (canvas-drag parity) —
  // converted to/from the endpoint's level-volts at the store boundary.
  const trigLevelLabel = el("span.gear__label", {}, `Level (${TD_UNIT_LABELS[tile.tdUnit]})`);
  const trigLevelInput = el("input.field", {
    type: "number",
    step: "any",
    "data-testid": "gear-trigger-level",
    onchange: (e: Event) => {
      const s = store.get();
      const t = s.layout.tiles[tileId];
      const sourceId = currentSourceId();
      if (!t || !sourceId) return;
      // The SAME offset scopeVM converts through (snapshot-baked when a
      // picture is held, live otherwise) — reading the trace's live offset
      // directly here could disagree with what the marker on the chart
      // shows once a picture is held across a range change (review #5).
      const offsetDb = triggerSourceOffsetDb(s, sourceId);
      const raw = Number((e.target as HTMLInputElement).value);
      // A blank/garbage field parses to NaN — never dispatch it (review #1;
      // `setTriggerLevelV` also guards this, this is defense in depth at
      // the UI edge itself).
      if (!Number.isFinite(raw)) return;
      setTriggerLevelV(store, ipc, sourceId, triggerLevelFromDisplay(raw, t.tdUnit, offsetDb));
    },
  });
  {
    const offsetDb0 = trigSourceId0 ? triggerSourceOffsetDb(s0, trigSourceId0) : null;
    trigLevelInput.value = String(triggerLevelToDisplay(trigSettings0.levelV, tile.tdUnit, offsetDb0));
  }

  const trigHystInput = el("input.field", {
    type: "number",
    step: "any",
    min: "0",
    placeholder: "auto",
    "data-testid": "gear-trigger-hyst",
    onchange: (e: Event) => {
      const sourceId = currentSourceId();
      if (!sourceId) return;
      const raw = (e.target as HTMLInputElement).value;
      if (raw === "") {
        setTriggerHystV(store, ipc, sourceId, null); // "" = auto
        return;
      }
      const n = Number(raw);
      if (!Number.isFinite(n)) return; // never dispatch garbage (review #1)
      setTriggerHystV(store, ipc, sourceId, n);
    },
  });
  if (trigSettings0.hystV !== null) trigHystInput.value = String(trigSettings0.hystV);

  const trigPositionInput = el("input.field", {
    type: "number",
    min: "0",
    max: "100",
    step: "any",
    "data-testid": "gear-trigger-position",
    onchange: (e: Event) => {
      const raw = Number((e.target as HTMLInputElement).value);
      if (!Number.isFinite(raw)) return; // never dispatch garbage (review #1)
      setTileTriggerPosition(store, ipc, tileId, raw);
    },
  });
  trigPositionInput.value = String(tile.triggerPositionPct);

  const trigMarkersBox = el("input", {
    type: "checkbox",
    "data-testid": "gear-trigger-markers",
    onchange: (e: Event) =>
      setTileShowTriggerMarkers(store, tileId, (e.target as HTMLInputElement).checked),
  }) as HTMLInputElement;
  trigMarkersBox.checked = tile.showTriggerMarkers;

  const trigArmBtn = el(
    "button.btn.btn--small",
    {
      "data-testid": "gear-trigger-arm",
      title: "Arm a SINGLE shot",
      onclick: () => {
        const sourceId = currentSourceId();
        if (sourceId) armSingle(store, ipc, sourceId);
      },
    },
    "Arm"
  );

  const triggerTab = el(
    "div.gear__tab",
    {},
    el("label.gear__row", {}, el("span.gear__label", {}, "Trigger source"), trigSourceSel),
    el("label.gear__row", {}, el("span.gear__label", {}, "Mode"), trigModeSel),
    el("label.gear__row", {}, el("span.gear__label", {}, "Edge"), trigEdgeSel),
    el("label.gear__row", {}, trigLevelLabel, trigLevelInput),
    el(
      "label.gear__row",
      {},
      el("span.gear__label", {}, "Hysteresis (V, ± around level)"),
      trigHystInput
    ),
    el("label.gear__row", {}, el("span.gear__label", {}, "Position (%)"), trigPositionInput),
    el("label.gear__row", {}, trigMarkersBox, el("span", {}, "Show trigger markers")),
    el("div.gear__row", {}, trigArmBtn),
    el(
      "p.gear__note",
      {},
      "Mode, edge, level and hysteresis are per ENDPOINT — shared by every tile whose trigger points at it. Source, position and markers are per TILE."
    )
  );

  /* ---- tabs ----------------------------------------------------------- */
  const tabs: { name: string; testid: string; pane: HTMLElement }[] = [
    { name: "Graph", testid: "gear-tab-graph", pane: graphTab },
    { name: "Traces", testid: "gear-tab-traces", pane: tracesTab },
    { name: "Axis", testid: "gear-tab-axis", pane: axisTab },
    { name: "Trigger", testid: "gear-tab-trigger", pane: triggerTab },
  ];
  const paneHost = el("div.gear__pane");
  const tabBar = el("div.gear__tabs");
  const showTab = (i: number): void => {
    paneHost.replaceChildren(tabs[i].pane);
    Array.from(tabBar.children).forEach((b, j) =>
      b.classList.toggle("btn--primary", i === j)
    );
  };
  tabs.forEach((t, i) =>
    tabBar.append(
      el(
        "button.btn.btn--small",
        { "data-testid": t.testid, onclick: () => showTab(i) },
        t.name
      )
    )
  );
  showTab(Math.max(0, tabs.findIndex((t) => t.testid === `gear-tab-${initialTab}`)));

  const handle = openDialog({
    title: "Graph settings",
    testid: "gear-dialog",
    body: el("div.gear", {}, tabBar, paneHost),
    actions: [
      el("button.btn.btn--primary", { onclick: () => handle.close() }, "Close"),
    ],
  });
}

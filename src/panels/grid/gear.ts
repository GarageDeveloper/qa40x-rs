/**
 * Per-tile ⚙ settings dialog (M3): Graph / Traces / Axis tabs. Every
 * control dispatches its store action immediately (live-apply — the dialog
 * is a view over the same state the tile renders from). The transfer-ref
 * (per-bin division by a reference trace) is DSP and lands with the M4
 * backend transform chains — noted in the Axis tab, not half-built here.
 */
import type { Store } from "../../store/store";
import type { AppState, GraphKind } from "../../store/state";
import type { Ipc } from "../../ipc/ipc";
import {
  setTileAxis,
  setTileKind,
  setTileShowHarmonics,
  setTileTimeWindow,
  setTileTraces,
} from "../../store/actions/layout";
import { openDialog } from "../../ui/dialog";
import { el } from "../../ui/dom";

export function openTileGearDialog(
  store: Store<AppState>,
  ipc: Ipc,
  tileId: string
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

  /* ---- tabs ----------------------------------------------------------- */
  const tabs: { name: string; testid: string; pane: HTMLElement }[] = [
    { name: "Graph", testid: "gear-tab-graph", pane: graphTab },
    { name: "Traces", testid: "gear-tab-traces", pane: tracesTab },
    { name: "Axis", testid: "gear-tab-axis", pane: axisTab },
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
  showTab(0);

  const handle = openDialog({
    title: "Graph settings",
    testid: "gear-dialog",
    body: el("div.gear", {}, tabBar, paneHost),
    actions: [
      el("button.btn.btn--primary", { onclick: () => handle.close() }, "Close"),
    ],
  });
}

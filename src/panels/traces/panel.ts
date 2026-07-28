/**
 * Traces panel: the pool of displayable traces. The 4 hardware endpoints
 * (Input L/R, Output L/R) are always present and never deletable (Traces
 * V2); frozen ❄ memory traces and transform endpoints (M4) can be deleted.
 * Program result traces are NOT listed here — they live in the Programs
 * panel. What a tile SHOWS is tile membership (grid panel / gear dialog) —
 * the FD badge tells the truth about the display-derived FFT budget (#52):
 * dimmed means "no fd graph shows this trace", symmetrically per channel.
 *
 * Row rendering lives in row.ts (lot E4 extraction — the device groups
 * nest the same rows under per-device headers in step 6b).
 */
import "./panel.css";
import type { Store } from "../../store/store";
import type { AppState, TraceMeta } from "../../store/state";
import type { Ipc } from "../../ipc/ipc";
import { addTransformTrace } from "../../store/actions/traces";
import { fdShownTraceIds } from "../../store/selectors/layout";
import { el, keyedList } from "../../ui/dom";
import { collapsiblePanel } from "../../ui/collapse";
import { openTransformDialog } from "./transformdialog";
import { createTraceRow, updateTraceRow, type Row } from "./row";

export function mountTracesPanel(
  host: HTMLElement,
  store: Store<AppState>,
  ipc: Ipc
): void {
  const list = el("div.traces__list", { "data-testid": "traces-list" });
  const addFx = el(
    "button.btn.btn--small",
    {
      type: "button",
      "data-testid": "btn-add-transform",
      title:
        "Add a transform trace: a chain (weighting, notch, deconvolve, Rhai) applied to another trace — DSP runs backend-side",
      onclick: () => openTransformDialog(store, ipc, addTransformTrace(store)),
    },
    "+ transform"
  );
  const head = el("div.traces__head", {}, el("h2.sidebar__title", {}, "Traces"), addFx);
  const section = el("section.traces", { "data-testid": "traces-panel" }, head, list);
  host.append(section);
  collapsiblePanel(store, section, head, "traces");

  store.select(
    (s) => {
      const fdShown = fdShownTraceIds(s);
      return s.traces.order
        .map((id) => s.traces.byId[id])
        .filter((t): t is TraceMeta => !!t && t.source.kind !== "program")
        .map((meta): Row => ({ meta, fdShown: fdShown.has(meta.id) }));
    },
    (rows) => {
      keyedList(list, rows, (r) => r.meta.id, {
        create: (r) => createTraceRow(store, ipc, r),
        update: (node, r) => updateTraceRow(node, r),
      });
    },
    (a, b) => JSON.stringify(a) === JSON.stringify(b)
  );
}

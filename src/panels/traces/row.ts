/**
 * One trace-pool row (extracted from panel.ts for issue #25 lot E4 — the
 * device groups nest the SAME rows under per-device headers, and the e2e
 * adapter keys on `.traces__row`, not on list nesting). Moved verbatim:
 * dot-as-color-picker, label, truthful badges (#52), ＋wt / ⤓ selects,
 * transform ⚙ and the memory/transform-only ✕.
 */
import type { Store } from "../../store/store";
import type { AppState, TraceMeta } from "../../store/state";
import { hwSlotOfTraceId } from "../../store/state";
import type { Ipc } from "../../ipc/ipc";
import {
  addWeightedCopy,
  deleteTrace,
  setTraceColor,
} from "../../store/actions/traces";
import { exportTraceCsv } from "../../export/export";
import type { Domain } from "../../core/model";
import { el } from "../../ui/dom";
import { openTransformDialog } from "./transformdialog";

export interface Row {
  meta: TraceMeta;
  /** Some displayed spectrum tile shows this trace (fd budget member). */
  fdShown: boolean;
}

export function createTraceRow(
  store: Store<AppState>,
  ipc: Ipc,
  r: Row
): HTMLElement {
  const id = r.meta.id;
  const kind = r.meta.source.kind;
  // The color dot IS the picker (M6 gap 10a) — native color input
  // styled as the classic dot; the swatch itself shows the color.
  const dot = el("input.traces__dot", {
    type: "color",
    "data-testid": `trace-color-${id}`,
    title: "Trace color — click to change",
  }) as HTMLInputElement;
  dot.addEventListener("input", () => setTraceColor(store, id, dot.value));
  const hwSlot = hwSlotOfTraceId(id);
  const row = el(
    "div.traces__row",
    // Hw endpoint rows carry their device slot (lot E3) — the hook
    // E4's device grouping and multi-device e2e key on; slot-0
    // rows are otherwise byte-identical.
    hwSlot === null ? {} : { "data-slot": String(hwSlot) },
    dot,
    el("span.traces__label"),
    el("span.traces__badges")
  );
  // One-click weighted copy (M6 discoverability): same per-trace
  // transform model as "+ transform", without the dialog trip.
  const wtSel = el("select.traces__wt", {
    "data-testid": `trace-wt-${id}`,
    title:
      "Add a weighted copy of this trace — a transform trace " +
      "(backend DSP), same as + transform with a weighting step",
  }) as HTMLSelectElement;
  wtSel.append(
    el("option", { value: "" }, "＋wt"),
    el("option", { value: "a" }, "A-weighted copy"),
    el("option", { value: "c" }, "C-weighted copy"),
    el("option", { value: "riaa" }, "RIAA copy")
  );
  wtSel.onchange = () => {
    const mode = wtSel.value as "a" | "c" | "riaa" | "";
    wtSel.value = "";
    if (mode) addWeightedCopy(store, ipc, id, mode);
  };
  row.append(wtSel);
  // CSV export (issue #30): one option per domain this trace
  // currently carries frames for — options live in update() (the
  // badges' domains sig), the wire units + provenance header in
  // export/csv.ts.
  const exSel = el("select.traces__wt", {
    "data-testid": `trace-export-${id}`,
    title:
      "Export this trace's data as CSV — wire units plus a " +
      "provenance header (device identity, acquisition settings)",
  }) as HTMLSelectElement;
  exSel.onchange = () => {
    const domain = exSel.value as Domain | "";
    exSel.value = "";
    if (domain) void exportTraceCsv(store, ipc, id, domain);
  };
  row.append(exSel);
  if (kind === "transform") {
    row.append(
      el(
        "button.traces__gear",
        {
          title: "Transformer chain (input + steps)",
          "data-testid": `trace-gear-${id}`,
          onclick: () => openTransformDialog(store, ipc, id),
        },
        "⚙"
      )
    );
  }
  if (kind === "memory" || kind === "transform") {
    row.append(
      el(
        "button.traces__delete",
        {
          title:
            kind === "memory"
              ? "Delete this frozen trace"
              : "Delete this transform trace",
          "data-testid": `trace-del-${id}`,
          onclick: () => deleteTrace(store, ipc, id),
        },
        "✕"
      )
    );
  }
  return row;
}

export function updateTraceRow(node: HTMLElement, r: Row): void {
  const [dot, label, badges] = Array.from(node.children) as [
    HTMLInputElement,
    HTMLElement,
    HTMLElement,
  ];
  if (dot.value !== r.meta.color) dot.value = r.meta.color;
  label.textContent = r.meta.label;

  // Badges: TD/SW when frames carry those domains; FD lit when a
  // spectrum landed, dimmed-with-reason when the display budget
  // excludes this trace — the #52 truthful-badge rule.
  const hasTd = r.meta.domains.includes("td");
  const hasFd = r.meta.domains.includes("fd");
  const hasSw = r.meta.domains.includes("sweep");
  const isMemory = r.meta.source.kind === "memory";
  const sig = `${hasTd}:${hasFd}:${hasSw}:${r.fdShown}:${isMemory}`;
  if (badges.dataset.sig === sig) return;
  badges.dataset.sig = sig;
  // Export options track the SAME domains sig as the badges — a
  // trace offers exactly the CSVs it has frames for.
  const exSel = node.querySelector<HTMLSelectElement>(
    `[data-testid="trace-export-${r.meta.id}"]`
  );
  if (exSel) {
    exSel.replaceChildren(
      el("option", { value: "" }, "⤓"),
      ...(hasTd ? [el("option", { value: "td" }, "Waveform CSV")] : []),
      ...(hasFd ? [el("option", { value: "fd" }, "Spectrum CSV")] : []),
      ...(hasSw ? [el("option", { value: "sweep" }, "Sweep CSV")] : [])
    );
    exSel.disabled = !hasTd && !hasFd && !hasSw;
  }
  badges.replaceChildren();
  if (hasTd) {
    badges.append(
      el(
        "span.traces__badge",
        { "data-testid": "badge-td", title: "Time-domain frame" },
        "TD"
      )
    );
  }
  if (hasFd) {
    badges.append(
      el(
        "span.traces__badge",
        { "data-testid": "badge-fd", title: "Frequency-domain frame" },
        "FD"
      )
    );
  } else if (!isMemory && !r.fdShown) {
    badges.append(
      el(
        "span.traces__badge.traces__badge--dim",
        {
          "data-testid": "badge-fd-dim",
          title:
            "No spectrum: no frequency-domain graph shows this trace — add it to a spectrum tile to compute its FFT",
        },
        "FD"
      )
    );
  }
  if (hasSw) {
    badges.append(
      el(
        "span.traces__badge",
        { "data-testid": "badge-sw", title: "Swept-measurement frame" },
        "SW"
      )
    );
  }
}

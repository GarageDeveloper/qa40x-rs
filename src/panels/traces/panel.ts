/**
 * Traces panel: the pool of displayable traces. The 4 hardware endpoints
 * (Input L/R, Output L/R) are always present and never deletable (Traces
 * V2); frozen ❄ memory traces and transform endpoints (M4) can be deleted.
 * Program result traces are NOT listed here — they live in the Programs
 * panel. What a tile SHOWS is tile membership (grid panel / gear dialog) —
 * the FD badge tells the truth about the display-derived FFT budget (#52):
 * dimmed means "no fd graph shows this trace", symmetrically per channel.
 */
import "./panel.css";
import type { Store } from "../../store/store";
import type { AppState, TraceMeta } from "../../store/state";
import type { Ipc } from "../../ipc/ipc";
import {
  addTransformTrace,
  addWeightedCopy,
  deleteTrace,
  setTraceColor,
} from "../../store/actions/traces";
import { fdShownTraceIds } from "../../store/selectors/layout";
import { el, keyedList } from "../../ui/dom";
import { collapsiblePanel } from "../../ui/collapse";
import { openTransformDialog } from "./transformdialog";

interface Row {
  meta: TraceMeta;
  /** Some displayed spectrum tile shows this trace (fd budget member). */
  fdShown: boolean;
}

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
        create: (r) => {
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
          const row = el(
            "div.traces__row",
            {},
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
        },
        update(node, r) {
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
        },
      });
    },
    (a, b) => JSON.stringify(a) === JSON.stringify(b)
  );
}

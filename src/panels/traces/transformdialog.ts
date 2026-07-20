/**
 * Transform-trace dialog (M4, port of v1 transformdialog.ts): which pool
 * trace feeds the endpoint and the chain applied to it. The smallest
 * reasonable chain editor — one weighting, an optional notch, an optional
 * deconvolve-by-reference, an optional Rhai transformer — applied in that
 * fixed order (the script runs last, in the backend sandbox). The step
 * model itself is an ordered `TransformStep[]`, so a richer editor can
 * replace this without a schema change.
 */
import type { Ipc } from "../../ipc/ipc";
import type { Store } from "../../store/store";
import type { AppState } from "../../store/state";
import {
  dialogModelToSteps,
  stepsToDialogModel,
  transformLabel,
} from "../../core/transforms";
import { configureTransform } from "../../store/actions/traces";
import { openDialog } from "../../ui/dialog";
import { el } from "../../ui/dom";

function row(label: string, field: HTMLElement): HTMLElement {
  return el("label.dialog__row", {}, el("span.dialog__label", {}, label), field);
}

export function openTransformDialog(
  store: Store<AppState>,
  ipc: Ipc,
  id: string
): void {
  const s = store.get();
  const t = s.traces.byId[id];
  if (!t || t.source.kind !== "transform") return;
  const model = stepsToDialogModel(t.source.input, t.source.steps);

  // Traces this endpoint may read from: anything in the pool except itself.
  const others = s.traces.order
    .filter((tid) => tid !== id)
    .map((tid) => ({ id: tid, label: s.traces.byId[tid]?.label ?? tid }));

  const name = el("input.field", {
    type: "text",
    "data-testid": `fx-name-${id}`,
    spellcheck: "false",
  });
  name.value = t.label;

  const input = el("select.field", { "data-testid": `fx-input-${id}` });
  input.append(...others.map((o) => el("option", { value: o.id }, o.label)));
  input.value = model.input;

  const weighting = el("select.field", { "data-testid": `fx-weighting-${id}` });
  weighting.append(
    el("option", { value: "none" }, "None (Z)"),
    el("option", { value: "a" }, "A-weighting"),
    el("option", { value: "c" }, "C-weighting"),
    el("option", { value: "riaa" }, "RIAA de-emphasis")
  );
  weighting.value = model.weighting;

  const notch = el("input", { type: "checkbox", "data-testid": `fx-notch-${id}` });
  notch.checked = model.notch;
  const notchFreq = el("input.field", {
    type: "number",
    min: "1",
    step: "any",
    "data-testid": `fx-notch-freq-${id}`,
  });
  notchFreq.value = String(model.notchFreq);

  const deconvolve = el("select.field", { "data-testid": `fx-deconvolve-${id}` });
  deconvolve.append(
    el("option", { value: "none" }, "None"),
    ...others.map((o) => el("option", { value: o.id }, o.label))
  );
  deconvolve.value = model.deconvolve;

  const script = el("textarea.field.dialog__code", {
    "data-testid": `fx-script-${id}`,
    spellcheck: "false",
    placeholder:
      "// Rhai transformer (runs last, backend-side): mutate freqs/mag_db (fd) or samples (td) in place.",
  });
  script.value = model.script;

  const readModel = () => ({
    input: input.value,
    weighting: weighting.value as "none" | "a" | "c" | "riaa",
    notch: notch.checked,
    notchFreq: Number(notchFreq.value) || 60,
    deconvolve: deconvolve.value,
    script: script.value,
  });

  const apply = el(
    "button.btn.btn--primary",
    {
      "data-testid": `fx-apply-${id}`,
      onclick: () => {
        const steps = dialogModelToSteps(readModel());
        // The label follows the chain until the user renames it by hand.
        const auto = name.value.trim() === "" || name.value === t.label;
        const stillAuto = t.label === transformLabel(t.source.kind === "transform" ? t.source.steps : []);
        const label =
          auto && stillAuto ? transformLabel(steps) : name.value.trim() || t.label;
        configureTransform(store, ipc, id, { label, input: input.value, steps });
        dialog.close();
      },
    },
    "Apply"
  );
  const cancel = el("button.btn", { onclick: () => dialog.close() }, "Cancel");

  const dialog = openDialog({
    title: "Transformer chain",
    testid: `transform-dialog-${id}`,
    body: el(
      "div.dialog__form",
      {},
      row("Name", name),
      row("Input trace", input),
      row("Weighting", weighting),
      row("Notch (hum removal)", notch),
      row("Notch frequency (Hz)", notchFreq),
      row("Deconvolve by", deconvolve),
      row("Rhai transformer", script)
    ),
    actions: [cancel, apply],
  });
}

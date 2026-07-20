/**
 * The script source editor — a modal dialog (v1-style: inline editing in a
 * narrow sidebar row was unusable): a proper mono-spaced editor, a preset
 * loader, Apply/Cancel. Apply pushes the text to the source (the backend
 * recompiles on the next sync; failures come back as the row's named error).
 */
import type { Ipc } from "../../ipc/ipc";
import type { Store } from "../../store/store";
import type { AppState } from "../../store/state";
import { setScriptSource } from "../../store/actions/sources";
import { openDialog } from "../../ui/dialog";
import { el } from "../../ui/dom";
import { SCRIPT_PRESETS } from "./script-presets";

export function openScriptDialog(
  store: Store<AppState>,
  ipc: Ipc,
  id: string
): void {
  const src = store.get().sources.byId[id];
  if (!src || src.kind !== "script") return;

  const text = el("textarea.field.scriptdialog__text", {
    "data-testid": `src-script-${id}`,
    spellcheck: "false",
  });
  text.value = src.source;

  const preset = el("select.field", { "data-testid": `src-preset-${id}` });
  preset.append(
    el("option", { value: "" }, "Load a preset…"),
    ...SCRIPT_PRESETS.map((p, i) => el("option", { value: String(i) }, p.name))
  );
  preset.addEventListener("change", () => {
    const idx = Number(preset.value);
    if (preset.value !== "" && SCRIPT_PRESETS[idx]) {
      text.value = SCRIPT_PRESETS[idx].source;
      preset.value = "";
    }
  });

  const apply = el(
    "button.btn.btn--primary",
    {
      "data-testid": `src-script-apply-${id}`,
      onclick: () => {
        setScriptSource(store, ipc, id, text.value);
        dialog.close();
      },
    },
    "Apply"
  );
  const cancel = el("button.btn", { onclick: () => dialog.close() }, "Cancel");

  const dialog = openDialog({
    title: `${src.label} — fn render(ctx)`,
    body: el("div.scriptdialog", {}, preset, text),
    actions: [cancel, apply],
    testid: `script-dialog-${id}`,
  });
  text.focus();
}

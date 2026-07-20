/**
 * Measurement-script dialog (M4, port of v1 scriptdialog.ts): a Rhai code
 * editor, the curated examples, a personal script library (localStorage
 * `{name: source}` snapshots — "Save to library" copies the editor text
 * under a name; "Load" copies a snapshot back INTO the editor, a copy, not
 * a live link), and the streaming run-output log.
 */
import { SCRIPT_EXAMPLES } from "../../core/script-examples";
import type { Ipc } from "../../ipc/ipc";
import type { Store } from "../../store/store";
import type { AppState } from "../../store/state";
import { configureScriptProgram } from "../../store/actions/programs";
import { openDialog } from "../../ui/dialog";
import { el } from "../../ui/dom";
import { MAX_LOG_LINES, scriptRunLog, type ScriptLogLine } from "./runlog";

/* ------------------------------------------------------------------ */
/* Script library (localStorage, a {name: source} map)                 */
/* ------------------------------------------------------------------ */

const LIBRARY_KEY = "qa402-script-library"; // shared with v1 — same snapshots

/** The saved script library: a `{name: source}` map (empty when unset). */
export function scriptLibrary(): Record<string, string> {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const lib: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") lib[k] = v;
    }
    return lib;
  } catch {
    return {};
  }
}

export function saveScriptToLibrary(name: string, source: string): void {
  const lib = scriptLibrary();
  lib[name] = source;
  localStorage.setItem(LIBRARY_KEY, JSON.stringify(lib));
}

export function deleteScriptFromLibrary(name: string): void {
  const lib = scriptLibrary();
  if (!(name in lib)) return;
  delete lib[name];
  localStorage.setItem(LIBRARY_KEY, JSON.stringify(lib));
}

/* ------------------------------------------------------------------ */
/* Dialog                                                              */
/* ------------------------------------------------------------------ */

export function openProgramScriptDialog(
  store: Store<AppState>,
  ipc: Ipc,
  id: string
): void {
  void ipc;
  const s = store.get();
  const prog = s.programs.byId[id];
  if (prog?.kind !== "script") return;

  const name = el("input.field", { type: "text", "data-testid": `prog-script-name-${id}` });
  name.value = s.traces.byId[id]?.label ?? "";

  const editor = el("textarea.field.dialog__code.scriptdialog__text", {
    "data-testid": `prog-script-src-${id}`,
    spellcheck: "false",
    "aria-label": "Rhai script",
    placeholder: "// Write a Rhai script, or load an example / library script below.",
  });
  editor.value = prog.source;

  // --- examples ------------------------------------------------------
  const exampleSel = el("select.field", { "aria-label": "Example scripts" });
  exampleSel.append(
    ...SCRIPT_EXAMPLES.map((ex, i) => el("option", { value: String(i) }, ex.name))
  );
  const loadExample = el(
    "button.btn.btn--small",
    {
      type: "button",
      title: "Replace the editor content with the selected example",
      onclick: () => {
        const ex = SCRIPT_EXAMPLES[Number(exampleSel.value)];
        if (ex) editor.value = ex.source;
      },
    },
    "Load example"
  );

  // --- library -------------------------------------------------------
  const libSel = el("select.field", { "aria-label": "Script library" });
  const refreshLibrary = (): void => {
    libSel.replaceChildren();
    const names = Object.keys(scriptLibrary()).sort((a, b) => a.localeCompare(b));
    if (names.length === 0) {
      const opt = el("option", { value: "" }, "(library is empty)");
      opt.disabled = true;
      opt.selected = true;
      libSel.append(opt);
    }
    libSel.append(...names.map((n) => el("option", { value: n }, n)));
  };
  refreshLibrary();
  const loadLib = el(
    "button.btn.btn--small",
    {
      type: "button",
      title: "Copy the selected library script into the editor (a copy, not a link)",
      onclick: () => {
        const src = scriptLibrary()[libSel.value];
        if (src === undefined) return;
        editor.value = src;
        name.value = libSel.value;
      },
    },
    "Load"
  );
  const saveLib = el(
    "button.btn.btn--small",
    {
      type: "button",
      title: "Store the editor content in the library under this program's name",
      onclick: () => {
        const n = name.value.trim();
        if (!n || !editor.value.trim()) return;
        saveScriptToLibrary(n, editor.value);
        refreshLibrary();
        libSel.value = n;
      },
    },
    "Save to library"
  );
  const delLib = el(
    "button.btn.btn--small",
    {
      type: "button",
      title: "Remove the selected script from the library",
      onclick: () => {
        if (!libSel.value) return;
        deleteScriptFromLibrary(libSel.value);
        refreshLibrary();
      },
    },
    "Delete"
  );

  // --- run output (streams while a script runs) ----------------------
  const output = el("div.scriptdialog__out", {
    role: "log",
    "aria-label": "Script output",
    "data-testid": `prog-script-out-${id}`,
  });
  const appendLine = (l: ScriptLogLine): void => {
    const cls =
      "scriptdialog__line" + (l.error ? " is-error" : "") + (l.meta ? " is-meta" : "");
    output.append(el(`div`, { class: cls }, l.line));
    while (output.childElementCount > MAX_LOG_LINES) output.firstElementChild?.remove();
    output.scrollTop = output.scrollHeight;
  };
  for (const l of scriptRunLog.lines()) appendLine(l);
  const unsubscribe = scriptRunLog.subscribe(appendLine);
  const clearBtn = el(
    "button.btn.btn--small",
    {
      type: "button",
      title: "Clear the output log",
      onclick: () => {
        scriptRunLog.clear();
        output.replaceChildren();
      },
    },
    "Clear"
  );

  const apply = el(
    "button.btn.btn--primary",
    {
      "data-testid": `prog-script-apply-${id}`,
      onclick: () => {
        configureScriptProgram(store, id, { label: name.value, source: editor.value });
        dialog.close();
      },
    },
    "Apply"
  );
  const cancel = el("button.btn", { onclick: () => dialog.close() }, "Cancel");

  const dialog = openDialog({
    title: "Measurement script",
    testid: `prog-script-dialog-${id}`,
    body: el(
      "div.dialog__form.scriptdialog",
      {},
      el("label.dialog__row", {}, el("span.dialog__label", {}, "Name"), name),
      editor,
      el("div.scriptdialog__bar", {}, exampleSel, loadExample),
      el(
        "div.scriptdialog__bar",
        {},
        el("span.dialog__label", {}, "Library"),
        libSel,
        loadLib,
        saveLib,
        delLib
      ),
      el("div.scriptdialog__outhead", {}, el("span.dialog__label", {}, "Output"), clearBtn),
      output
    ),
    actions: [cancel, apply],
  });
  // Every close path (buttons, Escape, backdrop, ✕) must drop the log
  // subscription — wrap the handle's own close.
  const innerClose = dialog.close;
  dialog.close = () => {
    unsubscribe();
    innerClose();
  };
  editor.focus();
}

/**
 * Minimal modal dialog: overlay + panel, closed by Escape, the backdrop or
 * the ✕ button. One dialog at a time (opening another closes the first —
 * the app's dialogs are all user-initiated, never stacked).
 */
import "./dialog.css";
import { el } from "./dom";

export interface DialogHandle {
  close(): void;
}

let current: DialogHandle | null = null;

export function openDialog(opts: {
  title: string;
  body: HTMLElement;
  /** Footer buttons, left to right (the caller wires their onclick and may
   * call `close()` from the returned handle). */
  actions: HTMLElement[];
  testid?: string;
}): DialogHandle {
  current?.close();

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") handle.close();
  };
  const overlay = el(
    "div.dialog__overlay",
    {
      onclick: (e: Event) => {
        if (e.target === overlay) handle.close();
      },
    },
    el(
      "div.dialog",
      { "data-testid": opts.testid ?? "dialog", role: "dialog" },
      el(
        "div.dialog__head",
        {},
        el("h2.dialog__title", {}, opts.title),
        el(
          "button.btn.btn--small",
          { onclick: () => handle.close(), "aria-label": "Close" },
          "✕"
        )
      ),
      el("div.dialog__body", {}, opts.body),
      el("div.dialog__foot", {}, ...opts.actions)
    )
  );

  const handle: DialogHandle = {
    close: () => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      if (current === handle) current = null;
    },
  };
  current = handle;
  document.addEventListener("keydown", onKey);
  document.body.append(overlay);
  return handle;
}

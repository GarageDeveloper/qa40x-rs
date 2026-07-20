/**
 * Workspace bar (M5, v1 parity): name the current bench, Save it under that
 * name, and Load ▾ a built-in template, a saved workspace (deletable per
 * item) or a legacy (v1 frontend) save through the v4 importer. The current
 * workspace also auto-saves on every edit (actions/workspace.ts) — this bar
 * is for explicit named saves.
 */
import "./panel.css";
import type { Store } from "../../store/store";
import type { AppState } from "../../store/state";
import type { Ipc } from "../../ipc/ipc";
import { deleteNamed, listLegacyNamed, listNamed } from "../../store/persist";
import { templates } from "../../store/templates";
import {
  applyWorkspaceDoc,
  loadWorkspaceNamed,
  saveWorkspaceAs,
  setWorkspaceName,
} from "../../store/actions/workspace";
import { toast } from "../../store/actions/ui";
import { el } from "../../ui/dom";

export function mountWorkspaceBar(
  host: HTMLElement,
  store: Store<AppState>,
  ipc: Ipc
): void {
  const name = el("input.field.wsbar__name", {
    "data-testid": "ws-name",
    type: "text",
    spellcheck: "false",
    title: "Workspace name",
    onchange: () => setWorkspaceName(store, name.value),
  }) as HTMLInputElement;

  const saveBtn = el(
    "button.btn",
    {
      "data-testid": "ws-save",
      title: "Save the current workspace under this name",
      onclick: () => {
        if (!name.value.trim()) {
          toast(store, "info", "Give the workspace a name first.");
          return;
        }
        saveWorkspaceAs(store, name.value);
        rebuildMenu();
      },
    },
    "Save"
  );

  const menu = el("div.wsbar__menu", { "data-testid": "ws-menu" });
  menu.hidden = true;

  const loadBtn = el(
    "button.btn",
    {
      "data-testid": "ws-load",
      onclick: (e: Event) => {
        e.stopPropagation();
        const open = menu.hidden;
        if (open) rebuildMenu();
        menu.hidden = !open;
        if (open) {
          document.addEventListener("click", () => (menu.hidden = true), {
            once: true,
            capture: true,
          });
        }
      },
    },
    "Load ▾"
  );

  function heading(text: string): HTMLElement {
    return el("div.wsbar__menu-head", {}, text);
  }
  function item(label: string, testid: string, onClick: () => void): HTMLElement {
    return el(
      "button.wsbar__menu-item",
      { "data-testid": testid, onclick: onClick },
      label
    );
  }

  function rebuildMenu(): void {
    menu.replaceChildren();

    menu.append(heading("Templates"));
    for (const t of templates()) {
      menu.append(
        item(t.name, `ws-tpl-${t.name}`, () => {
          if (applyWorkspaceDoc(store, ipc, t.make())) {
            toast(store, "success", `Template "${t.name}" loaded.`);
          }
          menu.hidden = true;
        })
      );
    }

    const saved = listNamed();
    if (saved.length > 0) {
      menu.append(heading("Saved"));
      for (const n of saved) {
        menu.append(
          el(
            "div.wsbar__menu-row",
            {},
            item(n, `ws-saved-${n}`, () => {
              loadWorkspaceNamed(store, ipc, n, "saved");
              menu.hidden = true;
            }),
            el(
              "button.wsbar__del",
              {
                "data-testid": `ws-del-${n}`,
                title: `Delete "${n}"`,
                onclick: (e: Event) => {
                  e.stopPropagation();
                  deleteNamed(n);
                  rebuildMenu();
                },
              },
              "✕"
            )
          )
        );
      }
    }

    // Legacy (v1 frontend) saves, loadable through the v4→v5 importer.
    // Read-only from here: the old page still owns those blobs.
    const legacy = listLegacyNamed();
    if (legacy.length > 0) {
      menu.append(heading("Legacy (v1)"));
      for (const n of legacy) {
        menu.append(
          item(n, `ws-legacy-${n}`, () => {
            loadWorkspaceNamed(store, ipc, n, "legacy");
            menu.hidden = true;
          })
        );
      }
    }
  }

  host.append(
    el(
      "section.wsbar",
      { "data-testid": "workspace-bar" },
      el("h2.sidebar__title.wsbar__label", {}, "Workspace"),
      el(
        "div.wsbar__row",
        {},
        name,
        saveBtn,
        el("div.wsbar__load", {}, loadBtn, menu)
      )
    )
  );

  store.select(
    (s) => s.workspace.name,
    (n) => {
      // Never clobber the field mid-edit.
      if (document.activeElement !== name) name.value = n;
    }
  );
}

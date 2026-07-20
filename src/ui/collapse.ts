/**
 * Collapsible sidebar section (M5): a chevron in the section head toggles
 * `workspace.collapsed` — state-owned (and so persisted with the
 * workspace), never a DOM-only affair. Collapsing hides everything but the
 * head (`.is-collapsed` in base.css; the head must be the first child).
 */
import type { Store } from "../store/store";
import type { AppState } from "../store/state";
import { togglePanelCollapsed } from "../store/actions/workspace";
import { el } from "./dom";

export function collapsiblePanel(
  store: Store<AppState>,
  section: HTMLElement,
  head: HTMLElement,
  key: string
): void {
  const btn = el(
    "button.collapse-btn",
    {
      "data-testid": `collapse-${key}`,
      title: "Collapse / expand",
      onclick: () => togglePanelCollapsed(store, key),
    },
    "▾"
  );
  head.insertBefore(btn, head.firstChild);
  store.select(
    (s) => s.workspace.collapsed.includes(key),
    (collapsed) => {
      section.classList.toggle("is-collapsed", collapsed);
      btn.textContent = collapsed ? "▸" : "▾";
    }
  );
}

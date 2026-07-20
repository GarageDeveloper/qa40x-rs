/** Toast stack — renders `ui.toasts`, auto-dismisses, click to close. */
import "./toast.css";
import type { Store } from "../store/store";
import type { AppState, Toast } from "../store/state";
import { dismissToast } from "../store/actions/ui";
import { el, keyedList } from "./dom";

const AUTO_DISMISS_MS = 4500;

export function mountToasts(host: HTMLElement, store: Store<AppState>): void {
  const stack = el("div.toasts");
  host.append(stack);
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  store.select(
    (s) => s.ui.toasts,
    (toasts) => {
      keyedList(stack, toasts, (t) => String(t.id), {
        create(t: Toast) {
          if (t.kind !== "error") {
            timers.set(
              t.id,
              setTimeout(() => dismissToast(store, t.id), AUTO_DISMISS_MS)
            );
          }
          return el(
            "div",
            { class: `toast toast--${t.kind}`, role: "status" },
            el("span.toast__msg", {}, t.message),
            el("button.toast__close", {
              onclick: () => dismissToast(store, t.id),
              "aria-label": "Dismiss",
            }, "✕")
          );
        },
        update() {
          /* toasts are immutable once shown */
        },
      });
      for (const [id, timer] of timers) {
        if (!toasts.some((t) => t.id === id)) {
          clearTimeout(timer);
          timers.delete(id);
        }
      }
    }
  );
}

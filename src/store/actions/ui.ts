/** UI actions: toasts + theme. */
import type { Store } from "../store";
import type { AppState, Toast } from "../state";

let nextToastId = 1;

export function toast(
  store: Store<AppState>,
  kind: Toast["kind"],
  message: string
): void {
  const id = nextToastId++;
  store.update("ui/toast", (s) => ({
    ...s,
    ui: { ...s.ui, toasts: [...s.ui.toasts, { id, kind, message }] },
  }));
}

export function dismissToast(store: Store<AppState>, id: number): void {
  store.update("ui/toast-dismiss", (s) => ({
    ...s,
    ui: { ...s.ui, toasts: s.ui.toasts.filter((t) => t.id !== id) },
  }));
}

export function setTheme(store: Store<AppState>, theme: "dark" | "light"): void {
  store.update("ui/theme", (s) => ({ ...s, ui: { ...s.ui, theme } }));
}

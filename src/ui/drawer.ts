/**
 * Right-hand slide-in drawer — the v1 `.drawer` chrome ported to BEM
 * (backdrop + translateX slide, sticky head, scrollable body). Non-blocking
 * visually: the app stays readable underneath — the reason a drawer beats a
 * modal for panels one leaves open (REST address, device telemetry).
 * One drawer at a time; Escape, backdrop or ✕ close it.
 */
import "./drawer.css";
import { el } from "./dom";

export interface DrawerHandle {
  close(): void;
}

let current: DrawerHandle | null = null;

export function openDrawer(opts: {
  title: string;
  body: HTMLElement;
  testid?: string;
  /** Cleanup hook — runs once, however the drawer closes (✕, Escape,
   * backdrop, or a replacing drawer). Unsubscribe store selections here. */
  onClose?: () => void;
}): DrawerHandle {
  current?.close();

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") handle.close();
  };

  const backdrop = el("div.drawer__backdrop", {
    onclick: () => handle.close(),
  });
  const drawer = el(
    "aside.drawer",
    { "data-testid": opts.testid ?? "drawer", "aria-label": opts.title },
    el(
      "header.drawer__head",
      {},
      el("h2.drawer__title", {}, opts.title),
      el(
        "button.btn.btn--small",
        { onclick: () => handle.close(), "aria-label": "Close" },
        "✕"
      )
    ),
    el("div.drawer__body", {}, opts.body)
  );

  let closed = false;
  const handle: DrawerHandle = {
    close: () => {
      if (closed) return;
      closed = true;
      drawer.classList.remove("drawer--open");
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
      // Let the slide-out run before the node leaves the DOM.
      setTimeout(() => drawer.remove(), 250);
      if (current === handle) current = null;
      opts.onClose?.();
    },
  };
  current = handle;
  document.addEventListener("keydown", onKey);
  document.body.append(backdrop, drawer);
  // Next frame so the initial (off-screen) transform is committed first.
  requestAnimationFrame(() => drawer.classList.add("drawer--open"));
  return handle;
}

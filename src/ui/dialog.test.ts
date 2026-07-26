// @vitest-environment jsdom
//
// `onClose` (added for issue #28's wow & flutter dialog, which cancels an
// in-flight measurement on ANY dismissal) is a shared primitive: every
// dialog in the app goes through `openDialog`, so a bug here regresses all
// of them silently. The contract that matters is "fires on every close
// path, exactly once" — a caller that (like the wow & flutter dialog) calls
// `stopWowFlutter()` from `onClose` would double-cancel or misbehave if it
// ever fired twice for one dismissal (e.g. Escape and a click landing in
// the same tick) or not at all on some path.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDialog } from "./dialog";

function esc(): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
}

function mkDialog(onClose: () => void) {
  return openDialog({
    title: "Test dialog",
    body: document.createElement("div"),
    actions: [],
    onClose,
  });
}

describe("ui/dialog — onClose fires on every dismissal path, exactly once", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("fires once on Escape", () => {
    let calls = 0;
    mkDialog(() => calls++);
    esc();
    expect(calls).toBe(1);
  });

  it("fires once on a backdrop click", () => {
    let calls = 0;
    mkDialog(() => calls++);
    const overlay = document.querySelector(".dialog__overlay") as HTMLElement;
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(calls).toBe(1);
  });

  it("fires once on the ✕ button", () => {
    let calls = 0;
    mkDialog(() => calls++);
    const closeBtn = document.querySelector('[aria-label="Close"]') as HTMLElement;
    closeBtn.click();
    expect(calls).toBe(1);
  });

  it("fires once when the caller's own action calls handle.close()", () => {
    let calls = 0;
    const handle = mkDialog(() => calls++);
    handle.close();
    expect(calls).toBe(1);
  });

  it("does NOT fire twice when two close paths land on the same dismissal (Escape then a click)", () => {
    // The exact scenario the guard comment calls out: "Escape + a click can
    // both fire in one dismissal" — e.g. a keydown handler and a synthetic
    // click both racing to close(). Only the first must count.
    let calls = 0;
    const handle = mkDialog(() => calls++);
    esc();
    handle.close(); // second close on an already-closed dialog: must no-op
    expect(calls).toBe(1);
  });

  it("fires exactly once when a second openDialog() replaces this one", () => {
    // `openDialog` closes `current` before building the new dialog (single-
    // dialog-at-a-time rule) — that replacement is itself a dismissal path
    // and must run the FIRST dialog's onClose, exactly once.
    let calls = 0;
    mkDialog(() => calls++);
    mkDialog(() => {}); // opening a second dialog closes the first
    expect(calls).toBe(1);
  });

  it("removes the overlay from the DOM and clears the keydown listener exactly once", () => {
    // Not just the callback count: closing twice must not double-remove or
    // throw, and a stale keydown listener must not linger to fire a second
    // onClose on a LATER, unrelated dialog's Escape.
    let calls = 0;
    const handle = mkDialog(() => calls++);
    handle.close();
    expect(document.querySelector(".dialog__overlay")).toBeNull();
    expect(() => handle.close()).not.toThrow();
    expect(calls).toBe(1);

    // A second, independent dialog's Escape must not trigger the first
    // dialog's already-fired onClose again (dangling document listener).
    let secondCalls = 0;
    mkDialog(() => secondCalls++);
    esc();
    expect(calls).toBe(1);
    expect(secondCalls).toBe(1);
  });

  it("is optional: a dialog opened without onClose closes cleanly", () => {
    const handle = openDialog({
      title: "No callback",
      body: document.createElement("div"),
      actions: [],
    });
    expect(() => handle.close()).not.toThrow();
    expect(document.querySelector(".dialog__overlay")).toBeNull();
  });
});

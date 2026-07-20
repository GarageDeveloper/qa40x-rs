/**
 * App drawer (≡) — the APPLICATION's periphery, per the maintainer's
 * taxonomy: things that are NOT the device. Today: the REST automation
 * server (status, address, network exposure) and appearance; future
 * peripheral items (export, history, updates) get sections here instead of
 * re-opening the placement debate.
 * Device matters (info, telemetry, firmware) live in the Device drawer.
 */
import "./drawer.css";
import type { Store } from "../../store/store";
import { shallowEq } from "../../store/store";
import type { AppState } from "../../store/state";
import type { Ipc } from "../../ipc/ipc";
import { refreshRest, REST_TOKEN_KEY, setRestExposed, setRestToken } from "../../store/actions/rest";
import { setTheme } from "../../store/actions/ui";
import { openDrawer } from "../../ui/drawer";
import { el } from "../../ui/dom";

export function openAppDrawer(store: Store<AppState>, ipc: Ipc): void {
  /* ---- Automation (REST) ---------------------------------------------- */
  const dot = el("span.led");
  const stateTxt = el("span.drawer__val", { "data-testid": "app-rest-state" });
  const addr = el("span.drawer__val", { "data-testid": "app-rest-addr" });
  const expose = el("input", {
    type: "checkbox",
    "data-testid": "app-rest-expose",
  }) as HTMLInputElement;
  const hint = el("p.drawer__hint", { "data-testid": "app-rest-hint" });

  expose.addEventListener("change", () => {
    expose.disabled = true;
    void setRestExposed(store, ipc, expose.checked).finally(() => {
      expose.disabled = false;
    });
  });

  // Fixed bearer token: empty = a fresh random token per exposure.
  const tokenInput = el("input.field", {
    type: "text",
    placeholder: "auto (new random token per exposure)",
    autocomplete: "off",
    spellcheck: "false",
    "data-testid": "app-rest-token",
  }) as HTMLInputElement;
  try {
    tokenInput.value = localStorage.getItem(REST_TOKEN_KEY) ?? "";
  } catch {
    /* no storage */
  }
  tokenInput.addEventListener("change", () => {
    tokenInput.disabled = true;
    void setRestToken(store, ipc, tokenInput.value).finally(() => {
      tokenInput.disabled = false;
    });
  });

  const restSection = el(
    "section.drawer__section",
    {},
    el("h3.drawer__section-title", {}, "Automation (REST)"),
    el("div.drawer__row", {}, el("span.drawer__key", {}, "Status"), dot, stateTxt),
    el("div.drawer__row", {}, el("span.drawer__key", {}, "Address"), addr),
    el(
      "label.drawer__row.appmenu__expose",
      {},
      el("span.drawer__key", {}, "Network"),
      expose,
      "Expose on the network"
    ),
    el(
      "label.drawer__row",
      {},
      el("span.drawer__key", {}, "Token"),
      tokenInput
    ),
    hint
  );

  /* ---- Appearance ------------------------------------------------------ */
  const themeSel = el("select.field", {
    "data-testid": "app-theme",
    onchange: (e: Event) =>
      setTheme(store, (e.target as HTMLSelectElement).value as "dark" | "light"),
  });
  themeSel.append(
    el("option", { value: "dark" }, "Dark"),
    el("option", { value: "light" }, "Light")
  );

  const body = el(
    "div.appmenu",
    {},
    restSection,
    el(
      "section.drawer__section",
      {},
      el("h3.drawer__section-title", {}, "Appearance"),
      el("div.drawer__row", {}, el("span.drawer__key", {}, "Theme"), themeSel)
    )
  );

  const subs: (() => void)[] = [];
  openDrawer({
    title: "App",
    body,
    testid: "app-drawer",
    onClose: () => subs.forEach((off) => off()),
  });

  // Live while open: the drawer reads the same ui.rest the status bar does.
  subs.push(store.select(
    (s) => s.ui.rest,
    (rest) => {
      dot.classList.toggle("led--on", rest?.running === true);
      stateTxt.textContent = rest ? (rest.running ? "running" : "stopped") : "—";
      addr.textContent = rest?.running ? `http://${rest.host}:${rest.port}/` : "—";
      expose.checked = rest?.exposed === true;
      hint.textContent = rest?.exposed
        ? "Exposed on the network (0.0.0.0) — remote clients must send " +
          `"Authorization: Bearer ${rest.token ?? "…"}". ` +
          "Turn off when you're done."
        : "Localhost only — reachable from this machine. Exposing lets " +
          "network hosts reach the analyzer's hardware controls (a bearer " +
          "token will be required).";
      hint.classList.toggle("drawer__hint--warn", rest?.exposed === true);
    },
    shallowEq
  ));
  subs.push(store.select(
    (s) => s.ui.theme,
    (t) => {
      themeSel.value = t;
    }
  ));

  void refreshRest(store, ipc);
}

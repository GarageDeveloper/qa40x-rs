/**
 * Device panel (top bar) — connect/disconnect + LED, input/output range,
 * sample rate, FFT size, annunciators, theme toggle, device identity.
 *
 * Pure view: builds its DOM once, updates retained nodes from store
 * selections, and emits actions. No IPC call happens outside an action.
 */
import "./panel.css";
import type { Store } from "../../store/store";
import { shallowEq } from "../../store/store";
import type { AppState } from "../../store/state";
import {
  FFT_SIZES,
  INPUT_RANGES_DBV,
  OUTPUT_RANGES_DBV,
} from "../../store/state";
import type { Ipc } from "../../ipc/ipc";
import {
  connect,
  connectVirtual,
  disconnect,
  setInputRange,
  setOutputRange,
  setSampleRate,
} from "../../store/actions/device";
import { setFftSize } from "../../store/actions/acquisition";
import { setTheme } from "../../store/actions/ui";
import { annunciators } from "../../store/selectors/annunciators";
import { openAppDrawer } from "../appmenu/drawer";
import { el, keyedList } from "../../ui/dom";

function fmtRate(hz: number): string {
  return `${hz / 1000} kHz`;
}

function fmtFft(n: number): string {
  return n >= 1048576 ? "1M" : `${n / 1024}k`;
}

function select(
  testid: string,
  label: string,
  onchange: (value: number) => void
): { root: HTMLElement; input: HTMLSelectElement } {
  const input = el("select.field", {
    "data-testid": testid,
    onchange: (e: Event) =>
      onchange(Number((e.target as HTMLSelectElement).value)),
  });
  const root = el(
    "label.device-panel__ctl",
    {},
    el("span.device-panel__ctl-label", {}, label),
    input
  );
  return { root, input };
}

function setOptions(
  sel: HTMLSelectElement,
  values: readonly number[],
  fmt: (v: number) => string,
  current: number | null
): void {
  const sig = values.join(",");
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.replaceChildren(
      ...values.map((v) => el("option", { value: String(v) }, fmt(v)))
    );
  }
  if (current !== null) sel.value = String(current);
}

export function mountDevicePanel(
  host: HTMLElement,
  store: Store<AppState>,
  ipc: Ipc
): void {
  const led = el("span.led", { "data-testid": "device-led" });
  const connectBtn = el("button.btn.btn--primary", {
    "data-testid": "btn-connect",
    onclick: () => {
      const { status } = store.get().device;
      if (status === "connected") void disconnect(store, ipc);
      else if (status === "disconnected") void connect(store, ipc);
    },
  }, "Connect");
  // Demo mode: one click attaches the embedded virtual QA403 — for trying
  // the app with no hardware, and for development. Hidden once connected;
  // the DEMO chip then marks the session so it can't pass for a measurement.
  const demoBtn = el("button.btn", {
    "data-testid": "btn-demo",
    title: "Demo mode — connect to a built-in virtual QA403 (no hardware needed)",
    onclick: () => {
      if (store.get().device.status === "disconnected")
        void connectVirtual(store, ipc);
    },
  }, "Demo");
  const demoChip = el(
    "span.device-panel__demo-chip.u-hidden",
    { "data-testid": "demo-chip", title: "Connected to the built-in virtual device" },
    "DEMO"
  );

  const inputSel = select("input-range", "In", (v) =>
    void setInputRange(store, ipc, v)
  );
  const outputSel = select("output-range", "Out", (v) =>
    void setOutputRange(store, ipc, v)
  );
  const rateSel = select("sample-rate", "Rate", (v) =>
    void setSampleRate(store, ipc, v)
  );
  const fftSel = select("fft-size", "FFT", (v) => setFftSize(store, ipc, v));

  const badges = el("div.device-panel__annunciators", {
    "data-testid": "annunciators",
  });

  const themeBtn = el("button.btn", {
    "data-testid": "btn-theme",
    onclick: () =>
      setTheme(store, store.get().ui.theme === "dark" ? "light" : "dark"),
    "aria-label": "Toggle theme",
  }, "◐");

  // ≡ opens the App drawer (application periphery: REST, appearance…);
  // the brand is the v1 signature — calibration tick + model + subtitle.
  const menuBtn = el(
    "button.device-panel__menu",
    {
      "data-testid": "btn-app-menu",
      title: "App menu (REST automation, appearance…)",
      "aria-label": "App menu",
      onclick: () => openAppDrawer(store, ipc),
    },
    "≡"
  );
  const brand = el(
    "div.brand",
    {},
    el("span.brand__model", {}, "QA40x-rs"),
    el("span.brand__sub", {}, "Audio Analyzer")
  );

  host.append(
    el(
      "div.device-panel",
      {},
      menuBtn,
      brand,
      el("div.device-panel__conn", {}, led, connectBtn, demoBtn, demoChip),
      el(
        "div.device-panel__ctls",
        {},
        inputSel.root,
        outputSel.root,
        rateSel.root,
        fftSel.root
      ),
      badges,
      themeBtn
    )
  );

  setOptions(fftSel.input, FFT_SIZES, fmtFft, store.get().acquisition.fftSize);

  store.select(
    (s) => s.device,
    (device) => {
      led.className = `led${
        device.status === "connected"
          ? " led--on"
          : device.status === "connecting"
            ? " led--busy"
            : ""
      }`;
      connectBtn.textContent =
        device.status === "connected" ? "Disconnect" : "Connect";
      connectBtn.toggleAttribute("disabled", device.status === "connecting");
      demoBtn.classList.toggle("u-hidden", device.status !== "disconnected");
      demoChip.classList.toggle(
        "u-hidden",
        !(device.status === "connected" && device.info?.is_virtual)
      );

      const cfg = device.config;
      setOptions(
        inputSel.input,
        INPUT_RANGES_DBV,
        (v) => `${v} dBV`,
        cfg?.input_gain ?? null
      );
      setOptions(
        outputSel.input,
        OUTPUT_RANGES_DBV,
        (v) => `${v > 0 ? "+" : ""}${v} dBV`,
        cfg?.output_gain ?? null
      );
      setOptions(
        rateSel.input,
        device.info?.sample_rates ?? [48000, 96000, 192000],
        fmtRate,
        cfg?.sample_rate ?? null
      );
      // All four controls are meaningless without a device — grey them out
      // (FFT size included: it only drives the capture loop).
      const disabled = device.status !== "connected";
      for (const sel of [
        inputSel.input,
        outputSel.input,
        rateSel.input,
        fftSel.input,
      ]) {
        sel.toggleAttribute("disabled", disabled);
      }
    },
    shallowEq
  );

  store.select(
    (s) => s.acquisition.fftSize,
    (fftSize) => {
      fftSel.input.value = String(fftSize);
    }
  );

  store.select(annunciators, (list) => {
    keyedList(badges, list, (b) => b.key, {
      create: (b) =>
        el("span", {
          class: "annunciator",
          "data-testid": `ann-${b.key}`,
        }, b.label),
      update(node, b) {
        node.textContent = b.label;
        node.className = `annunciator${b.lit ? " annunciator--lit" : ""}${
          b.lit && b.alarm ? " annunciator--alarm" : ""
        }${b.lit && !b.alarm && b.warn ? " annunciator--warn" : ""}`;
      },
    });
  }, (a, b) => JSON.stringify(a) === JSON.stringify(b));
}

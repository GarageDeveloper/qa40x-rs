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
import { FFT_SIZES } from "../../store/state";
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
import { pickDevice } from "../../store/actions/devices";
import {
  availableEntries,
  inputRangesDbv,
  outputRangesDbv,
  pickedDeviceId,
  sampleRatesHz,
  showDevicePicker,
} from "../../store/selectors/devices";
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
  // Before the first enumeration lands (capabilities not known yet) the
  // list is empty: render ONE disabled placeholder so the closed select
  // keeps a sane width — the control never collapses (no layout shift).
  const sig = values.length ? values.join(",") : "empty";
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.replaceChildren(
      ...(values.length
        ? values.map((v) => el("option", { value: String(v) }, fmt(v)))
        : [el("option", { value: "", disabled: true }, "—")])
    );
  }
  if (current !== null && values.length) sel.value = String(current);
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
      else if (status === "disconnected")
        // Rule P3: a deviceId rides along only when the user explicitly
        // picked a unit — an untouched picker keeps the legacy call.
        void connect(store, ipc, { deviceId: pickedDeviceId(store.get()) });
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
  // Unit picker (issue #25 lot D): hidden unless ≥2 PHYSICAL units are on
  // the bus — with 0 or 1 the bar is byte-for-byte the pre-lot-D bar
  // (u-hidden is display:none, no flex gap: the Demo button's own
  // mechanism). Disabled while connected: switching units goes through
  // Disconnect — a <select> must not hide a live-measurement teardown
  // (lot E replaces this with several open units).
  const unitSel = el("select.field.device-panel__unit.u-hidden", {
    "data-testid": "device-select",
    title: "Measurement device — pick which unit Connect opens",
    onchange: (e: Event) =>
      pickDevice(store, (e.target as HTMLSelectElement).value),
  });

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

  // ⚙ opens the App drawer (application periphery: REST, appearance…).
  // Top-RIGHT, like the drawer it opens and the status bar's REST indicator —
  // a left trigger for a right-anchored panel broke the spatial link (#13);
  // the top-left corner stays the brand's (and a future real app menu's).
  const menuBtn = el(
    "button.device-panel__menu",
    {
      "data-testid": "btn-app-menu",
      title: "App settings (REST automation, appearance…)",
      "aria-label": "App settings",
      onclick: () => openAppDrawer(store, ipc),
    },
    "⚙︎"
  );
  // The brand is the v1 signature — calibration tick + model + subtitle.
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
      brand,
      el("div.device-panel__conn", {}, led, unitSel, connectBtn, demoBtn, demoChip),
      el(
        "div.device-panel__ctls",
        {},
        inputSel.root,
        outputSel.root,
        rateSel.root,
        fftSel.root
      ),
      badges,
      themeBtn,
      menuBtn
    )
  );

  setOptions(fftSel.input, FFT_SIZES, fmtFft, store.get().acquisition.fftSize);

  store.select(
    // Ranges/rates come from the PRIMARY unit's backend capabilities (issue
    // #25 lot D) — the selection spans both slices so the menus fill in the
    // moment an enumeration lands, not only on a device-slice change. The
    // arrays are entry-stable; setOptions' signature guard absorbs the
    // refresh churn.
    (s) => ({
      device: s.device,
      inputRanges: inputRangesDbv(s),
      outputRanges: outputRangesDbv(s),
      rates: sampleRatesHz(s),
    }),
    ({ device, inputRanges, outputRanges, rates }) => {
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
      setOptions(inputSel.input, inputRanges, (v) => `${v} dBV`, cfg?.input_gain ?? null);
      setOptions(
        outputSel.input,
        outputRanges,
        (v) => `${v > 0 ? "+" : ""}${v} dBV`,
        cfg?.output_gain ?? null
      );
      setOptions(rateSel.input, rates, fmtRate, cfg?.sample_rate ?? null);
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

  store.select(
    (s) => ({
      show: showDevicePicker(s),
      units: availableEntries(s),
      // While connected the picker mirrors the OPEN unit (= the primary,
      // rule P1); disconnected it shows the user's pick, else the primary.
      value:
        s.device.status === "disconnected"
          ? s.devices.pick ?? s.devices.primary
          : s.devices.primary,
      connected: s.device.status !== "disconnected",
    }),
    ({ show, units, value, connected }) => {
      unitSel.classList.toggle("u-hidden", !show);
      unitSel.toggleAttribute("disabled", connected);
      const sig = units.map((u) => u.id).join("|");
      if (unitSel.dataset.sig !== sig) {
        unitSel.dataset.sig = sig;
        unitSel.replaceChildren(
          ...units.map((u) =>
            el(
              "option",
              { value: u.id },
              `${u.model} · ${u.serial}${u.is_virtual ? " (virtual)" : ""}`
            )
          )
        );
      }
      if (value !== null && units.some((u) => u.id === value)) {
        unitSel.value = value;
      }
    },
    shallowEq
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

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
import { FFT_SIZES, SLOT0 } from "../../store/state";
import type { SessionKey } from "../../store/sessionkey";
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
import { focusedDevice, sessionKeys } from "../../store/selectors/session";
import { pickDevice, setFocusedSession } from "../../store/actions/devices";
import {
  availableEntries,
  deviceLabel,
  focusSelectorMode,
  inputRangesDbv,
  outputRangesDbv,
  pickedDeviceId,
  sampleRatesHz,
  sessionLabel,
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
  // list is empty: render ONE disabled placeholder so the control never
  // collapses to zero width. (Honest limit, review #8: the placeholder is
  // narrower than a real entry, so the pathological slow-boot path still
  // widens the bar when the scan lands — accepted; the NORMAL boot awaits
  // the enumeration before the panel mounts, so this branch never shows.)
  const sig = values.length ? values.join(",") : "empty";
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.replaceChildren(
      ...(values.length
        ? values.map((v) => el("option", { value: String(v) }, fmt(v)))
        : [el("option", { value: "", disabled: true }, "—")])
    );
  }
  // Only adopt `current` when it is actually offered — assigning a missing
  // value would render the select BLANK (selectedIndex −1), worse than
  // keeping the previous selection (review #3).
  if (current !== null && values.includes(current)) sel.value = String(current);
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
      const s = store.get();
      const { status } = focusedDevice(s);
      // KEYED to the focus (lot E4, C1 fix): the bar READS the focused
      // session, so its Disconnect must act on that same session — the
      // SLOT0 default would close the wrong unit under a moved focus.
      if (status === "connected") void disconnect(store, ipc, s.devices.focus);
      else if (status === "disconnected" && s.devices.focus === SLOT0)
        // Rule P3: a deviceId rides along only when the user explicitly
        // picked a unit — an untouched picker keeps the legacy call. A
        // slot ≥ 1 focus cannot reconnect here (connect_device owns slot
        // 0 only): the button is disabled with a pointer to + device.
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
      if (focusedDevice(store.get()).status === "disconnected")
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
    onchange: (e: Event) => {
      const v = (e.target as HTMLSelectElement).value;
      // Dispatch-time mode read (lot E4, decision B7): the same node is
      // the lot-D pick list at ≤ 1 session and the FOCUS selector at ≥ 2
      // — option values are session keys there, and the only legal focus
      // mutator is setFocusedSession (it re-syncs every running stream).
      if (unitSel.dataset.mode === "focus") {
        setFocusedSession(store, ipc, v as SessionKey);
        // A refused switch (e.g. output-only generator running) leaves the
        // focus in place — snap the select back so it never lies.
        unitSel.value = store.get().devices.focus;
      } else if (store.get().devices.byId[v]) {
        // The byId sniff drops a value delivered across a focus→pick mode
        // flip (a session key is junk as a pick — review note).
        pickDevice(store, v);
      }
    },
  });

  // KEYED to the focus (lot E4, C1 fix): the menus DISPLAY the focused
  // session's registers, so their writes must land on that same session —
  // the SLOT0 default would set slot 0's registers while showing slot 1's.
  const inputSel = select("input-range", "In", (v) =>
    void setInputRange(store, ipc, v, store.get().devices.focus)
  );
  const outputSel = select("output-range", "Out", (v) =>
    void setOutputRange(store, ipc, v, store.get().devices.focus)
  );
  const rateSel = select("sample-rate", "Rate", (v) =>
    void setSampleRate(store, ipc, v, store.get().devices.focus)
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
      device: focusedDevice(s),
      focusIsSlot0: s.devices.focus === SLOT0,
      inputRanges: inputRangesDbv(s),
      outputRanges: outputRangesDbv(s),
      rates: sampleRatesHz(s),
    }),
    ({ device, focusIsSlot0, inputRanges, outputRanges, rates }) => {
      led.className = `led${
        device.status === "connected"
          ? " led--on"
          : device.status === "connecting"
            ? " led--busy"
            : ""
      }`;
      connectBtn.textContent =
        device.status === "connected" ? "Disconnect" : "Connect";
      // A DISCONNECTED slot ≥ 1 focus cannot be reopened by connect_device
      // (it owns slot 0 only): disabled with a pointer, not hidden.
      const slot1Reconnect = device.status === "disconnected" && !focusIsSlot0;
      connectBtn.toggleAttribute(
        "disabled",
        device.status === "connecting" || slot1Reconnect
      );
      connectBtn.title = slot1Reconnect
        ? "An added device reopens from the Traces panel's + device menu"
        : "";
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
    // Scalar-only selection (review #5): an allocated array per evaluation
    // would defeat shallowEq and re-fire this on EVERY store batch — per
    // frame during a capture. The signatures are the rebuild triggers; the
    // entries are read back off the store inside the callback.
    (s) => {
      const mode = focusSelectorMode(s);
      return {
        show: showDevicePicker(s),
        // Dual-mode (lot E4, decision B7): "pick" is the lot-D picker
        // byte-for-byte; at ≥ 2 live sessions the node becomes the FOCUS
        // selector — option values are SESSION KEYS (slot 0 can
        // transiently hold no device id, and focus is a slot concept).
        mode,
        // Aliases join the signature (lot E2): a rename must rebuild the
        // option texts even though the id list is unchanged. JSON, not
        // string joins — the alias is USER TEXT, and a free-text field
        // containing the join character must never collide two states
        // (the captureBenchSignature rule, state.ts).
        sig:
          mode === "focus"
            ? JSON.stringify(sessionKeys(s).map((k) => [k, sessionLabel(s, k)]))
            : JSON.stringify(
                s.devices.available.map((id) => [id, s.devices.aliases[id] ?? null])
              ),
        // Pick mode: while connected the picker mirrors the OPEN unit (=
        // the primary, rule P1); disconnected it shows the user's pick,
        // else the primary. Focus mode: the focused session key.
        value:
          mode === "focus"
            ? s.devices.focus
            : focusedDevice(s).status === "disconnected"
              ? s.devices.pick ?? s.devices.primary
              : s.devices.primary,
        connected: focusedDevice(s).status !== "disconnected",
      };
    },
    ({ show, mode, sig, value, connected }) => {
      unitSel.classList.toggle("u-hidden", !show);
      // The attribute exists only in focus mode: the one-session bar keeps
      // the exact pre-E4 attribute set (byte-identity, review #10).
      if (mode === "focus") unitSel.dataset.mode = "focus";
      else delete unitSel.dataset.mode;
      // Focus mode: always enabled — switching the focus is its whole job
      // (and wire-safe: setFocusedSession re-syncs every running stream).
      // Pick mode keeps the lot-D disabled-while-connected rule.
      unitSel.toggleAttribute("disabled", mode === "pick" && connected);
      unitSel.title =
        mode === "focus"
          ? "Focused device — the transport, spacebar and bench sources follow it"
          : "Measurement device — pick which unit Connect opens";
      const fullSig = mode === "focus" ? `focus|${sig}` : sig;
      if (unitSel.dataset.sig !== fullSig) {
        unitSel.dataset.sig = fullSig;
        const s = store.get();
        unitSel.replaceChildren(
          ...(mode === "focus"
            ? sessionKeys(s).map((k) =>
                el("option", { value: k }, sessionLabel(s, k))
              )
            : availableEntries(s).map((u) =>
                el("option", { value: u.id }, deviceLabel(s, u))
              ))
        );
      }
      if (mode === "focus") {
        unitSel.value = value as string;
      } else if (
        value !== null &&
        availableEntries(store.get()).some((u) => u.id === value)
      ) {
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

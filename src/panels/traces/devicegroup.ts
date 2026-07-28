/**
 * One device group in the Traces panel (issue #25 lot E4): a header line
 * (LED, identity, alias editor, per-group Run/Stop, Remove) plus a second
 * line of per-session In/Out/Rate controls, wrapping the slot's endpoint
 * rows. A header renders for EVERY group — the lone slot-0 one included
 * (decision B3): the panel's structure must not change when a second unit
 * is plugged in, and alias editing is useful at one device.
 *
 * No-layout-shift rule: every control is always rendered; state changes
 * flip `disabled`/text, never presence.
 *
 * The In/Out/Rate line deliberately duplicates the top bar for the focused
 * device: the alternative (read-only groups) would force a FOCUS change —
 * a wire-visible stimulus migration — just to set a range. Both read the
 * same store fields, so they can never disagree.
 */
import type { Store } from "../../store/store";
import type { AppState } from "../../store/state";
import type { Ipc } from "../../ipc/ipc";
import type { SessionKey } from "../../store/sessionkey";
import { setDeviceAlias } from "../../store/actions/devices";
import {
  addDevice,
  removeDevice,
  setInputRange,
  setOutputRange,
  setSampleRate,
} from "../../store/actions/device";
import { startRun, stopRun } from "../../store/actions/stream";
import { togglePanelCollapsed } from "../../store/actions/workspace";
import { reviveCandidateId } from "../../store/selectors/devices";
import { session } from "../../store/selectors/session";
import { el } from "../../ui/dom";

/** The `workspace.collapsed` key of one group's fold state — the SAME
 * store the sidebar sections use (persists with the doc; slot-keyed like
 * the trace ids, so it is bench-portable, never device-bound). */
export function traceGroupCollapseKey(slot: number): string {
  return `traces-group-${slot}`;
}

/** The per-group projection the panel selects — NO per-frame fields
 * (run.stats, telemetry): the panel's keyed list re-runs on its JSON
 * signature, and a frame-rate field would re-render the whole pool ~8
 * times a second (C10). */
export interface GroupVM {
  key: SessionKey;
  slot: number;
  live: boolean;
  deviceId: string | null;
  label: string;
  alias: string;
  status: "disconnected" | "connecting" | "connected";
  streaming: boolean;
  stopping: boolean;
  locked: boolean;
  routable: boolean;
  /** Folded to its header line (workspace.collapsed, key
   * `traces-group-<slot>` — Raphaël 2026-07-28: reclaim the space once a
   * device is set up). */
  collapsed: boolean;
  /** For a group with no usable connection: the enumerated unit its
   * capture provenance names (reviveCandidateId) — the transport button
   * then reads "Connect" and revives the group in one click. */
  reviveId: string | null;
  inputRanges: number[];
  outputRanges: number[];
  rates: number[];
  inputGain: number | null;
  outputGain: number | null;
  sampleRate: number | null;
}

export interface GroupView {
  root: HTMLElement;
  /** Host the panel renders the slot's trace rows into. */
  rowHost: HTMLElement;
  update(vm: GroupVM): void;
}

/** Same option-fill discipline as the top bar's setOptions (device/panel.ts
 * review #3 and #8): signature-guarded rebuild, placeholder when the table
 * is unknown, never adopt a value the list doesn't offer (a missing value
 * would render the select blank). Local copy — a cross-panel import of a
 * view helper would couple the two panels for 20 lines. */
function setOptions(
  sel: HTMLSelectElement,
  values: readonly number[],
  fmt: (v: number) => string,
  current: number | null
): void {
  const sig = values.length ? values.join(",") : "empty";
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.replaceChildren(
      ...(values.length
        ? values.map((v) => el("option", { value: String(v) }, fmt(v)))
        : [el("option", { value: "", disabled: true }, "—")])
    );
  }
  if (current !== null && values.includes(current)) sel.value = String(current);
}

function fmtRate(hz: number): string {
  return `${hz / 1000} kHz`;
}

export function createDeviceGroup(
  store: Store<AppState>,
  ipc: Ipc,
  key: SessionKey,
  slot: number
): GroupView {
  const collapseBtn = el(
    "button.traces__group-collapse",
    {
      "data-testid": `group-collapse-${slot}`,
      title: "Collapse / expand this device",
      onclick: () => togglePanelCollapsed(store, traceGroupCollapseKey(slot)),
    },
    "▾"
  );
  const led = el("span.led", { "data-testid": `group-led-${slot}` });
  const title = el("span.traces__group-title", {
    "data-testid": `group-title-${slot}`,
  });
  const alias = el("input.traces__group-alias", {
    type: "text",
    "data-testid": `group-alias-${slot}`,
    placeholder: "alias",
    title:
      "Name this device (stored on this computer only — never sent to the " +
      "device, never saved into workspace files)",
  }) as HTMLInputElement;
  let aliasFor: string | null = null;
  alias.addEventListener("change", () => {
    if (aliasFor !== null) setDeviceAlias(store, aliasFor, alias.value);
  });
  const runBtn = el(
    "button.btn.btn--small",
    {
      "data-testid": `group-run-${slot}`,
      onclick: () => {
        const s = store.get();
        const sess = session(s, key);
        if (sess && sess.device.status === "connected") {
          if (sess.run.streaming) void stopRun(store, ipc, key);
          // No playAllIfIdle: a group Run is a per-device capture start —
          // only the toolbar transport arms the bench sources (they play
          // on the FOCUSED device; flipping them from a monitor-mode group
          // would rewrite user intent for another device's stream).
          else void startRun(store, ipc, { sessionKey: key });
          return;
        }
        // Revive gesture (dormant group, or a disconnected session): the
        // capture provenance names the unit — re-open it on THIS slot so
        // the group's rows come back to life.
        const reviveId = reviveCandidateId(s, slot);
        if (reviveId !== null) void addDevice(store, ipc, reviveId, { slot });
      },
    },
    "Run"
  );
  const removeBtn = el(
    "button.traces__delete",
    {
      "data-testid": `group-remove-${slot}`,
      onclick: () => void removeDevice(store, ipc, key),
    },
    "✕"
  );
  const head = el(
    "div.traces__group-head",
    {},
    collapseBtn,
    led,
    title,
    alias,
    runBtn,
    removeBtn
  );

  const mkSel = (
    testid: string,
    label: string,
    onchange: (v: number) => void
  ): { root: HTMLElement; input: HTMLSelectElement } => {
    const input = el("select.field.traces__group-sel", {
      "data-testid": testid,
      onchange: (e: Event) =>
        onchange(Number((e.target as HTMLSelectElement).value)),
    }) as HTMLSelectElement;
    const root = el(
      "label.traces__group-ctl",
      {},
      el("span.traces__group-ctl-label", {}, label),
      input
    );
    return { root, input };
  };
  // Keyed with THIS group's session (bookkeeping item 4): the wire call
  // and the refreshConfig read-back land on the same session — never the
  // SLOT0 default.
  const inSel = mkSel(`group-input-range-${slot}`, "In", (v) =>
    void setInputRange(store, ipc, v, key)
  );
  const outSel = mkSel(`group-output-range-${slot}`, "Out", (v) =>
    void setOutputRange(store, ipc, v, key)
  );
  const rateSel = mkSel(`group-sample-rate-${slot}`, "Rate", (v) =>
    void setSampleRate(store, ipc, v, key)
  );
  const ctls = el(
    "div.traces__group-ctls",
    {},
    inSel.root,
    outSel.root,
    rateSel.root
  );

  const rowHost = el("div.traces__group-rows");
  const root = el(
    "div.traces__group",
    { "data-testid": `traces-group-${slot}`, "data-slot": String(slot) },
    head,
    ctls,
    rowHost
  );

  function update(vm: GroupVM): void {
    root.classList.toggle("traces__group--collapsed", vm.collapsed);
    collapseBtn.textContent = vm.collapsed ? "▸" : "▾";
    led.className = `led${
      vm.status === "connected"
        ? " led--on"
        : vm.status === "connecting"
          ? " led--busy"
          : ""
    }`;
    // "— not connected" covers BOTH a dormant group and a live session
    // whose device dropped (a top-bar Disconnect of a slot ≥ 1 focus keeps
    // its session): the dark LED alone under-tells it (review note).
    title.textContent =
      vm.live && vm.status !== "disconnected"
        ? vm.label
        : `${vm.label} — not connected`;

    // Alias editing keys on the REGISTRY id (an alias survives a replug
    // onto another slot); no id ⇒ disabled, still rendered (no layout
    // shift). Never clobber the user's in-progress edit.
    aliasFor = vm.deviceId;
    alias.toggleAttribute("disabled", vm.deviceId === null);
    if (document.activeElement !== alias && alias.value !== vm.alias) {
      alias.value = vm.alias;
    }

    // Revive mode (a slot ≥ 1 group that is dormant, or whose session's
    // device dropped): the transport button becomes "Connect" and reopens
    // the provenance-matched unit on THIS slot — one click, no + device
    // trip (Raphaël 2026-07-28). Same button, same place in the header: no
    // layout shift. Never slot 0 — the default device connects from the
    // top bar.
    const reviveMode =
      vm.slot !== 0 && (!vm.live || vm.status === "disconnected");
    runBtn.textContent = reviveMode ? "Connect" : vm.streaming ? "Stop" : "Run";
    const runBlocked = reviveMode
      ? vm.reviveId === null
      : vm.status !== "connected" || !vm.routable || vm.stopping || vm.locked;
    runBtn.toggleAttribute("disabled", runBlocked);
    runBtn.title = reviveMode
      ? vm.reviveId !== null
        ? "Reconnect this device — it reopens on this same slot and these rows come back to life"
        : "Not connected — its unit is not on the bus (or these rows never captured); re-add a device from the + device menu above"
      : vm.status === "disconnected"
        ? "Not connected"
        : vm.status === "connecting"
          ? "Connecting…"
          : !vm.routable
          ? "Device id not adopted yet — one enumeration away; retry in a moment"
          : vm.locked
            ? "A measurement program owns this device"
            : vm.stopping
              ? "Stopping…"
              : vm.streaming
                ? "Stop this device's capture"
                : "Start this device's capture (monitor unless focused)";

    // Locked too (review #7): a program owns its device exclusively — a
    // remove would disconnect it mid-command AND drop the session's lock
    // out of anyProgramLock, letting a workspace load replace the trace
    // pool the program is still writing into.
    removeBtn.toggleAttribute("disabled", vm.slot === 0 || vm.locked);
    removeBtn.title =
      vm.slot === 0
        ? "The default device disconnects from the top bar; its endpoints are permanent"
        : vm.locked
          ? "A measurement program owns this device"
          : vm.live
            ? "Remove this device from the bench (its trace rows go too)"
            : "Purge this disconnected device's leftover trace rows";

    const ctlsDisabled = vm.status !== "connected";
    setOptions(inSel.input, vm.inputRanges, (v) => `${v} dBV`, vm.inputGain);
    setOptions(
      outSel.input,
      vm.outputRanges,
      (v) => `${v > 0 ? "+" : ""}${v} dBV`,
      vm.outputGain
    );
    setOptions(rateSel.input, vm.rates, fmtRate, vm.sampleRate);
    for (const sel of [inSel.input, outSel.input, rateSel.input]) {
      sel.toggleAttribute("disabled", ctlsDisabled);
    }
  }

  return { root, rowHost, update };
}

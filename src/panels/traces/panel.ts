/**
 * Traces panel: the pool of displayable traces, grouped per DEVICE (issue
 * #25 lot E4). Each group wraps one slot's 4 hardware endpoints (Input
 * L/R, Output L/R — always present for a live slot, never deletable) under
 * a header carrying the device's identity, alias editor, per-group
 * Run/Stop and Remove; memory/transform traces sit in a flat tail below
 * (decision B2 — they are bench artifacts, not device endpoints). Program
 * result traces are NOT listed here — they live in the Programs panel.
 * What a tile SHOWS is tile membership (grid panel / gear dialog) — the FD
 * badge tells the truth about the display-derived FFT budget (#52).
 *
 * Row rendering lives in row.ts; the group chrome in devicegroup.ts.
 */
import "./panel.css";
import type { Store } from "../../store/store";
import type { AppState } from "../../store/state";
import type { Ipc } from "../../ipc/ipc";
import type { TraceId } from "../../core/model";
import { addTransformTrace } from "../../store/actions/traces";
import { addDevice } from "../../store/actions/device";
import { fdShownTraceIds } from "../../store/selectors/layout";
import { deviceGroups, ungroupedTraceIds } from "../../store/selectors/traces";
import {
  addableEntries,
  deviceLabel,
  dormantGroupLabel,
  reviveCandidateId,
  sessionInputRanges,
  sessionLabel,
  sessionOutputRanges,
  sessionRates,
  sessionSupportsI2s,
} from "../../store/selectors/devices";
import { isRoutable } from "../../store/selectors/session";
import { sessionHasI2sSources } from "../../store/selectors/sources";
import { i2sPortConfig } from "../../store/actions/i2s";
import { el, keyedList } from "../../ui/dom";
import { collapsiblePanel } from "../../ui/collapse";
import { openTransformDialog } from "./transformdialog";
import { createTraceRow, updateTraceRow, type Row } from "./row";
import {
  createDeviceGroup,
  traceGroupCollapseKey,
  type GroupVM,
  type GroupView,
} from "./devicegroup";

interface GroupItem {
  vm: GroupVM;
  rows: Row[];
}

export function mountTracesPanel(
  host: HTMLElement,
  store: Store<AppState>,
  ipc: Ipc
): void {
  const groupsHost = el("div.traces__groups");
  const tailHost = el("div.traces__tail");
  const list = el(
    "div.traces__list",
    { "data-testid": "traces-list" },
    groupsHost,
    tailHost
  );
  // Add-device (lot E4): opens an enumerated unit ALONGSIDE the current one
  // (connect_additional_device — never a supersede). Quiet-select idiom
  // like the rows' ＋wt: the closed face is the affordance.
  const addDev = el("select.traces__wt.traces__adddev", {
    "data-testid": "traces-add-device",
    title:
      "Add a measurement device to the bench — opens it alongside the " +
      "connected one, capture-only until focused",
  }) as HTMLSelectElement;
  addDev.onchange = () => {
    const id = addDev.value;
    addDev.value = "";
    if (id) void addDevice(store, ipc, id);
  };
  const addFx = el(
    "button.btn.btn--small",
    {
      type: "button",
      "data-testid": "btn-add-transform",
      title:
        "Add a transform trace: a chain (weighting, notch, deconvolve, Rhai) applied to another trace — DSP runs backend-side",
      onclick: () => openTransformDialog(store, ipc, addTransformTrace(store)),
    },
    "+ transform"
  );
  const head = el(
    "div.traces__head",
    {},
    el("h2.sidebar__title", {}, "Traces"),
    el("div.traces__head-actions", {}, addDev, addFx)
  );
  const section = el("section.traces", { "data-testid": "traces-panel" }, head, list);
  host.append(section);
  collapsiblePanel(store, section, head, "traces");

  const rowRenderer = {
    create: (r: Row) => createTraceRow(store, ipc, r),
    update: (node: HTMLElement, r: Row) => updateTraceRow(node, r),
  };
  /** Retained group views by session key (keyedList holds only the DOM). */
  const groupViews = new Map<string, GroupView>();

  store.select(
    (s) => {
      const fdShown = fdShownTraceIds(s);
      // Narrowed projection (review #9): exactly what the row renderer
      // reads — never the whole TraceMeta, whose `seq` would re-render the
      // pool on every ingested frame through the JSON comparison below.
      const rowOf = (id: TraceId): Row | null => {
        const meta = s.traces.byId[id];
        if (!meta || meta.source.kind === "program") return null;
        // Hover provenance for bench artifacts (❄/transform): which
        // device produced this data, at what rate, when — from the
        // capture snapshot (issue #40; `derived` marks a transform's
        // inherited provenance).
        const kind = meta.source.kind;
        const cap =
          kind === "memory" || kind === "transform" ? meta.capture : null;
        const tip = cap?.device
          ? `${cap.derived ? "Derived from" : "Captured on"} ${cap.device.model} · ${cap.device.serial}` +
            (cap.sampleRateHz !== null ? ` @ ${cap.sampleRateHz / 1000} kHz` : "") +
            (cap.capturedAt !== null
              ? ` — ${cap.capturedAt.slice(0, 16).replace("T", " ")}`
              : "")
          : null;
        return {
          id,
          kind,
          color: meta.color,
          label: meta.label,
          domains: meta.domains,
          fdShown: fdShown.has(id),
          tip,
        };
      };
      const groups: GroupItem[] = deviceGroups(s).map((g) => {
        const sess = s.devices.sessions[g.key];
        return {
          vm: {
            key: g.key,
            slot: g.slot,
            live: g.live,
            deviceId: g.deviceId,
            // A dormant group (no session) names the unit its persisted
            // capture identifies — never the anonymous "Device #N" while
            // the revive knows exactly which unit it would reopen.
            label: g.live
              ? sessionLabel(s, g.key)
              : dormantGroupLabel(s, g.slot) ?? sessionLabel(s, g.key),
            alias: g.deviceId !== null ? s.devices.aliases[g.deviceId] ?? "" : "",
            status: sess?.device.status ?? "disconnected",
            // Deliberately NO per-frame field here (run.stats, telemetry):
            // this projection re-renders the pool via its JSON signature.
            streaming: sess?.run.streaming ?? false,
            stopping: sess?.run.stopping ?? false,
            locked: (sess?.run.programLock ?? null) !== null,
            routable: isRoutable(s, g.key),
            collapsed: s.workspace.collapsed.includes(
              traceGroupCollapseKey(g.slot)
            ),
            reviveId:
              !g.live || sess?.device.status === "disconnected"
                ? reviveCandidateId(s, g.slot)
                : null,
            inputRanges: sessionInputRanges(s, g.key),
            outputRanges: sessionOutputRanges(s, g.key),
            rates: sessionRates(s, g.key),
            inputGain: sess?.device.config?.input_gain ?? null,
            outputGain: sess?.device.config?.output_gain ?? null,
            sampleRate: sess?.device.config?.sample_rate ?? null,
            // Front-panel I2S port (issue #71). run.i2s.blocks stays out
            // (the no-per-frame-fields rule — it advances every poll).
            i2sSupported: sessionSupportsI2s(s, g.key),
            i2sEnabled: i2sPortConfig(s, g.key).enabled,
            i2sReferenceDbv: i2sPortConfig(s, g.key).referenceDbv,
            i2sRunning: sess?.run.i2s.running ?? false,
            i2sSigmaDbv: sess?.run.i2s.sigmaPeakDbv ?? null,
            i2sClipped: sess?.run.i2s.clipped ?? false,
            i2sError: sess?.run.i2s.error ?? null,
            i2sRouted: sessionHasI2sSources(s, g.key),
          },
          rows: g.traceIds.map(rowOf).filter((r): r is Row => r !== null),
        };
      });
      const tail = ungroupedTraceIds(s)
        .map(rowOf)
        .filter((r): r is Row => r !== null);
      const addable = addableEntries(s).map((d) => ({
        id: d.id,
        label: deviceLabel(s, d),
      }));
      return { groups, tail, addable, addBusy: s.devices.adding.length > 0 };
    },
    ({ groups, tail, addable, addBusy }) => {
      const sig = JSON.stringify(addable);
      if (addDev.dataset.sig !== sig) {
        addDev.dataset.sig = sig;
        addDev.replaceChildren(
          el("option", { value: "" }, "+ device"),
          ...addable.map((d) => el("option", { value: d.id }, d.label))
        );
      }
      addDev.toggleAttribute("disabled", addable.length === 0 || addBusy);

      keyedList(groupsHost, groups, (g) => g.vm.key, {
        create: (g) => {
          const view = createDeviceGroup(store, ipc, g.vm.key, g.vm.slot);
          groupViews.set(g.vm.key, view);
          return view.root;
        },
        update: (_node, g) => {
          const view = groupViews.get(g.vm.key);
          if (!view) return;
          view.update(g.vm);
          keyedList(view.rowHost, g.rows, (r) => r.id, rowRenderer);
        },
      });
      keyedList(tailHost, tail, (r) => r.id, rowRenderer);
      // Prune views whose group keyedList just removed. Membership in
      // groupsHost, NOT isConnected: the panel may live in a detached host
      // (jsdom tests) where isConnected is false for everything — the
      // first render would purge every live view and later updates would
      // silently no-op.
      for (const [k, v] of groupViews) {
        if (v.root.parentElement !== groupsHost) groupViews.delete(k);
      }
    },
    (a, b) => JSON.stringify(a) === JSON.stringify(b)
  );
}

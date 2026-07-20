/**
 * Sweep-program dialog (M4, port of v1 sweepdialog.ts): name, measurement
 * (THD vs freq | frequency response), range, level, channel, and the
 * kind-specific knobs (points + curve for THD, duration for FR).
 */
import type { Ipc } from "../../ipc/ipc";
import type { Store } from "../../store/store";
import type { AppState, SweepProgramParams } from "../../store/state";
import { configureSweepProgram } from "../../store/actions/programs";
import { openDialog } from "../../ui/dialog";
import { el } from "../../ui/dom";

function row(label: string, field: HTMLElement): HTMLElement {
  return el("label.dialog__row", {}, el("span.dialog__label", {}, label), field);
}

export function openSweepDialog(store: Store<AppState>, ipc: Ipc, id: string): void {
  void ipc;
  const s = store.get();
  const prog = s.programs.byId[id];
  if (prog?.kind !== "sweep") return;
  const p = prog.params;

  const name = el("input.field", { type: "text", "data-testid": `sweep-name-${id}` });
  name.value = s.traces.byId[id]?.label ?? "";

  const measurement = el("select.field", { "data-testid": `sweep-measurement-${id}` });
  measurement.append(
    el("option", { value: "thd" }, "THD vs frequency"),
    el("option", { value: "fr" }, "Frequency response")
  );
  measurement.value = p.measurement;

  const num = (testid: string, value: number, attrs: Record<string, string> = {}) => {
    const input = el("input.field", { type: "number", step: "any", "data-testid": testid, ...attrs });
    input.value = String(value);
    return input;
  };
  const start = num(`sweep-start-${id}`, p.startHz, { min: "1" });
  const end = num(`sweep-end-${id}`, p.endHz, { min: "1" });
  const level = num(`sweep-level-${id}`, p.levelDbfs);
  const points = num(`sweep-points-${id}`, p.points, { min: "2", step: "1" });
  const duration = num(`sweep-duration-${id}`, p.durationS, { min: "0.1", step: "0.1" });

  const channel = el("select.field", { "data-testid": `sweep-channel-${id}` });
  channel.append(
    el("option", { value: "left" }, "Left"),
    el("option", { value: "right" }, "Right"),
    el("option", { value: "both" }, "Both (L + R)")
  );
  channel.value = p.channel;

  const metric = el("select.field", { "data-testid": `sweep-metric-${id}` });
  metric.append(
    el("option", { value: "thd_db" }, "THD (dB)"),
    el("option", { value: "thd_percent" }, "THD (%)"),
    el("option", { value: "thdn_db" }, "THD+N (dB)")
  );
  metric.value = p.metric;

  // THD-only vs FR-only rows follow the measurement select.
  const pointsRow = row("Points", points);
  const metricRow = row("Curve", metric);
  const durationRow = row("Duration (s)", duration);
  const syncVisibility = (): void => {
    const fr = measurement.value === "fr";
    pointsRow.classList.toggle("u-hidden", fr);
    metricRow.classList.toggle("u-hidden", fr);
    durationRow.classList.toggle("u-hidden", !fr);
  };
  measurement.addEventListener("change", syncVisibility);
  syncVisibility();

  const apply = el(
    "button.btn.btn--primary",
    {
      "data-testid": `sweep-apply-${id}`,
      onclick: () => {
        const params: SweepProgramParams = {
          measurement: measurement.value as "thd" | "fr",
          channel: channel.value as SweepProgramParams["channel"],
          startHz: Number(start.value) || 20,
          endHz: Number(end.value) || 20000,
          levelDbfs: Number(level.value),
          points: Math.max(2, Math.round(Number(points.value) || 2)),
          durationS: Math.max(0.1, Number(duration.value) || 1),
          metric: metric.value as SweepProgramParams["metric"],
        };
        configureSweepProgram(store, id, { label: name.value, params });
        dialog.close();
      },
    },
    "Apply"
  );
  const cancel = el("button.btn", { onclick: () => dialog.close() }, "Cancel");

  const dialog = openDialog({
    title: "Sweep parameters",
    testid: `sweep-dialog-${id}`,
    body: el(
      "div.dialog__form",
      {},
      row("Name", name),
      row("Measurement", measurement),
      row("Start (Hz)", start),
      row("End (Hz)", end),
      row("Level (dBFS)", level),
      row("Channel", channel),
      pointsRow,
      metricRow,
      durationRow
    ),
    actions: [cancel, apply],
  });
}

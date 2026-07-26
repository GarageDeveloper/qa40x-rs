/**
 * Sweep-program dialog (M4, port of v1 sweepdialog.ts): name, measurement
 * (THD vs freq | frequency response), range, level, channel, and the
 * kind-specific knobs (points + curve for THD, duration for FR). THD also
 * picks its swept AXIS (issue #27): frequency (log sweep, constant level —
 * the original shape) or level (linear dB sweep at a fixed tone).
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

  const axis = el("select.field", { "data-testid": `sweep-axis-${id}` });
  axis.append(
    el("option", { value: "frequency" }, "Frequency"),
    el("option", { value: "level" }, "Level")
  );
  axis.value = p.axis;

  const num = (testid: string, value: number, attrs: Record<string, string> = {}) => {
    const input = el("input.field", { type: "number", step: "any", "data-testid": testid, ...attrs });
    input.value = String(value);
    return input;
  };
  const start = num(`sweep-start-${id}`, p.startHz, { min: "1" });
  const end = num(`sweep-end-${id}`, p.endHz, { min: "1" });
  const level = num(`sweep-level-${id}`, p.levelDbfs);
  const tone = num(`sweep-tone-${id}`, p.toneHz, { min: "1" });
  const startDb = num(`sweep-startdb-${id}`, p.startDbfs);
  const endDb = num(`sweep-enddb-${id}`, p.endDbfs);
  const points = num(`sweep-points-${id}`, p.points, { min: "2", step: "1" });
  const duration = num(`sweep-duration-${id}`, p.durationS, { min: "0.1", step: "0.1" });

  // Level-axis-only note (issue #27 review finding #5): the batched capture
  // uses ONE fixed input range for the WHOLE sweep (no per-point
  // auto-ranging, unlike a live tile) — near the low end of the sweep a
  // reading can be the ADC's own noise floor, not the DUT's.
  const levelNote = el(
    "p.dialog__note",
    { "data-testid": `sweep-level-note-${id}` },
    "One fixed input range covers the whole sweep — no per-point auto-ranging. Near the low end you may be reading the ADC's noise floor, not the DUT."
  );

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

  // Rows that follow the measurement select (THD-only vs FR-only), plus,
  // within THD, the axis select (frequency-axis vs level-axis fields).
  const axisRow = row("Sweep axis", axis);
  const startRow = row("Start (Hz)", start);
  const endRow = row("End (Hz)", end);
  const levelRow = row("Level (dBFS)", level);
  const toneRow = row("Tone (Hz)", tone);
  const startDbRow = row("Start level (dBFS)", startDb);
  const endDbRow = row("End level (dBFS)", endDb);
  const pointsRow = row("Points", points);
  const metricRow = row("Curve", metric);
  const durationRow = row("Duration (s)", duration);
  const syncVisibility = (): void => {
    const fr = measurement.value === "fr";
    const levelAxis = !fr && axis.value === "level";
    axisRow.classList.toggle("u-hidden", fr); // FR has no axis choice — always frequency
    startRow.classList.toggle("u-hidden", levelAxis);
    endRow.classList.toggle("u-hidden", levelAxis);
    levelRow.classList.toggle("u-hidden", levelAxis);
    toneRow.classList.toggle("u-hidden", !levelAxis);
    startDbRow.classList.toggle("u-hidden", !levelAxis);
    endDbRow.classList.toggle("u-hidden", !levelAxis);
    levelNote.classList.toggle("u-hidden", !levelAxis);
    pointsRow.classList.toggle("u-hidden", fr);
    metricRow.classList.toggle("u-hidden", fr);
    durationRow.classList.toggle("u-hidden", !fr);
  };
  measurement.addEventListener("change", syncVisibility);
  axis.addEventListener("change", syncVisibility);
  syncVisibility();

  const apply = el(
    "button.btn.btn--primary",
    {
      "data-testid": `sweep-apply-${id}`,
      onclick: () => {
        const measurementVal = measurement.value as "thd" | "fr";
        const params: SweepProgramParams = {
          measurement: measurementVal,
          axis: measurementVal === "fr" ? "frequency" : (axis.value as "frequency" | "level"),
          channel: channel.value as SweepProgramParams["channel"],
          startHz: Number(start.value) || 20,
          endHz: Number(end.value) || 20000,
          levelDbfs: Number(level.value),
          toneHz: Number(tone.value) || 1000,
          startDbfs: Number(startDb.value),
          endDbfs: Number(endDb.value),
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
      axisRow,
      startRow,
      endRow,
      levelRow,
      toneRow,
      startDbRow,
      endDbRow,
      levelNote,
      row("Channel", channel),
      pointsRow,
      metricRow,
      durationRow
    ),
    actions: [cancel, apply],
  });
}

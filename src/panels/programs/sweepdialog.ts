/**
 * Sweep-program dialog (M4, port of v1 sweepdialog.ts): name, measurement
 * (THD vs freq | frequency response | wow & flutter), range, level, channel,
 * and the kind-specific knobs (points + curve for THD, duration for FR,
 * reference tone + independent output/input channel + generate toggle for
 * wow & flutter). THD also picks its swept AXIS (issue #27): frequency (log
 * sweep, constant level — the original shape) or level (linear dB sweep at
 * a fixed tone).
 *
 * Wow & flutter (issue #28 second pass) reuses this SAME dialog/program
 * shape instead of its own bespoke one-shot dialog: its result is exactly a
 * curve (modulation rate vs % deviation), so it gets the same gear-config,
 * ▶/⏹, freeze, and persistence every other sweep already has.
 */
import type { Ipc } from "../../ipc/ipc";
import type { Store } from "../../store/store";
import type { AppState, SweepProgramParams } from "../../store/state";
import { configureSweepProgram, setProgramDeviceSlot } from "../../store/actions/programs";
import { openDialog } from "../../ui/dialog";
import { el } from "../../ui/dom";
import { programDeviceRow } from "./deviceselect";

function row(label: string, field: HTMLElement, help?: string): HTMLElement {
  return el("label.dialog__row", { title: help ?? "" }, el("span.dialog__label", {}, label), field);
}

export function openSweepDialog(store: Store<AppState>, ipc: Ipc, id: string): void {
  void ipc;
  const s = store.get();
  const prog = s.programs.byId[id];
  if (prog?.kind !== "sweep") return;
  const p = prog.params;

  const name = el("input.field", { type: "text", "data-testid": `sweep-name-${id}` });
  name.value = s.traces.byId[id]?.label ?? "";

  // Which device the sweep drives (issue #25 lot F4) — hidden on a
  // single-device bench with no pin, so the dialog stays byte-identical.
  const dev = programDeviceRow(store, id);

  const measurement = el("select.field", { "data-testid": `sweep-measurement-${id}` });
  measurement.append(
    el("option", { value: "thd" }, "THD vs frequency/level"),
    el("option", { value: "fr" }, "Frequency response"),
    el("option", { value: "wowflutter" }, "Wow & flutter")
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
  // Bounds matching the backend's own clamp (issue #28 second-pass review
  // finding #4): `measure_wow_flutter` clamps reference_freq to
  // [20, 0.9·Nyquist] and duration_secs to [1, 15] regardless of what's
  // asked — an unbounded input invites a silent surprise. `duration`'s own
  // max/min are further adjusted per-measurement in `syncVisibility()`
  // since FR's chirp length has no such ceiling. Nyquist is the TARGET
  // session's (lot F4): a program pinned to a 48 k device under a 384 kHz
  // focus must clamp against ITS converter, not the focused one's — it
  // follows the Device row's selection live.
  let nyquist = dev.sampleRateHz() / 2;
  const wowReference = num(`sweep-wowref-${id}`, p.wowReferenceHz, {
    min: "20",
    max: String(Math.floor(nyquist * 0.9)),
  });
  dev.select.addEventListener("change", () => {
    nyquist = dev.sampleRateHz() / 2;
    wowReference.max = String(Math.floor(nyquist * 0.9));
  });

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

  // Wow & flutter's own channel selects — independent output/input (an
  // external transport may feed a different channel than the one driving
  // it), unlike THD/FR's single "both/left/right" `channel`.
  const wowOutputChannel = el("select.field", { "data-testid": `sweep-wowout-${id}` });
  wowOutputChannel.append(el("option", { value: "left" }, "Left"), el("option", { value: "right" }, "Right"));
  wowOutputChannel.value = p.wowOutputChannel;
  const wowInputChannel = el("select.field", { "data-testid": `sweep-wowin-${id}` });
  wowInputChannel.append(el("option", { value: "left" }, "Left"), el("option", { value: "right" }, "Right"));
  wowInputChannel.value = p.wowInputChannel;
  const wowGenerate = el("input", {
    type: "checkbox",
    "data-testid": `sweep-wowgen-${id}`,
  }) as HTMLInputElement;
  wowGenerate.checked = p.wowGenerate;

  // Rows that follow the measurement select (THD-only vs FR-only vs
  // wow-flutter-only), plus, within THD, the axis select (frequency-axis vs
  // level-axis fields).
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
  const channelRow = row("Channel", channel);
  const wowReferenceRow = row(
    "Reference tone (Hz)",
    wowReference,
    "The DIN/IEC 386 reference tone, typically 3150 Hz. Clamped sub-Nyquist backend-side."
  );
  const wowOutputRow = row(
    "Play tone on",
    wowOutputChannel,
    'Only used while "Generate reference tone" is checked.'
  );
  const wowInputRow = row("Monitor input", wowInputChannel);
  const wowGenerateRow = row(
    "Generate reference tone",
    wowGenerate,
    'Off: silence is sent and the input is just monitored — an external transport (tape, turntable) is assumed to already be playing the test tone.'
  );
  const wowNote = el(
    "p.dialog__note",
    { "data-testid": `sweep-wow-note-${id}` },
    "The weighted (DIN/IEC 386) figure is an APPROXIMATION of the standard's " +
      "weighting curve — treat it as indicative, not a certified reading. " +
      "Scalars (weighted/unweighted %, peak, static offset) show on the " +
      "program card once a run lands."
  );
  const syncVisibility = (): void => {
    const fr = measurement.value === "fr";
    const wow = measurement.value === "wowflutter";
    const thd = !fr && !wow;
    const levelAxis = thd && axis.value === "level";
    axisRow.classList.toggle("u-hidden", !thd); // FR/W&F have no axis choice
    startRow.classList.toggle("u-hidden", !thd || levelAxis);
    endRow.classList.toggle("u-hidden", !thd || levelAxis);
    levelRow.classList.toggle("u-hidden", !thd || levelAxis);
    toneRow.classList.toggle("u-hidden", !levelAxis);
    startDbRow.classList.toggle("u-hidden", !levelAxis);
    endDbRow.classList.toggle("u-hidden", !levelAxis);
    levelNote.classList.toggle("u-hidden", !levelAxis);
    pointsRow.classList.toggle("u-hidden", !thd);
    metricRow.classList.toggle("u-hidden", !thd);
    durationRow.classList.toggle("u-hidden", !fr && !wow);
    // Wow & flutter's capture is backend-clamped to [1, 15] s (finding #4);
    // FR's chirp has no such ceiling — the shared `duration` field's own
    // bounds follow whichever measurement currently owns the row.
    if (wow) {
      duration.min = "1";
      duration.max = "15";
    } else {
      duration.min = "0.1";
      duration.removeAttribute("max");
    }
    channelRow.classList.toggle("u-hidden", wow); // W&F has its own two selects
    wowReferenceRow.classList.toggle("u-hidden", !wow);
    wowOutputRow.classList.toggle("u-hidden", !wow);
    wowInputRow.classList.toggle("u-hidden", !wow);
    wowGenerateRow.classList.toggle("u-hidden", !wow);
    wowNote.classList.toggle("u-hidden", !wow);
  };
  measurement.addEventListener("change", syncVisibility);
  axis.addEventListener("change", syncVisibility);
  syncVisibility();

  const apply = el(
    "button.btn.btn--primary",
    {
      "data-testid": `sweep-apply-${id}`,
      onclick: () => {
        const measurementVal = measurement.value as "thd" | "fr" | "wowflutter";
        const params: SweepProgramParams = {
          measurement: measurementVal,
          axis: measurementVal === "thd" ? (axis.value as "frequency" | "level") : "frequency",
          channel: channel.value as SweepProgramParams["channel"],
          startHz: Number(start.value) || 20,
          endHz: Number(end.value) || 20000,
          levelDbfs: Number(level.value),
          toneHz: Number(tone.value) || 1000,
          startDbfs: Number(startDb.value),
          endDbfs: Number(endDb.value),
          points: Math.max(2, Math.round(Number(points.value) || 2)),
          // A typed-over-the-max value isn't blocked by the input's `max`
          // attribute (a soft hint, not enforced without reportValidity())
          // — clamp explicitly so the STORED param matches what the
          // backend will actually do (finding #4).
          durationS:
            measurementVal === "wowflutter"
              ? Math.min(15, Math.max(1, Number(duration.value) || 4))
              : Math.max(0.1, Number(duration.value) || 1),
          metric: metric.value as SweepProgramParams["metric"],
          wowReferenceHz: Math.min(
            Math.floor(nyquist * 0.9),
            Math.max(20, Number(wowReference.value) || 3150)
          ),
          wowOutputChannel: wowOutputChannel.value as "left" | "right",
          wowInputChannel: wowInputChannel.value as "left" | "right",
          wowGenerate: wowGenerate.checked,
        };
        setProgramDeviceSlot(store, id, dev.value());
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
      dev.row,
      row("Measurement", measurement),
      axisRow,
      startRow,
      endRow,
      levelRow,
      toneRow,
      startDbRow,
      endDbRow,
      levelNote,
      channelRow,
      pointsRow,
      metricRow,
      durationRow,
      wowReferenceRow,
      wowOutputRow,
      wowInputRow,
      wowGenerateRow,
      wowNote
    ),
    actions: [cancel, apply],
  });
}

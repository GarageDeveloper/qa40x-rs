/**
 * Levels panel (issue #29): exposes the backend's `measure_levels` — a
 * single exclusive generate+capture reporting unweighted / A / C RMS + peak
 * (dBFS), and absolute Vrms/dBV/dBu once calibrated. Same device-lock family
 * as the sweep programs (store/actions/levels.ts mirrors runProgram's
 * suspend/resume handshake), but the result is one scalar reading, not a
 * trace — so it lives here, not in the Programs panel/pool.
 */
import "./panel.css";
import type { Store } from "../../store/store";
import type { AppState, LevelsState } from "../../store/state";
import type { Ipc } from "../../ipc/ipc";
import { programLockReason } from "../../store/actions/programs";
import {
  runLevelsMeasurement,
  setLevelsDurationSecs,
  setLevelsGenerate,
  setLevelsInputChannel,
  setLevelsOutputChannel,
  setLevelsStimulusDbfs,
  setLevelsStimulusFreqHz,
} from "../../store/actions/levels";
import { collapsiblePanel } from "../../ui/collapse";
import { el } from "../../ui/dom";

function channelSelect(
  testid: string,
  value: "left" | "right",
  onchange: (v: "left" | "right") => void
): HTMLSelectElement {
  const sel = el("select.field", {
    "data-testid": testid,
    onchange: (e: Event) => onchange((e.target as HTMLSelectElement).value as "left" | "right"),
  }) as HTMLSelectElement;
  sel.append(el("option", { value: "left" }, "Left"), el("option", { value: "right" }, "Right"));
  sel.value = value;
  return sel;
}

function row(label: string, field: HTMLElement): HTMLElement {
  return el("label.levels__row", {}, el("span.levels__label", {}, label), field);
}

/** dBFS floor mirrors the backend (`measurements::` never reports below
 * −200 dB) — "—" only for values the backend itself uses as "no reading".
 * Each unit gets its OWN suffix (issue #29 review finding #9b — dBV/dBu
 * readouts must never just say "dB", they're different physical
 * references). */
function fmtDbfs(v: number): string {
  return v <= -199.9 ? "—" : `${v.toFixed(1)} dBFS`;
}
function fmtDbv(v: number): string {
  return v <= -199.9 ? "—" : `${v.toFixed(1)} dBV`;
}
function fmtDbu(v: number): string {
  return v <= -199.9 ? "—" : `${v.toFixed(1)} dBu`;
}

function fmtV(v: number): string {
  return `${v.toFixed(4)} V`;
}

function fmtHz(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(3)} kHz` : `${hz.toFixed(1)} Hz`;
}

export function mountLevelsPanel(host: HTMLElement, store: Store<AppState>, ipc: Ipc): void {
  const inputCh = channelSelect("levels-input-channel", store.get().levels.inputChannel, (v) =>
    setLevelsInputChannel(store, v)
  );
  const outputCh = channelSelect("levels-output-channel", store.get().levels.outputChannel, (v) =>
    setLevelsOutputChannel(store, v)
  );
  const duration = el("input.field", {
    type: "number",
    min: "0.2",
    max: "15",
    step: "0.1",
    "data-testid": "levels-duration",
    onchange: (e: Event) => setLevelsDurationSecs(store, Number((e.target as HTMLInputElement).value)),
  }) as HTMLInputElement;

  const generate = el("input", {
    type: "checkbox",
    "data-testid": "levels-generate",
    onchange: (e: Event) => setLevelsGenerate(store, (e.target as HTMLInputElement).checked),
  }) as HTMLInputElement;

  const stimulusFreq = el("input.field", {
    type: "number",
    min: "1",
    step: "any",
    "data-testid": "levels-stimulus-freq",
    onchange: (e: Event) =>
      setLevelsStimulusFreqHz(store, Number((e.target as HTMLInputElement).value)),
  }) as HTMLInputElement;
  const stimulusDbfs = el("input.field", {
    type: "number",
    max: "0",
    step: "any",
    "data-testid": "levels-stimulus-dbfs",
    onchange: (e: Event) =>
      setLevelsStimulusDbfs(store, Number((e.target as HTMLInputElement).value)),
  }) as HTMLInputElement;
  const stimulusFreqRow = row("Freq (Hz)", stimulusFreq);
  const stimulusDbfsRow = row("Level (dBFS)", stimulusDbfs);

  const measureBtn = el(
    "button.btn.btn--small.levels__measure",
    {
      type: "button",
      "data-testid": "levels-measure",
      onclick: () => void runLevelsMeasurement(store, ipc),
    },
    "Measure"
  ) as HTMLButtonElement;

  // The readout grid: ALWAYS present (no layout shift — issue's GUI rule),
  // "—" before the first measurement, then the last result's values.
  const readout = (testid: string, label: string): { root: HTMLElement; value: HTMLElement } => {
    const value = el("span.levels__readout-value", { "data-testid": testid }, "—");
    return {
      root: el("div.levels__readout", {}, el("span.levels__readout-label", {}, label), value),
      value,
    };
  };
  const rUnweighted = readout("levels-readout-unweighted", "Unweighted");
  const rA = readout("levels-readout-a", "A-weighted");
  const rC = readout("levels-readout-c", "C-weighted");
  const rPeak = readout("levels-readout-peak", "Peak");
  const rVrms = readout("levels-readout-vrms", "Vrms");
  const rDbv = readout("levels-readout-dbv", "dBV");
  const rDbu = readout("levels-readout-dbu", "dBu");
  // A-weighted ABSOLUTE level (rms_a_dbv) — computed by the backend for
  // every result but previously dropped at the UI edge (issue #29 review
  // finding #9a): the one figure a noise-floor measurement actually wants.
  const rADbv = readout("levels-readout-a-dbv", "A-weighted (dBV)");
  const rCal = readout("levels-readout-cal", "Calibrated");
  // ALWAYS present (never conditionally inserted — no-layout-shift rule):
  // "ok" before/after a clean capture, "CLIP" the moment one saturates
  // (issue #29 review finding #4 — a saturated capture must never read as
  // a plausible, if loud, normal measurement).
  const rClip = readout("levels-readout-clip", "Clip");
  // The frequency ACTUALLY played (post Nyquist-alias clamp), read back
  // from the result rather than echoing the request field (issue #29
  // review finding #1).
  const rPlayed = readout("levels-readout-played", "Played");

  const head = el("div.levels__head", {}, el("h2.sidebar__title", {}, "Levels"));
  const section = el(
    "section.levels",
    { "data-testid": "levels-panel" },
    head,
    el(
      "div.levels__form",
      {},
      row("Input", inputCh),
      row("Output", outputCh),
      row("Duration (s)", duration),
      row("Generate stimulus", generate),
      stimulusFreqRow,
      stimulusDbfsRow,
      measureBtn,
      el(
        "div.levels__readouts",
        { "data-testid": "levels-readouts" },
        rUnweighted.root,
        rA.root,
        rC.root,
        rPeak.root,
        rVrms.root,
        rDbv.root,
        rDbu.root,
        rADbv.root,
        rCal.root,
        rClip.root,
        rPlayed.root
      ),
      el("div.levels__note", { "data-testid": "levels-note" })
    )
  );
  host.append(section);
  collapsiblePanel(store, section, head, "levels");

  const note = section.querySelector<HTMLElement>('[data-testid="levels-note"]')!;

  const render = (levels: LevelsState, lock: string | null): void => {
    inputCh.value = levels.inputChannel;
    outputCh.value = levels.outputChannel;
    duration.value = String(levels.durationSecs);
    generate.checked = levels.generate;
    stimulusFreq.value = String(levels.stimulusFreqHz);
    stimulusDbfs.value = String(levels.stimulusDbfs);
    stimulusFreqRow.classList.toggle("u-hidden", !levels.generate);
    stimulusDbfsRow.classList.toggle("u-hidden", !levels.generate);

    const busy = levels.running;
    const otherLock = lock !== null && !busy ? lock : null;
    measureBtn.disabled = busy || otherLock !== null;
    measureBtn.textContent = busy ? "Measuring…" : "Measure";
    measureBtn.title = otherLock ?? "Run one generate+capture and read the levels";

    const r = levels.result;
    rUnweighted.value.textContent = r ? fmtDbfs(r.rms_dbfs) : "—";
    rA.value.textContent = r ? fmtDbfs(r.rms_a_dbfs) : "—";
    rC.value.textContent = r ? fmtDbfs(r.rms_c_dbfs) : "—";
    rPeak.value.textContent = r ? fmtDbfs(r.peak_dbfs) : "—";
    rVrms.value.textContent = r ? fmtV(r.rms_vrms) : "—";
    rDbv.value.textContent = r ? fmtDbv(r.rms_dbv) : "—";
    rDbu.value.textContent = r ? fmtDbu(r.rms_dbu) : "—";
    rADbv.value.textContent = r ? fmtDbv(r.rms_a_dbv) : "—";
    rCal.value.textContent = r ? (r.calibrated ? "yes" : "no (ideal range)") : "—";
    rClip.value.textContent = r ? (r.clipped ? "CLIP" : "ok") : "—";
    rClip.value.classList.toggle("levels__readout-value--clip", !!r?.clipped);
    rPlayed.value.textContent = r && r.stimulus_freq_hz > 0 ? fmtHz(r.stimulus_freq_hz) : "—";

    note.textContent = levels.error ? levels.error : "";
  };

  store.select(
    (s) => ({ levels: s.levels, lock: programLockReason(s) }),
    ({ levels, lock }) => render(levels, lock),
    (a, b) => JSON.stringify(a) === JSON.stringify(b)
  );
}

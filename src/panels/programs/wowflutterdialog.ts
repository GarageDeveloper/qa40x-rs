/**
 * Wow & flutter dialog (issue #28) — configure and run a one-shot DIN/IEC
 * 386-approximation measurement (backend: `audio::wow_flutter`,
 * `measure_wow_flutter` command) and show its result: weighted/unweighted
 * RMS, a weighted peak, the static frequency offset, and the deviation
 * spectrum (wow = low rate, flutter = higher rate).
 *
 * Not a persisted program: `store/actions/wowflutter.ts` runs it as a
 * one-shot device-owning call under the same exclusive lock `runProgram`
 * uses; the result lives only in this dialog's own DOM, gone when it
 * closes (nothing here is saved to the workspace document). The capture is
 * cancellable — Stop, or dismissing the dialog any other way, cancels the
 * in-flight measurement instead of leaving every transport locked for up
 * to the full capture duration (issue #28 review point 7).
 */
import "./wowflutterdialog.css";
import type { Channel, WowFlutterResult } from "../../gen";
import type { Ipc } from "../../ipc/ipc";
import type { Store } from "../../store/store";
import type { AppState } from "../../store/state";
import { runWowFlutter, stopWowFlutter } from "../../store/actions/wowflutter";
import { toast } from "../../store/actions/ui";
import { readCssVars, onThemeChange, offThemeChange } from "../../chart/theme";
import { openDialog } from "../../ui/dialog";
import { el } from "../../ui/dom";

function row(label: string, field: HTMLElement, help?: string): HTMLElement {
  return el(
    "label.dialog__row",
    { title: help ?? "" },
    el("span.dialog__label", {}, label),
    field
  );
}

/**
 * Cents of a Hz offset around a reference tone (100 ¢ = one semitone) — a
 * musician-legible complement to the raw Hz static-offset reading. `null`
 * when the ratio isn't meaningful (a non-positive reference, or an offset
 * that would erase the whole reference frequency) — never `-Infinity`
 * (issue #28 review point 9).
 */
function centsOffset(offsetHz: number, referenceHz: number): number | null {
  if (referenceHz <= 0) return null;
  const ratio = 1 + offsetHz / referenceHz;
  if (!(ratio > 0)) return null;
  return 1200 * Math.log2(ratio);
}

function fmtPct(v: number): string {
  return `${v.toFixed(3)} %`;
}

function fmtSigned(v: number, digits: number, unit: string): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)} ${unit}`;
}

/**
 * Minimal inline-SVG line plot of the deviation spectrum. No zoom, no
 * cursor — this is a diagnostic glance inside a modal, not a tile chart
 * (the interactive canvas charts in `src/chart/` are built for the live
 * grid, not a one-shot dialog result).
 *
 * X axis is LOG, not linear: wow lives in the first few Hz while flutter
 * can run out past 100 Hz, so a linear 0–200 Hz axis crushed wow into ~2 %
 * of the plot width (issue #28 review point 2). Ticks are derived from the
 * data's own range, never hardcoded, so they can't collide (the old fixed
 * `[0, 4, maxRate]` overlapped "0 Hz" and "4 Hz" into unreadable text).
 */
function spectrumSvg(rateHz: number[], pct: number[]): SVGSVGElement {
  const v = readCssVars();
  const svgNs = "http://www.w3.org/2000/svg";
  const w = 480;
  const h = 150;
  const padL = 40;
  const padT = 10;
  const padR = 26;
  const padB = 20;

  const svg = document.createElementNS(svgNs, "svg") as unknown as SVGSVGElement;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("class", "wf__svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Deviation spectrum");
  svg.setAttribute("data-testid", "wf-spectrum-svg");

  const maxRate = Math.max(rateHz[rateHz.length - 1] ?? 200, 1);
  // Skip the DC (0 Hz) bin — it has no place on a log axis.
  const minHz = Math.max(0.5, rateHz.find((f) => f > 0) ?? 0.5);
  const logMin = Math.log10(minHz);
  const logMax = Math.log10(Math.max(maxRate, minHz * 1.01));
  const maxPct = Math.max(1e-6, ...pct) * 1.15;

  const x = (hz: number): number => {
    const lf = Math.log10(Math.max(hz, minHz));
    return padL + ((lf - logMin) / (logMax - logMin)) * (w - padL - padR);
  };
  const y = (p: number): number => h - padB - (p / maxPct) * (h - padT - padB);

  const mk = (tag: string, attrs: Record<string, string>): SVGElement => {
    const n = document.createElementNS(svgNs, tag) as SVGElement;
    for (const [k, val] of Object.entries(attrs)) n.setAttribute(k, val);
    return n;
  };

  const gridColor = v("--chart-grid-minor", "#19222b");
  const inkMuted = v("--chart-ink-muted", "#6f7e8b");

  // Y grid + labels (0, half, max) plus a "%" unit caption.
  for (let i = 0; i <= 2; i++) {
    const p = (maxPct * i) / 2;
    const gy = y(p);
    svg.append(
      mk("line", {
        x1: String(padL),
        x2: String(w - padR),
        y1: String(gy),
        y2: String(gy),
        stroke: gridColor,
        "stroke-width": "1",
      })
    );
    const t = mk("text", {
      x: String(padL - 4),
      y: String(gy + 3),
      fill: inkMuted,
      "font-size": "9",
      "text-anchor": "end",
    });
    t.textContent = p.toFixed(2);
    svg.append(t);
  }
  const yLabel = mk("text", { x: "2", y: String(padT), fill: inkMuted, "font-size": "9" });
  yLabel.textContent = "%";
  svg.append(yLabel);

  // X ticks: nice round Hz values actually inside the plotted (log) range.
  const candidates = [0.5, 1, 2, 4, 10, 20, 50, 100, 200, 500];
  let ticks = candidates.filter((f) => f >= minHz * 0.99 && f <= maxRate * 1.01);
  if (ticks.length < 2) ticks = [minHz, maxRate];
  for (const hz of ticks) {
    const gx = x(hz);
    const t = mk("text", {
      x: String(gx),
      y: String(h - 4),
      fill: inkMuted,
      "font-size": "9",
      "text-anchor": gx < padL + 10 ? "start" : gx > w - padR - 10 ? "end" : "middle",
    });
    t.textContent = hz >= 1 ? `${Math.round(hz)}` : hz.toFixed(1);
    svg.append(t);
  }
  const xLabel = mk("text", {
    x: String(w - 2),
    y: String(padT),
    fill: inkMuted,
    "font-size": "9",
    "text-anchor": "end",
  });
  xLabel.textContent = "Hz (log)";
  svg.append(xLabel);

  const points = rateHz
    .map((hz, i) => ({ hz, p: pct[i] ?? 0 }))
    .filter(({ hz }) => hz > 0);
  if (points.length > 1) {
    const d = points
      .map(({ hz, p }, i) => `${i === 0 ? "M" : "L"}${x(hz).toFixed(1)},${y(p).toFixed(1)}`)
      .join(" ");
    svg.append(
      mk("path", {
        d,
        fill: "none",
        stroke: v("--accent", "#3d90ef"),
        "stroke-width": "1.5",
      })
    );
  }
  return svg;
}

export function openWowFlutterDialog(store: Store<AppState>, ipc: Ipc): void {
  const referenceFreq = el("input.field", {
    type: "number",
    step: "any",
    min: "1",
    "data-testid": "wf-reference-freq",
  }) as HTMLInputElement;
  referenceFreq.value = "3150";

  const duration = el("input.field", {
    type: "number",
    step: "0.1",
    min: "1",
    max: "15",
    "data-testid": "wf-duration",
  }) as HTMLInputElement;
  duration.value = "4";

  const outputChannel = el("select.field", {
    "data-testid": "wf-output-channel",
  }) as HTMLSelectElement;
  outputChannel.append(el("option", { value: "Left" }, "Left"), el("option", { value: "Right" }, "Right"));

  const inputChannel = el("select.field", {
    "data-testid": "wf-input-channel",
  }) as HTMLSelectElement;
  inputChannel.append(el("option", { value: "Left" }, "Left"), el("option", { value: "Right" }, "Right"));

  const generate = el("input", {
    type: "checkbox",
    "data-testid": "wf-generate",
  }) as HTMLInputElement;
  generate.checked = true;
  const formFields: (HTMLInputElement | HTMLSelectElement)[] = [
    referenceFreq,
    duration,
    outputChannel,
    inputChannel,
    generate,
  ];

  const resultHost = el("div.wf__result", { "data-testid": "wf-result" });
  function renderEmpty(): void {
    resultHost.replaceChildren(
      el("p.wf__note", {}, "No measurement yet — set the parameters above and Run.")
    );
  }
  renderEmpty();

  // The last landed result, kept so a theme change can redraw the spectrum
  // with the new palette instead of freezing the colors baked in at first
  // render (issue #28 review point 10b).
  let lastResult: { res: WowFlutterResult; requestedFreq: number } | null = null;
  // Whether a measurement is currently in flight — lets closing the dialog
  // any other way (✕, Escape, backdrop) cancel it too, not just Stop.
  let measuring = false;

  const runBtn = el(
    "button.btn.btn--primary",
    { "data-testid": "wf-run", onclick: () => void run() },
    "Run"
  ) as HTMLButtonElement;
  const stopBtn = el(
    "button.btn",
    { "data-testid": "wf-stop", onclick: () => stopWowFlutter(ipc) },
    "Stop"
  ) as HTMLButtonElement;
  stopBtn.hidden = true;

  function setMeasuring(on: boolean): void {
    measuring = on;
    runBtn.hidden = on;
    stopBtn.hidden = !on;
    for (const f of formFields) f.disabled = on;
  }

  function renderResult(res: WowFlutterResult, requestedFreq: number): void {
    lastResult = { res, requestedFreq };
    const cents = centsOffset(res.static_offset_hz, res.reference_freq);
    const hasSpectrum = res.rate_hz.length > 1;
    const clamped = Math.abs(res.reference_freq - requestedFreq) > 0.5;
    resultHost.replaceChildren(
      ...(clamped
        ? [
            el(
              "p.wf__hint-text",
              {},
              `Note: ${requestedFreq.toFixed(0)} Hz was out of range for the current ` +
                `sample rate — the measurement actually used ` +
                `${res.reference_freq.toFixed(1)} Hz.`
            ),
          ]
        : []),
      el(
        "dl.wf__meta",
        {},
        el("dt", {}, "Weighted RMS (DIN/IEC 386, approx.)"),
        el("dd", { "data-testid": "wf-weighted" }, fmtPct(res.weighted_rms_percent)),
        el("dt", {}, "Unweighted RMS"),
        el("dd", { "data-testid": "wf-unweighted" }, fmtPct(res.unweighted_rms_percent)),
        el("dt", {}, "Peak (weighted)"),
        el("dd", { "data-testid": "wf-peak" }, fmtPct(res.peak_weighted_percent)),
        el("dt", {}, "Static frequency offset"),
        el(
          "dd",
          { "data-testid": "wf-offset" },
          cents === null
            ? fmtSigned(res.static_offset_hz, 2, "Hz")
            : `${fmtSigned(res.static_offset_hz, 2, "Hz")} (${fmtSigned(cents, 1, "¢")})`
        )
      ),
      el(
        "p.wf__hint-text",
        {},
        "The weighted figure is an APPROXIMATION of the DIN/IEC 386 weighting " +
          "curve (a 4 Hz-peaked band-pass) — treat it as indicative, not a " +
          "certified reading. The unweighted RMS is BROADBAND: it is not " +
          "limited to the DIN 45507/IEC 386 0.5–200 Hz measurement window, so " +
          "it also includes any sub-0.5 Hz drift and noise up to the " +
          "demodulator's own bandwidth."
      ),
      el(
        "h4.wf__subtitle",
        {},
        `Deviation spectrum (0–${Math.round(res.rate_hz[res.rate_hz.length - 1] ?? 0)} Hz)`
      ),
      hasSpectrum
        ? spectrumSvg(res.rate_hz, res.spectrum_percent)
        : el("p.wf__note", {}, "Not enough captured signal for a spectrum.")
    );
  }

  async function run(): Promise<void> {
    setMeasuring(true);
    resultHost.replaceChildren(el("p.wf__note", { "data-testid": "wf-status" }, "Measuring…"));
    try {
      const refHz = Number(referenceFreq.value) || 3150;
      const res = await runWowFlutter(store, ipc, {
        referenceFreq: refHz,
        durationSecs: Number(duration.value) || 4,
        outputChannel: outputChannel.value as Channel,
        inputChannel: inputChannel.value as Channel,
        generate: generate.checked,
      });
      renderResult(res, refHz);
      toast(
        store,
        "success",
        `Wow & flutter: ${fmtPct(res.weighted_rms_percent)} weighted, ` +
          `${fmtPct(res.unweighted_rms_percent)} unweighted.`
      );
    } catch (error) {
      const message = String(error);
      renderEmpty();
      if (message.includes("cancelled")) {
        toast(store, "info", "Wow & flutter measurement stopped.");
      } else {
        toast(store, "error", `Wow & flutter measurement failed: ${message}`);
      }
    } finally {
      setMeasuring(false);
    }
  }

  const onTheme = (): void => {
    if (lastResult) renderResult(lastResult.res, lastResult.requestedFreq);
  };
  onThemeChange(onTheme);

  const closeBtn = el("button.btn", { onclick: () => dialog.close() }, "Close");
  const dialog = openDialog({
    title: "Wow & flutter",
    testid: "wow-flutter-dialog",
    onClose: () => {
      offThemeChange(onTheme);
      if (measuring) stopWowFlutter(ipc);
    },
    body: el(
      "div.wf",
      {},
      el(
        "p.wf__intro",
        {},
        "FM-demodulates a captured reference tone (typically 3150 Hz, per " +
          "DIN/IEC 386) to measure speed variation — wow (slow) and flutter " +
          "(fast). Either play the tone yourself, or leave \"Generate\" off " +
          "and just monitor an external transport (tape, turntable) already " +
          "playing it."
      ),
      el(
        "div.dialog__form",
        {},
        row("Reference tone (Hz)", referenceFreq),
        row("Duration (s)", duration),
        row(
          "Play tone on",
          outputChannel,
          "Only used while \"Generate reference tone\" is checked."
        ),
        row("Monitor input", inputChannel),
        el(
          "label.dialog__row",
          {},
          el("span.dialog__label", {}, "Generate reference tone"),
          generate
        )
      ),
      el("div.wf__actions", {}, runBtn, stopBtn),
      resultHost
    ),
    actions: [closeBtn],
  });
}

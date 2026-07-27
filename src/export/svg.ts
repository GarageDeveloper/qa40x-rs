/**
 * Tile → SVG export (issue #30, maintainer follow-up on PR #41): a real
 * VECTOR rendering of the tile's view-model — not a canvas screenshot in
 * an <image> wrapper — so the file scales losslessly into papers, forum
 * posts and docs. PURE (VM + strings in, SVG text out), like csv.ts; the
 * dialogs/IPC stay in export.ts.
 *
 * Deliberate rendering choices, distinct from the on-screen canvas:
 *  - white background / dark ink regardless of the app theme — this is a
 *    publication artifact, not a screen clone;
 *  - the same DISPLAY-unit series the canvas draws (chartvm VMs — dBr,
 *    converter offsets, scope window clip applied by the caller);
 *  - provenance rides INSIDE the file (a <metadata> block with the same
 *    `# key=value` lines as the CSV export) plus a small printed footer;
 *  - kept to the load-bearing elements: grid, ticks, curves, legend. The
 *    FR phase overlay and harmonic markers stay screen/CSV features.
 */

/* ------------------------------------------------------------------ */
/* Small pure helpers                                                   */
/* ------------------------------------------------------------------ */

export function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const r2 = (v: number): string => (Math.round(v * 100) / 100).toString();

/** Nice linear ticks: 1/2/5·10^k steps, ~`target` of them across [a, b]. */
export function linTicks(a: number, b: number, target = 6): number[] {
  const span = b - a;
  if (!(span > 0) || !isFinite(span)) return [a];
  const raw = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  // 1.5/3/7 breakpoints (the d3-style rule) — plain ≤1/≤2/≤5 rounds a 2.5
  // raw step up to 5 and starves a 150-span axis down to 3 ticks.
  const step = (norm <= 1.5 ? 1 : norm <= 3 ? 2 : norm <= 7 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(a / step) * step; v <= b + step / 1e6; v += step) {
    // Snap floating drift (0.30000000000000004 → 0.3) for clean labels.
    out.push(Math.abs(v) < step / 1e6 ? 0 : Number(v.toPrecision(12)));
  }
  return out;
}

/** Log ticks: full decades, plus 2/5 sub-ticks when few decades span. */
export function logTicks(a: number, b: number): number[] {
  const out: number[] = [];
  const lo = Math.floor(Math.log10(a));
  const hi = Math.ceil(Math.log10(b));
  // Sub-ticks (2/5) only when the VISIBLE span is a few decades — measured
  // on the actual [a, b] span, not the outer decade bounds (20→20 kHz is 3
  // decades even though its decade envelope spans 4).
  const subs = Math.log10(b / a) <= 3.01 ? [1, 2, 5] : [1];
  for (let d = lo; d <= hi; d++) {
    for (const m of subs) {
      const v = m * Math.pow(10, d);
      if (v >= a * 0.999 && v <= b * 1.001) out.push(v);
    }
  }
  return out;
}

/** "20k" / "1k" / "0.5" — the compact frequency-style tick label. */
export function fmtTick(v: number): string {
  const av = Math.abs(v);
  if (av >= 1e6) return `${Number((v / 1e6).toPrecision(3))}M`;
  if (av >= 1e3) return `${Number((v / 1e3).toPrecision(3))}k`;
  return `${Number(v.toPrecision(3))}`;
}

/** Seconds with an engineering unit — scope time axes ("2.5 ms", "10 µs"). */
export function fmtSeconds(v: number): string {
  const av = Math.abs(v);
  if (v === 0) return "0";
  if (av >= 1) return `${Number(v.toPrecision(3))} s`;
  if (av >= 1e-3) return `${Number((v * 1e3).toPrecision(3))} ms`;
  return `${Number((v * 1e6).toPrecision(3))} µs`;
}

/* ------------------------------------------------------------------ */
/* The generic renderer                                                 */
/* ------------------------------------------------------------------ */

export interface SvgSeries {
  label: string;
  color: string;
  x: ArrayLike<number>;
  y: ArrayLike<number>;
}

export interface SvgSpec {
  title: string;
  /** Small grey provenance lines printed under the plot. */
  footer: string[];
  /** Full `# key=value` provenance block, embedded as <metadata>. */
  provenance: string[];
  /** Y-axis unit label ("dBV", "V", "dB", "%"…). */
  unitLabel: string;
  /** X-axis unit label ("Hz", "s", "dBFS"…). */
  xUnitLabel: string;
  xLog: boolean;
  series: SvgSeries[];
  /** Fixed y range (a manual spectrum axis); auto from the data otherwise. */
  yDomain?: [number, number];
  /** Symmetric-about-zero auto range (scope). */
  ySymmetric?: boolean;
  /** Tick label formatter for the x axis (defaults to fmtTick). */
  xFormat?: (v: number) => string;
}

const W = 860;
const PLOT_X = 64;
const PLOT_W = W - PLOT_X - 20;
const PLOT_H = 400;
const INK = "#1a1a1a";
const GRID = "#dddddd";
const MUTED = "#777777";
const FONT = "font-family=\"Helvetica, Arial, sans-serif\"";

function finiteExtent(series: SvgSeries[], pick: "x" | "y"): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const sv of series) {
    const arr = pick === "x" ? sv.x : sv.y;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (Number.isFinite(v)) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

/** Smallest positive x across the series (log-axis floor). */
function minPositiveX(series: SvgSeries[]): number | null {
  let lo = Infinity;
  for (const sv of series) {
    for (let i = 0; i < sv.x.length; i++) {
      const v = sv.x[i];
      if (Number.isFinite(v) && v > 0 && v < lo) lo = v;
    }
  }
  return isFinite(lo) ? lo : null;
}

/**
 * Render a tile view-model as a standalone SVG document. Null when no
 * series carries a finite point (nothing to draw — the caller toasts, the
 * same contract as composeTileImage).
 */
export function renderTileSvg(spec: SvgSpec): string | null {
  const series = spec.series.filter((sv) => sv.x.length > 0 && sv.y.length > 0);
  const xExt = finiteExtent(series, "x");
  const yExt = finiteExtent(series, "y");
  if (!xExt || !yExt) return null;

  /* -- domains -------------------------------------------------------- */
  let [x0, x1] = xExt;
  if (spec.xLog) {
    const floor = minPositiveX(series);
    if (floor === null) return null; // log axis with no positive x at all
    x0 = Math.max(x0, floor);
  }
  if (x1 <= x0) x1 = x0 + (Math.abs(x0) || 1) * 0.01; // single-point pad

  let [y0, y1] = spec.yDomain ?? yExt;
  if (!spec.yDomain) {
    if (spec.ySymmetric) {
      const m = Math.max(Math.abs(y0), Math.abs(y1)) || 1;
      y0 = -m * 1.1;
      y1 = m * 1.1;
    } else {
      const pad = (y1 - y0 || Math.abs(y1) || 1) * 0.05;
      y0 -= pad;
      y1 += pad;
    }
  }

  /* -- scales --------------------------------------------------------- */
  const lx0 = spec.xLog ? Math.log10(x0) : x0;
  const lx1 = spec.xLog ? Math.log10(x1) : x1;
  const px = (v: number): number =>
    PLOT_X + (((spec.xLog ? Math.log10(v) : v) - lx0) / (lx1 - lx0)) * PLOT_W;
  const plotY = 56; // title + legend band
  const py = (v: number): number => plotY + (1 - (v - y0) / (y1 - y0)) * PLOT_H;

  /* -- ticks ---------------------------------------------------------- */
  const xTicks = (spec.xLog ? logTicks(x0, x1) : linTicks(x0, x1)).filter(
    (v) => v >= x0 - 1e-12 && v <= x1 + 1e-12
  );
  const yTicks = linTicks(y0, y1);
  const fx = spec.xFormat ?? fmtTick;

  const xLabelBand = 30;
  const footerBand = spec.footer.length * 14 + 10;
  const H = plotY + PLOT_H + xLabelBand + footerBand;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`
  );
  parts.push(
    `<metadata>${xmlEscape(spec.provenance.join("\n"))}</metadata>`,
    `<desc>${xmlEscape(spec.title)} — qa40x-rs data export</desc>`,
    `<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`
  );

  /* -- title + legend -------------------------------------------------- */
  parts.push(
    `<text x="${PLOT_X}" y="20" ${FONT} font-size="14" fill="${INK}">${xmlEscape(spec.title)}</text>`
  );
  let lx = PLOT_X;
  for (const sv of series) {
    parts.push(
      `<rect x="${lx}" y="32" width="10" height="10" fill="${sv.color}"/>`,
      `<text x="${lx + 14}" y="41" ${FONT} font-size="11" fill="${INK}">${xmlEscape(sv.label)}</text>`
    );
    lx += 14 + 7 * sv.label.length + 22; // coarse advance; overflow is benign
  }

  /* -- grid + ticks ---------------------------------------------------- */
  for (const v of xTicks) {
    const x = r2(px(v));
    parts.push(
      `<line x1="${x}" y1="${plotY}" x2="${x}" y2="${plotY + PLOT_H}" stroke="${GRID}" stroke-width="1"/>`,
      `<text x="${x}" y="${plotY + PLOT_H + 16}" ${FONT} font-size="10" fill="${MUTED}" text-anchor="middle">${xmlEscape(fx(v))}</text>`
    );
  }
  for (const v of yTicks) {
    const y = r2(py(v));
    parts.push(
      `<line x1="${PLOT_X}" y1="${y}" x2="${PLOT_X + PLOT_W}" y2="${y}" stroke="${GRID}" stroke-width="1"/>`,
      `<text x="${PLOT_X - 6}" y="${Number(y) + 3}" ${FONT} font-size="10" fill="${MUTED}" text-anchor="end">${xmlEscape(fmtTick(v))}</text>`
    );
  }
  // Axis unit labels: y at the top-left of the plot, x at the bottom-right.
  parts.push(
    `<text x="${PLOT_X + 4}" y="${plotY + 12}" ${FONT} font-size="10" fill="${MUTED}">${xmlEscape(spec.unitLabel)}</text>`,
    `<text x="${PLOT_X + PLOT_W}" y="${plotY + PLOT_H + 16}" ${FONT} font-size="10" fill="${MUTED}" text-anchor="end">${xmlEscape(spec.xUnitLabel)}</text>`,
    `<rect x="${PLOT_X}" y="${plotY}" width="${PLOT_W}" height="${PLOT_H}" fill="none" stroke="${INK}" stroke-width="1"/>`
  );

  /* -- curves (clipped to the plot) ------------------------------------ */
  parts.push(
    `<clipPath id="plot"><rect x="${PLOT_X}" y="${plotY}" width="${PLOT_W}" height="${PLOT_H}"/></clipPath>`,
    `<g clip-path="url(#plot)">`
  );
  for (const sv of series) {
    const d: string[] = [];
    let pen = false;
    const n = Math.min(sv.x.length, sv.y.length);
    for (let i = 0; i < n; i++) {
      const xv = sv.x[i];
      const yv = sv.y[i];
      // A non-finite sample (silence at -∞ dB) or a sub-floor log-x point
      // lifts the pen — a gap, never a bridged line.
      if (!Number.isFinite(xv) || !Number.isFinite(yv) || (spec.xLog && xv <= 0)) {
        pen = false;
        continue;
      }
      d.push(`${pen ? "L" : "M"}${r2(px(xv))} ${r2(py(yv))}`);
      pen = true;
    }
    if (d.length > 0) {
      parts.push(
        `<path d="${d.join(" ")}" fill="none" stroke="${sv.color}" stroke-width="1.5" stroke-linejoin="round"/>`
      );
    }
  }
  parts.push(`</g>`);

  /* -- footer ---------------------------------------------------------- */
  spec.footer.forEach((line, i) => {
    parts.push(
      `<text x="${PLOT_X}" y="${plotY + PLOT_H + xLabelBand + 14 * (i + 1) - 4}" ${FONT} font-size="9" fill="${MUTED}">${xmlEscape(line)}</text>`
    );
  });

  parts.push(`</svg>`);
  return parts.join("\n") + "\n";
}

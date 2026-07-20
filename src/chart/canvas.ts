/**
 * Canvas chart module for the QA40x controller.
 *
 * Vanilla 2D-canvas charts with:
 *  - devicePixelRatio-aware rendering (crisp on retina, re-renders on DPR change)
 *  - ResizeObserver-driven relayout, redrawing from retained data
 *  - a cached static layer so overlay interaction (crosshair, markers) is cheap
 *  - keyboard-accessible cursor (arrow keys) mirroring the hover readout
 *
 * The frequency-response and spectrum charts extend InteractiveLogChart, which
 * layers on wheel/box zoom, pan, reset, and up-to-two draggable data markers.
 * All interaction state (viewport, markers) survives resize and DPR changes
 * because it is stored in data units, not pixels.
 */

import { readCssVars, onThemeChange, offThemeChange, hexToRgba } from "./theme";

/* ------------------------------------------------------------------ */
/* Theme — mirrors the CSS custom properties in styles.css. The canvas   */
/* can't read CSS, so `refreshChartTheme` pulls the tokens into `T` and   */
/* re-runs on every theme change (charts repaint via onThemeChange).     */
/* Values below are the dark defaults / fallbacks.                       */
/* ------------------------------------------------------------------ */

const T = {
  surface: "#0f141a",
  plotFill: "rgba(120, 170, 220, 0.022)",
  gridMinor: "#19222b",
  gridMajor: "#232f39",
  axis: "#33414d",
  zeroLine: "#3c4b58",
  ink: "#e8edf1",
  inkSecondary: "#a7b1ba",
  inkMuted: "#6f7e8b",
  seriesLeft: "#3987e5",
  seriesRight: "#199e70",
  phase: "#9085e9",
  lowConf: "rgba(167, 177, 186, 0.42)",
  crosshair: "rgba(232, 237, 241, 0.28)",
  markerA: "#e6a23c",
  markerB: "#e06ca6",
  markerLine: "rgba(232, 237, 241, 0.45)",
  readoutBg: "rgba(11, 15, 20, 0.95)",
  readoutBorder: "rgba(255, 255, 255, 0.13)",
  chipInk: "#0f141a",
  shadow: "rgba(0, 0, 0, 0.5)",
  peakHold: "rgba(214, 146, 17, 0.85)",
};

function refreshChartTheme(): void {
  const v = readCssVars();
  T.surface = v("--chart-surface", T.surface);
  T.plotFill = v("--chart-plot-fill", T.plotFill);
  T.gridMinor = v("--chart-grid-minor", T.gridMinor);
  T.gridMajor = v("--chart-grid-major", T.gridMajor);
  T.axis = v("--chart-axis", T.axis);
  T.zeroLine = v("--chart-zero-line", T.zeroLine);
  T.ink = v("--chart-ink", T.ink);
  T.inkSecondary = v("--chart-ink-secondary", T.inkSecondary);
  T.inkMuted = v("--chart-ink-muted", T.inkMuted);
  T.seriesLeft = v("--series-l", T.seriesLeft);
  T.seriesRight = v("--series-r", T.seriesRight);
  T.phase = v("--series-phase", T.phase);
  T.lowConf = v("--chart-low-conf", T.lowConf);
  T.crosshair = v("--chart-crosshair", T.crosshair);
  T.markerA = v("--marker-a", T.markerA);
  T.markerB = v("--marker-b", T.markerB);
  T.markerLine = v("--chart-marker-line", T.markerLine);
  T.readoutBg = v("--chart-readout-bg", T.readoutBg);
  T.readoutBorder = v("--chart-readout-border", T.readoutBorder);
  T.chipInk = v("--chart-chip-ink", T.chipInk);
  T.shadow = v("--chart-shadow", T.shadow);
  T.peakHold = v("--chart-peak-hold", T.peakHold);
}

refreshChartTheme();
onThemeChange(refreshChartTheme);

const MONO = 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace';
const TICK_FONT = `10px ${MONO}`;
const READOUT_FONT = `11px ${MONO}`;

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

export function formatHz(f: number): string {
  if (!isFinite(f)) return "--";
  if (f >= 1000) {
    const k = f / 1000;
    return `${k >= 100 ? k.toFixed(1) : k >= 10 ? k.toFixed(2) : k.toFixed(3)} kHz`;
  }
  return `${f >= 100 ? f.toFixed(1) : f.toFixed(2)} Hz`;
}

/** Short tick label: 20, 100, 1k, 20k */
function tickHz(f: number): string {
  if (f >= 1000) {
    const k = f / 1000;
    return Number.isInteger(k) ? `${k}k` : `${k}k`;
  }
  return `${f}`;
}

/* ------------------------------------------------------------------ */
/* Frequency axis scale                                                */
/* ------------------------------------------------------------------ */

/** Frequency-axis scale for the spectrum chart. */
export type XScale = "log" | "linear";

/** 1-2-5 tick step covering `range` with roughly `target` divisions. */
function niceStep(range: number, target: number): number {
  const raw = Math.abs(range) / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  for (const m of [1, 2, 5, 10]) {
    if (raw <= m * mag * 1.0001) return m * mag;
  }
  return 10 * mag;
}

interface LogTick {
  value: number;
  major: boolean; // 1/2/5 per decade get labels, the rest are minor grid
}

function logTicks(min: number, max: number): LogTick[] {
  const out: LogTick[] = [];
  const e0 = Math.floor(Math.log10(min));
  const e1 = Math.ceil(Math.log10(max));
  for (let e = e0; e <= e1; e++) {
    const base = Math.pow(10, e);
    for (let m = 1; m < 10; m++) {
      const v = m * base;
      if (v < min * 0.9995 || v > max * 1.0005) continue;
      out.push({ value: v, major: m === 1 || m === 2 || m === 5 });
    }
  }
  return out;
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Binary search: index of the sorted-array element nearest to `v`. */
function nearestIndex(sorted: number[], v: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  if (hi < 0) return -1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < v) lo = mid;
    else hi = mid;
  }
  return Math.abs(sorted[lo] - v) <= Math.abs(sorted[hi] - v) ? lo : hi;
}

/** Interval in octaves between two frequencies. */
function octaves(fa: number, fb: number): number {
  if (fa <= 0 || fb <= 0) return NaN;
  return Math.log2(fb / fa);
}

/**
 * Whether two frequency vectors span the same extent (same length and matching
 * end points within 0.1%). Used to decide if a new measurement should refit the
 * view (different sweep range) or preserve the current zoom/pan (a redraw of the
 * same range).
 */
function sameFrequencyExtent(a: number[], b: number[]): boolean {
  if (a.length < 2 || b.length < 2 || a.length !== b.length) return false;
  const close = (x: number, y: number): boolean =>
    Math.abs(x - y) <= Math.max(1e-6, Math.abs(x) * 1e-3);
  return close(a[0], b[0]) && close(a[a.length - 1], b[b.length - 1]);
}

/**
 * Stroke a dense series as a polyline, min/max-bucketed per pixel column so
 * peaks survive decimation. `xAt` must be monotonically non-decreasing.
 */
/**
 * Append a series polyline to the CURRENT path, decimated to a min/max pair
 * per pixel column when the series is denser than the plot. The decimation
 * matters for fills as much as strokes: a filled polygon keeps every vertex
 * in the rasterizer's scanline edge lists, and a 16k-point spectrum bunched
 * on the right of a log axis makes software rasterization take SECONDS per
 * frame (measured on the M3 grid) — where the per-column path is ~2k
 * vertices and indistinguishable within a pixel.
 */
function traceSeriesPath(
  ctx: CanvasRenderingContext2D,
  n: number,
  xAt: (i: number) => number,
  yAt: (i: number) => number,
  plotWidth: number,
  moveToFirst: boolean
): void {
  const first = (x: number, y: number): void => {
    if (moveToFirst) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  };
  if (n <= plotWidth * 1.5) {
    first(xAt(0), yAt(0));
    for (let i = 1; i < n; i++) ctx.lineTo(xAt(i), yAt(i));
  } else {
    let col = Math.round(xAt(0));
    let min = yAt(0);
    let max = min;
    first(xAt(0), min);
    for (let i = 1; i < n; i++) {
      const x = Math.round(xAt(i));
      const y = yAt(i);
      if (x === col) {
        if (y < min) min = y;
        else if (y > max) max = y;
      } else {
        ctx.lineTo(col, min);
        ctx.lineTo(col, max);
        col = x;
        min = y;
        max = y;
      }
    }
    ctx.lineTo(col, min);
    ctx.lineTo(col, max);
  }
}

function strokeSeries(
  ctx: CanvasRenderingContext2D,
  n: number,
  xAt: (i: number) => number,
  yAt: (i: number) => number,
  plotWidth: number
): void {
  if (n === 0) return;
  ctx.beginPath();
  traceSeriesPath(ctx, n, xAt, yAt, plotWidth, true);
  ctx.stroke();
}

/** Series marker: filled dot with a 2px surface ring so it reads over lines. */
function drawDot(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, r = 4): void {
  ctx.beginPath();
  ctx.arc(x, y, r + 2, 0, Math.PI * 2);
  ctx.fillStyle = T.surface;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

interface ReadoutRow {
  key?: string; // series color for the short line-key
  label: string;
  value: string;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Cursor readout box. Values lead (strong ink), labels follow (secondary). */
function drawReadout(
  ctx: CanvasRenderingContext2D,
  anchorX: number,
  anchorY: number,
  plot: Rect,
  title: string,
  rows: ReadoutRow[]
): void {
  ctx.font = READOUT_FONT;
  const padX = 10;
  const rowH = 16;
  const keyW = 14; // 10px stroke + 4px gap
  let width = ctx.measureText(title).width;
  for (const r of rows) {
    const w = (r.key ? keyW : 0) + ctx.measureText(`${r.label}  `).width + ctx.measureText(r.value).width;
    if (w > width) width = w;
  }
  const boxW = Math.ceil(width) + padX * 2;
  const boxH = 10 + rowH * (rows.length + 1);

  let bx = anchorX + 14;
  if (bx + boxW > plot.x + plot.w - 2) bx = anchorX - 14 - boxW;
  let by = anchorY - boxH / 2;
  by = Math.max(plot.y + 2, Math.min(by, plot.y + plot.h - boxH - 2));

  ctx.save();
  ctx.shadowColor = T.shadow;
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 3;
  ctx.fillStyle = T.readoutBg;
  roundRectPath(ctx, bx, by, boxW, boxH, 6);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = T.readoutBorder;
  ctx.lineWidth = 1;
  roundRectPath(ctx, bx, by, boxW, boxH, 6);
  ctx.stroke();

  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  let ty = by + 8 + rowH / 2;
  ctx.fillStyle = T.inkSecondary;
  ctx.fillText(title, bx + padX, ty);
  for (const r of rows) {
    ty += rowH;
    let tx = bx + padX;
    if (r.key) {
      ctx.strokeStyle = r.key;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx + 10, ty);
      ctx.stroke();
      tx += keyW;
    }
    ctx.fillStyle = T.inkSecondary;
    ctx.fillText(r.label, tx, ty);
    ctx.fillStyle = T.ink;
    ctx.textAlign = "right";
    ctx.fillText(r.value, bx + boxW - padX, ty);
    ctx.textAlign = "left";
  }
}

/* ------------------------------------------------------------------ */
/* Base chart                                                          */
/* ------------------------------------------------------------------ */

abstract class BaseChart {
  protected readonly container: HTMLElement;
  protected readonly canvas: HTMLCanvasElement;
  protected readonly ctx: CanvasRenderingContext2D;
  protected w = 0; // CSS px
  protected h = 0;
  protected emptyMessage: string;
  protected cursorIndex = -1;

  private readonly staticLayer: HTMLCanvasElement;
  private readonly ro: ResizeObserver;
  private dprQuery: MediaQueryList | null = null;
  private readonly onDprChange = (): void => this.resize();
  /** Repaint with the refreshed palette when the theme toggles. */
  private readonly onThemeChanged = (): void => this.render();

  constructor(container: HTMLElement, emptyMessage: string) {
    this.container = container;
    this.emptyMessage = emptyMessage;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "chart-canvas";
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute("role", "img");
    container.appendChild(this.canvas);
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    this.ctx = ctx;
    this.staticLayer = document.createElement("canvas");

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    onThemeChange(this.onThemeChanged);

    this.canvas.addEventListener("pointermove", (e) => this.onPointerMove(e));
    this.canvas.addEventListener("pointerleave", () => this.onPointerLeave());
    this.canvas.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.canvas.addEventListener("blur", () => this.setCursor(-1));

    // No synchronous resize here: subclass fields are not yet initialized
    // during super(); the ResizeObserver delivers an initial callback.
  }

  destroy(): void {
    this.ro.disconnect();
    this.dprQuery?.removeEventListener("change", this.onDprChange);
    offThemeChange(this.onThemeChanged);
    this.canvas.remove();
  }

  /** Re-render the retained data (call after setData or option changes). */
  protected render(): void {
    const dpr = window.devicePixelRatio || 1;
    this.staticLayer.width = this.canvas.width;
    this.staticLayer.height = this.canvas.height;
    const sctx = this.staticLayer.getContext("2d");
    if (!sctx) return;
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sctx.clearRect(0, 0, this.w, this.h);
    if (this.hasData()) {
      this.drawStatic(sctx);
    } else {
      this.drawEmpty(sctx);
    }
    this.cursorIndex = -1;
    this.blit();
  }

  protected blit(overlay?: (ctx: CanvasRenderingContext2D) => void): void {
    const { ctx, canvas } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(this.staticLayer, 0, 0);
    if (overlay) {
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      overlay(ctx);
    }
  }

  protected setCursor(index: number): void {
    if (index === this.cursorIndex) return;
    this.cursorIndex = index;
    if (index < 0 || !this.hasData()) {
      this.blit();
    } else {
      this.blit((ctx) => this.drawCursor(ctx, index));
    }
  }

  protected onPointerLeave(): void {
    this.setCursor(-1);
  }

  /**
   * Force a re-measure and redraw. Used when a chart that was hidden
   * (display:none, so it had no measurable size) becomes visible again.
   */
  relayout(): void {
    this.resize();
  }

  protected resize(): void {
    const rect = this.container.getBoundingClientRect();
    const w = Math.max(40, Math.floor(rect.width));
    const h = Math.max(40, Math.floor(rect.height));
    const dpr = window.devicePixelRatio || 1;
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.watchDpr();
    this.render();
  }

  private watchDpr(): void {
    this.dprQuery?.removeEventListener("change", this.onDprChange);
    this.dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    this.dprQuery.addEventListener("change", this.onDprChange, { once: true });
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (!this.hasData()) return;
    const n = this.dataLength();
    if (n === 0) return;
    let next = this.cursorIndex;
    const step = e.shiftKey ? Math.max(1, Math.round(n / 50)) : 1;
    switch (e.key) {
      case "ArrowRight":
        next = this.cursorIndex < 0 ? 0 : Math.min(n - 1, this.cursorIndex + step);
        break;
      case "ArrowLeft":
        next = this.cursorIndex < 0 ? n - 1 : Math.max(0, this.cursorIndex - step);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = n - 1;
        break;
      case "Escape":
        next = -1;
        break;
      default:
        return;
    }
    e.preventDefault();
    this.setCursor(next);
  }

  private drawEmpty(ctx: CanvasRenderingContext2D): void {
    ctx.font = `12px ${MONO}`;
    ctx.fillStyle = T.inkMuted;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(this.emptyMessage, this.w / 2, this.h / 2);
  }

  protected abstract hasData(): boolean;
  protected abstract dataLength(): number;
  protected abstract drawStatic(ctx: CanvasRenderingContext2D): void;
  protected abstract drawCursor(ctx: CanvasRenderingContext2D, index: number): void;
  protected abstract onPointerMove(e: PointerEvent): void;
}

/* ------------------------------------------------------------------ */
/* Shared axis painters                                                */
/* ------------------------------------------------------------------ */

function drawPlotBackdrop(ctx: CanvasRenderingContext2D, plot: Rect): void {
  ctx.fillStyle = T.plotFill;
  ctx.fillRect(plot.x, plot.y, plot.w, plot.h);
}

function drawLogXAxis(
  ctx: CanvasRenderingContext2D,
  plot: Rect,
  fMin: number,
  fMax: number,
  xOf: (f: number) => number
): void {
  const ticks = logTicks(fMin, fMax);
  ctx.lineWidth = 1;
  for (const t of ticks) {
    const x = Math.round(xOf(t.value)) + 0.5;
    if (x < plot.x - 0.5 || x > plot.x + plot.w + 0.5) continue;
    ctx.strokeStyle = t.major ? T.gridMajor : T.gridMinor;
    ctx.beginPath();
    ctx.moveTo(x, plot.y);
    ctx.lineTo(x, plot.y + plot.h);
    ctx.stroke();
  }
  // Labels on major ticks, skipping any that would collide.
  ctx.font = TICK_FONT;
  ctx.fillStyle = T.inkMuted;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  let lastRight = -Infinity;
  for (const t of ticks) {
    if (!t.major) continue;
    const x = xOf(t.value);
    if (x < plot.x - 2 || x > plot.x + plot.w + 2) continue;
    const label = tickHz(t.value);
    const half = ctx.measureText(label).width / 2;
    // Clamp edge labels into the plot span instead of dropping them.
    const cx = Math.max(plot.x + half - 6, Math.min(plot.x + plot.w - half + 6, x));
    if (cx - half < lastRight + 8) continue;
    ctx.fillText(label, cx, plot.y + plot.h + 7);
    lastRight = cx + half;
  }
}

function drawLinXAxis(
  ctx: CanvasRenderingContext2D,
  plot: Rect,
  fMin: number,
  fMax: number,
  xOf: (f: number) => number
): void {
  const step = niceStep(fMax - fMin, 8);
  ctx.lineWidth = 1;
  const start = Math.ceil(fMin / step) * step;
  ctx.strokeStyle = T.gridMajor;
  for (let v = start; v <= fMax + step * 0.01; v += step) {
    const x = Math.round(xOf(v)) + 0.5;
    if (x < plot.x - 0.5 || x > plot.x + plot.w + 0.5) continue;
    ctx.beginPath();
    ctx.moveTo(x, plot.y);
    ctx.lineTo(x, plot.y + plot.h);
    ctx.stroke();
  }
  ctx.font = TICK_FONT;
  ctx.fillStyle = T.inkMuted;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  let lastRight = -Infinity;
  for (let v = start; v <= fMax + step * 0.01; v += step) {
    const x = xOf(v);
    if (x < plot.x - 2 || x > plot.x + plot.w + 2) continue;
    const label = v >= 1000 && Number.isInteger(v / 1000) ? `${v / 1000}k` : tickHz(Math.round(v));
    const half = ctx.measureText(label).width / 2;
    const cx = Math.max(plot.x + half - 6, Math.min(plot.x + plot.w - half + 6, x));
    if (cx - half < lastRight + 8) continue;
    ctx.fillText(label, cx, plot.y + plot.h + 7);
    lastRight = cx + half;
  }
}

function drawDbYAxis(
  ctx: CanvasRenderingContext2D,
  plot: Rect,
  yMin: number,
  yMax: number,
  step: number,
  yOf: (v: number) => number,
  unit: string,
  // Gridlines are drawn across the whole range, but values above `labelMax` get
  // no numeric label — so a pinned axis can keep headroom at the top without the
  // +20 / 0 labels.
  labelMax?: number
): void {
  ctx.font = TICK_FONT;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const start = Math.ceil(yMin / step) * step;
  for (let v = start; v <= yMax + step * 0.01; v += step) {
    const y = Math.round(yOf(v)) + 0.5;
    if (y < plot.y - 0.5 || y > plot.y + plot.h + 0.5) continue;
    ctx.strokeStyle = Math.abs(v) < step * 0.01 ? T.zeroLine : T.gridMajor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.w, y);
    ctx.stroke();
    if (labelMax === undefined || v <= labelMax + step * 0.01) {
      ctx.fillStyle = T.inkMuted;
      ctx.fillText(String(Math.round(v * 10) / 10), plot.x - 8, y);
    }
  }
  // Unit tag, top-left corner of the plot.
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = T.inkMuted;
  ctx.fillText(unit, plot.x + 7, plot.y + 6);
}

function drawFrame(ctx: CanvasRenderingContext2D, plot: Rect): void {
  ctx.strokeStyle = T.axis;
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(plot.x) + 0.5, Math.round(plot.y) + 0.5, Math.round(plot.w) - 1, Math.round(plot.h) - 1);
}

/* ------------------------------------------------------------------ */
/* Interactive log-frequency chart (zoom / pan / markers)              */
/* ------------------------------------------------------------------ */

type DragMode = "idle" | "box" | "pan" | "marker";

interface MarkerReadout {
  freq: number;
  valueDb: number;
  valueText: string;
  extraText?: string;
}

/**
 * A chart with a logarithmic frequency X axis and a linear (dB) Y axis, plus a
 * full interaction stack. Subclasses own the data and drawing; this class owns
 * the viewport, the pointer state machine, and the marker overlay/panel.
 *
 * Interaction model (also surfaced as an on-chart hint):
 *   alt + wheel        zoom frequency at cursor (plain wheel scrolls the page)
 *   alt + shift + wheel  zoom level (dB) at cursor
 *   drag             box-zoom to the swept rectangle
 *   shift/space/mid  pan (when zoomed)
 *   click            drop / move a marker (max 2, snap to data)
 *   drag a marker    move it along frequency
 *   right-click      remove the marker under the cursor
 *   double-click     reset to full view
 */
abstract class InteractiveLogChart extends BaseChart {
  // Effective ranges — recomputed each drawStatic via applyViewport(). Named
  // "log*" for history, but they hold *axis units*: log10(Hz) in log mode and
  // raw Hz in linear mode. `fwd`/`inv` convert between Hz and axis units, so the
  // whole zoom/pan/marker machinery is scale-agnostic.
  protected xScale: XScale = "log";
  protected plot: Rect = { x: 0, y: 0, w: 0, h: 0 };
  protected logMin = 1;
  protected logMax = 4;
  protected yMin = -80;
  protected yMax = 20;

  // Full data extents captured each drawStatic (before viewport override).
  protected fullLogMin = 1;
  protected fullLogMax = 4;
  protected fullYMin = -80;
  protected fullYMax = 20;

  // Last axis-limits config applied, so re-applying the SAME config (e.g. every
  // live frame) is a no-op and never stomps the user's interactive zoom/pan.
  private lastLimitsSig: string | null = null;
  // Viewport overrides (null → use the full/auto extent).
  protected viewLog: [number, number] | null = null;
  protected viewY: [number, number] | null = null;

  // Markers: data indices, at most two.
  protected markers: number[] = [];

  private mode: DragMode = "idle";
  private downX = 0;
  private downY = 0;
  private curX = 0;
  private curY = 0;
  private moved = false;
  /** True while the pointer is over the plot — lets a live refresh re-derive
   * the hover cursor instead of losing the readout every frame. */
  private hovering = false;
  private dragSlot = -1;
  private panLog: [number, number] = [0, 0];
  private panYv: [number, number] = [0, 0];
  private spaceDown = false;
  private pointerId = -1;

  private readonly controls: HTMLDivElement;
  private readonly resetBtn: HTMLButtonElement;
  private readonly clearBtn: HTMLButtonElement;
  private readonly readoutPanel: HTMLDivElement;

  constructor(container: HTMLElement, emptyMessage: string) {
    super(container, emptyMessage);

    // Floating controls: reset zoom + clear markers (shown contextually).
    this.controls = document.createElement("div");
    this.controls.className = "chart-controls";
    this.resetBtn = document.createElement("button");
    this.resetBtn.type = "button";
    this.resetBtn.className = "chart-ctl";
    this.resetBtn.textContent = "Reset zoom";
    this.resetBtn.title = "Reset to full view (double-click chart)";
    this.resetBtn.addEventListener("click", () => this.resetView());
    this.clearBtn = document.createElement("button");
    this.clearBtn.type = "button";
    this.clearBtn.className = "chart-ctl";
    this.clearBtn.textContent = "Clear markers";
    this.clearBtn.addEventListener("click", () => this.clearMarkers());
    this.controls.append(this.resetBtn, this.clearBtn);
    container.appendChild(this.controls);

    // Marker readout panel (A / B / delta).
    this.readoutPanel = document.createElement("div");
    this.readoutPanel.className = "chart-markers";
    this.readoutPanel.hidden = true;
    container.appendChild(this.readoutPanel);

    // Interaction hint, faint until first hover.
    const hint = document.createElement("div");
    hint.className = "chart-hint";
    hint.innerHTML =
      '<span>⌥ scroll</span> zoom · <span>⌥⇧ scroll</span> level · ' +
      '<span>drag</span> box · <span>⇧ drag</span> pan · ' +
      '<span>click</span> marker · <span>dbl-click</span> reset';
    container.appendChild(hint);

    this.canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.canvas.addEventListener("pointerup", (e) => this.onPointerUp(e));
    this.canvas.addEventListener("dblclick", () => this.resetView());
    this.canvas.addEventListener("contextmenu", (e) => this.onContextMenu(e));
    this.canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener("keydown", (e) => this.onSpaceKey(e, true));
    this.canvas.addEventListener("keyup", (e) => this.onSpaceKey(e, false));
  }

  /* ------- public/programmatic control (also used for tests) ------- */

  resetView(): void {
    if (!this.viewLog && !this.viewY) return;
    this.viewLog = null;
    this.viewY = null;
    this.render();
  }

  /**
   * Fix the visible ranges from a config (dashboard gear "Axis limits"): a side
   * is pinned only when autoscale is explicitly off and min/max are a valid pair;
   * otherwise it auto-ranges. Sets state only — the caller renders (e.g. setData).
   */
  applyLimits(
    x: { autoscale?: boolean; min?: number; max?: number },
    y: { autoscale?: boolean; min?: number; max?: number }
  ): void {
    // Only touch the viewport when the CONFIG changes. Re-applying the same
    // limits every live frame would reset the interactive zoom/pan (they share
    // this.viewLog/viewY).
    const sig = JSON.stringify([x, y]);
    if (sig === this.lastLimitsSig) return;
    this.lastLimitsSig = sig;
    const xFixed = x.autoscale === false && x.min != null && x.max != null && x.max > x.min;
    this.viewLog = xFixed ? [this.fwd(x.min as number), this.fwd(x.max as number)] : null;
    const yFixed = y.autoscale === false && y.min != null && y.max != null && y.max > y.min;
    this.viewY = yFixed ? [y.min as number, y.max as number] : null;
    this.render();
  }

  clearMarkers(): void {
    if (this.markers.length === 0) return;
    this.markers = [];
    this.updatePanels();
    this.refreshOverlay();
  }

  /** Drop markers at the given frequencies (snapped to nearest data point). */
  setMarkerFreqs(freqs: number[]): void {
    const xs = this.xValues();
    if (!xs.length) return;
    this.markers = freqs.slice(0, 2).map((f) => nearestIndex(xs, f)).filter((i) => i >= 0);
    this.updatePanels();
    this.refreshOverlay();
  }

  /** Zoom the frequency axis to [f0, f1]. */
  zoomToFreq(f0: number, f1: number): void {
    const a = this.fwd(Math.min(f0, f1));
    const b = this.fwd(Math.max(f0, f1));
    this.viewLog = [a, b];
    this.render();
  }

  /* --------------------- subclass contract ------------------------- */

  /** Sorted (ascending) frequency values used for snapping and hover. */
  protected abstract xValues(): number[];
  /** Pixel Y of the primary series at data index i (for the marker dot). */
  protected abstract markerSeriesY(i: number): number;
  /** Colour of the primary series (marker dot). */
  protected abstract seriesColor(): string;
  /** Readout content for a marker at data index i. */
  protected abstract readMarker(i: number): MarkerReadout;

  /* --------------------- viewport plumbing ------------------------- */

  /** Apply the viewport override on top of the full extents. Call in drawStatic. */
  protected applyViewport(): void {
    this.logMin = this.viewLog ? this.viewLog[0] : this.fullLogMin;
    this.logMax = this.viewLog ? this.viewLog[1] : this.fullLogMax;
    this.yMin = this.viewY ? this.viewY[0] : this.fullYMin;
    this.yMax = this.viewY ? this.viewY[1] : this.fullYMax;
  }

  /** Hz → axis units. */
  protected fwd(f: number): number {
    return this.xScale === "linear" ? f : Math.log10(f);
  }

  /** Axis units → Hz. */
  protected inv(u: number): number {
    return this.xScale === "linear" ? u : Math.pow(10, u);
  }

  protected xOf = (f: number): number =>
    this.plot.x + ((this.fwd(f) - this.logMin) / (this.logMax - this.logMin)) * this.plot.w;

  protected yOf = (db: number): number =>
    this.plot.y + this.plot.h - ((db - this.yMin) / (this.yMax - this.yMin)) * this.plot.h;

  private inPlot(x: number, y: number): boolean {
    const p = this.plot;
    return x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h;
  }

  private logAtX(px: number): number {
    return this.logMin + ((px - this.plot.x) / this.plot.w) * (this.logMax - this.logMin);
  }

  private valAtY(py: number): number {
    return this.yMin + ((this.plot.y + this.plot.h - py) / this.plot.h) * (this.yMax - this.yMin);
  }

  private nearestIndexAtX(px: number): number {
    const xs = this.xValues();
    if (!xs.length) return -1;
    return nearestIndex(xs, this.inv(this.logAtX(px)));
  }

  /* -------------------------- rendering ---------------------------- */

  protected render(): void {
    super.render();
    // Keep the hover readout alive across live refreshes: super.render() clears
    // the cursor, so re-derive it from the current pointer position.
    if (this.hovering && this.mode === "idle" && this.hasData()) {
      this.cursorIndex = this.nearestIndexAtX(this.curX);
    }
    this.updatePanels();
    this.refreshOverlay();
  }

  protected onPointerLeave(): void {
    this.hovering = false;
    if (this.mode === "idle") this.setCursor(-1);
  }

  /** Repaint the interaction overlay (markers + crosshair + drag box). */
  protected refreshOverlay(): void {
    if (!this.hasData()) {
      this.blit();
      return;
    }
    this.blit((ctx) => {
      this.drawMarkers(ctx);
      if (this.cursorIndex >= 0 && this.mode === "idle") this.drawCursor(ctx, this.cursorIndex);
      if (this.mode === "box" && this.moved) this.drawBox(ctx);
    });
  }

  protected setCursor(index: number): void {
    if (index === this.cursorIndex) return;
    this.cursorIndex = index;
    this.refreshOverlay();
  }

  private drawMarkers(ctx: CanvasRenderingContext2D): void {
    const p = this.plot;
    const xs = this.xValues();
    this.markers.forEach((idx, slot) => {
      if (idx < 0 || idx >= xs.length) return;
      const x = this.xOf(xs[idx]);
      if (x < p.x - 1 || x > p.x + p.w + 1) return;
      const color = slot === 0 ? T.markerA : T.markerB;
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, p.y);
      ctx.lineTo(Math.round(x) + 0.5, p.y + p.h);
      ctx.stroke();
      ctx.restore();

      const y = Math.max(p.y, Math.min(p.y + p.h, this.markerSeriesY(idx)));
      drawDot(ctx, x, y, color, 3.5);

      // Letter chip at the top of the marker line.
      const label = slot === 0 ? "A" : "B";
      ctx.font = `600 10px ${MONO}`;
      const cw = ctx.measureText(label).width + 8;
      let cx = x - cw / 2;
      cx = Math.max(p.x + 1, Math.min(p.x + p.w - cw - 1, cx));
      ctx.fillStyle = color;
      roundRectPath(ctx, cx, p.y + 3, cw, 14, 3);
      ctx.fill();
      ctx.fillStyle = T.chipInk;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, cx + cw / 2, p.y + 3 + 7.5);
    });
  }

  private drawBox(ctx: CanvasRenderingContext2D): void {
    const p = this.plot;
    const x0 = Math.max(p.x, Math.min(this.downX, this.curX));
    const x1 = Math.min(p.x + p.w, Math.max(this.downX, this.curX));
    const y0 = Math.max(p.y, Math.min(this.downY, this.curY));
    const y1 = Math.min(p.y + p.h, Math.max(this.downY, this.curY));
    ctx.fillStyle = hexToRgba(T.seriesLeft, 0.12);
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeStyle = hexToRgba(T.seriesLeft, 0.85);
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
    ctx.setLineDash([]);
  }

  /* ----------------------- pointer handling ------------------------ */

  protected onPointerMove(e: PointerEvent): void {
    this.curX = e.offsetX;
    this.curY = e.offsetY;
    if (Math.abs(this.curX - this.downX) > 3 || Math.abs(this.curY - this.downY) > 3) this.moved = true;

    switch (this.mode) {
      case "marker": {
        const idx = this.nearestIndexAtX(Math.max(this.plot.x, Math.min(this.plot.x + this.plot.w, this.curX)));
        if (idx >= 0 && this.markers[this.dragSlot] !== idx) {
          this.markers[this.dragSlot] = idx;
          this.updatePanels();
        }
        this.refreshOverlay();
        return;
      }
      case "pan": {
        this.doPan();
        return;
      }
      case "box": {
        this.refreshOverlay();
        return;
      }
      default: {
        this.hovering = this.inPlot(this.curX, this.curY);
        if (this.hovering) this.setCursor(this.nearestIndexAtX(this.curX));
        else this.setCursor(-1);
      }
    }
  }

  private onPointerDown(e: PointerEvent): void {
    if (!this.hasData()) return;
    const x = e.offsetX;
    const y = e.offsetY;
    if (!this.inPlot(x, y)) return;
    this.canvas.focus();
    this.downX = this.curX = x;
    this.downY = this.curY = y;
    this.moved = false;
    this.pointerId = e.pointerId;

    const wantPan = e.button === 1 || (e.button === 0 && (e.shiftKey || this.spaceDown));

    if (e.button === 0 && !wantPan) {
      const slot = this.markerSlotNear(x);
      if (slot >= 0) {
        this.mode = "marker";
        this.dragSlot = slot;
        this.canvas.setPointerCapture(e.pointerId);
        this.canvas.style.cursor = "ew-resize";
        e.preventDefault();
        return;
      }
    }

    if (wantPan) {
      if (!this.viewLog && !this.viewY) return; // nothing to pan at full view
      this.mode = "pan";
      this.panLog = [this.logMin, this.logMax];
      this.panYv = [this.yMin, this.yMax];
      this.canvas.setPointerCapture(e.pointerId);
      this.canvas.style.cursor = "grabbing";
      e.preventDefault();
      return;
    }

    if (e.button === 0) {
      this.mode = "box";
      this.canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.pointerId !== e.pointerId) return;
    const mode = this.mode;
    this.mode = "idle";
    this.canvas.style.cursor = "";
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);

    if (mode === "box") {
      if (this.moved) this.applyBoxZoom();
      else this.dropMarker(e.offsetX);
    }
    // marker / pan: nothing to finalize.
    this.refreshOverlay();
  }

  private onContextMenu(e: MouseEvent): void {
    const slot = this.markerSlotNear(e.offsetX);
    if (slot >= 0) {
      e.preventDefault();
      this.markers.splice(slot, 1);
      this.updatePanels();
      this.refreshOverlay();
    }
  }

  private onWheel(e: WheelEvent): void {
    // Zoom only while the Option/Alt key is held, so plain wheel scrolls the
    // page instead of accidentally zooming. Alt = zoom X (frequency),
    // Alt+Shift = zoom Y (dB). Ctrl is avoided (macOS screen-zoom gesture).
    if (!e.altKey) return;
    if (!this.hasData() || !this.inPlot(e.offsetX, e.offsetY)) return;
    e.preventDefault();
    const factor = Math.exp((e.deltaY || 0) * 0.0016);
    if (e.shiftKey) this.zoomY(this.valAtY(e.offsetY), factor);
    else this.zoomLog(this.logAtX(e.offsetX), factor);
    this.render();
  }

  private onSpaceKey(e: KeyboardEvent, down: boolean): void {
    if (e.code !== "Space") return;
    if (down) e.preventDefault();
    this.spaceDown = down;
    if (this.mode === "idle") this.canvas.style.cursor = down ? "grab" : "";
  }

  /* --------------------------- zoom math --------------------------- */

  private zoomLog(center: number, factor: number): void {
    let a = center - (center - this.logMin) * factor;
    let b = center + (this.logMax - center) * factor;
    const fa = this.fullLogMin;
    const fb = this.fullLogMax;
    if (b - a >= fb - fa - 1e-9) {
      this.viewLog = null;
      return;
    }
    if (a < fa) {
      b += fa - a;
      a = fa;
    }
    if (b > fb) {
      a -= b - fb;
      b = fb;
    }
    this.viewLog = [Math.max(fa, a), Math.min(fb, b)];
  }

  private zoomY(center: number, factor: number): void {
    let a = center - (center - this.yMin) * factor;
    let b = center + (this.yMax - center) * factor;
    const fa = this.fullYMin;
    const fb = this.fullYMax;
    if (b - a >= fb - fa - 1e-9) {
      this.viewY = null;
      return;
    }
    if (a < fa) {
      b += fa - a;
      a = fa;
    }
    if (b > fb) {
      a -= b - fb;
      b = fb;
    }
    this.viewY = [Math.max(fa, a), Math.min(fb, b)];
  }

  private applyBoxZoom(): void {
    const p = this.plot;
    const x0 = Math.max(p.x, Math.min(this.downX, this.curX));
    const x1 = Math.min(p.x + p.w, Math.max(this.downX, this.curX));
    const y0 = Math.max(p.y, Math.min(this.downY, this.curY));
    const y1 = Math.min(p.y + p.h, Math.max(this.downY, this.curY));
    if (x1 - x0 >= 6) {
      const a = this.logAtX(x0);
      const b = this.logAtX(x1);
      this.viewLog = [Math.max(this.fullLogMin, a), Math.min(this.fullLogMax, b)];
    }
    if (y1 - y0 >= 6) {
      const hi = this.valAtY(y0);
      const lo = this.valAtY(y1);
      this.viewY = [Math.max(this.fullYMin, lo), Math.min(this.fullYMax, hi)];
    }
    this.render();
  }

  private doPan(): void {
    const p = this.plot;
    // Frequency (log) pan.
    const dLog = ((this.curX - this.downX) / p.w) * (this.panLog[1] - this.panLog[0]);
    let a = this.panLog[0] - dLog;
    let b = this.panLog[1] - dLog;
    const fa = this.fullLogMin;
    const fb = this.fullLogMax;
    if (a < fa) {
      b += fa - a;
      a = fa;
    }
    if (b > fb) {
      a -= b - fb;
      b = fb;
    }
    this.viewLog = b - a >= fb - fa - 1e-9 ? null : [Math.max(fa, a), Math.min(fb, b)];

    // Level (dB) pan — only when the Y axis is actually zoomed.
    if (this.viewY) {
      const dVal = ((this.curY - this.downY) / p.h) * (this.panYv[1] - this.panYv[0]);
      let c = this.panYv[0] + dVal;
      let d = this.panYv[1] + dVal;
      const ga = this.fullYMin;
      const gb = this.fullYMax;
      if (c < ga) {
        d += ga - c;
        c = ga;
      }
      if (d > gb) {
        c -= d - gb;
        d = gb;
      }
      this.viewY = d - c >= gb - ga - 1e-9 ? null : [Math.max(ga, c), Math.min(gb, d)];
    }
    this.render();
  }

  /* --------------------------- markers ----------------------------- */

  private markerSlotNear(px: number): number {
    const xs = this.xValues();
    for (let slot = 0; slot < this.markers.length; slot++) {
      const idx = this.markers[slot];
      if (idx < 0 || idx >= xs.length) continue;
      if (Math.abs(this.xOf(xs[idx]) - px) <= 7) return slot;
    }
    return -1;
  }

  private dropMarker(px: number): void {
    const idx = this.nearestIndexAtX(px);
    if (idx < 0) return;
    if (this.markers.length < 2) {
      this.markers.push(idx);
    } else {
      // Move whichever marker is nearer in pixels.
      const xs = this.xValues();
      const d0 = Math.abs(this.xOf(xs[this.markers[0]]) - px);
      const d1 = Math.abs(this.xOf(xs[this.markers[1]]) - px);
      this.markers[d0 <= d1 ? 0 : 1] = idx;
    }
    this.updatePanels();
    this.refreshOverlay();
  }

  /* ------------------------- HTML panels --------------------------- */

  private updatePanels(): void {
    const zoomed = !!(this.viewLog || this.viewY);
    this.resetBtn.hidden = !zoomed;
    this.clearBtn.hidden = this.markers.length === 0;
    this.controls.hidden = !zoomed && this.markers.length === 0;

    const panel = this.readoutPanel;
    if (this.markers.length === 0 || !this.hasData()) {
      panel.hidden = true;
      panel.replaceChildren();
      return;
    }
    panel.hidden = false;
    const rows: HTMLElement[] = [];
    const reads = this.markers.map((i) => this.readMarker(i));
    reads.forEach((r, slot) => {
      const row = document.createElement("div");
      row.className = "mk-row";
      const dot = document.createElement("span");
      dot.className = "mk-dot";
      dot.style.background = slot === 0 ? T.markerA : T.markerB;
      const name = document.createElement("span");
      name.className = "mk-name";
      name.textContent = slot === 0 ? "A" : "B";
      const freq = document.createElement("span");
      freq.className = "mk-freq";
      freq.textContent = formatHz(r.freq);
      const val = document.createElement("span");
      val.className = "mk-val";
      val.textContent = r.extraText ? `${r.valueText}  ${r.extraText}` : r.valueText;
      row.append(dot, name, freq, val);
      rows.push(row);
    });
    if (reads.length === 2) {
      const d = document.createElement("div");
      d.className = "mk-row mk-delta";
      const name = document.createElement("span");
      name.className = "mk-name";
      name.textContent = "Δ";
      const freq = document.createElement("span");
      freq.className = "mk-freq";
      const oct = octaves(reads[0].freq, reads[1].freq);
      freq.textContent = `${formatHz(Math.abs(reads[1].freq - reads[0].freq))}  ${
        isFinite(oct) ? `${oct >= 0 ? "+" : ""}${oct.toFixed(2)} oct` : ""
      }`;
      const val = document.createElement("span");
      val.className = "mk-val";
      const dd = reads[1].valueDb - reads[0].valueDb;
      val.textContent = `${dd >= 0 ? "+" : ""}${dd.toFixed(2)} dB`;
      d.append(document.createElement("span"), name, freq, val);
      (d.firstChild as HTMLElement).className = "mk-dot mk-dot-empty";
      rows.push(d);
    }
    panel.replaceChildren(...rows);
  }
}

/* ------------------------------------------------------------------ */
/* Frequency response chart                                            */
/* ------------------------------------------------------------------ */

export interface FrequencyResponseData {
  frequencies: number[];
  magnitudes_db: number[];
  phases: number[]; // degrees, unwrapped, latency-compensated
  coherence: number[]; // 0..1 per point
  latency_samples: number;
}

/**
 * A saved trace overlaid on the live chart for comparison. Each carries its own
 * accessible colour (assigned from the categorical palette by the caller) and a
 * label used in the legend. Only magnitude is required; phase/coherence are
 * drawn when present and the relevant view is enabled.
 */
export interface OverlayTrace {
  label: string;
  color: string;
  frequencies: number[];
  magnitudes_db: number[];
  phases?: number[];
  coherence?: number[];
}

export type ScaleMode = "auto" | "fixed";

const COHERENCE_MIN = 0.5;

export class FrequencyResponseChart extends InteractiveLogChart {
  private data: FrequencyResponseData | null = null;
  private overlays: OverlayTrace[] = [];
  private traceColor: string = T.seriesLeft;
  private showPhase = false;
  private scaleMode: ScaleMode = "auto";
  private readonly fixedRange: [number, number] = [-80, 20];
  /** Y-axis unit caption (e.g. "dB", "%"); reflects the plotted quantity. */
  private yUnit = "dB";

  constructor(container: HTMLElement) {
    super(container, "Run a sweep to plot the response");
    this.canvas.setAttribute("aria-label", "Frequency response chart");
  }

  /** Set the Y-axis unit caption (e.g. "dB" for level/THD-dB, "%" for THD-%). */
  setYUnit(unit: string): void {
    if (unit === this.yUnit) return;
    this.yUnit = unit;
    this.render();
  }

  /**
   * Set the primary ("live") trace. Markers, crosshair, and the readout all
   * track this series. Pass `colorOverride` to paint it a comparison colour
   * (used when the primary is itself a saved measurement); otherwise it takes
   * the channel colour. Setting a primary clears any comparison overlays.
   */
  setData(data: FrequencyResponseData, inputChannel: "Left" | "Right", colorOverride?: string): void {
    // A fresh measurement over a different frequency range must refit the axes;
    // only a redraw of the *same* range preserves the user's zoom/pan/markers.
    const refit = !this.data || !sameFrequencyExtent(this.data.frequencies, data.frequencies);
    this.data = data;
    this.traceColor = colorOverride ?? (inputChannel === "Left" ? T.seriesLeft : T.seriesRight);
    this.overlays = [];
    if (refit) {
      this.viewLog = null;
      this.viewY = null;
      this.markers = [];
    }
    this.render();
  }

  /** Overlay N saved traces on top of the primary, refitting to include them. */
  setOverlays(traces: OverlayTrace[]): void {
    this.overlays = traces.slice();
    this.viewLog = null;
    this.viewY = null;
    this.render();
  }

  clearOverlays(): void {
    if (this.overlays.length === 0) return;
    this.overlays = [];
    this.viewLog = null;
    this.viewY = null;
    this.render();
  }

  hasOverlays(): boolean {
    return this.overlays.length > 0;
  }

  clearData(): void {
    this.data = null;
    this.overlays = [];
    this.markers = [];
    this.viewLog = null;
    this.viewY = null;
    this.render();
  }

  setShowPhase(v: boolean): void {
    this.showPhase = v;
    this.render();
  }

  setScaleMode(mode: ScaleMode): void {
    this.scaleMode = mode;
    this.viewY = null; // level viewport no longer meaningful across a scale change
    this.render();
  }

  getFixedRange(): [number, number] {
    return this.fixedRange;
  }

  protected hasData(): boolean {
    return this.data != null && this.data.frequencies.length > 1;
  }

  protected dataLength(): number {
    return this.data?.frequencies.length ?? 0;
  }

  protected xValues(): number[] {
    return this.data?.frequencies ?? [];
  }

  protected seriesColor(): string {
    return this.traceColor;
  }

  /** Displayed magnitude of the primary trace at index i. */
  private dispMag(i: number): number {
    return this.data!.magnitudes_db[i];
  }

  /** Displayed magnitude of an overlay trace at index i. */
  private dispOverlayMag(o: OverlayTrace, i: number): number {
    return o.magnitudes_db[i];
  }

  protected markerSeriesY(i: number): number {
    return this.yOf(this.dispMag(i));
  }

  protected readMarker(i: number): MarkerReadout {
    const d = this.data!;
    const coh = d.coherence?.[i];
    let extra = this.showPhase ? `${d.phases[i].toFixed(1)}°` : undefined;
    if (coh != null && coh < COHERENCE_MIN) extra = extra ? `${extra} · γ${coh.toFixed(2)}` : `γ${coh.toFixed(2)}`;
    const m = this.dispMag(i);
    return {
      freq: d.frequencies[i],
      valueDb: m,
      valueText: `${m.toFixed(2)} dB`,
      extraText: extra,
    };
  }

  private yPhaseOf = (deg: number): number =>
    this.plot.y + this.plot.h - ((deg + 180) / 360) * this.plot.h;

  protected drawStatic(ctx: CanvasRenderingContext2D): void {
    const d = this.data;
    if (!d) return;
    const right = this.showPhase ? 46 : 16;
    this.plot = { x: 48, y: 14, w: this.w - 48 - right, h: this.h - 14 - 32 };
    const { plot } = this;
    if (plot.w < 40 || plot.h < 40) return;

    let fMin = Math.max(1, d.frequencies[0]);
    let fMax = d.frequencies[d.frequencies.length - 1];
    for (const o of this.overlays) {
      if (o.frequencies.length) {
        fMin = Math.min(fMin, Math.max(1, o.frequencies[0]));
        fMax = Math.max(fMax, o.frequencies[o.frequencies.length - 1]);
      }
    }
    fMax = Math.max(fMin * 1.01, fMax);
    this.fullLogMin = Math.log10(fMin);
    this.fullLogMax = Math.log10(fMax);

    if (this.scaleMode === "fixed") {
      [this.fullYMin, this.fullYMax] = this.fixedRange;
    } else {
      let lo = Infinity;
      let hi = -Infinity;
      const scan = (_freqs: number[], mags: number[]): void => {
        for (let i = 0; i < mags.length; i++) {
          const m = mags[i];
          if (!isFinite(m)) continue;
          if (m < lo) lo = m;
          if (m > hi) hi = m;
        }
      };
      scan(d.frequencies, d.magnitudes_db);
      for (const o of this.overlays) scan(o.frequencies, o.magnitudes_db);
      if (!isFinite(lo)) {
        lo = -1;
        hi = 1;
      }
      const pad = Math.max((hi - lo) * 0.12, 1);
      const step0 = niceStep(hi - lo + pad * 2, 6);
      this.fullYMin = Math.floor((lo - pad) / step0) * step0;
      this.fullYMax = Math.ceil((hi + pad) / step0) * step0;
      if (this.fullYMax <= this.fullYMin) this.fullYMax = this.fullYMin + step0;
    }

    this.applyViewport();
    const step = niceStep(this.yMax - this.yMin, 6);

    drawPlotBackdrop(ctx, plot);
    drawLogXAxis(ctx, plot, Math.pow(10, this.logMin), Math.pow(10, this.logMax), this.xOf);
    drawDbYAxis(ctx, plot, this.yMin, this.yMax, step, this.yOf, this.yUnit);

    // Phase axis (right, fixed -180..180 in 90 degree steps).
    if (this.showPhase) {
      ctx.font = TICK_FONT;
      ctx.fillStyle = T.inkMuted;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      for (let deg = -180; deg <= 180; deg += 90) {
        const y = this.yPhaseOf(deg);
        ctx.fillText(`${deg}°`, plot.x + plot.w + 7, y);
      }
    }

    drawFrame(ctx, plot);

    // Traces, clipped to the plot area.
    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x, plot.y, plot.w, plot.h);
    ctx.clip();

    // Comparison overlays sit under the primary trace so it stays readable.
    this.drawOverlays(ctx);

    if (this.showPhase) {
      // The phase rides ITS curve's color, dashed (same scheme as overlay
      // phases): a fixed "phase purple" read as the wrong curve's phase
      // when a multi-curve sweep hid its purple sibling (M4 review).
      ctx.save();
      ctx.strokeStyle = this.traceColor;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.globalAlpha = 0.85;
      ctx.setLineDash([2, 3]);
      strokeSeries(
        ctx,
        d.frequencies.length,
        (i) => this.xOf(d.frequencies[i]),
        (i) => this.yPhaseOf(d.phases[i]),
        plot.w
      );
      ctx.restore();
    }

    this.drawMagnitude(ctx);
    ctx.restore();
  }

  /** Stroke each comparison overlay's magnitude (and phase, when shown). */
  private drawOverlays(ctx: CanvasRenderingContext2D): void {
    if (this.overlays.length === 0) return;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const o of this.overlays) {
      const n = o.frequencies.length;
      if (n < 2 || o.magnitudes_db.length < n) continue;
      if (this.showPhase && o.phases && o.phases.length === n) {
        ctx.save();
        ctx.strokeStyle = o.color;
        // Dashed keeps it distinct from the magnitude; 0.6 keeps it READABLE
        // (at the old 0.3 an overlay phase riding the primary's — a
        // both-channel loopback — was invisible, M4 review).
        ctx.globalAlpha = 0.6;
        ctx.lineWidth = 1.25;
        ctx.setLineDash([2, 3]);
        strokeSeries(ctx, n, (i) => this.xOf(o.frequencies[i]), (i) => this.yPhaseOf(o.phases![i]), this.plot.w);
        ctx.restore();
      }
      ctx.strokeStyle = o.color;
      ctx.globalAlpha = 0.92;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      strokeSeries(ctx, n, (i) => this.xOf(o.frequencies[i]), (i) => this.yOf(this.dispOverlayMag(o, i)), this.plot.w);
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Magnitude trace, drawn as coherence-weighted runs: confident segments are
   * solid and full strength; low-coherence segments (band edges, mostly) are
   * dashed and dimmed so the eye discounts them.
   */
  private drawMagnitude(ctx: CanvasRenderingContext2D): void {
    const d = this.data!;
    const n = d.frequencies.length;
    const coh = d.coherence ?? [];
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    const confAt = (i: number): boolean => {
      const c = coh[i];
      return c == null || c >= COHERENCE_MIN;
    };

    let i = 0;
    while (i < n - 1) {
      const conf = confAt(i) && confAt(i + 1);
      // Extend the run while consecutive segments share the confidence class.
      let j = i + 1;
      while (j < n - 1) {
        if ((confAt(j) && confAt(j + 1)) !== conf) break;
        j++;
      }
      ctx.beginPath();
      ctx.moveTo(this.xOf(d.frequencies[i]), this.yOf(this.dispMag(i)));
      for (let k = i + 1; k <= j; k++) {
        ctx.lineTo(this.xOf(d.frequencies[k]), this.yOf(this.dispMag(k)));
      }
      if (conf) {
        ctx.strokeStyle = this.traceColor;
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      } else {
        ctx.strokeStyle = T.lowConf;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.globalAlpha = 1;
      }
      ctx.stroke();
      i = j;
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  protected drawCursor(ctx: CanvasRenderingContext2D, i: number): void {
    const d = this.data;
    if (!d) return;
    const f = d.frequencies[i];
    const x = this.xOf(f);
    if (x < this.plot.x || x > this.plot.x + this.plot.w) return;
    ctx.strokeStyle = T.crosshair;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, this.plot.y);
    ctx.lineTo(x, this.plot.y + this.plot.h);
    ctx.stroke();

    const yMag = Math.max(this.plot.y, Math.min(this.plot.y + this.plot.h, this.yOf(this.dispMag(i))));
    if (this.showPhase) {
      drawDot(ctx, x, this.yPhaseOf(d.phases[i]), this.traceColor);
    }
    drawDot(ctx, x, yMag, this.traceColor);

    const rows: ReadoutRow[] = [
      { key: this.traceColor, label: "Mag", value: `${this.dispMag(i).toFixed(2)} dB` },
    ];
    if (this.showPhase) {
      rows.push({ key: this.traceColor, label: "Phase", value: `${d.phases[i].toFixed(1)}°` });
    }
    const coh = d.coherence?.[i];
    if (coh != null) {
      rows.push({ label: "Coh", value: coh.toFixed(2) });
    }
    // Every overlay reads out too (a both-channel sweep is one trace whose
    // sibling curve rides as an overlay — the cursor must tell both, M4
    // review): value at the nearest overlay bin + a dot on its curve.
    for (const o of this.overlays) {
      const n = o.frequencies.length;
      if (n === 0 || o.magnitudes_db.length < n) continue;
      let j = 0;
      for (let k = 1; k < n; k++) {
        if (Math.abs(o.frequencies[k] - f) < Math.abs(o.frequencies[j] - f)) j = k;
      }
      const m = this.dispOverlayMag(o, j);
      drawDot(ctx, this.xOf(o.frequencies[j]), Math.max(this.plot.y, Math.min(this.plot.y + this.plot.h, this.yOf(m))), o.color);
      const tag = o.label ? ` ${o.label}` : "";
      rows.push({ key: o.color, label: `Mag${tag}`, value: `${m.toFixed(2)} dB` });
      if (this.showPhase && o.phases && o.phases.length === n) {
        rows.push({ key: o.color, label: `Phase${tag}`, value: `${o.phases[j].toFixed(1)}°` });
      }
    }
    drawReadout(ctx, x, yMag, this.plot, formatHz(f), rows);
  }
}

/* ------------------------------------------------------------------ */
/* Spectrum chart                                                      */
/* ------------------------------------------------------------------ */

export interface SpectrumPeak {
  frequency: number;
  magnitude_db: number;
  index: number;
}

export interface SpectrumData {
  frequencies: number[];
  magnitudes_db: number[];
  peaks: SpectrumPeak[];
}

interface SpectrumOverlay {
  label: string;
  color: string;
  freqs: number[];
  mags: number[]; // weighted (displayed)
  rawMags: number[]; // as measured, pre-weighting
}

/** A harmonic tap annotated on the spectrum (H1 = fundamental, H2.. = harmonics). */
export interface SpectrumHarmonic {
  n: number;
  frequency: number;
  magnitude_db: number;
  magnitude_dbc: number;
}

export class SpectrumChart extends InteractiveLogChart {
  private freqs: number[] = [];
  private mags: number[] = []; // weighted (displayed)
  private rawMags: number[] = []; // as measured, pre-weighting
  private peaks: SpectrumPeak[] = []; // weighted (displayed)
  private rawPeaks: SpectrumPeak[] = [];
  private overlays: SpectrumOverlay[] = [];
  private harmonics: SpectrumHarmonic[] = [];
  private traceColor: string = T.seriesLeft;
  // Level-axis units: a constant dB offset added to the raw magnitudes, plus
  // the axis label. dBFS → offset 0; dBV → the input calibration offset; dBr →
  // the negative of the chosen reference. Raw data is untouched (kept for save).
  private levelOffsetDb = 0;
  private levelUnit = "dBFS";
  // Optional second (right) level axis: relative dBr labels that TRACK the
  // left axis — the same gridlines relabelled as raw dBFS + rightOffsetDb
  // (rightOffsetDb = −(the 0 dBr reference in dBFS)). Null = single axis.
  private rightUnit: string | null = null;
  private rightOffsetDb = 0;
  // Sticky Y auto-range: with a live INPUT the noise floor's min bin jitters
  // frame-to-frame, so recomputing the rounded bounds every frame made the axis
  // rescale constantly. We hold the range and only grow it when data leaves it,
  // shrinking only when there is a lot of dead space — so micro-variations no
  // longer move the axis. A deliberate change (weighting/units/scale/FFT size)
  // forces a clean refit.
  private stickyYMin = NaN;
  private stickyYMax = NaN;
  private refitY = true;
  private prevBinCount = -1;
  // Fixed Y range (in DISPLAY units, [min, max]) — when set, the axis is pinned
  // here instead of auto-ranging, so switching signals/weightings no longer
  // makes the scale jump. Default: +20 (top) down to -160 (bottom) — a
  // conventional full-scale-to-noise-floor span for audio analyzers. null =
  // fall back to sticky auto-range. Zoom still works and resets back to this range.
  private fixedYRange: [number, number] | null = [-160, 20];
  // Peak-hold: per-bin running maximum of the raw magnitudes, drawn as a held
  // trace over the live curve. Stored raw so weighting/units apply to it too.
  private peakHoldOn = false;
  private peakHoldRaw: number[] = [];
  private peakHoldDisp: number[] = [];
  // During a live run the peak value labels are suppressed (they recompute and
  // flicker every frame); hover to read a value instead. A frozen snapshot keeps
  // the labels. The peak dots stay in both modes.
  private liveMode = false;

  constructor(container: HTMLElement) {
    super(container, "Acquire a signal to plot its spectrum");
    this.canvas.setAttribute("aria-label", "Spectrum chart");
  }

  /**
   * Set the level-axis units: a constant `offsetDb` added to every displayed
   * magnitude (composing with the per-bin weighting) and the axis `unit` label
   * (e.g. "dBFS" / "dBV" / "dBr"). Purely a display transform over retained raw
   * data, so it is cheap and does not affect saved measurements.
   */
  setLevelUnits(unit: string, offsetDb: number): void {
    if (this.levelUnit === unit && this.levelOffsetDb === offsetDb) return;
    this.levelUnit = unit;
    this.levelOffsetDb = isFinite(offsetDb) ? offsetDb : 0;
    this.refitY = true; // a level shift should re-fit the axis cleanly
    this.applyWeighting();
    this.render();
  }

  /**
   * Show (or hide with `unit = null`) a second, right-hand level axis whose
   * labels TRACK the left axis: the same gridlines relabelled as
   * `raw dBFS + offsetDb`. Used for the dashboard's dual-axis graphs — left
   * absolute (dBV/dBFS), right relative (dBr, offsetDb = −reference).
   */
  setRightAxis(unit: string | null, offsetDb = 0): void {
    const off = isFinite(offsetDb) ? offsetDb : 0;
    if (this.rightUnit === unit && this.rightOffsetDb === off) return;
    this.rightUnit = unit;
    this.rightOffsetDb = off;
    this.render();
  }

  /** Pin the level axis to a fixed [min, max] in display units (stable scale),
   * or pass null to restore sticky auto-range. Clears any active zoom. */
  setYRangeFixed(min: number | null, max?: number): void {
    this.fixedYRange = min === null ? null : [min, max as number];
    this.viewY = null;
    this.refitY = true;
    this.render();
  }

  /**
   * The loudest peak's base level (raw dBFS, excluding the units offset),
   * for choosing a dBr reference so the peak reads exactly 0 dB.
   * Returns null when no data is loaded.
   */
  topPeakBaseDb(): number | null {
    if (this.rawPeaks.length === 0) return null;
    return this.rawPeaks[0].magnitude_db;
  }

  /**
   * Live mode suppresses the always-on peak value labels (they flicker as the
   * curve updates); the hover readout and user markers still work. A frozen
   * snapshot (liveMode false) shows the labels.
   */
  setLiveMode(on: boolean): void {
    if (this.liveMode === on) return;
    this.liveMode = on;
    this.render();
  }

  /** Enable/disable the peak-hold (max-hold) trace over the live spectrum. */
  setPeakHold(on: boolean): void {
    if (this.peakHoldOn === on) return;
    this.peakHoldOn = on;
    if (!on) {
      this.peakHoldRaw = [];
      this.peakHoldDisp = [];
    } else {
      // Seed from the current frame so it appears immediately.
      this.peakHoldRaw = this.rawMags.slice();
    }
    this.applyWeighting();
    this.render();
  }

  /** Clear the held maxima (start a fresh peak-hold accumulation). */
  resetPeakHold(): void {
    this.peakHoldRaw = this.peakHoldOn ? this.rawMags.slice() : [];
    this.applyWeighting();
    this.render();
  }

  setData(data: SpectrumData, channel: "Left" | "Right", colorOverride?: string): void {
    // Drop DC / sub-audio bins: the x axis starts at 10 Hz.
    const fLo = 10;
    this.freqs = [];
    this.rawMags = [];
    for (let i = 0; i < data.frequencies.length; i++) {
      if (data.frequencies[i] >= fLo && isFinite(data.magnitudes_db[i])) {
        this.freqs.push(data.frequencies[i]);
        this.rawMags.push(data.magnitudes_db[i]);
      }
    }
    this.rawPeaks = [...data.peaks]
      .filter((p) => p.frequency >= fLo)
      .sort((a, b) => b.magnitude_db - a.magnitude_db)
      .slice(0, 6);
    const nextColor = colorOverride ?? (channel === "Left" ? T.seriesLeft : T.seriesRight);
    // Re-fit the Y axis on a genuine context change (new FFT size or a switch to
    // a different trace), but NOT on every live frame of the same series — that
    // is what keeps the axis steady under a live input's micro-variations.
    const binCountChanged = this.freqs.length !== this.prevBinCount;
    if (binCountChanged || nextColor !== this.traceColor) {
      this.refitY = true;
    }
    this.prevBinCount = this.freqs.length;
    this.traceColor = nextColor;
    // Accumulate the per-bin running maximum for peak-hold (raw domain).
    if (this.peakHoldOn) {
      if (this.peakHoldRaw.length !== this.rawMags.length) {
        this.peakHoldRaw = this.rawMags.slice();
      } else {
        for (let i = 0; i < this.rawMags.length; i++) {
          if (this.rawMags[i] > this.peakHoldRaw[i]) this.peakHoldRaw[i] = this.rawMags[i];
        }
      }
    }
    this.overlays = [];
    this.harmonics = [];
    // A live run must preserve the user's zoom/pan across frames — resetting the
    // viewport every frame would snap the axis back to full view as they zoom.
    // Markers survive too while the bin layout is unchanged (their indices stay
    // valid); a bin-count change or any non-live setData (fresh snapshot / recall)
    // resets to the full view. Explicit resets (clearData / double-click) still
    // clear the viewport directly.
    if (!this.liveMode) {
      this.viewLog = null;
      this.viewY = null;
      this.markers = [];
    } else if (binCountChanged) {
      this.markers = [];
    }
    this.applyWeighting();
    this.render();
  }

  /**
   * Choose the frequency-axis scale (log, default, or linear). Resets the X
   * viewport since it is stored in axis units that don't survive the transform.
   */
  setXScale(scale: XScale): void {
    if (this.xScale === scale) return;
    this.xScale = scale;
    this.viewLog = null;
    this.render();
  }

  /**
   * Recompute displayed magnitudes from the retained raw data: raw dBFS + the
   * constant level-units offset (dBV / dBr). A pure display transform over
   * retained raw data; the saved / analysed data stays untouched.
   * (The per-bin frequency-weighting path that used to compose here was
   * removed at the M7 cutover — weighting is a backend transform now.)
   */
  private applyWeighting(): void {
    const off = this.levelOffsetDb;
    this.mags = this.rawMags.map((m) => m + off);
    this.peaks = this.rawPeaks.map((p) => ({
      ...p,
      magnitude_db: p.magnitude_db + off,
    }));
    for (const o of this.overlays) {
      o.mags = o.rawMags.map((m) => m + off);
    }
    this.peakHoldDisp =
      this.peakHoldOn && this.peakHoldRaw.length === this.freqs.length
        ? this.peakHoldRaw.map((m) => m + off)
        : [];
  }

  /**
   * Annotate the plotted spectrum with harmonic taps (H1 = fundamental). Call
   * after setData. Passing an empty array clears them. When present, the taps
   * replace the automatic peak labels so the distortion story reads cleanly.
   */
  setHarmonicMarkers(harmonics: SpectrumHarmonic[]): void {
    this.harmonics = harmonics.slice();
    this.render();
  }

  /** Overlay saved spectra (magnitude only) for comparison. */
  setOverlays(traces: OverlayTrace[]): void {
    const fLo = 10;
    this.overlays = traces.map((t) => {
      const freqs: number[] = [];
      const rawMags: number[] = [];
      for (let i = 0; i < t.frequencies.length; i++) {
        if (t.frequencies[i] >= fLo && isFinite(t.magnitudes_db[i])) {
          freqs.push(t.frequencies[i]);
          rawMags.push(t.magnitudes_db[i]);
        }
      }
      return { label: t.label, color: t.color, freqs, mags: rawMags.slice(), rawMags };
    });
    this.applyWeighting();
    // A live run pushes overlays every frame; resetting the viewport here was
    // dropping the user's zoom/pan on every frame. Only refit for a non-live
    // change (fresh snapshot / recall).
    if (!this.liveMode) {
      this.viewLog = null;
      this.viewY = null;
    }
    this.render();
  }

  clearOverlays(): void {
    if (this.overlays.length === 0) return;
    this.overlays = [];
    this.viewLog = null;
    this.viewY = null;
    this.render();
  }

  hasOverlays(): boolean {
    return this.overlays.length > 0;
  }

  clearData(): void {
    this.freqs = [];
    this.mags = [];
    this.rawMags = [];
    this.peaks = [];
    this.rawPeaks = [];
    this.overlays = [];
    this.harmonics = [];
    this.markers = [];
    this.viewLog = null;
    this.viewY = null;
    this.stickyYMin = NaN;
    this.stickyYMax = NaN;
    this.refitY = true;
    this.prevBinCount = -1;
    this.render();
  }

  protected hasData(): boolean {
    return this.freqs != null && this.freqs.length > 1;
  }

  protected dataLength(): number {
    return this.freqs.length;
  }

  protected xValues(): number[] {
    return this.freqs;
  }

  protected seriesColor(): string {
    return this.traceColor;
  }

  protected markerSeriesY(i: number): number {
    return this.yOf(this.mags[i]);
  }

  protected readMarker(i: number): MarkerReadout {
    return {
      freq: this.freqs[i],
      valueDb: this.mags[i],
      valueText: `${this.mags[i].toFixed(1)} ${this.levelUnit}`,
    };
  }

  protected drawStatic(ctx: CanvasRenderingContext2D): void {
    // The dual right axis needs room for its tick labels; single-axis charts
    // keep the slim margin.
    const rightPad = this.rightUnit ? 44 : 16;
    this.plot = { x: 48, y: 14, w: this.w - 48 - rightPad, h: this.h - 14 - 32 };
    const { plot } = this;
    if (plot.w < 40 || plot.h < 40) return;

    let fMin = this.freqs[0];
    let fMax = this.freqs[this.freqs.length - 1];
    for (const o of this.overlays) {
      if (o.freqs.length) {
        fMin = Math.min(fMin, o.freqs[0]);
        fMax = Math.max(fMax, o.freqs[o.freqs.length - 1]);
      }
    }
    this.fullLogMin = this.fwd(fMin);
    this.fullLogMax = this.fwd(Math.max(fMax, fMin * 1.01));

    let hi = -Infinity;
    let lo = Infinity;
    const scanSpec = (arr: number[]): void => {
      for (const m of arr) {
        if (!isFinite(m)) continue;
        if (m > hi) hi = m;
        if (m < lo) lo = m;
      }
    };
    scanSpec(this.mags);
    for (const o of this.overlays) scanSpec(o.mags);
    if (this.peakHoldDisp.length) scanSpec(this.peakHoldDisp);
    if (this.fixedYRange) {
      // Pinned axis: stable regardless of what the signal does.
      this.fullYMin = this.fixedYRange[0];
      this.fullYMax = this.fixedYRange[1];
    } else {
      // Sticky auto-range (see the field comment): grow when the signal reaches
      // within 2 dB of an edge, shrink only when ≥20 dB of dead space opens up,
      // so a live input's frame-to-frame jitter no longer rescales the axis. A
      // deliberate change sets refitY to snap cleanly to the data.
      // +60 accommodates dBu at the top input range (~+44 dBu) with headroom;
      // the old +10 cap was a dBFS-era assumption that cropped absolute-unit
      // curves (a +17 dBV fundamental left the plot — maintainer report, M6).
      const candMax = Math.min(60, Math.ceil((hi + 5) / 10) * 10);
      const candMin = Math.max(-160, Math.floor(lo / 10) * 10);
      if (!isFinite(hi) || !isFinite(lo)) {
        // No data this frame — keep whatever range we had.
      } else if (this.refitY || !isFinite(this.stickyYMax) || !isFinite(this.stickyYMin)) {
        this.stickyYMax = candMax;
        this.stickyYMin = candMin;
        this.refitY = false;
      } else {
        if (hi > this.stickyYMax - 2 || this.stickyYMax - candMax >= 20) this.stickyYMax = candMax;
        if (lo < this.stickyYMin + 2 || candMin - this.stickyYMin >= 20) this.stickyYMin = candMin;
      }
      this.fullYMax = isFinite(this.stickyYMax) ? this.stickyYMax : 10;
      this.fullYMin = isFinite(this.stickyYMin) ? this.stickyYMin : -120;
      if (this.fullYMin >= this.fullYMax) this.fullYMin = this.fullYMax - 20;
    }

    this.applyViewport();
    // At the pinned full view, label every 20 dB (…−20, −40, −60… −160), a
    // common convention; when zoomed, fall back to an adaptive "nice" step.
    const step =
      this.fixedYRange && !this.viewY ? 20 : niceStep(this.yMax - this.yMin, 6);

    drawPlotBackdrop(ctx, plot);
    if (this.xScale === "linear") {
      drawLinXAxis(ctx, plot, this.inv(this.logMin), this.inv(this.logMax), this.xOf);
    } else {
      drawLogXAxis(ctx, plot, this.inv(this.logMin), this.inv(this.logMax), this.xOf);
    }
    // On the pinned view, keep one step of unlabeled headroom at the very top
    // (drop only the +20 label; 0 dBV stays); label everything when zoomed.
    const labelMax =
      this.fixedYRange && !this.viewY ? this.yMax - step : undefined;
    drawDbYAxis(ctx, plot, this.yMin, this.yMax, step, this.yOf, this.levelUnit, labelMax);
    // Dual axis: right-hand dBr labels tracking the same gridlines. A displayed
    // value v is raw dBFS + levelOffsetDb (+ per-bin weighting, which is not a
    // constant and thus not part of an axis); its relative reading is
    // raw + rightOffsetDb = v − levelOffsetDb + rightOffsetDb.
    if (this.rightUnit) {
      const delta = this.rightOffsetDb - this.levelOffsetDb;
      ctx.font = TICK_FONT;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = T.inkMuted;
      const start = Math.ceil(this.yMin / step) * step;
      for (let v = start; v <= this.yMax + step * 0.01; v += step) {
        const y = Math.round(this.yOf(v)) + 0.5;
        if (y < plot.y - 0.5 || y > plot.y + plot.h + 0.5) continue;
        if (labelMax !== undefined && v > labelMax + step * 0.01) continue;
        ctx.fillText(String(Math.round((v + delta) * 10) / 10), plot.x + plot.w + 8, y);
      }
      // Unit tag, top-right corner of the plot (mirrors the left tag).
      ctx.textAlign = "right";
      ctx.textBaseline = "top";
      ctx.fillText(this.rightUnit, plot.x + plot.w - 7, plot.y + 6);
    }
    drawFrame(ctx, plot);

    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x, plot.y, plot.w, plot.h);
    ctx.clip();

    // Comparison overlays under the primary trace.
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const o of this.overlays) {
      if (o.freqs.length < 2) continue;
      ctx.strokeStyle = o.color;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1.25;
      strokeSeries(ctx, o.freqs.length, (i) => this.xOf(o.freqs[i]), (i) => this.yOf(o.mags[i]), plot.w);
    }
    ctx.globalAlpha = 1;

    // Peak-hold (max-hold) trace, drawn under the live curve so the live trace
    // stays readable on top (peak-hold always sits at or above it).
    if (this.peakHoldDisp.length === this.freqs.length && this.freqs.length > 1) {
      ctx.strokeStyle = T.peakHold;
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      strokeSeries(
        ctx,
        this.freqs.length,
        (i) => this.xOf(this.freqs[i]),
        (i) => this.yOf(this.peakHoldDisp[i]),
        plot.w
      );
    }

    // Soft fill under the trace for weight.
    const fillColor = this.traceColor === T.seriesRight ? T.seriesRight : T.seriesLeft;
    const grad = ctx.createLinearGradient(0, plot.y, 0, plot.y + plot.h);
    grad.addColorStop(0, hexToRgba(fillColor, 0.16));
    grad.addColorStop(1, hexToRgba(fillColor, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(this.xOf(this.freqs[0]), plot.y + plot.h);
    // Decimated like the stroke: an undecimated 16k-vertex fill polygon is
    // seconds per frame in software rasterization (see traceSeriesPath).
    traceSeriesPath(
      ctx,
      this.freqs.length,
      (i) => this.xOf(this.freqs[i]),
      (i) => this.yOf(this.mags[i]),
      plot.w,
      false
    );
    ctx.lineTo(this.xOf(this.freqs[this.freqs.length - 1]), plot.y + plot.h);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = this.traceColor;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    strokeSeries(
      ctx,
      this.freqs.length,
      (i) => this.xOf(this.freqs[i]),
      (i) => this.yOf(this.mags[i]),
      plot.w
    );
    ctx.restore();

    if (this.harmonics.length > 0) {
      this.drawHarmonics(ctx, plot);
    } else {
      // Peak annotations: markers on the top peaks, sparse labels.
      ctx.font = TICK_FONT;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      const labeledX: number[] = [];
      for (const p of this.peaks) {
        const x = this.xOf(p.frequency);
        const y = this.yOf(p.magnitude_db);
        if (x < plot.x || x > plot.x + plot.w) continue;
        drawDot(ctx, x, Math.max(plot.y + 4, y), this.traceColor);
        // No value labels during a live run — they flicker; hover to read.
        if (this.liveMode) continue;
        const crowded = labeledX.some((lx) => Math.abs(lx - x) < 56);
        if (!crowded) {
          const label = `${tickHz(Math.round(p.frequency))} ${p.magnitude_db.toFixed(1)}`;
          const half = ctx.measureText(label).width / 2;
          const ty = Math.max(plot.y + 22, y - 8);
          let tx = x;
          if (ty > y) tx = x + half + 14 > plot.x + plot.w - 2 ? x - half - 12 : x + half + 12;
          tx = Math.max(plot.x + half + 2, Math.min(plot.x + plot.w - half - 2, tx));
          ctx.fillStyle = T.inkSecondary;
          ctx.fillText(label, tx, ty);
          labeledX.push(x);
        }
      }
    }
  }

  /**
   * Draw harmonic taps: a labelled chip at the top rail for each harmonic (H1
   * the fundamental in the trace colour, H2.. in amber), a guide line down to
   * the trace, and a dot. The dBc value is printed beneath the chip when the
   * neighbours are not too crowded (the table always carries the full figures).
   */
  private drawHarmonics(ctx: CanvasRenderingContext2D, plot: Rect): void {
    const rowH = 15;
    const maxRows = 3;
    const top = plot.y + 4;
    // Right edge occupied on each stagger row, so close harmonics step down
    // instead of overprinting each other.
    const rowRight: number[] = [];
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    for (const hm of this.harmonics) {
      const x = this.xOf(hm.frequency);
      if (x < plot.x - 1 || x > plot.x + plot.w + 1) continue;
      const isFund = hm.n === 1;
      const color = isFund ? this.traceColor : T.markerA;
      const yTrace = Math.max(plot.y + 2, Math.min(plot.y + plot.h, this.yOf(hm.magnitude_db)));

      // Prefer the fuller "Hn -dBc" label; fall back to "Hn" when it would not
      // fit on a free row. The table always carries the exact figures.
      ctx.font = `600 10px ${MONO}`;
      const full = isFund
        ? `H1 ${hm.magnitude_db.toFixed(0)}`
        : `H${hm.n} ${hm.magnitude_dbc.toFixed(0)}dBc`;
      const short = `H${hm.n}`;

      const fits = (w: number): number => {
        const half = w / 2;
        const left = Math.max(plot.x + 1, Math.min(plot.x + plot.w - w - 1, x - half));
        for (let r = 0; r < maxRows; r++) {
          if (left >= (rowRight[r] ?? -Infinity) + 4) return r;
        }
        return -1;
      };

      let label = full;
      let cw = ctx.measureText(full).width + 8;
      let row = fits(cw);
      if (row < 0) {
        // No room for the verbose label: fall back to the compact "Hn".
        label = short;
        cw = ctx.measureText(short).width + 8;
        row = fits(cw);
      }
      if (row < 0) {
        // Still crowded: use the least-occupied row to minimise overlap.
        row = 0;
        for (let r = 1; r < maxRows; r++) {
          if ((rowRight[r] ?? -Infinity) < (rowRight[row] ?? -Infinity)) row = r;
        }
      }

      const cy = top + row * rowH;
      let cx = x - cw / 2;
      cx = Math.max(plot.x + 1, Math.min(plot.x + plot.w - cw - 1, cx));
      rowRight[row] = cx + cw;

      // Guide from just under the chip's row down to the trace dot.
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = color;
      ctx.globalAlpha = isFund ? 0.5 : 0.4;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, cy + 14);
      ctx.lineTo(Math.round(x) + 0.5, yTrace);
      ctx.stroke();
      ctx.restore();

      drawDot(ctx, x, yTrace, color, 3.2);

      ctx.font = `600 10px ${MONO}`;
      ctx.fillStyle = color;
      roundRectPath(ctx, cx, cy, cw, 14, 3);
      ctx.fill();
      ctx.fillStyle = T.chipInk;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, cx + cw / 2, cy + 7.5);
    }
  }

  protected drawCursor(ctx: CanvasRenderingContext2D, i: number): void {
    const f = this.freqs[i];
    const x = this.xOf(f);
    if (x < this.plot.x || x > this.plot.x + this.plot.w) return;
    ctx.strokeStyle = T.crosshair;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, this.plot.y);
    ctx.lineTo(x, this.plot.y + this.plot.h);
    ctx.stroke();
    const y = Math.max(this.plot.y, Math.min(this.plot.y + this.plot.h, this.yOf(this.mags[i])));
    drawDot(ctx, x, y, this.traceColor);
    const rows: ReadoutRow[] = [
      { key: this.traceColor, label: "Level", value: `${this.mags[i].toFixed(1)} ${this.levelUnit}` },
    ];
    // Every overlaid trace, sampled at the same frequency, so a multi-curve
    // graph reads all curves at the cursor (not just the primary).
    for (const o of this.overlays) {
      if (o.freqs.length === 0) continue;
      const oi = nearestIndex(o.freqs, f);
      const oy = Math.max(this.plot.y, Math.min(this.plot.y + this.plot.h, this.yOf(o.mags[oi])));
      drawDot(ctx, x, oy, o.color);
      rows.push({ key: o.color, label: o.label, value: `${o.mags[oi].toFixed(1)} ${this.levelUnit}` });
    }
    drawReadout(ctx, x, y, this.plot, formatHz(f), rows);
  }
}

/* ------------------------------------------------------------------ */
/* Scope (time domain) chart                                           */
/* ------------------------------------------------------------------ */

export class ScopeChart extends BaseChart {
  private left: number[] = [];
  private right: number[] = [];
  private leftColor: string | null = null;
  private scopeOverlays: { samples: number[]; color: string; label?: string }[] = [];
  private sampleRate = 48000;
  private showLeft = true;
  private showRight = true;

  private plot: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private yRange = 1;
  /** Displayed time window in ms; null = the whole capture. */
  private timeWindowMs: number | null = null;
  /** Fixed amplitude range (±value, full-scale); null = auto. */
  private yScaleFixed: number | null = null;
  /** Y-axis display unit label and volts-per-full-scale (null = raw "FS"). */
  private ampUnit = "FS";
  private ampPerFs: number | null = null;

  // Up-to-two draggable time markers (sample indices) with a Δt / frequency readout.
  private markers: number[] = [];
  private dragSlot = -1;
  /** Pointer plot-X while hovering (null = not hovering), so a live refresh can
   * re-derive the cursor readout instead of dropping it every frame. */
  private hoverPx: number | null = null;
  private readonly markerPanel: HTMLDivElement;
  private readonly markerControls: HTMLDivElement;
  private readonly clearBtn: HTMLButtonElement;

  constructor(container: HTMLElement) {
    super(container, "Acquire a signal to view the waveform");
    this.canvas.setAttribute("aria-label", "Time domain scope");

    this.markerControls = document.createElement("div");
    this.markerControls.className = "chart-controls";
    this.clearBtn = document.createElement("button");
    this.clearBtn.type = "button";
    this.clearBtn.className = "chart-ctl";
    this.clearBtn.textContent = "Clear markers";
    this.clearBtn.addEventListener("click", () => this.clearMarkers());
    this.markerControls.appendChild(this.clearBtn);
    this.markerControls.hidden = true;
    container.appendChild(this.markerControls);

    this.markerPanel = document.createElement("div");
    this.markerPanel.className = "chart-markers";
    this.markerPanel.hidden = true;
    container.appendChild(this.markerPanel);

    const hint = document.createElement("div");
    hint.className = "chart-hint";
    hint.innerHTML =
      '<span>click</span> marker · <span>drag</span> move · ' +
      '<span>right-click</span> remove — Δ shows time &amp; frequency';
    container.appendChild(hint);

    this.canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.canvas.addEventListener("pointerup", (e) => this.onPointerUp(e));
    this.canvas.addEventListener("contextmenu", (e) => this.onContextMenu(e));
  }

  setData(left: number[], right: number[], sampleRate: number, primaryColor?: string): void {
    this.left = left;
    this.right = right;
    this.leftColor = primaryColor ?? null;
    this.sampleRate = Math.max(1, sampleRate);
    // Keep markers across updates (e.g. live capture) so they can be used to
    // read frequency on a running signal; just drop any now out of range.
    const n = this.dataLength();
    this.markers = this.markers.filter((i) => i < n);
    this.updateMarkerPanel();
    this.render();
  }

  clearMarkers(): void {
    if (this.markers.length === 0) return;
    this.markers = [];
    this.updateMarkerPanel();
    this.refreshScopeOverlay();
  }

  /** Choose which channel traces are drawn. At least one should stay on. */
  setChannelVisibility(left: boolean, right: boolean): void {
    this.showLeft = left;
    this.showRight = right;
    this.render();
  }

  /** Overlay extra waveforms (e.g. dashboard reference/compare traces). */
  setOverlays(traces: { samples: number[]; color: string; label?: string }[]): void {
    this.scopeOverlays = traces;
    this.render();
  }

  /** Sample index under a pixel X, honoring the displayed window. */
  private sampleAtX(px: number): number {
    const n = this.displayCount();
    const t = (px - this.plot.x) / Math.max(1, this.plot.w);
    return Math.max(0, Math.min(n - 1, Math.round(t * (n - 1))));
  }

  private valueAt(i: number): number {
    if (i < this.left.length) return this.left[i];
    if (i < this.right.length) return this.right[i];
    return 0;
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 || !this.hasData()) return;
    const { plot } = this;
    if (e.offsetX < plot.x || e.offsetX > plot.x + plot.w) return;
    // Grab a nearby existing marker (within 6 px) to drag it; else drop a new one.
    let slot = -1;
    for (let s = 0; s < this.markers.length; s++) {
      if (Math.abs(this.xOf(this.markers[s]) - e.offsetX) <= 6) {
        slot = s;
        break;
      }
    }
    if (slot < 0) {
      if (this.markers.length < 2) {
        this.markers.push(this.sampleAtX(e.offsetX));
        slot = this.markers.length - 1;
      } else {
        // Move the nearest of the two.
        slot =
          Math.abs(this.xOf(this.markers[0]) - e.offsetX) <=
          Math.abs(this.xOf(this.markers[1]) - e.offsetX)
            ? 0
            : 1;
        this.markers[slot] = this.sampleAtX(e.offsetX);
      }
    }
    this.dragSlot = slot;
    this.canvas.setPointerCapture(e.pointerId);
    this.updateMarkerPanel();
    this.refreshScopeOverlay();
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.dragSlot >= 0) {
      this.dragSlot = -1;
      try {
        this.canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
  }

  private onContextMenu(e: MouseEvent): void {
    if (!this.hasData()) return;
    for (let s = 0; s < this.markers.length; s++) {
      if (Math.abs(this.xOf(this.markers[s]) - e.offsetX) <= 8) {
        e.preventDefault();
        this.markers.splice(s, 1);
        this.updateMarkerPanel();
        this.refreshScopeOverlay();
        return;
      }
    }
  }

  private refreshScopeOverlay(): void {
    if (!this.hasData()) {
      this.blit();
      return;
    }
    this.blit((ctx) => {
      this.drawScopeMarkers(ctx);
      if (this.cursorIndex >= 0 && this.dragSlot < 0) this.drawCursor(ctx, this.cursorIndex);
    });
  }

  protected setCursor(index: number): void {
    if (index === this.cursorIndex) return;
    this.cursorIndex = index;
    this.refreshScopeOverlay();
  }

  private drawScopeMarkers(ctx: CanvasRenderingContext2D): void {
    const p = this.plot;
    const n = this.displayCount();
    this.markers.forEach((idx, slot) => {
      if (idx < 0 || idx >= n) return;
      const x = this.xOf(idx);
      if (x < p.x - 1 || x > p.x + p.w + 1) return;
      const color = slot === 0 ? T.markerA : T.markerB;
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, p.y);
      ctx.lineTo(Math.round(x) + 0.5, p.y + p.h);
      ctx.stroke();
      ctx.restore();
      drawDot(ctx, x, Math.max(p.y, Math.min(p.y + p.h, this.yOf(this.valueAt(idx)))), color, 3.5);

      const label = slot === 0 ? "A" : "B";
      ctx.font = `600 10px ${MONO}`;
      const cw = ctx.measureText(label).width + 8;
      let cx = x - cw / 2;
      cx = Math.max(p.x + 1, Math.min(p.x + p.w - cw - 1, cx));
      ctx.fillStyle = color;
      roundRectPath(ctx, cx, p.y + 3, cw, 14, 3);
      ctx.fill();
      ctx.fillStyle = T.chipInk;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, cx + cw / 2, p.y + 3 + 7.5);
    });
  }

  private updateMarkerPanel(): void {
    this.clearBtn.hidden = this.markers.length === 0;
    this.markerControls.hidden = this.markers.length === 0;
    const panel = this.markerPanel;
    if (this.markers.length === 0 || !this.hasData()) {
      panel.hidden = true;
      panel.replaceChildren();
      return;
    }
    panel.hidden = false;
    const mkRow = (name: string, color: string | null, colA: string, colB: string): HTMLElement => {
      const row = document.createElement("div");
      row.className = "mk-row";
      const dot = document.createElement("span");
      dot.className = color ? "mk-dot" : "mk-dot mk-dot-empty";
      if (color) dot.style.background = color;
      const nm = document.createElement("span");
      nm.className = "mk-name";
      nm.textContent = name;
      const c1 = document.createElement("span");
      c1.className = "mk-freq";
      c1.textContent = colA;
      const c2 = document.createElement("span");
      c2.className = "mk-val";
      c2.textContent = colB;
      row.append(dot, nm, c1, c2);
      return row;
    };
    const tms = (i: number): number => (i / this.sampleRate) * 1000;
    const rows: HTMLElement[] = this.markers.map((i, slot) =>
      mkRow(
        slot === 0 ? "A" : "B",
        slot === 0 ? T.markerA : T.markerB,
        `${tms(i).toFixed(3)} ms`,
        this.valueAt(i).toFixed(4)
      )
    );
    if (this.markers.length === 2) {
      const dtMs = Math.abs(tms(this.markers[1]) - tms(this.markers[0]));
      const freq = dtMs > 0 ? 1000 / dtMs : Infinity;
      rows.push(
        mkRow("Δ", null, `${dtMs.toFixed(4)} ms`, isFinite(freq) ? formatHz(freq) : "—")
      );
    }
    panel.replaceChildren(...rows);
  }

  /** Set the displayed time base (ms), or null for the full capture. */
  setTimeWindow(ms: number | null): void {
    this.timeWindowMs = ms != null && ms > 0 ? ms : null;
    this.render();
  }

  /** Set a fixed ± amplitude range (full-scale), or null for auto. */
  setYScale(fs: number | null): void {
    this.yScaleFixed = fs != null && fs > 0 ? fs : null;
    this.render();
  }

  /** Label the Y axis in volts: `unit` is the shown label (e.g. "V", "mV") and
   * `perFs` scales a full-scale sample (±1) to that unit. Pass ("FS", null) to
   * show raw normalized full-scale. Purely a display transform over raw data. */
  setAmplitudeUnit(unit: string, perFs: number | null): void {
    this.ampUnit = unit;
    this.ampPerFs = perFs;
    this.render();
  }

  /** Number of samples shown, honoring the time window. */
  private displayCount(): number {
    const n = this.dataLength();
    if (this.timeWindowMs == null) return n;
    const c = Math.round((this.timeWindowMs / 1000) * this.sampleRate);
    return Math.max(2, Math.min(n, c));
  }

  clearData(): void {
    this.left = [];
    this.right = [];
    this.scopeOverlays = [];
    this.render();
  }

  protected hasData(): boolean {
    return this.left != null && (this.left.length > 1 || this.right.length > 1);
  }

  protected dataLength(): number {
    return Math.max(this.left.length, this.right.length);
  }

  private xOf = (i: number): number =>
    this.plot.x + (i / Math.max(1, this.displayCount() - 1)) * this.plot.w;

  private yOf = (v: number): number =>
    this.plot.y + this.plot.h / 2 - (v / this.yRange) * (this.plot.h / 2);

  protected drawStatic(ctx: CanvasRenderingContext2D): void {
    this.plot = { x: 54, y: 14, w: this.w - 54 - 16, h: this.h - 14 - 32 };
    const { plot } = this;
    if (plot.w < 40 || plot.h < 40) return;
    const n = this.displayCount();

    if (this.yScaleFixed != null) {
      this.yRange = this.yScaleFixed;
    } else {
      // Auto-scale over the displayed (and visible) traces only.
      let peak = 0;
      for (let i = 0; i < n; i++) {
        if (this.showLeft && i < this.left.length) peak = Math.max(peak, Math.abs(this.left[i]));
        if (this.showRight && i < this.right.length) peak = Math.max(peak, Math.abs(this.right[i]));
      }
      for (const o of this.scopeOverlays) {
        for (let i = 0; i < Math.min(o.samples.length, n); i++) peak = Math.max(peak, Math.abs(o.samples[i]));
      }
      this.yRange = peak > 0 ? peak * 1.15 : 1;
    }

    drawPlotBackdrop(ctx, plot);

    // Horizontal grid: quarters plus an emphasized zero line.
    ctx.font = TICK_FONT;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let q = -2; q <= 2; q++) {
      const v = (q / 2) * this.yRange;
      const y = Math.round(this.yOf(v)) + 0.5;
      ctx.strokeStyle = q === 0 ? T.zeroLine : T.gridMajor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(plot.x, y);
      ctx.lineTo(plot.x + plot.w, y);
      ctx.stroke();
      ctx.fillStyle = T.inkMuted;
      const shown = this.ampPerFs != null ? v * this.ampPerFs : v;
      ctx.fillText(v === 0 ? "0" : shown.toPrecision(2), plot.x - 8, y);
    }

    // Time grid.
    const totalMs = ((n - 1) / this.sampleRate) * 1000;
    const tStep = niceStep(totalMs, 6);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let t = 0; t <= totalMs + tStep * 0.01; t += tStep) {
      const x = Math.round(plot.x + (t / totalMs) * plot.w) + 0.5;
      if (x > plot.x + plot.w + 1) break;
      ctx.strokeStyle = T.gridMajor;
      ctx.beginPath();
      ctx.moveTo(x, plot.y);
      ctx.lineTo(x, plot.y + plot.h);
      ctx.stroke();
      ctx.fillStyle = T.inkMuted;
      ctx.fillText(`${Math.round(t * 100) / 100}`, x, plot.y + plot.h + 7);
    }
    ctx.fillStyle = T.inkMuted;
    ctx.textAlign = "left";
    ctx.fillText("ms", plot.x + plot.w + 2, plot.y + plot.h + 7);
    ctx.fillText(this.ampUnit, plot.x + 7, plot.y + 6);

    drawFrame(ctx, plot);

    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x, plot.y, plot.w, plot.h);
    ctx.clip();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    if (this.showRight && this.right.length > 1) {
      ctx.strokeStyle = T.seriesRight;
      ctx.lineWidth = 1.5;
      strokeSeries(ctx, Math.min(this.right.length, n), this.xOf, (i) => this.yOf(this.right[i]), plot.w);
    }
    for (const o of this.scopeOverlays) {
      if (o.samples.length < 2) continue;
      ctx.strokeStyle = o.color;
      ctx.lineWidth = 1.25;
      strokeSeries(ctx, Math.min(o.samples.length, n), this.xOf, (i) => this.yOf(o.samples[i]), plot.w);
    }
    if (this.showLeft && this.left.length > 1) {
      ctx.strokeStyle = this.leftColor ?? T.seriesLeft;
      ctx.lineWidth = 1.5;
      strokeSeries(ctx, Math.min(this.left.length, n), this.xOf, (i) => this.yOf(this.left[i]), plot.w);
    }
    ctx.restore();
  }

  protected drawCursor(ctx: CanvasRenderingContext2D, i: number): void {
    const x = this.xOf(i);
    ctx.strokeStyle = T.crosshair;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, this.plot.y);
    ctx.lineTo(x, this.plot.y + this.plot.h);
    ctx.stroke();

    const rows: ReadoutRow[] = [];
    let anchorY = this.plot.y + this.plot.h / 2;
    if (this.showLeft && i < this.left.length) {
      const y = this.yOf(this.left[i]);
      drawDot(ctx, x, y, T.seriesLeft);
      rows.push({ key: T.seriesLeft, label: "Left", value: this.left[i].toFixed(5) });
      anchorY = y;
    }
    if (this.showRight && i < this.right.length) {
      const y = this.yOf(this.right[i]);
      drawDot(ctx, x, y, T.seriesRight);
      rows.push({ key: T.seriesRight, label: "Right", value: this.right[i].toFixed(5) });
    }
    // Overlaid waveforms (e.g. a second dashboard trace) — read each at the cursor.
    for (const o of this.scopeOverlays) {
      if (i >= o.samples.length) continue;
      const y = this.yOf(o.samples[i]);
      drawDot(ctx, x, y, o.color);
      rows.push({ key: o.color, label: o.label ?? "Trace", value: o.samples[i].toFixed(5) });
    }
    const tMs = (i / this.sampleRate) * 1000;
    drawReadout(ctx, x, anchorY, this.plot, `t = ${tMs.toFixed(3)} ms`, rows);
  }

  protected render(): void {
    super.render();
    // Keep the hover readout alive across live refreshes (super.render clears
    // the cursor): re-derive it from the current pointer position.
    if (this.hoverPx != null && this.dragSlot < 0 && this.hasData()) {
      this.cursorIndex = this.indexAtPx(this.hoverPx);
    }
    if (this.cursorIndex >= 0 || this.markers.length) this.refreshScopeOverlay();
  }

  private indexAtPx(px: number): number {
    const n = this.displayCount();
    return Math.max(0, Math.min(n - 1, Math.round(((px - this.plot.x) / this.plot.w) * (n - 1))));
  }

  protected onPointerLeave(): void {
    this.hoverPx = null;
    this.setCursor(-1);
  }

  protected onPointerMove(e: PointerEvent): void {
    if (!this.hasData()) return;
    if (this.dragSlot >= 0) {
      this.markers[this.dragSlot] = this.sampleAtX(e.offsetX);
      this.updateMarkerPanel();
      this.refreshScopeOverlay();
      return;
    }
    const { plot } = this;
    const x = e.offsetX;
    const y = e.offsetY;
    if (x < plot.x || x > plot.x + plot.w || y < plot.y || y > plot.y + plot.h) {
      this.hoverPx = null;
      this.setCursor(-1);
      return;
    }
    this.hoverPx = x;
    this.setCursor(this.indexAtPx(x));
  }
}

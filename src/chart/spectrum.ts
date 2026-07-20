/**
 * SpectrumRenderer implementation wrapping the legacy canvas SpectrumChart
 * (plan §3.4, M1). The wrapper pins the chart's internal transform paths to
 * IDENTITY — `setLevelUnits(label, 0)` — because the view-model already
 * carries display-unit values; the offset-per-bin path descended from bugs
 * #51/#60 must never re-engage through this wrapper (guarded by the ported
 * e2e level invariants). The canvas weighting path was cut at M7.
 *
 * The canvas implementation lives in ./canvas.ts (moved here at the M7
 * cutover); it imports only ./theme.ts and ./weighting.ts (pure TS — no
 * legacy CSS enters the page; the chart palette rides the shared
 * --chart-* tokens).
 */
import { SpectrumChart, type OverlayTrace, type SpectrumData } from "./canvas";
import type { HarmonicMarkVM, SeriesVM } from "../store/selectors/chartvm";
import type { SpectrumAxis, SpectrumRenderer } from "./renderer";

export class WrappedSpectrumChart implements SpectrumRenderer {
  private readonly chart: SpectrumChart;
  private unitLabel = "dBFS";
  private axis: SpectrumAxis | null = null;

  constructor(host: HTMLElement) {
    this.chart = new SpectrumChart(host);
    this.chart.setLevelUnits(this.unitLabel, 0); // identity — offsets live in the VM
    this.chart.setXScale("log");
    this.chart.setLiveMode(true);
  }

  setSeries(series: SeriesVM[]): void {
    // The legacy chart CLEARS its harmonic markers inside setData — every
    // feed wipes them. Invalidate the signature so the setHarmonics() call
    // that follows each feed re-applies the marks (maintainer report: the
    // markers lived exactly one frame). "" keeps the no-marks case a no-op.
    this.lastHarmonicsSig = "";
    const [primary, ...rest] = series;
    if (primary) {
      const data: SpectrumData = {
        frequencies: Array.from(primary.x),
        magnitudes_db: Array.from(primary.y),
        peaks: [],
      };
      this.chart.setData(data, "Left", primary.color);
    } else {
      this.chart.setData({ frequencies: [], magnitudes_db: [], peaks: [] }, "Left");
    }
    const overlays: OverlayTrace[] = rest.map((s) => ({
      label: s.label,
      color: s.color,
      frequencies: Array.from(s.x),
      magnitudes_db: Array.from(s.y),
    }));
    this.chart.setOverlays(overlays);
  }

  setUnitLabel(label: string): void {
    if (label === this.unitLabel) return;
    this.unitLabel = label;
    // Offset stays 0 FOREVER: the unit label is cosmetic here, the values
    // were converted in the selector.
    this.chart.setLevelUnits(label, 0);
    this.chart.resetPeakHold();
  }

  setAxis(axis: SpectrumAxis): void {
    // Idempotent by design: `setYRangeFixed` forces a Y-axis refit, and a
    // per-frame refit collapses the sticky autoscale onto flat (silence)
    // data — the noise floor's per-bin jitter then spans many plot heights
    // and software rasterization explodes (seconds per frame, measured).
    // Only a REAL axis change may reach the chart.
    const a = this.axis;
    if (
      a &&
      a.xLog === axis.xLog &&
      a.yAuto === axis.yAuto &&
      a.yMin === axis.yMin &&
      a.yMax === axis.yMax
    ) {
      return;
    }
    this.axis = { ...axis };
    this.chart.setXScale(axis.xLog ? "log" : "linear");
    if (axis.yAuto) this.chart.setYRangeFixed(null);
    else this.chart.setYRangeFixed(axis.yMin, axis.yMax);
  }

  setPeakHold(on: boolean): void {
    this.chart.setPeakHold(on);
  }

  resetPeakHold(): void {
    this.chart.resetPeakHold();
  }

  setHarmonics(marks: HarmonicMarkVM[]): void {
    // Values arrive in display units from the VM; the chart draws verbatim
    // (its own paths are pinned to identity). Signature-guarded — markers
    // move only when the analysis does, not every feed.
    const sig = marks.map((m) => `${m.n}:${m.frequency}:${m.magnitudeDb}`).join("|");
    if (sig === this.lastHarmonicsSig) return;
    this.lastHarmonicsSig = sig;
    this.chart.setHarmonicMarkers(
      marks.map((m) => ({
        n: m.n,
        frequency: m.frequency,
        magnitude_db: m.magnitudeDb,
        magnitude_dbc: m.magnitudeDbc,
      }))
    );
  }
  private lastHarmonicsSig = "";

  destroy(): void {
    this.chart.destroy();
  }
}

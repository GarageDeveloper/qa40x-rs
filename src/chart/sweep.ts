/**
 * SweepRenderer implementation wrapping the legacy canvas
 * FrequencyResponseChart (plan §3.4 — same adoption pattern as M1's
 * spectrum wrapper): the view-model already carries display-unit values
 * (the canvas weighting path was cut at M7). The
 * primary curve is the chart's data (markers/crosshair track it); the rest
 * ride as comparison overlays.
 */
import { FrequencyResponseChart, type OverlayTrace } from "./canvas";
import type { SweepSeriesVM } from "../store/selectors/chartvm";
import type { SweepRenderer } from "./renderer";

export class WrappedSweepChart implements SweepRenderer {
  private readonly chart: FrequencyResponseChart;
  private lastSig = "";
  private phaseRequested = false;
  private primaryHasPhase = false;

  constructor(host: HTMLElement) {
    this.chart = new FrequencyResponseChart(host);
    this.chart.setScaleMode("auto");
  }

  /** ∠ draws only when the primary curve actually CARRIES phase (an FR
   * sweep). A THD sweep has none — the zero-filled placeholder below is
   * marker-readout safety, and stroking it would paint a phantom flat 0°
   * line across the plot (maintainer report, M4 review). */
  private applyShowPhase(): void {
    this.chart.setShowPhase(this.phaseRequested && this.primaryHasPhase);
  }

  setSeries(series: SweepSeriesVM[]): void {
    const [primary, ...rest] = series;
    // The FR chart refits/clears markers on setData — feed it only when the
    // curves actually changed (per-frame feed() calls are cheap no-ops).
    // Color is part of the signature: a recolored trace re-feeds the chart
    // even though its data didn't move (10a — maintainer report).
    const sig = series.map((s) => `${s.id}:${s.seq}:${s.y.length}:${s.color}`).join("|");
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    if (!primary) {
      this.chart.clearData();
      return;
    }
    this.primaryHasPhase = primary.phaseDeg !== null;
    this.chart.setData(
      {
        frequencies: Array.from(primary.x),
        magnitudes_db: Array.from(primary.y),
        phases: primary.phaseDeg
          ? Array.from(primary.phaseDeg)
          : new Array<number>(primary.x.length).fill(0),
        coherence: [],
        latency_samples: 0,
      },
      "Left",
      primary.color
    );
    const overlays: OverlayTrace[] = rest.map((s) => ({
      // Sibling curves keep their SHORT name ("Right") — it tags the cursor
      // readout rows; unrelated overlays keep their full label.
      label: s.curveLabel ?? s.label,
      color: s.color,
      frequencies: Array.from(s.x),
      magnitudes_db: Array.from(s.y),
      phases: s.phaseDeg ? Array.from(s.phaseDeg) : undefined,
    }));
    this.chart.setOverlays(overlays);
    this.applyShowPhase();
  }

  setUnitLabel(label: string): void {
    this.chart.setYUnit(label);
  }

  setShowPhase(on: boolean): void {
    this.phaseRequested = on;
    this.applyShowPhase();
  }

  destroy(): void {
    this.chart.destroy();
  }
}

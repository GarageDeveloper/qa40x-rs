/**
 * ScopeRenderer implementation wrapping the legacy canvas ScopeChart (plan
 * §3.4, M3). The wrapper pins the chart's internal amplitude-unit path to
 * IDENTITY — `setAmplitudeUnit(label, null)` — because the view-model
 * already carries display-unit samples (the trace's own converter offset,
 * applied in the selector). The per-converter volts path of chart.ts must
 * never re-engage through this wrapper (#60's td twin of #51).
 */
import { ScopeChart } from "./canvas";
import type { TdSeriesVM } from "../store/selectors/chartvm";
import type { ScopeRenderer } from "./renderer";

export class WrappedScopeChart implements ScopeRenderer {
  private readonly chart: ScopeChart;

  constructor(host: HTMLElement) {
    this.chart = new ScopeChart(host);
    this.chart.setAmplitudeUnit("V", null); // identity — units live in the VM
  }

  setSeries(series: TdSeriesVM[]): void {
    const [primary, ...rest] = series;
    if (primary) {
      this.chart.setChannelVisibility(true, false);
      this.chart.setData(
        Array.from(primary.samples),
        [],
        primary.sampleRate,
        primary.color
      );
    } else {
      this.chart.setChannelVisibility(true, false);
      this.chart.setData([], [], 48000);
    }
    this.chart.setOverlays(
      rest.map((s) => ({
        samples: Array.from(s.samples),
        color: s.color,
        label: s.label,
      }))
    );
  }

  setUnitLabel(label: string): void {
    // perFs stays null FOREVER: the label is cosmetic, the samples were
    // converted in the selector.
    this.chart.setAmplitudeUnit(label, null);
  }

  setTimeWindow(ms: number | null): void {
    this.chart.setTimeWindow(ms);
  }

  destroy(): void {
    this.chart.destroy();
  }
}

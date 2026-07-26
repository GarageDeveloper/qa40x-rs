// @vitest-environment jsdom
/**
 * FrequencyResponseChart's X-axis floor (issue #28 second pass, review
 * findings #3/#7): "frequency" (THD-vs-freq / FR) keeps the ORIGINAL ≥1 Hz
 * clamp — real "Hz" data has no meaningful content below it and log10(0)
 * must stay out of the picture — but "rateHz" (wow & flutter's deviation
 * spectrum) floors two decades lower instead, because a real defect can sit
 * there: a 33⅓ rpm once-per-revolution wow is 0.555 Hz, and the demod's own
 * bin resolution can go under 0.1 Hz on a long capture. Clamping those away
 * at 1 Hz — the bug this pins — would silently hide the headline defect the
 * "Tape / turntable" wow & flutter template exists to catch.
 *
 * This exercises the actual drawn axis extent (`fullLogMin`, computed in
 * `drawStatic`), not just the view-model data array — the VM's `x` values
 * are never clamped (issue #28 second-pass review finding #5's "the unit
 * rides on the frame" principle applies to the data, not the axis), so a
 * regression here is invisible to any test that only reads `sweepVM()`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FrequencyResponseChart, type FrequencyResponseData } from "./canvas";

/** A CanvasRenderingContext2D stand-in: every method call is a no-op,
 * every property read/write round-trips through a plain store, and
 * `measureText` returns a zero-width metric — enough for the chart's
 * drawing code to run to completion without a real <canvas> backend
 * (jsdom's `getContext("2d")` returns null). */
function makeFakeCtx(fillTextLog?: string[]): CanvasRenderingContext2D {
  const store: Record<string, unknown> = {};
  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      if (prop === "measureText") return () => ({ width: 0 });
      if (prop === "createLinearGradient") return () => makeFakeCtx(fillTextLog);
      if (prop === "fillText") {
        return (text: string) => {
          fillTextLog?.push(text);
        };
      }
      if (prop in store) return store[prop as string];
      return () => undefined;
    },
    set(_t, prop, value) {
      store[prop as string] = value;
      return true;
    },
  };
  return new Proxy({}, handler) as unknown as CanvasRenderingContext2D;
}

function makeData(frequencies: number[]): FrequencyResponseData {
  return {
    frequencies,
    magnitudes_db: frequencies.map(() => 0),
    phases: frequencies.map(() => 0),
    coherence: frequencies.map(() => 1),
    latency_samples: 0,
  };
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  );
  // jsdom doesn't implement matchMedia at all (no property to spy on).
  window.matchMedia = ((query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => makeFakeCtx() as unknown as RenderingContext
  );
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    width: 600,
    height: 400,
    top: 0,
    left: 0,
    bottom: 400,
    right: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
});

function buildChart(): FrequencyResponseChart {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return new FrequencyResponseChart(container);
}

/** Same as `buildChart`, but every `fillText` call the chart makes lands in
 * the returned array — used to pin the "rateHz"-only X-axis unit tag below
 * without depending on canvas pixel output. */
function buildChartWithFillTextLog(): { chart: FrequencyResponseChart; fillTextLog: string[] } {
  const fillTextLog: string[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => makeFakeCtx(fillTextLog) as unknown as RenderingContext
  );
  const container = document.createElement("div");
  document.body.appendChild(container);
  return { chart: new FrequencyResponseChart(container), fillTextLog };
}

describe("FrequencyResponseChart x-axis floor (issue #28 second-pass review findings #3/#7)", () => {
  it("rateHz keeps a 0.5 Hz bin — below the frequency-mode floor — INSIDE the plotted extent", () => {
    const chart = buildChart();
    chart.setXKind("rateHz");
    chart.setData(makeData([0.5, 1, 2, 4, 8]), "Left");
    chart.relayout(); // force resize (0×0 in jsdom by default) -> a real drawStatic pass

    const fullLogMin = (chart as unknown as { fullLogMin: number }).fullLogMin;
    // Pinned: log10(0.5) ≈ -0.30103 — the 0.5 Hz bin sets the floor itself,
    // the 0.1 Hz clamp never engages because nothing here is below it.
    expect(fullLogMin).toBeCloseTo(Math.log10(0.5), 6);
  });

  it("rateHz floors sub-0.1 Hz content AT 0.1 Hz, never lower (the clamp still exists, just moved)", () => {
    const chart = buildChart();
    chart.setXKind("rateHz");
    chart.setData(makeData([0.02, 0.5, 1, 2]), "Left");
    chart.relayout();

    const fullLogMin = (chart as unknown as { fullLogMin: number }).fullLogMin;
    expect(fullLogMin).toBeCloseTo(Math.log10(0.1), 6);
  });

  it("frequency mode is STRICTLY unchanged: the same 0.5 Hz bin is clamped away at the 1 Hz floor", () => {
    const chart = buildChart();
    // xKind defaults to "frequency" — no setXKind call.
    chart.setData(makeData([0.5, 1, 2, 4, 8]), "Left");
    chart.relayout();

    const fullLogMin = (chart as unknown as { fullLogMin: number }).fullLogMin;
    expect(fullLogMin).toBeCloseTo(Math.log10(1), 6);
  });
});

/**
 * "rateHz" is the only X-axis kind whose unit isn't already implied by
 * established convention (a 20 Hz–20 kHz sweep reads as Hz on sight; a
 * 0.5–200 Hz modulation-rate axis does not — user report on the wow &
 * flutter tile). This pins that the chart draws an explicit "Hz" tag in
 * that mode ONLY — "frequency" and "level" must render byte-for-byte as
 * before (no new fillText calls, no layout change).
 */
describe("FrequencyResponseChart X-axis unit tag (issue #28 review — rateHz ambiguity)", () => {
  it('draws a "Hz" tag when xKind is "rateHz"', () => {
    const { chart, fillTextLog } = buildChartWithFillTextLog();
    chart.setXKind("rateHz");
    chart.setData(makeData([0.5, 1, 2, 4, 8]), "Left");
    chart.relayout();

    expect(fillTextLog).toContain("Hz");
  });

  it('does NOT draw a "Hz" tag in "frequency" mode (default xKind, unchanged)', () => {
    const { chart, fillTextLog } = buildChartWithFillTextLog();
    // xKind defaults to "frequency" — no setXKind call.
    chart.setData(makeData([20, 100, 1000, 10000]), "Left");
    chart.relayout();

    expect(fillTextLog).not.toContain("Hz");
  });

  it('does NOT draw a "Hz" tag in "level" mode (THD-vs-level, issue #27, unchanged)', () => {
    const { chart, fillTextLog } = buildChartWithFillTextLog();
    chart.setXKind("level");
    chart.setData(makeData([-60, -40, -20, 0]), "Left");
    chart.relayout();

    expect(fillTextLog).not.toContain("Hz");
  });
});

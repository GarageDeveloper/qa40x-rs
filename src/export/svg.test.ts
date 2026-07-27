import { describe, it, expect } from "vitest";
import {
  fmtSeconds,
  fmtTick,
  linTicks,
  logTicks,
  renderTileSvg,
  xmlEscape,
  type SvgSpec,
} from "./svg";

function spec(over: Partial<SvgSpec> = {}): SvgSpec {
  return {
    title: "Spectrum — Input L",
    footer: ["qa40x-rs v0.3.0"],
    provenance: ["# qa40x-rs data export", "# device_model=QA403"],
    unitLabel: "dBV",
    xUnitLabel: "Hz",
    xLog: true,
    series: [
      {
        label: "Input L",
        color: "#3987e5",
        x: Float64Array.from([20, 1000, 20000]),
        y: Float64Array.from([-80, -3, -60]),
      },
    ],
    ...over,
  };
}

describe("svg helpers", () => {
  it("linTicks lands on 1/2/5 steps inside the domain", () => {
    expect(linTicks(-140, 10)).toEqual([-140, -120, -100, -80, -60, -40, -20, 0]);
    expect(linTicks(0, 1)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
  });

  it("logTicks spans decades, with 2/5 subs on narrow spans", () => {
    expect(logTicks(20, 20000)).toEqual([20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]);
    expect(logTicks(1, 1e6)).toEqual([1, 10, 100, 1000, 10000, 100000, 1000000]);
  });

  it("formats compact ticks and engineering seconds", () => {
    expect(fmtTick(20000)).toBe("20k");
    expect(fmtTick(0.5)).toBe("0.5");
    expect(fmtSeconds(0.0025)).toBe("2.5 ms");
    expect(fmtSeconds(0)).toBe("0");
    expect(xmlEscape('a<b&"c"')).toBe('a&lt;b&amp;"c"');
  });
});

describe("renderTileSvg", () => {
  it("is a standalone document: white background, one path per series, embedded provenance", () => {
    const svg = renderTileSvg(
      spec({
        series: [
          ...spec().series,
          {
            label: "Input R",
            color: "#199e70",
            x: Float64Array.from([20, 20000]),
            y: Float64Array.from([-90, -70]),
          },
        ],
      })
    );
    expect(svg).not.toBeNull();
    expect(svg!.startsWith("<svg xmlns=")).toBe(true);
    expect(svg).toContain('fill="#ffffff"');
    expect((svg!.match(/<path d="M/g) ?? []).length).toBe(2);
    expect(svg).toContain('stroke="#3987e5"');
    expect(svg).toContain('stroke="#199e70"');
    // The FULL provenance block rides inside the file, XML-escaped.
    expect(svg).toContain("<metadata># qa40x-rs data export\n# device_model=QA403</metadata>");
    expect(svg).toContain("Spectrum — Input L");
    expect(svg).toContain(">dBV</text>");
    expect(svg).toContain(">Hz</text>");
  });

  it("maps a log x axis: 1 kHz sits mid-way between 20 Hz and 50 kHz-ish extents", () => {
    // 20 → 20000 spans 3 decades; 632.45 ≈ 20·10^1.5 is the geometric
    // middle. Pull the drawn x of the middle sample out of the path data.
    const svg = renderTileSvg(
      spec({
        series: [
          {
            label: "L",
            color: "#000000",
            x: Float64Array.from([20, 632.455532, 20000]),
            y: Float64Array.from([0, 0, 0]),
          },
        ],
        yDomain: [-1, 1],
      })
    )!;
    const d = /<path d="M([\d.]+) [\d.]+ L([\d.]+) [\d.]+ L([\d.]+) /.exec(svg)!;
    const [x0, xm, x1] = [Number(d[1]), Number(d[2]), Number(d[3])];
    expect(xm - x0).toBeCloseTo((x1 - x0) / 2, 0);
  });

  it("lifts the pen over non-finite samples instead of bridging the gap", () => {
    const svg = renderTileSvg(
      spec({
        xLog: false,
        series: [
          {
            label: "L",
            color: "#000000",
            x: Float64Array.from([0, 1, 2, 3]),
            y: Float64Array.from([0, -Infinity, 0.5, 0.2]),
          },
        ],
      })
    )!;
    // Two disconnected segments → two M commands within ONE path.
    const d = /<path d="([^"]+)"/.exec(svg)![1];
    expect((d.match(/M/g) ?? []).length).toBe(2);
  });

  it("returns null when nothing is drawable", () => {
    expect(renderTileSvg(spec({ series: [] }))).toBeNull();
    expect(
      renderTileSvg(
        spec({
          series: [
            {
              label: "L",
              color: "#000",
              x: Float64Array.from([1, 2]),
              y: Float64Array.from([NaN, Infinity]),
            },
          ],
        })
      )
    ).toBeNull();
    // A log axis with only non-positive x has no drawable domain either.
    expect(
      renderTileSvg(
        spec({
          series: [
            {
              label: "L",
              color: "#000",
              x: Float64Array.from([-60, -10, 0]),
              y: Float64Array.from([1, 2, 3]),
            },
          ],
        })
      )
    ).toBeNull();
  });
});

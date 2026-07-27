import { describe, it, expect } from "vitest";
import { initialState, type AppState, type TraceMeta } from "../store/state";
import type { ScopeVM, SpectrumVM, SweepVM } from "../store/selectors/chartvm";
import {
  benchProvenance,
  columnsCsv,
  numCell,
  provenanceComments,
  sweepXHeader,
  textCell,
  tileScopeCsv,
  tileSpectrumCsv,
  tileSweepCsv,
  traceFdCsv,
  traceSourceLine,
  traceSweepCsv,
  traceTdCsv,
} from "./csv";

/* ------------------------------------------------------------------ */
/* Fixtures                                                             */
/* ------------------------------------------------------------------ */

function meta(over: Partial<TraceMeta> = {}): TraceMeta {
  return {
    id: "t1",
    label: "Input L",
    color: "#fff",
    source: { kind: "hw_input", channel: "left" },
    domains: ["td", "fd"],
    seq: 1,
    offsetDb: null,
    ...over,
  };
}

function stateWithDevice(): AppState {
  const s = initialState();
  return {
    ...s,
    device: {
      ...s.device,
      info: {
        model: "QA403",
        firmware_version: 61,
        serial: "AB12_CD34",
        product: "QA403 Audio Analyzer",
        sample_rates: [48000],
        supports_flash: false,
        capabilities: s.device.info?.capabilities ?? ({} as never),
        is_virtual: false,
      },
      config: { input_gain: 42, output_gain: 18, sample_rate: 48000 },
      offsets: { input_l: 32.1, input_r: 32.2, output_l: 8.1, output_r: 8.2, calibrated: true },
    },
    acquisition: {
      ...s.acquisition,
      fftSize: 32768,
      window: "flattop",
      averaging: { mode: "power", count: 8 },
      coherentGen: true,
    },
  };
}

const rows = (csv: string): string[] => csv.trimEnd().split("\n");
const dataRows = (csv: string): string[] => rows(csv).filter((l) => !l.startsWith("#"));

/* ------------------------------------------------------------------ */
/* Cells / assembly                                                     */
/* ------------------------------------------------------------------ */

describe("csv cells", () => {
  it("numCell uses '.' decimals, keeps exponent form, blanks non-finite", () => {
    expect(numCell(1.5)).toBe("1.5");
    expect(numCell(1e-7)).toBe("1e-7");
    expect(numCell(-Infinity)).toBe("");
    expect(numCell(NaN)).toBe("");
  });

  it("textCell quotes only when needed and doubles quotes", () => {
    expect(textCell("Input L (dBV)")).toBe("Input L (dBV)");
    expect(textCell('a,b "c"')).toBe('"a,b ""c"""');
  });

  it("columnsCsv pads unequal columns with empty cells", () => {
    const csv = columnsCsv([], [
      { header: "a", values: Float64Array.from([1, 2, 3]) },
      { header: "b", values: Float64Array.from([9]) },
    ]);
    expect(rows(csv)).toEqual(["a,b", "1,9", "2,", "3,"]);
  });
});

/* ------------------------------------------------------------------ */
/* Provenance                                                           */
/* ------------------------------------------------------------------ */

describe("benchProvenance", () => {
  it("carries app, device identity (#25), acquisition, ranges and calibration", () => {
    const lines = provenanceComments(
      benchProvenance(stateWithDevice(), "0.3.0", "2026-07-27T10:00:00.000Z")
    );
    expect(lines[0]).toBe("# qa40x-rs data export");
    for (const expected of [
      "# format_version=1",
      "# app_version=0.3.0",
      "# exported_at=2026-07-27T10:00:00.000Z",
      "# device_model=QA403",
      "# device_serial=AB12_CD34",
      "# device_firmware=61",
      "# device_virtual=false",
      "# sample_rate_hz=48000",
      "# input_range_dbv=42",
      "# output_range_dbv=18",
      "# fft_size=32768",
      "# window=flattop",
      "# averaging=power",
      "# averaging_count=8",
      "# round_to_bin=true",
      "# calibrated=true",
      "# offset_input_l_db=32.1",
    ]) {
      expect(lines).toContain(expected);
    }
  });

  it("degrades honestly with no device connected", () => {
    const lines = provenanceComments(
      benchProvenance(initialState(), "0.3.0", "2026-07-27T10:00:00.000Z")
    );
    expect(lines).toContain("# device_model=none");
    expect(lines.some((l) => l.startsWith("# device_serial"))).toBe(false);
    expect(lines).toContain("# calibrated=false");
    // averaging off → no count line
    expect(lines.some((l) => l.startsWith("# averaging_count"))).toBe(false);
  });
});

describe("traceSourceLine", () => {
  const s = initialState();

  it("names hardware endpoints", () => {
    expect(traceSourceLine(s, meta())).toBe("hardware input L");
    expect(
      traceSourceLine(s, meta({ source: { kind: "hw_output", channel: "right" } }))
    ).toBe("hardware output R");
  });

  it("resolves frozen/transform references to labels while they exist", () => {
    const base = s.traces.order[0];
    const label = s.traces.byId[base].label;
    expect(
      traceSourceLine(s, meta({ source: { kind: "memory", frozenFrom: base, ratio: true } }))
    ).toBe(`frozen copy of ${label} (ratio)`);
    expect(
      traceSourceLine(
        s,
        meta({
          source: {
            kind: "transform",
            input: base,
            steps: [{ type: "weighting", mode: "a" }, { type: "notch", freq: 1000, q: null }],
          },
        })
      )
    ).toBe(`transform of ${label} [weighting → notch]`);
    // A deleted referent degrades to the raw id — never throws.
    expect(
      traceSourceLine(s, meta({ source: { kind: "memory", frozenFrom: "gone" } }))
    ).toBe("frozen copy of gone");
  });
});

/* ------------------------------------------------------------------ */
/* Tile exports                                                         */
/* ------------------------------------------------------------------ */

describe("tileSpectrumCsv", () => {
  const series = (label: string, x: number[], y: number[]) => ({
    id: label,
    label,
    color: "#fff",
    x: Float64Array.from(x),
    y: Float64Array.from(y),
    seq: 1,
  });

  it("shares one frequency column when every series is on the same grid", () => {
    const vm: SpectrumVM = {
      unitLabel: "dBV",
      harmonics: [],
      series: [series("Input L", [0, 10], [-3, -6]), series("Input R", [0, 10], [-9, -12])],
    };
    const csv = tileSpectrumCsv(vm, ["# a=b"]);
    expect(rows(csv)).toEqual([
      "# a=b",
      "frequency_hz,Input L (dBV),Input R (dBV)",
      "0,-3,-9",
      "10,-6,-12",
    ]);
  });

  it("gives each series its own x column on distinct grids", () => {
    const vm: SpectrumVM = {
      unitLabel: "dBFS",
      harmonics: [],
      series: [series("A", [0, 10], [-3, -6]), series("B", [0, 5, 10], [-1, -2, -3])],
    };
    const head = dataRows(tileSpectrumCsv(vm, []))[0];
    expect(head).toBe("frequency_hz (A),A (dBFS),frequency_hz (B),B (dBFS)");
  });
});

describe("tileScopeCsv", () => {
  it("derives a shared time axis from the sample rate", () => {
    const vm: ScopeVM = {
      unitLabel: "V",
      trigger: null,
      series: [
        {
          id: "a",
          label: "Input L",
          color: "#fff",
          samples: Float64Array.from([0, 1, 0, -1]),
          sampleRate: 4,
          seq: 1,
        },
      ],
    };
    expect(dataRows(tileScopeCsv(vm, []))).toEqual([
      "time_s,Input L (V)",
      "0,0",
      "0.25,1",
      "0.5,0",
      "0.75,-1",
    ]);
  });
});

describe("tileSweepCsv", () => {
  it("labels the x axis by unit and appends phase columns when carried", () => {
    expect(sweepXHeader("dBFS")).toBe("level_dbfs");
    expect(sweepXHeader("rateHz")).toBe("rate_hz");
    const vm: SweepVM = {
      unitLabel: "dB",
      xUnit: "Hz",
      omitted: [],
      series: [
        {
          id: "p",
          label: "FR Left",
          curveLabel: "Left",
          color: "#fff",
          x: Float64Array.from([20, 20000]),
          y: Float64Array.from([-0.1, -3]),
          phaseDeg: Float64Array.from([0, -90]),
          seq: 1,
        },
      ],
    };
    expect(dataRows(tileSweepCsv(vm, []))).toEqual([
      "frequency_hz,FR Left (dB),FR Left phase (deg)",
      "20,-0.1,0",
      "20000,-3,-90",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* Trace exports                                                        */
/* ------------------------------------------------------------------ */

describe("traceTdCsv", () => {
  const td = { sampleRate: 2, samples: Float64Array.from([0.5, -0.5]) };

  it("writes full-scale samples, plus volts when the offset is known", () => {
    const csv = traceTdCsv(meta({ offsetDb: 20 }), td, []);
    expect(rows(csv)).toEqual([
      "# trace_sample_rate_hz=2",
      "time_s,amplitude_fs,amplitude_v",
      "0,0.5,5",
      "0.5,-0.5,-5",
    ]);
  });

  it("omits the volts column with no converter offset yet", () => {
    expect(dataRows(traceTdCsv(meta(), td, []))[0]).toBe("time_s,amplitude_fs");
  });
});

describe("traceFdCsv", () => {
  const fd = { freqs: Float64Array.from([100]), magDb: Float64Array.from([-6]) };

  it("writes dBFS plus a derived dBV column when the offset is known", () => {
    expect(dataRows(traceFdCsv(meta({ offsetDb: 32 }), fd, [], false))).toEqual([
      "frequency_hz,magnitude_dbfs,magnitude_dbv",
      "100,-6,26",
    ]);
  });

  it("labels a ratio trace relative — no absolute columns", () => {
    expect(dataRows(traceFdCsv(meta({ offsetDb: 32 }), fd, [], true))[0]).toBe(
      "frequency_hz,magnitude_db_rel"
    );
  });
});

describe("traceSweepCsv", () => {
  it("suffixes curve labels on multi-curve traces and honors frame units", () => {
    const sweep = {
      freqs: Float64Array.from([0.5, 4]),
      curves: [
        { label: "Left", values: Float64Array.from([0.1, 0.05]), phaseDeg: null },
        { label: "Right", values: Float64Array.from([0.2, 0.1]), phaseDeg: null },
      ],
      xUnit: "rateHz" as const,
      yUnit: "%" as const,
    };
    expect(dataRows(traceSweepCsv(meta({ label: "W&F" }), sweep, []))).toEqual([
      "rate_hz,W&F Left (%),W&F Right (%)",
      "0.5,0.1,0.2",
      "4,0.05,0.1",
    ]);
  });
});

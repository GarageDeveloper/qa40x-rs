import { describe, it, expect } from "vitest";
import {
  initialState,
  DEFAULT_SWEEP_PARAMS,
  type AppState,
  type CaptureProvenance,
  type TraceMeta,
} from "../store/state";
import type { ScopeVM, SpectrumVM, SweepVM } from "../store/selectors/chartvm";
import {
  benchProvenance,
  clipScopeWindow,
  columnsCsv,
  numCell,
  provenanceComments,
  sweepXHeader,
  textCell,
  tileScopeCsv,
  tileSpectrumCsv,
  tileSweepCsv,
  traceFdCsv,
  traceProvenance,
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
    capture: null,
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
    expect(rows(csv)).toEqual(["a;b", "1;9", "2;", "3;"]);
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

  it("device connected but not yet configured: identity lines, no ranges/offsets", () => {
    // A real transient bench state (right after connect, before the config
    // readback lands): `info` is set, `config`/`offsets` are still null. The
    // header must not fabricate a sample rate or "calibrated=true" it never
    // measured.
    const s = stateWithDevice();
    const lines = provenanceComments(
      benchProvenance(
        { ...s, device: { ...s.device, config: null, offsets: null } },
        "0.3.0",
        "2026-07-27T10:00:00.000Z"
      )
    );
    expect(lines).toContain("# device_model=QA403");
    expect(lines).toContain("# device_serial=AB12_CD34");
    expect(lines.some((l) => l.startsWith("# sample_rate_hz"))).toBe(false);
    expect(lines.some((l) => l.startsWith("# input_range_dbv"))).toBe(false);
    expect(lines.some((l) => l.startsWith("# output_range_dbv"))).toBe(false);
    expect(lines).toContain("# calibrated=false");
    expect(lines.some((l) => l.startsWith("# offset_input"))).toBe(false);
  });
});

describe("traceProvenance (issue #40: capture snapshot preferred over the live bench)", () => {
  /** A snapshot that MATCHES `stateWithDevice()`'s live bench exactly. */
  function liveMatchingCapture(over: Partial<CaptureProvenance> = {}): CaptureProvenance {
    return {
      device: { model: "QA403", serial: "AB12_CD34", firmware: 61, isVirtual: false },
      sampleRateHz: 48000,
      inputRangeDbv: 42,
      outputRangeDbv: 18,
      offsets: { input_l: 32.1, input_r: 32.2, output_l: 8.1, output_r: 8.2, calibrated: true },
      fftSize: 32768,
      window: "flattop",
      averaging: { mode: "power", count: 8 },
      capturedAt: null,
      ...over,
    };
  }
  const at = "2026-07-27T10:00:00.000Z";
  const asLines = (s: AppState, c: CaptureProvenance | null): string[] =>
    provenanceComments(traceProvenance(s, c, "0.3.0", at));

  it("no snapshot → exactly the classic bench header", () => {
    const s = stateWithDevice();
    expect(traceProvenance(s, null, "0.3.0", at)).toEqual(benchProvenance(s, "0.3.0", at));
  });

  it("a LIVE snapshot matching the bench adds nothing — the header stays lean", () => {
    const s = stateWithDevice();
    expect(asLines(s, liveMatchingCapture())).toEqual(
      provenanceComments(benchProvenance(s, "0.3.0", at))
    );
  });

  it("a pinned instant (frozen ❄) emits the capture_* block and swaps the note", () => {
    const lines = asLines(
      stateWithDevice(),
      liveMatchingCapture({ capturedAt: "2026-07-26T08:00:00.000Z" })
    );
    for (const want of [
      "# capture_device_model=QA403",
      "# capture_device_serial=AB12_CD34",
      "# capture_device_firmware=61",
      "# capture_device_virtual=false",
      "# capture_sample_rate_hz=48000",
      "# capture_input_range_dbv=42",
      "# capture_output_range_dbv=18",
      "# capture_fft_size=32768",
      "# capture_window=flattop",
      "# capture_averaging=power",
      "# capture_averaging_count=8",
      "# capture_calibrated=true",
      "# capture_offset_input_l_db=32.1",
      "# capture_time=2026-07-26T08:00:00.000Z",
    ]) {
      expect(lines).toContain(want);
    }
    // The export-time bench block STAYS (additive keys, format_version=1),
    // and the note now explains the two contexts instead of disclaiming.
    expect(lines).toContain("# device_model=QA403");
    expect(lines).toContain("# format_version=1");
    expect(
      lines.some((l) => l.startsWith("# note=capture_* keys describe the bench"))
    ).toBe(true);
  });

  it("the QA403-froze-then-bench-moved case: capture_* contradicts the live keys", () => {
    // Measure on a QA403, freeze, reconfigure the bench (96 kHz) — the
    // frozen trace's export must carry ITS bench, not just the current one
    // (issue #40's founding example).
    const s = stateWithDevice();
    const moved: AppState = {
      ...s,
      device: { ...s.device, config: { ...s.device.config!, sample_rate: 96000 } },
    };
    const lines = asLines(moved, liveMatchingCapture({ capturedAt: at }));
    expect(lines).toContain("# sample_rate_hz=96000");
    expect(lines).toContain("# capture_sample_rate_hz=48000");
  });

  it("a live snapshot is ALSO emitted once the bench has moved under it (no pinned instant needed)", () => {
    const s = stateWithDevice();
    const moved: AppState = {
      ...s,
      device: { ...s.device, config: { ...s.device.config!, input_gain: 0 } },
    };
    const lines = asLines(moved, liveMatchingCapture());
    expect(lines).toContain("# capture_input_range_dbv=42");
    expect(lines).toContain("# input_range_dbv=0");
  });

  it("derived / mixed markers and the program params snapshot ride along", () => {
    const lines = asLines(
      stateWithDevice(),
      liveMatchingCapture({
        derived: true,
        mixed: true,
        programParams: { ...DEFAULT_SWEEP_PARAMS },
      })
    );
    expect(lines).toContain("# capture_derived=true");
    expect(lines).toContain("# capture_mixed=true");
    const params = lines.find((l) => l.startsWith("# capture_program_params="));
    expect(params).toBeDefined();
    expect(JSON.parse(params!.slice("# capture_program_params=".length))).toEqual(
      DEFAULT_SWEEP_PARAMS
    );
  });

  it("degrades honestly: a snapshot with no device says so", () => {
    const lines = asLines(
      stateWithDevice(),
      liveMatchingCapture({ device: null, offsets: null, capturedAt: at })
    );
    expect(lines).toContain("# capture_device_model=none");
    expect(lines).toContain("# capture_calibrated=false");
    expect(lines.some((l) => l.startsWith("# capture_offset_input"))).toBe(false);
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
      dbrRefDb: null,
      series: [series("Input L", [0, 10], [-3, -6]), series("Input R", [0, 10], [-9, -12])],
    };
    const csv = tileSpectrumCsv(vm, ["# a=b"]);
    expect(rows(csv)).toEqual([
      "# a=b",
      "frequency_hz;Input L (dBV);Input R (dBV)",
      "0;-3;-9",
      "10;-6;-12",
    ]);
  });

  it("gives each series its own x column on distinct grids", () => {
    const vm: SpectrumVM = {
      unitLabel: "dBFS",
      harmonics: [],
      dbrRefDb: null,
      series: [series("A", [0, 10], [-3, -6]), series("B", [0, 5, 10], [-1, -2, -3])],
    };
    const head = dataRows(tileSpectrumCsv(vm, []))[0];
    expect(head).toBe("frequency_hz (A);A (dBFS);frequency_hz (B);B (dBFS)");
  });

  it("quotes a series label that itself contains a comma", () => {
    // A trace label with a comma (e.g. a user-renamed "Left, 2nd") must not
    // silently shift the CSV's column count — textCell wraps the whole
    // header cell in quotes, exactly like columnsCsv's unit tests, but here
    // exercised through the real tile assembly path.
    const vm: SpectrumVM = {
      unitLabel: "dBV",
      harmonics: [],
      dbrRefDb: null,
      series: [series("Left, 2nd", [0, 10], [-3, -6])],
    };
    const head = rows(tileSpectrumCsv(vm, []))[0];
    expect(head).toBe('frequency_hz;"Left, 2nd (dBV)"');
  });
});

describe("clipScopeWindow", () => {
  const series = (samples: number[], sampleRate: number) => ({
    id: "a",
    label: "Input L",
    color: "#fff",
    samples: Float64Array.from(samples),
    sampleRate,
    seq: 1,
  });

  it("clips each series to the renderer's own displayCount rule", () => {
    // 10 ms @ 1 kHz → round(10) = 10 samples out of 16 — the exported file
    // must match the DRAWN extent (review finding #3), not the capture.
    const vm: ScopeVM = { unitLabel: "V", trigger: null, series: [series(Array.from({ length: 16 }, (_, i) => i), 1000)] };
    const clipped = clipScopeWindow(vm, 10);
    expect(clipped.series[0].samples.length).toBe(10);
    expect(Array.from(clipped.series[0].samples)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("keeps everything on a 'full' window, clamps to the data and to a 2-sample floor", () => {
    const vm: ScopeVM = { unitLabel: "V", trigger: null, series: [series([1, 2, 3], 1000)] };
    // null window = full capture, untouched (same object shape).
    expect(clipScopeWindow(vm, null).series[0].samples.length).toBe(3);
    // A window longer than the data never over-reads.
    expect(clipScopeWindow(vm, 60_000).series[0].samples.length).toBe(3);
    // A sub-sample window still keeps the renderer's 2-sample minimum.
    expect(clipScopeWindow(vm, 0.5).series[0].samples.length).toBe(2);
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
      "time_s;Input L (V)",
      "0;0",
      "0.25;1",
      "0.5;0",
      "0.75;-1",
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
          yUnitLabel: "dB",
        },
      ],
    };
    expect(dataRows(tileSweepCsv(vm, []))).toEqual([
      "frequency_hz;FR Left (dB);FR Left phase (deg)",
      "20;-0.1;0",
      "20000;-3;-90",
    ]);
  });

  it("labels each column with its OWN trace's y unit — a dB and a % sweep sharing a tile", () => {
    // The tile-level unitLabel is fixed by the FIRST member only (chartvm);
    // stamping it on every column mislabeled a THD-% column as dB (review
    // finding #5) — a persisted, machine-parsed wrong claim.
    const vm: SweepVM = {
      unitLabel: "dB",
      xUnit: "Hz",
      omitted: [],
      series: [
        {
          id: "a",
          label: "THD dB",
          curveLabel: null,
          color: "#fff",
          x: Float64Array.from([20, 20000]),
          y: Float64Array.from([-80, -70]),
          phaseDeg: null,
          seq: 1,
          yUnitLabel: "dB",
        },
        {
          id: "b",
          label: "THD pct",
          curveLabel: null,
          color: "#fff",
          x: Float64Array.from([20, 20000]),
          y: Float64Array.from([0.01, 0.031]),
          phaseDeg: null,
          seq: 1,
          yUnitLabel: "%",
        },
      ],
    };
    expect(dataRows(tileSweepCsv(vm, []))[0]).toBe(
      "frequency_hz;THD dB (dB);THD pct (%)"
    );
  });

  it("gives each series its own x column with phase, on distinct grids; pads the shorter one", () => {
    // A tile mixing two FR sweeps with different point counts (e.g. one
    // finished a re-run at a coarser resolution) — same "distinct grids"
    // branch as tileSpectrumCsv, but exercising phaseDeg AND row padding
    // together, which the shared-x test above never reaches.
    const vm: SweepVM = {
      unitLabel: "dB",
      xUnit: "Hz",
      omitted: [],
      series: [
        {
          id: "a",
          label: "FR Left",
          curveLabel: "Left",
          color: "#fff",
          x: Float64Array.from([20, 200, 20000]),
          y: Float64Array.from([-0.1, -0.2, -3]),
          phaseDeg: Float64Array.from([0, -10, -90]),
          seq: 1,
          yUnitLabel: "dB",
        },
        {
          id: "b",
          label: "FR Right",
          curveLabel: "Right",
          color: "#fff",
          x: Float64Array.from([20, 20000]),
          y: Float64Array.from([-0.2, -3.5]),
          phaseDeg: null,
          seq: 1,
          yUnitLabel: "dB",
        },
      ],
    };
    const csvRows = dataRows(tileSweepCsv(vm, []));
    expect(csvRows[0]).toBe(
      "frequency_hz (FR Left);FR Left (dB);FR Left phase (deg);frequency_hz (FR Right);FR Right (dB)"
    );
    expect(csvRows).toHaveLength(4); // header + the longer series' 3 rows
    // The shorter series' row 3 pads with empty cells, not zeros.
    expect(csvRows[3]).toBe("20000;-3;-90;;");
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
      "time_s;amplitude_fs;amplitude_v",
      "0;0.5;5",
      "0.5;-0.5;-5",
    ]);
  });

  it("omits the volts column with no converter offset yet", () => {
    expect(dataRows(traceTdCsv(meta(), td, []))[0]).toBe("time_s;amplitude_fs");
  });
});

describe("traceFdCsv", () => {
  const fd = { freqs: Float64Array.from([100]), magDb: Float64Array.from([-6]) };

  it("writes dBFS plus a derived dBV column when the offset is known", () => {
    expect(dataRows(traceFdCsv(meta({ offsetDb: 32 }), fd, [], false))).toEqual([
      "frequency_hz;magnitude_dbfs;magnitude_dbv",
      "100;-6;26",
    ]);
  });

  it("labels a ratio trace relative — no absolute columns", () => {
    expect(dataRows(traceFdCsv(meta({ offsetDb: 32 }), fd, [], true))[0]).toBe(
      "frequency_hz;magnitude_db_rel"
    );
  });
});

describe("traceSweepCsv", () => {
  it("suffixes curve labels on multi-curve traces and honors caller-resolved units", () => {
    const sweep = {
      freqs: Float64Array.from([0.5, 4]),
      curves: [
        { label: "Left", values: Float64Array.from([0.1, 0.05]), phaseDeg: null },
        { label: "Right", values: Float64Array.from([0.2, 0.1]), phaseDeg: null },
      ],
      xUnit: "rateHz" as const,
      yUnit: "%" as const,
    };
    expect(dataRows(traceSweepCsv(meta({ label: "W&F" }), sweep, [], "rateHz", "%"))).toEqual([
      "rate_hz;W&F Left (%);W&F Right (%)",
      "0.5;0.1;0.2",
      "4;0.05;0.1",
    ]);
  });

  it("appends a phase column when the frame carries one (FR sweep frame)", () => {
    // Unlike the multi-curve case above, this pins the single-curve path
    // (no " Left"/" Right" suffix) together with phaseDeg — the trace-export
    // twin of tileSweepCsv's phase test, but reading the raw frames-cache
    // shape instead of a chartvm SweepSeriesVM.
    const sweep = {
      freqs: Float64Array.from([20, 20000]),
      curves: [
        { label: "Left", values: Float64Array.from([-0.1, -3]), phaseDeg: Float64Array.from([0, -90]) },
      ],
      xUnit: "Hz" as const,
      yUnit: "dB" as const,
    };
    expect(dataRows(traceSweepCsv(meta({ label: "FR" }), sweep, [], "Hz", "dB"))).toEqual([
      "frequency_hz;FR (dB);FR phase (deg)",
      "20;-0.1;0",
      "20000;-3;-90",
    ]);
  });
});

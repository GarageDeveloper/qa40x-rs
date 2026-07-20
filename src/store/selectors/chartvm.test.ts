/**
 * chartvm selectors — the unit/offset math applied BEFORE the renderers.
 *
 * The #48/#50/#51/#58/#60 invariant, at selector level: each trace converts
 * through its OWN converter's offset, so an ADC offset change must move
 * Input curves and MUST NOT move a DAC (Output) curve — in the spectrum
 * (fd, #51) AND in the scope volts (td, #60: the twin).
 */
import { describe, expect, it, beforeEach } from "vitest";
import { clearAllFrames, putFrames } from "../../data/frames";
import { initialState, type AppState, type TileConfig } from "../state";
import { HW_TRACE_IDS } from "../state";
import { DBU_OVER_DBV_DB } from "../../core/units";
import { displayOffsetDb, displayScale, scopeVM, spectrumVM, sweepVM } from "./chartvm";

const FREQS = Float64Array.from([100, 1000, 10000]);

function seedFd(id: string, magDb: number[], seq = 1): void {
  putFrames(id, seq, { fd: { freqs: FREQS, magDb: Float64Array.from(magDb) } });
}

function seedTd(id: string, samples: number[], seq = 1): void {
  putFrames(id, seq, { td: { sampleRate: 48000, samples: Float64Array.from(samples) } });
}

/** State with the first tile showing `traces`, plus per-trace offset/seq. */
function stateWith(
  traces: string[],
  patches: Partial<Record<string, { offsetDb?: number; seq?: number }>> = {}
): AppState {
  const s = initialState();
  s.layout.tiles["tile-1"].traces = traces;
  for (const [id, patch] of Object.entries(patches)) {
    const t = s.traces.byId[id];
    if (t && patch) Object.assign(t, patch);
  }
  return s;
}

function tile(s: AppState): TileConfig {
  return s.layout.tiles["tile-1"];
}

describe("displayOffsetDb", () => {
  it("dBFS is identity — the wire already is each converter's own dBFS", () => {
    expect(displayOffsetDb("dbfs", 20.81)).toBe(0);
  });

  it("dBV adds the trace's own converter offset", () => {
    expect(displayOffsetDb("dbv", 20.81)).toBeCloseTo(20.81, 9);
  });

  it("dBu is dBV plus the fixed dBu-over-dBV constant", () => {
    expect(displayOffsetDb("dbu", 3.01)).toBeCloseTo(3.01 + DBU_OVER_DBV_DB, 9);
    expect(DBU_OVER_DBV_DB).toBeCloseTo(2.2185, 3);
  });
});

describe("displayScale (td twin, #60)", () => {
  it("%FS ignores the converter — it is converter-relative by definition", () => {
    expect(displayScale("pctfs", 20.81)).toBe(100);
  });

  it("V scales a full-scale sample by the trace's own offset", () => {
    expect(displayScale("v", 20)).toBeCloseTo(10, 9);
    expect(displayScale("mv", 20)).toBeCloseTo(10_000, 6);
  });
});

describe("spectrumVM", () => {
  beforeEach(() => clearAllFrames());

  it("emits one series per member trace that has an fd frame", () => {
    seedFd(HW_TRACE_IDS.inputL, [-100, -12, -100]);
    seedFd(HW_TRACE_IDS.outputL, [-110, -20, -110]);
    const s = stateWith(
      [HW_TRACE_IDS.inputL, HW_TRACE_IDS.outputL, HW_TRACE_IDS.inputR],
      {
        [HW_TRACE_IDS.inputL]: { offsetDb: 20.81, seq: 1 },
        [HW_TRACE_IDS.outputL]: { offsetDb: 11.01, seq: 1 },
        // inputR is a member but has no frame → absent
      }
    );
    const vm = spectrumVM(s, tile(s));
    expect(vm.series.map((x) => x.id)).toEqual([
      HW_TRACE_IDS.inputL,
      HW_TRACE_IDS.outputL,
    ]);
  });

  it("converts each trace through its OWN converter offset (dBV)", () => {
    seedFd(HW_TRACE_IDS.inputL, [-100, -12, -100]);
    seedFd(HW_TRACE_IDS.outputL, [-110, -20, -110]);
    const s = stateWith([HW_TRACE_IDS.inputL, HW_TRACE_IDS.outputL], {
      [HW_TRACE_IDS.inputL]: { offsetDb: 20.81, seq: 1 },
      [HW_TRACE_IDS.outputL]: { offsetDb: 11.01, seq: 1 },
    });
    tile(s).fdUnit = "dbv";
    const [inL, outL] = spectrumVM(s, tile(s)).series;
    expect(inL.y[1]).toBeCloseTo(-12 + 20.81, 6);
    expect(outL.y[1]).toBeCloseTo(-20 + 11.01, 6);
  });

  it("an ADC offset change moves Input curves and NEVER a DAC curve (#51)", () => {
    seedFd(HW_TRACE_IDS.inputL, [-100, -12, -100]);
    seedFd(HW_TRACE_IDS.outputL, [-110, -20, -110]);
    const members = [HW_TRACE_IDS.inputL, HW_TRACE_IDS.outputL];
    const base = {
      [HW_TRACE_IDS.inputL]: { offsetDb: 20.81, seq: 1 },
      [HW_TRACE_IDS.outputL]: { offsetDb: 11.01, seq: 1 },
    };
    const before = stateWith(members, base);
    tile(before).fdUnit = "dbv";
    // An input-range step re-references the ADC only: input offset moves by
    // +12 dB (range 42→30), the DAC offset is untouched.
    const after = stateWith(members, {
      ...base,
      [HW_TRACE_IDS.inputL]: { offsetDb: 20.81 + 12, seq: 2 },
    });
    tile(after).fdUnit = "dbv";

    const [inBefore, outBefore] = spectrumVM(before, tile(before)).series;
    const [inAfter, outAfter] = spectrumVM(after, tile(after)).series;
    expect(inAfter.y[1] - inBefore.y[1]).toBeCloseTo(12, 6);
    expect(outAfter.y[1]).toBeCloseTo(outBefore.y[1], 9); // the #51 pin
  });

  it("dBFS leaves the wire values untouched (identity, zero-copy)", () => {
    seedFd(HW_TRACE_IDS.inputL, [-100, -12, -100]);
    const s = stateWith([HW_TRACE_IDS.inputL], {
      [HW_TRACE_IDS.inputL]: { offsetDb: 20.81, seq: 1 },
    });
    tile(s).fdUnit = "dbfs"; // the tested unit (tiles boot in dBV since M4)
    const [inL] = spectrumVM(s, tile(s)).series;
    expect(Array.from(inL.y)).toEqual([-100, -12, -100]);
  });

  it("dual-dBr subtracts a scalar reference and relabels the axis", () => {
    seedFd(HW_TRACE_IDS.inputL, [-100, -12, -100]);
    const s = stateWith([HW_TRACE_IDS.inputL], {
      [HW_TRACE_IDS.inputL]: { offsetDb: 20.81, seq: 1 },
    });
    tile(s).fdUnit = "dbfs"; // pin: the dBr math rides the tile's base unit
    tile(s).axis.dbrEnabled = true;
    tile(s).axis.dbrRefDb = -12;
    const vm = spectrumVM(s, tile(s));
    expect(vm.unitLabel).toBe("dBr");
    expect(vm.series[0].y[1]).toBeCloseTo(0, 9);
  });

  it("dBr auto reference is the primary series' peak (0 dBr at the top)", () => {
    seedFd(HW_TRACE_IDS.inputL, [-100, -12, -100]);
    const s = stateWith([HW_TRACE_IDS.inputL], {
      [HW_TRACE_IDS.inputL]: { offsetDb: 20.81, seq: 1 },
    });
    tile(s).axis.dbrEnabled = true; // dbrRefDb stays null = auto
    const vm = spectrumVM(s, tile(s));
    expect(Math.max(...vm.series[0].y)).toBeCloseTo(0, 9);
  });
});

describe("scopeVM", () => {
  beforeEach(() => clearAllFrames());

  it("scales each trace's samples by its OWN converter (V)", () => {
    seedTd(HW_TRACE_IDS.inputL, [0.5, -0.5]);
    seedTd(HW_TRACE_IDS.outputL, [0.5, -0.5]);
    const s = stateWith([HW_TRACE_IDS.inputL, HW_TRACE_IDS.outputL], {
      [HW_TRACE_IDS.inputL]: { offsetDb: 20, seq: 1 },
      [HW_TRACE_IDS.outputL]: { offsetDb: 0, seq: 1 },
    });
    tile(s).kind = "scope";
    tile(s).tdUnit = "v";
    const [inL, outL] = scopeVM(s, tile(s)).series;
    expect(inL.samples[0]).toBeCloseTo(5, 9); // 0.5 × 10^(20/20)
    expect(outL.samples[0]).toBeCloseTo(0.5, 9);
  });

  it("an fd-side (ADC) offset change NEVER moves a DAC trace's volts (#60)", () => {
    seedTd(HW_TRACE_IDS.outputL, [0.5, -0.5]);
    // Between the two states the ADC offsets stepped 12 dB; the DAC trace
    // only carries ITS OWN offset, which did not move.
    const before = stateWith([HW_TRACE_IDS.outputL], {
      [HW_TRACE_IDS.outputL]: { offsetDb: 11.01, seq: 1 },
      [HW_TRACE_IDS.inputL]: { offsetDb: 20.81, seq: 1 },
    });
    tile(before).kind = "scope";
    tile(before).tdUnit = "v";
    const after = stateWith([HW_TRACE_IDS.outputL], {
      [HW_TRACE_IDS.outputL]: { offsetDb: 11.01, seq: 2 },
      [HW_TRACE_IDS.inputL]: { offsetDb: 20.81 + 12, seq: 2 },
    });
    tile(after).kind = "scope";
    tile(after).tdUnit = "v";
    const [a] = scopeVM(before, tile(before)).series;
    const [b] = scopeVM(after, tile(after)).series;
    expect(b.samples[0]).toBeCloseTo(a.samples[0], 9);
  });

  it("%FS shows converter-relative percent regardless of offsets", () => {
    seedTd(HW_TRACE_IDS.inputL, [0.25]);
    const s = stateWith([HW_TRACE_IDS.inputL], {
      [HW_TRACE_IDS.inputL]: { offsetDb: 20.81, seq: 1 },
    });
    tile(s).kind = "scope";
    tile(s).tdUnit = "pctfs";
    const vm = scopeVM(s, tile(s));
    expect(vm.unitLabel).toBe("%FS");
    expect(vm.series[0].samples[0]).toBeCloseTo(25, 9);
  });
});

describe("harmonic markers VM (M6 — per-tile toggle, backend-located)", () => {
  beforeEach(() => clearAllFrames());

  const MARKS = [
    { n: 1, frequency: 1000, magnitude_db: -12, magnitude_dbc: 0 },
    { n: 2, frequency: 2000, magnitude_db: -92, magnitude_dbc: -80 },
  ];

  function seedWithHarmonics(id: string, seq = 1): void {
    putFrames(id, seq, {
      fd: { freqs: FREQS, magDb: Float64Array.from([-100, -12, -100]) },
      harmonics: MARKS,
    });
  }

  it("toggle off → no marks (default)", () => {
    seedWithHarmonics(HW_TRACE_IDS.inputL);
    const s = stateWith([HW_TRACE_IDS.inputL], {
      [HW_TRACE_IDS.inputL]: { offsetDb: 20.81, seq: 1 },
    });
    expect(spectrumVM(s, tile(s)).harmonics).toEqual([]);
  });

  it("marks convert through the SOURCE trace's own offset, like its curve", () => {
    seedWithHarmonics(HW_TRACE_IDS.inputL);
    const s = stateWith([HW_TRACE_IDS.inputL], {
      [HW_TRACE_IDS.inputL]: { offsetDb: 20.81, seq: 1 },
    });
    tile(s).showHarmonics = true;
    tile(s).fdUnit = "dbv";
    const marks = spectrumVM(s, tile(s)).harmonics;
    expect(marks).toHaveLength(2);
    expect(marks[0].magnitudeDb).toBeCloseTo(-12 + 20.81, 6);
    expect(marks[1].magnitudeDb).toBeCloseTo(-92 + 20.81, 6);
    // dBc is unit-independent — no offset may leak into it.
    expect(marks[1].magnitudeDbc).toBe(-80);
    expect(marks[1].frequency).toBe(2000);
  });

  it("dBr shifts marks by the same reference as the series", () => {
    seedWithHarmonics(HW_TRACE_IDS.inputL);
    const s = stateWith([HW_TRACE_IDS.inputL], {
      [HW_TRACE_IDS.inputL]: { offsetDb: 0, seq: 1 },
    });
    tile(s).showHarmonics = true;
    tile(s).axis.dbrEnabled = true;
    tile(s).axis.dbrRefDb = -12;
    const vm = spectrumVM(s, tile(s));
    expect(vm.unitLabel).toBe("dBr");
    expect(vm.harmonics[0].magnitudeDb).toBeCloseTo(0, 6); // fundamental at ref
    expect(vm.harmonics[1].magnitudeDb).toBeCloseTo(-80, 6);
  });

  it("a legend-hidden chip source draws no floating marks", () => {
    seedWithHarmonics(HW_TRACE_IDS.inputL);
    const s = stateWith([HW_TRACE_IDS.inputL], {
      [HW_TRACE_IDS.inputL]: { offsetDb: 20.81, seq: 1 },
    });
    tile(s).showHarmonics = true;
    tile(s).chipSource = HW_TRACE_IDS.inputL;
    tile(s).hidden = [HW_TRACE_IDS.inputL];
    expect(spectrumVM(s, tile(s)).harmonics).toEqual([]);
  });
});

describe("ratio traces (deconvolve — M4 maintainer report)", () => {
  beforeEach(() => clearAllFrames());

  /** State with a deconvolve transform trace `fx` shown on tile-1. */
  function stateWithRatio(): AppState {
    const s = stateWith(["fx"]);
    s.traces.order.push("fx");
    s.traces.byId["fx"] = {
      id: "fx",
      label: "÷ ref",
      color: "#9a6ee2",
      source: {
        kind: "transform",
        input: HW_TRACE_IDS.inputL,
        steps: [{ type: "deconvolve", ref: "mem-1" }],
      },
      domains: ["fd", "td"],
      seq: 1,
      offsetDb: 20.81, // inherited from its ADC input — must NOT apply to fd
    };
    return s;
  }

  it("a deconvolved spectrum is a ratio: no converter offset in ANY fd unit", () => {
    seedFd("fx", [0, 0, 0]); // flat ratio vs its reference
    const s = stateWithRatio();
    for (const unit of ["dbfs", "dbv", "dbu"] as const) {
      s.layout.tiles["tile-1"].fdUnit = unit;
      const vm = spectrumVM(s, tile(s));
      expect(Array.from(vm.series[0].y)).toEqual([0, 0, 0]);
    }
  });

  it("its SCOPE keeps the absolute conversion — deconvolve never touches td", () => {
    seedTd("fx", [0.5, -0.5]);
    const s = stateWithRatio();
    s.layout.tiles["tile-1"].kind = "scope";
    s.layout.tiles["tile-1"].tdUnit = "v";
    const vm = scopeVM(s, tile(s));
    // Full-scale 0.5 × 10^(20.81/20) ≈ 5.49 V — the input's own volts.
    expect(vm.series[0].samples[0]).toBeCloseTo(0.5 * Math.pow(10, 20.81 / 20), 6);
  });
});

describe("sweepVM per-curve legend hiding (v1 parity, M4)", () => {
  beforeEach(() => clearAllFrames());

  it("a hidden curve leaves the VM; its sibling keeps its color slot", () => {
    putFrames("prog-1", 1, {
      sweep: {
        freqs: Float64Array.from([20, 1000]),
        curves: [
          { label: "Left", values: Float64Array.from([-100, -100]), phaseDeg: null },
          { label: "Right", values: Float64Array.from([-90, -90]), phaseDeg: null },
        ],
      },
    });
    const s = initialState();
    s.traces.order.push("prog-1");
    s.traces.byId["prog-1"] = {
      id: "prog-1",
      label: "Sweep",
      color: "#9a6ee2",
      source: { kind: "program" },
      domains: ["sweep"],
      seq: 1,
      offsetDb: null,
    };
    const t = s.layout.tiles["tile-1"];
    t.kind = "sweep";
    t.traces = ["prog-1"];

    const both = sweepVM(s, t);
    expect(both.series.map((x) => x.label)).toEqual(["Sweep Left", "Sweep Right"]);
    expect(both.series[0].color).not.toBe(both.series[1].color); // distinct L/R

    const rightColor = both.series[1].color;
    s.layout.tiles["tile-1"] = { ...t, hiddenCurves: { "prog-1": ["Left"] } };
    const vm = sweepVM(s, s.layout.tiles["tile-1"]);
    expect(vm.series.map((x) => x.label)).toEqual(["Sweep Right"]);
    expect(vm.series[0].color).toBe(rightColor); // color keyed by curve INDEX
  });
});

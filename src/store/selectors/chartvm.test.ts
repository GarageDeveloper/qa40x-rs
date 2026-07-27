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
import { clearTriggerSnapshots, putTriggerSnapshot } from "../../data/triggered";
import { initialState, type AppState, type TileConfig } from "../state";
import { DEFAULT_SWEEP_PARAMS, HW_TRACE_IDS } from "../state";
import { DBU_OVER_DBV_DB } from "../../core/units";
import {
  displayOffsetDb,
  displayScale,
  scopeVM,
  spectrumVM,
  sweepVM,
  triggerLevelFromDisplay,
  triggerLevelToDisplay,
  triggerSourceOffsetDb,
} from "./chartvm";

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

  it("trigger off (default) ⇒ EXACTLY today's shape plus trigger: null (regression pin)", () => {
    seedTd(HW_TRACE_IDS.inputL, [0.5, -0.5]);
    const s = stateWith([HW_TRACE_IDS.inputL], {
      [HW_TRACE_IDS.inputL]: { offsetDb: 20, seq: 1 },
    });
    tile(s).kind = "scope";
    tile(s).tdUnit = "v";
    const vm = scopeVM(s, tile(s));
    expect(vm).toEqual({
      series: [
        {
          id: HW_TRACE_IDS.inputL,
          label: "Input L",
          color: "#3987e5",
          samples: Float64Array.from([5, -5]),
          sampleRate: 48000,
          seq: 1,
        },
      ],
      unitLabel: "V",
      trigger: null,
    });
  });
});

describe("scopeVM trigger alignment (Lot A, issue #26)", () => {
  beforeEach(() => {
    clearAllFrames();
    clearTriggerSnapshots();
  });

  /** A resolved-source state: tile-1 is a scope on Input L, trigger mode on,
   * 480-sample window (10 ms @ 48 kHz), position 50 % ⇒ pre = 240. fftSize
   * matches `seedSnapshot`'s 1000-sample ramp (review #3: `scopeVM` now
   * requires a held snapshot's own sample length to match the CURRENT
   * fftSize, else it falls back to the live path — see the dedicated
   * mismatch test below). */
  function stateWithTrigger(mode: "auto" | "normal" | "single" = "auto"): AppState {
    const s = stateWith([HW_TRACE_IDS.inputL], {
      [HW_TRACE_IDS.inputL]: { offsetDb: 20.81, seq: 1 },
    });
    s.device.config = { input_gain: 0, output_gain: 0, sample_rate: 48000 };
    s.acquisition.fftSize = 1000;
    tile(s).kind = "scope";
    tile(s).tdUnit = "v";
    tile(s).timeWindowMs = 10;
    tile(s).triggerPositionPct = 50;
    s.triggers[HW_TRACE_IDS.inputL] = {
      mode,
      edge: "rising",
      levelV: 0.5,
      hystV: null,
      armEpoch: 0,
    };
    return s;
  }

  /** A 1000-sample ramp so slicing is verifiable by value (samples[i] = i). */
  function seedSnapshot(over: Partial<Parameters<typeof putTriggerSnapshot>[1]> = {}): void {
    putTriggerSnapshot(HW_TRACE_IDS.inputL, {
      seq: 1,
      state: "triggered",
      index: 500,
      frac: 0.3,
      sampleRate: 48000,
      samples: { [HW_TRACE_IDS.inputL]: Float64Array.from({ length: 1000 }, (_, i) => i) },
      offsetDb: { [HW_TRACE_IDS.inputL]: 20 }, // 10x, distinct from the live 20.81 above
      ...over,
    });
  }

  it("no snapshot yet ⇒ falls back to today's (live, unaligned) shape with trigger: null", () => {
    seedTd(HW_TRACE_IDS.inputL, [0.1, 0.2]);
    const s = stateWithTrigger();
    const vm = scopeVM(s, tile(s));
    expect(vm.trigger).toBeNull();
    expect(Array.from(vm.series[0].samples)).toEqual([
      0.1 * Math.pow(10, 20.81 / 20),
      0.2 * Math.pow(10, 20.81 / 20),
    ]);
  });

  it("aligned: series start at index − pre, and frac is passed through", () => {
    seedSnapshot();
    const s = stateWithTrigger();
    s.run.triggers[HW_TRACE_IDS.inputL] = { state: "triggered", index: 500, frac: 0.3 };
    const vm = scopeVM(s, tile(s));
    // pre = round(0.5 * 480) = 240; start = 500 - 240 = 260.
    const k = Math.pow(10, 20 / 20); // the SNAPSHOT's baked offset (20), not the live 20.81
    expect(vm.series[0].samples[0]).toBeCloseTo(260 * k, 9);
    expect(vm.series[0].samples.length).toBe(480);
    expect(vm.trigger).not.toBeNull();
    expect(vm.trigger!.frac).toBe(0.3);
    // count = end - start = 480 (unclamped here), so the denominator is
    // count - 1 = 479, NOT windowSamples (480) — this is what matches the
    // canvas's own `displayCount() - 1` denominator in `xOf`, so the
    // crossing at continuous sample `index - 1 + frac` lands exactly on the
    // drawn marker (issue #26 reviews #4/#7; the old 240/480 pin put the
    // marker very slightly off).
    expect(vm.trigger!.position).toBeCloseTo(240 / 479, 9);
    expect(vm.trigger!.sourceId).toBe(HW_TRACE_IDS.inputL);
  });

  it("clamps pre to the trigger index so the slice never starts before sample 0 (review #4/#7)", () => {
    seedSnapshot({ index: 100 });
    const s = stateWithTrigger();
    s.run.triggers[HW_TRACE_IDS.inputL] = { state: "triggered", index: 100, frac: 0 };
    const vm = scopeVM(s, tile(s));
    // pre would be round(0.5*480) = 240, > index (100) ⇒ clamped to 100 ⇒
    // start = 0, end = min(0+480,1000) = 480, count = 480.
    const k = Math.pow(10, 20 / 20);
    expect(vm.series[0].samples[0]).toBeCloseTo(0 * k, 9);
    expect(vm.series[0].samples.length).toBe(480);
    expect(vm.trigger!.position).toBeCloseTo(100 / 479, 9);
  });

  it("clamps the slice end to the snapshot length when the window would run past it (review #4/#7)", () => {
    seedSnapshot({ index: 900 });
    const s = stateWithTrigger();
    tile(s).triggerPositionPct = 10; // pre = round(0.1*480) = 48
    s.run.triggers[HW_TRACE_IDS.inputL] = { state: "triggered", index: 900, frac: 0 };
    const vm = scopeVM(s, tile(s));
    // start = 900 - 48 = 852; end = min(852+480, 1000) = 1000; count = 148.
    expect(vm.series[0].samples.length).toBe(148);
    expect(vm.trigger!.position).toBeCloseTo(48 / 147, 9);
  });

  it("a snapshot whose sample length no longer matches the current fftSize falls back to the live path (review #3)", () => {
    seedTd(HW_TRACE_IDS.inputL, [0.1, 0.2]);
    seedSnapshot(); // 1000-sample ramp, baked while fftSize was 1000
    const s = stateWithTrigger("normal");
    s.acquisition.fftSize = 2048; // the user changed FFT size while NORMAL held a picture
    s.run.triggers[HW_TRACE_IDS.inputL] = { state: "waiting", index: 999, frac: 0 };
    const vm = scopeVM(s, tile(s));
    expect(vm.trigger).toBeNull();
    expect(Array.from(vm.series[0].samples)).toEqual([
      0.1 * Math.pow(10, 20.81 / 20),
      0.2 * Math.pow(10, 20.81 / 20),
    ]);
  });

  it("levelDisplay converts the endpoint's level-volts via the SNAPSHOT offset, in v/mv/%FS", () => {
    seedSnapshot();
    const s = stateWithTrigger();
    s.run.triggers[HW_TRACE_IDS.inputL] = { state: "auto", index: 500, frac: 0 };
    // Snapshot offset baked at 20 dB ⇒ 10x volts-per-FS.
    tile(s).tdUnit = "v";
    expect(scopeVM(s, tile(s)).trigger!.levelDisplay).toBeCloseTo(0.5, 9);
    tile(s).tdUnit = "mv";
    expect(scopeVM(s, tile(s)).trigger!.levelDisplay).toBeCloseTo(500, 9);
    tile(s).tdUnit = "pctfs";
    expect(scopeVM(s, tile(s)).trigger!.levelDisplay).toBeCloseTo(5, 9); // 0.5/10 × 100
  });

  it("sourceOffsetDb exposes the SNAPSHOT-baked offset, not the live trace offset (review #5)", () => {
    seedSnapshot(); // baked offsetDb 20, distinct from the live 20.81
    const s = stateWithTrigger();
    s.run.triggers[HW_TRACE_IDS.inputL] = { state: "auto", index: 500, frac: 0 };
    const vm = scopeVM(s, tile(s));
    expect(vm.trigger!.sourceOffsetDb).toBe(20);
    expect(vm.trigger!.sourceOffsetDb).not.toBe(s.traces.byId[HW_TRACE_IDS.inputL].offsetDb);
  });

  it("held (waiting/stopped): trigger.held is true and the picture is the snapshot's", () => {
    seedSnapshot();
    const s = stateWithTrigger("normal");
    s.run.triggers[HW_TRACE_IDS.inputL] = { state: "waiting", index: 999, frac: 0 };
    const vm = scopeVM(s, tile(s));
    expect(vm.trigger!.held).toBe(true);
    expect(vm.trigger!.state).toBe("waiting");
    // Slicing still uses the SNAPSHOT's own index (999 was never latched —
    // it's this frame's live report; the held index stays the one baked in
    // seedSnapshot(), 500).
    const k = Math.pow(10, 20 / 20);
    expect(vm.series[0].samples[0]).toBeCloseTo(260 * k, 9);
  });

  it("a later live range/offset change does NOT rescale a held picture", () => {
    seedSnapshot();
    const s = stateWithTrigger("normal");
    s.run.triggers[HW_TRACE_IDS.inputL] = { state: "stopped", index: 500, frac: 0.3 };
    const before = scopeVM(s, tile(s)).series[0].samples[0];

    // A live range step moves the trace's OWN (store) offset — the snapshot
    // must not follow it.
    s.traces.byId[HW_TRACE_IDS.inputL] = {
      ...s.traces.byId[HW_TRACE_IDS.inputL],
      offsetDb: 20.81 + 12,
      capture: null,
    };
    const after = scopeVM(s, tile(s)).series[0].samples[0];
    expect(after).toBeCloseTo(before, 9);
  });

  it("a memory trace member keeps its OWN (live, unsliced) origin", () => {
    seedSnapshot();
    seedTd("mem-1", [0.1, -0.1]); // its own, much shorter time base
    const s = stateWithTrigger();
    s.traces.order.push("mem-1");
    s.traces.byId["mem-1"] = {
      id: "mem-1",
      label: "Input L ❄1",
      color: "#3987e599",
      source: { kind: "memory", frozenFrom: HW_TRACE_IDS.inputL },
      domains: ["td"],
      seq: 1,
      offsetDb: 0,
      capture: null,
    };
    tile(s).traces = [HW_TRACE_IDS.inputL, "mem-1"];
    // Explicit — the "mem-1" member has its own td frame too, which would
    // otherwise win the "auto" chip-source fallback (drawn order).
    tile(s).triggerSource = HW_TRACE_IDS.inputL;
    s.run.triggers[HW_TRACE_IDS.inputL] = { state: "triggered", index: 500, frac: 0.3 };
    const vm = scopeVM(s, tile(s));
    const mem = vm.series.find((sv) => sv.id === "mem-1")!;
    expect(Array.from(mem.samples)).toEqual([0.1, -0.1]); // offsetDb 0 ⇒ identity, unsliced
  });
});

describe("triggerLevelToDisplay / triggerLevelFromDisplay", () => {
  it("v is identity regardless of offset", () => {
    expect(triggerLevelToDisplay(0.5, "v", 20)).toBeCloseTo(0.5, 9);
    expect(triggerLevelToDisplay(0.5, "v", null)).toBeCloseTo(0.5, 9);
  });

  it("mv is a flat ×1000, independent of offset", () => {
    expect(triggerLevelToDisplay(0.5, "mv", 20)).toBeCloseTo(500, 9);
    expect(triggerLevelToDisplay(0.5, "mv", -6)).toBeCloseTo(500, 9);
  });

  it("pctfs folds in the offset (level-volts ÷ volts-per-FS × 100)", () => {
    expect(triggerLevelToDisplay(0.5, "pctfs", 20)).toBeCloseTo(5, 9); // ÷10 × 100
  });

  it("triggerLevelFromDisplay is the exact inverse", () => {
    for (const unit of ["v", "mv", "pctfs"] as const) {
      for (const offsetDb of [null, 0, 20.81, -6]) {
        const levelV = 0.37;
        const display = triggerLevelToDisplay(levelV, unit, offsetDb);
        expect(triggerLevelFromDisplay(display, unit, offsetDb)).toBeCloseTo(levelV, 9);
      }
    }
  });
});

describe("triggerSourceOffsetDb (review #5)", () => {
  beforeEach(() => {
    clearAllFrames();
    clearTriggerSnapshots();
  });

  function stateWithTrigger(mode: "off" | "auto" | "normal" | "single" = "auto"): AppState {
    const s = stateWith([HW_TRACE_IDS.inputL], {
      [HW_TRACE_IDS.inputL]: { offsetDb: 20.81, seq: 1 },
    });
    s.device.config = { input_gain: 0, output_gain: 0, sample_rate: 48000 };
    s.acquisition.fftSize = 1000;
    tile(s).kind = "scope";
    tile(s).timeWindowMs = 10;
    tile(s).triggerPositionPct = 50;
    s.triggers[HW_TRACE_IDS.inputL] = { mode, edge: "rising", levelV: 0.5, hystV: null, armEpoch: 0 };
    return s;
  }

  it("no snapshot resolved (mode off, or none latched) ⇒ the trace's LIVE offset", () => {
    const s = stateWithTrigger("off");
    expect(triggerSourceOffsetDb(s, HW_TRACE_IDS.inputL)).toBe(20.81);
  });

  it("a resolved snapshot ⇒ the SNAPSHOT's baked offset, matching scopeVM's levelDisplay exactly", () => {
    const s = stateWithTrigger();
    putTriggerSnapshot(HW_TRACE_IDS.inputL, {
      seq: 1,
      state: "triggered",
      index: 500,
      frac: 0.3,
      sampleRate: 48000,
      samples: { [HW_TRACE_IDS.inputL]: Float64Array.from({ length: 1000 }, (_, i) => i) },
      offsetDb: { [HW_TRACE_IDS.inputL]: 20 },
    });
    expect(triggerSourceOffsetDb(s, HW_TRACE_IDS.inputL)).toBe(20);
    expect(triggerSourceOffsetDb(s, HW_TRACE_IDS.inputL)).toBe(
      scopeVM(s, tile(s)).trigger!.sourceOffsetDb
    );
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
      capture: null,
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
      capture: null,
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

  it("a THD level-axis program's sweep reports xUnit dBFS (issue #27) — read from the FRAME, not just the program", () => {
    putFrames("prog-2", 1, {
      sweep: {
        freqs: Float64Array.from([-60, -30, 0]),
        curves: [{ label: "Left", values: Float64Array.from([-120, -100, -80]), phaseDeg: null }],
        xUnit: "dBFS",
      },
    });
    const s = initialState();
    s.traces.order.push("prog-2");
    s.traces.byId["prog-2"] = {
      id: "prog-2",
      label: "Sweep",
      color: "#9a6ee2",
      source: { kind: "program" },
      domains: ["sweep"],
      seq: 1,
      offsetDb: null,
      capture: null,
    };
    s.programs.order.push("prog-2");
    s.programs.byId["prog-2"] = {
      id: "prog-2",
      kind: "sweep",
      run: "idle",
      progress: null,
      startedAtMs: null,
      params: { ...DEFAULT_SWEEP_PARAMS, measurement: "thd", axis: "level" },
    };
    const t = s.layout.tiles["tile-1"];
    t.kind = "sweep";
    t.traces = ["prog-2"];

    expect(sweepVM(s, t).xUnit).toBe("dBFS");
  });

  it("review finding #1: a level sweep's xUnit survives the program being GONE (frozen ❄ / deleted) — no NaN-axis regression", () => {
    // The exact bug: freeze (or delete the program) drops the programs.byId
    // entry the OLD code read xUnit from; the frame itself must still know
    // it's a level sweep, or the chart falls back to a log-Hz axis and
    // Math.log10(-60) → NaN.
    putFrames("mem-1", 1, {
      sweep: {
        freqs: Float64Array.from([-60, -30, 0]),
        curves: [{ label: "Left", values: Float64Array.from([-120, -100, -80]), phaseDeg: null }],
        xUnit: "dBFS",
      },
    });
    const s = initialState();
    s.traces.order.push("mem-1");
    s.traces.byId["mem-1"] = {
      id: "mem-1",
      label: "Sweep ❄1",
      color: "#9a6ee2",
      source: { kind: "memory", frozenFrom: "prog-2" },
      domains: ["sweep"],
      seq: 1,
      offsetDb: null,
      capture: null,
    };
    // Deliberately NO s.programs.byId["mem-1"] and NO s.programs.byId["prog-2"]
    // — a memory trace is never itself a program, and the original program
    // may have been deleted too.
    const t = s.layout.tiles["tile-1"];
    t.kind = "sweep";
    t.traces = ["mem-1"];

    expect(sweepVM(s, t).xUnit).toBe("dBFS");
  });

  it("a frame with no xUnit (predates issue #27 — a script-emitted sweep, or an old save) falls back to the program's axis, else Hz", () => {
    putFrames("prog-3", 1, {
      sweep: {
        freqs: Float64Array.from([-60, -30, 0]),
        curves: [{ label: "Left", values: Float64Array.from([-120, -100, -80]), phaseDeg: null }],
        // no xUnit
      },
    });
    const s = initialState();
    s.traces.order.push("prog-3");
    s.traces.byId["prog-3"] = {
      id: "prog-3",
      label: "Sweep",
      color: "#9a6ee2",
      source: { kind: "program" },
      domains: ["sweep"],
      seq: 1,
      offsetDb: null,
      capture: null,
    };
    s.programs.order.push("prog-3");
    s.programs.byId["prog-3"] = {
      id: "prog-3",
      kind: "sweep",
      run: "idle",
      progress: null,
      startedAtMs: null,
      params: { ...DEFAULT_SWEEP_PARAMS, measurement: "thd", axis: "level" },
    };
    const t = s.layout.tiles["tile-1"];
    t.kind = "sweep";
    t.traces = ["prog-3"];
    expect(sweepVM(s, t).xUnit).toBe("dBFS"); // falls back to the program

    // No frame xUnit AND no program entry at all — genuinely nothing to
    // read the axis from, defaults to Hz.
    const noProgVm = sweepVM(s, { ...t, traces: [] });
    expect(noProgVm.xUnit).toBe("Hz");
  });

  it("review finding #4: flipping the dialog's axis WITHOUT re-running leaves the landed frame's xUnit untouched (no stale relabel)", () => {
    // The frame landed as a Hz (frequency-axis) sweep...
    putFrames("prog-4", 1, {
      sweep: {
        freqs: Float64Array.from([20, 1000, 20000]),
        curves: [{ label: "Left", values: Float64Array.from([-120, -100, -80]), phaseDeg: null }],
        xUnit: "Hz",
      },
    });
    const s = initialState();
    s.traces.order.push("prog-4");
    s.traces.byId["prog-4"] = {
      id: "prog-4",
      label: "Sweep 20–20000 Hz",
      color: "#9a6ee2",
      source: { kind: "program" },
      domains: ["sweep"],
      seq: 1,
      offsetDb: null,
      capture: null,
    };
    s.programs.order.push("prog-4");
    // ...then the user opens the gear, flips axis to "level", and Applies —
    // WITHOUT pressing Run again. The program's params now say "level"; the
    // landed frame is still the old Hz data.
    s.programs.byId["prog-4"] = {
      id: "prog-4",
      kind: "sweep",
      run: "idle",
      progress: null,
      startedAtMs: null,
      params: { ...DEFAULT_SWEEP_PARAMS, measurement: "thd", axis: "level" },
    };
    const t = s.layout.tiles["tile-1"];
    t.kind = "sweep";
    t.traces = ["prog-4"];

    // Must still read Hz — the axis the DATA was actually swept over, not
    // the dialog's current (not-yet-run) setting.
    expect(sweepVM(s, t).xUnit).toBe("Hz");
  });

  it("review finding #3: a tile mixing a frequency sweep and a level sweep omits the second axis instead of NaN-ing the plot", () => {
    putFrames("prog-freq", 1, {
      sweep: {
        freqs: Float64Array.from([20, 1000, 20000]),
        curves: [{ label: "Left", values: Float64Array.from([-120, -110, -90]), phaseDeg: null }],
        xUnit: "Hz",
      },
    });
    putFrames("prog-level", 1, {
      sweep: {
        freqs: Float64Array.from([-60, -30, 0]),
        curves: [{ label: "Left", values: Float64Array.from([-120, -100, -80]), phaseDeg: null }],
        xUnit: "dBFS",
      },
    });
    const s = initialState();
    for (const id of ["prog-freq", "prog-level"]) {
      s.traces.order.push(id);
      s.traces.byId[id] = {
        id,
        label: id,
        color: "#9a6ee2",
        source: { kind: "program" },
        domains: ["sweep"],
        seq: 1,
        offsetDb: null,
        capture: null,
      };
    }
    const t = s.layout.tiles["tile-1"];
    t.kind = "sweep";
    t.traces = ["prog-freq", "prog-level"];

    const vm = sweepVM(s, t);
    // The tile's axis is fixed by the FIRST member (Hz) — the level sweep
    // is entirely excluded, not drawn on a mismatched scale.
    expect(vm.xUnit).toBe("Hz");
    expect(vm.series.map((x) => x.id)).toEqual(["prog-freq"]);
    expect(vm.omitted).toEqual(["prog-level"]);

    // Reversed membership order: whichever lands FIRST wins the axis: this
    // time the level sweep is drawn and the Hz one is omitted.
    const reversed = sweepVM(s, { ...t, traces: ["prog-level", "prog-freq"] });
    expect(reversed.xUnit).toBe("dBFS");
    expect(reversed.series.map((x) => x.id)).toEqual(["prog-level"]);
    expect(reversed.omitted).toEqual(["prog-freq"]);
  });

  it("a SINGLE trace re-run level → frequency → level tracks the CURRENT frame every render — no stale axis carried over from a previous call (tile.ts calls sweepVM fresh on every render)", () => {
    // Same program/trace id re-run three times with the axis flipped each
    // time — sweepVM has no cross-call cache, so each call must reflect
    // only the frame that's in the cache RIGHT NOW.
    const s = initialState();
    s.traces.order.push("prog-hot");
    s.traces.byId["prog-hot"] = {
      id: "prog-hot",
      label: "Sweep",
      color: "#9a6ee2",
      source: { kind: "program" },
      domains: ["sweep"],
      seq: 1,
      offsetDb: null,
      capture: null,
    };
    const t = s.layout.tiles["tile-1"];
    t.kind = "sweep";
    t.traces = ["prog-hot"];

    putFrames("prog-hot", 1, {
      sweep: {
        freqs: Float64Array.from([-60, -30, 0]),
        curves: [{ label: "Left", values: Float64Array.from([-120, -100, -80]), phaseDeg: null }],
        xUnit: "dBFS",
      },
    });
    expect(sweepVM(s, t).xUnit).toBe("dBFS");
    expect(Array.from(sweepVM(s, t).series[0].x)).toEqual([-60, -30, 0]);

    putFrames("prog-hot", 2, {
      sweep: {
        freqs: Float64Array.from([20, 1000, 20000]),
        curves: [{ label: "Left", values: Float64Array.from([-120, -110, -90]), phaseDeg: null }],
        xUnit: "Hz",
      },
    });
    expect(sweepVM(s, t).xUnit).toBe("Hz");
    expect(Array.from(sweepVM(s, t).series[0].x)).toEqual([20, 1000, 20000]);

    putFrames("prog-hot", 3, {
      sweep: {
        freqs: Float64Array.from([-40, -20, 0]),
        curves: [{ label: "Left", values: Float64Array.from([-118, -98, -78]), phaseDeg: null }],
        xUnit: "dBFS",
      },
    });
    expect(sweepVM(s, t).xUnit).toBe("dBFS");
    expect(Array.from(sweepVM(s, t).series[0].x)).toEqual([-40, -20, 0]);
    // Never omitted — a single-trace tile has nothing to clash against.
    expect(sweepVM(s, t).omitted).toEqual([]);
  });
});

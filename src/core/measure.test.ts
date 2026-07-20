/**
 * Measure-chip formatting: level chips follow the TILE's unit through the
 * measured trace's OWN converter offset (a scope in volts reads volts, not
 * raw dBFS); dBFS stays the honest fallback while no offset is known.
 */
import { describe, expect, it } from "vitest";
import type { ChipContext } from "./measure";
import { measureByKey } from "./measure";

function ctx(over: Partial<ChipContext>): ChipContext {
  return {
    measures: {
      td: { rms: 0.1, peak: 0.1414, dc_offset: 0.001 },
      fd: { index: 100, freq: 1000, mag_db: -53.3 },
    },
    metrics: null,
    offsetDb: 20, // ×10 in linear
    tdUnit: "v",
    fdUnit: "dbv",
    ...over,
  };
}

const fmt = (key: string, c: ChipContext): string => measureByKey(key)!.format(c);

describe("td level chips", () => {
  it("RMS prints RMS volts through the trace's own offset", () => {
    expect(fmt("rms", ctx({}))).toBe("1.00 Vrms"); // 0.1 × 10
  });

  it("Peak prints instantaneous volts (Vpk)", () => {
    expect(fmt("peak", ctx({}))).toBe("1.41 Vpk"); // 0.1414 × 10
  });

  it("%FS ignores the converter (converter-relative by definition)", () => {
    expect(fmt("rms", ctx({ tdUnit: "pctfs" }))).toBe("10.0 %FS");
    expect(fmt("peak", ctx({ tdUnit: "pctfs" }))).toBe("14.1 %FS");
  });

  it("falls back to dBFS while the offset is unknown", () => {
    expect(fmt("rms", ctx({ offsetDb: null }))).toBe("-20.0 dBFS");
  });

  it("DC prints millivolts through the offset", () => {
    expect(fmt("dc", ctx({}))).toBe("10.0 mV"); // 0.001 × 10 → 10 mV
  });
});

describe("fd level chip", () => {
  it("Peak level follows the tile's fd unit", () => {
    expect(fmt("peaklvl", ctx({}))).toBe("-33.3 dBV"); // −53.3 + 20
    expect(fmt("peaklvl", ctx({ fdUnit: "dbfs" }))).toBe("-53.3 dBFS");
  });

  it("labels dBFS while the offset is unknown", () => {
    expect(fmt("peaklvl", ctx({ offsetDb: null }))).toBe("-53.3 dBFS");
  });
});

/**
 * Measure-chip formatting: level chips follow the TILE's unit through the
 * measured trace's OWN converter offset (a scope in volts reads volts, not
 * raw dBFS); dBFS stays the honest fallback while no offset is known.
 */
import { describe, expect, it } from "vitest";
import type { ScopeMeasures, ScopeStat } from "../gen";
import type { ChipContext } from "./measure";
import { measureByKey, MEASURES, SCOPE_MEASURE_KEYS } from "./measure";

function ctx(over: Partial<ChipContext>): ChipContext {
  return {
    measures: {
      td: { rms: 0.1, peak: 0.1414, dc_offset: 0.001 },
      fd: { index: 100, freq: 1000, mag_db: -53.3 },
    },
    metrics: null,
    scope: null,
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

describe("scope measurement suite chips (issue #26 lot B)", () => {
  const stat = (value: number | null, n = 1): ScopeStat => ({
    value,
    avg: value ?? 0,
    min: value ?? 0,
    max: value ?? 0,
    sd: 0,
    n: value === null ? 0 : n,
  });
  const scope = (over: Partial<ScopeMeasures> = {}): ScopeMeasures => ({
    vpp: stat(0.2),
    vmean: stat(0.001),
    rms_ac: stat(0.0707),
    freq_hz: stat(997.13),
    rise_s: stat(296e-6),
    fall_s: stat(297e-6),
    duty: stat(0.25),
    ...over,
  });

  it("Vpp prints volts through the trace's own offset, with the Vpp suffix", () => {
    expect(fmt("vpp", ctx({ scope: scope() }))).toBe("2.00 Vpp"); // 0.2 × 10
  });

  it("Vpp in %FS ignores the converter", () => {
    expect(fmt("vpp", ctx({ scope: scope(), tdUnit: "pctfs" }))).toBe("20.0 %FS");
  });

  it("Vpp falls back to raw FS while the offset is unknown", () => {
    expect(fmt("vpp", ctx({ scope: scope(), offsetDb: null }))).toBe("0.200 FS");
  });

  it("AC RMS prints Vrms; Vmean prints millivolts (the DC convention)", () => {
    expect(fmt("acrms", ctx({ scope: scope() }))).toBe("707 mVrms"); // 0.0707 × 10
    expect(fmt("vmean", ctx({ scope: scope() }))).toBe("10.0 mV"); // 0.001 × 10
  });

  it("Freq keeps DSO-grade digits (the backend refines to ~mHz)", () => {
    expect(fmt("freq", ctx({ scope: scope() }))).toBe("997.130 Hz");
    // (50.12345 sits just below the .5 boundary in binary — rounds down.)
    expect(fmt("freq", ctx({ scope: scope({ freq_hz: stat(50.12345) }) }))).toBe("50.1234 Hz");
    expect(fmt("freq", ctx({ scope: scope({ freq_hz: stat(12345.678) }) }))).toBe("12345.68 Hz");
  });

  it("Rise/Fall print SI-prefixed seconds; Duty a percentage", () => {
    expect(fmt("rise", ctx({ scope: scope() }))).toBe("296 µs");
    expect(fmt("duty", ctx({ scope: scope() }))).toBe("25.0 %");
  });

  it("shows — when the suite is absent or the metric undefined this frame", () => {
    expect(fmt("freq", ctx({ scope: null }))).toBe("—");
    expect(fmt("freq", ctx({ scope: scope({ freq_hz: stat(null) }) }))).toBe("—");
  });

  it("statsTooltip carries avg/min/max/σ/n — and null before any reading", () => {
    const def = measureByKey("freq")!;
    const withStats = ctx({
      scope: scope({
        freq_hz: { value: 997.13, avg: 997.131, min: 997.127, max: 997.135, sd: 0.002, n: 42 },
      }),
    });
    const tip = def.statsTooltip!(withStats);
    expect(tip).toContain("avg 997.131 Hz");
    expect(tip).toContain("min 997.127 Hz");
    expect(tip).toContain("max 997.135 Hz");
    expect(tip).toContain("σ 0.0020 Hz");
    expect(tip).toContain("n=42");

    expect(def.statsTooltip!(ctx({ scope: scope({ freq_hz: stat(null) }) }))).toBeNull();
    expect(def.statsTooltip!(ctx({ scope: null }))).toBeNull();
  });

  it("every SCOPE_MEASURE_KEYS entry is a registered chip (and vice versa)", () => {
    for (const key of SCOPE_MEASURE_KEYS) expect(measureByKey(key)).toBeDefined();
    const suiteDefs = MEASURES.filter((m) => m.statsTooltip);
    expect(new Set(suiteDefs.map((m) => m.key))).toEqual(new Set(SCOPE_MEASURE_KEYS));
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

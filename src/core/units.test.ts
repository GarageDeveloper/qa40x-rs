import { describe, it, expect } from "vitest";
import type { Unit } from "./model";
import {
  DEFAULT_REFS,
  formatVrms,
  fromVrms,
  isDbUnit,
  toVrms,
  unitLabel,
  type UnitRefs,
} from "./units";

describe("units core — fromVrms", () => {
  it("passes Vrms through and scales Vpk by √2", () => {
    expect(fromVrms(1, "vrms")).toBe(1);
    expect(fromVrms(1, "vpk")).toBeCloseTo(Math.SQRT2, 12);
  });

  it("dBV is 0 at 1 Vrms and +6.02 at 2 Vrms", () => {
    expect(fromVrms(1, "dbv")).toBeCloseTo(0, 9);
    expect(fromVrms(2, "dbv")).toBeCloseTo(6.0206, 3);
    expect(fromVrms(0.5, "dbv")).toBeCloseTo(-6.0206, 3);
  });

  it("dBu references 0.7746 Vrms (~2.218 dB below dBV)", () => {
    expect(fromVrms(0.7745966692, "dbu")).toBeCloseTo(0, 6);
    expect(fromVrms(1, "dbu")).toBeCloseTo(2.2185, 3);
  });

  it("dBFS references the full-scale Vrms", () => {
    const refs: UnitRefs = { ...DEFAULT_REFS, fullScaleVrms: 2 };
    expect(fromVrms(2, "dbfs", refs)).toBeCloseTo(0, 9);
    expect(fromVrms(1, "dbfs", refs)).toBeCloseTo(-6.0206, 3);
  });

  it("percent is a linear ratio to the reference", () => {
    const refs: UnitRefs = { ...DEFAULT_REFS, refVrms: 1 };
    expect(fromVrms(0.5, "percent", refs)).toBeCloseTo(50, 9);
    expect(fromVrms(1, "percent", refs)).toBeCloseTo(100, 9);
  });

  it("watts is v²/R", () => {
    const refs: UnitRefs = { ...DEFAULT_REFS, loadOhms: 8 };
    expect(fromVrms(2, "watt", refs)).toBeCloseTo(0.5, 9); // 4/8
    expect(fromVrms(Math.sqrt(8), "watt", refs)).toBeCloseTo(1, 9);
  });

  it("clamps sub-zero volts and returns −∞ for dB at zero", () => {
    expect(fromVrms(0, "dbv")).toBe(-Infinity);
    expect(fromVrms(-1, "vrms")).toBe(0);
  });
});

describe("units core — round trips (toVrms ∘ fromVrms = id)", () => {
  const refs: UnitRefs = { fullScaleVrms: 3.1, refVrms: 0.5, loadOhms: 4 };
  const units: Unit[] = ["vrms", "vpk", "dbv", "dbu", "dbfs", "dbr", "percent", "watt", "db"];
  for (const u of units) {
    it(`round-trips ${u}`, () => {
      for (const v of [0.001, 0.05, 0.5, 1, 2.5]) {
        expect(toVrms(fromVrms(v, u, refs), u, refs)).toBeCloseTo(v, 9);
      }
    });
  }
});

describe("units core — labels & classification", () => {
  it("labels each unit", () => {
    const expected: Record<Unit, string> = {
      vrms: "Vrms",
      vpk: "Vpk",
      dbv: "dBV",
      dbu: "dBu",
      dbfs: "dBFS",
      dbr: "dBr",
      watt: "W",
      percent: "%",
      db: "dB",
    };
    for (const [u, label] of Object.entries(expected)) {
      expect(unitLabel(u as Unit)).toBe(label);
    }
  });

  it("knows which units are logarithmic", () => {
    expect(isDbUnit("dbv")).toBe(true);
    expect(isDbUnit("dbfs")).toBe(true);
    expect(isDbUnit("vrms")).toBe(false);
    expect(isDbUnit("percent")).toBe(false);
    expect(isDbUnit("watt")).toBe(false);
  });
});

describe("units core — formatVrms", () => {
  it("formats dB units to 0.1 dB with the label", () => {
    expect(formatVrms(0.5, "dbv")).toBe("−6.0 dBV");
    expect(formatVrms(0, "dbv")).toBe("−∞ dBV");
  });

  it("uses an adaptive SI prefix for volts", () => {
    expect(formatVrms(1.23, "vrms")).toBe("1.23 Vrms");
    expect(formatVrms(0.0123, "vrms")).toBe("12.3 mVrms");
    expect(formatVrms(1.23e-6, "vrms")).toBe("1.23 µVrms");
  });

  it("formats watts and percent", () => {
    expect(formatVrms(2, "watt", { ...DEFAULT_REFS, loadOhms: 8 })).toBe("500 mW");
    expect(formatVrms(0.5, "percent")).toBe("50.0 %");
  });
});

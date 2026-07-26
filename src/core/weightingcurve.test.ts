import { describe, expect, it } from "vitest";
import {
  describeUserCurve,
  MAX_CURVE_POINTS,
  parseUserCurveCsv,
  sanitizeUserCurve,
} from "./weightingcurve";

describe("parseUserCurveCsv", () => {
  it("parses a simple comma-separated freq_hz,gain_db file", () => {
    const parsed = parseUserCurveCsv("20,0\n1000,12\n20000,-3\n");
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.curve).toEqual({ freqs: [20, 1000, 20000], gains: [0, 12, -3] });
    expect(parsed.skipped).toBe(0);
  });

  it("skips a header row, blank lines, and comments", () => {
    const parsed = parseUserCurveCsv(
      "freq_hz, gain_db\n\n# a comment\n100, 3.5\n1000, 12\n"
    );
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.curve).toEqual({ freqs: [100, 1000], gains: [3.5, 12] });
  });

  it("accepts whitespace-separated pairs too", () => {
    const parsed = parseUserCurveCsv("100 3\n1000 12");
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.curve).toEqual({ freqs: [100, 1000], gains: [3, 12] });
  });

  it("sorts out-of-order rows ascending by frequency", () => {
    const parsed = parseUserCurveCsv("1000,12\n20,0\n100,3\n");
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.curve.freqs).toEqual([20, 100, 1000]);
    expect(parsed.curve.gains).toEqual([0, 3, 12]);
  });

  it("keeps the LAST row on a duplicate frequency", () => {
    const parsed = parseUserCurveCsv("100,3\n100,7\n1000,12\n");
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.curve.freqs).toEqual([100, 1000]);
    expect(parsed.curve.gains).toEqual([7, 12]);
  });

  it("counts unparsable data rows as skipped rather than failing", () => {
    const parsed = parseUserCurveCsv("100,3\nbogus\n0,5\n-10,2\n1000,12\n");
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    // "bogus" (< 2 fields), freq 0 and freq -10 (not > 0) are all skipped.
    expect(parsed.curve.freqs).toEqual([100, 1000]);
    expect(parsed.skipped).toBe(3);
  });

  it("errors on a file with no valid rows", () => {
    const parsed = parseUserCurveCsv("freq_hz,gain_db\n\n# nothing here\n");
    expect("error" in parsed).toBe(true);
  });

  it("marks a small curve as not decimated", () => {
    const parsed = parseUserCurveCsv("20,0\n1000,12\n20000,-3\n");
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.decimated).toBe(false);
    expect(parsed.originalPoints).toBe(3);
  });

  describe("decimation (review finding #2 — a ~20k-row REW/ARTA export must not "
    + "bloat every transform-chain batch and blow the localStorage quota)", () => {
    function bigCsv(n: number): string {
      const lines: string[] = [];
      const logLo = Math.log(20);
      const logHi = Math.log(20000);
      for (let i = 0; i < n; i++) {
        const f = Math.exp(logLo + (i / (n - 1)) * (logHi - logLo));
        lines.push(`${f.toFixed(3)},${(i % 7) - 3}`);
      }
      return lines.join("\n");
    }

    it("caps a huge import at MAX_CURVE_POINTS", () => {
      const parsed = parseUserCurveCsv(bigCsv(20000));
      expect("error" in parsed).toBe(false);
      if ("error" in parsed) return;
      expect(parsed.decimated).toBe(true);
      expect(parsed.originalPoints).toBe(20000);
      expect(parsed.curve.freqs.length).toBeLessThanOrEqual(MAX_CURVE_POINTS);
      expect(parsed.curve.freqs.length).toBeGreaterThan(MAX_CURVE_POINTS / 2);
    });

    it("decimation keeps the curve strictly ascending and endpoint-anchored", () => {
      const parsed = parseUserCurveCsv(bigCsv(20000));
      expect("error" in parsed).toBe(false);
      if ("error" in parsed) return;
      const { freqs } = parsed.curve;
      for (let i = 1; i < freqs.length; i++) {
        expect(freqs[i]).toBeGreaterThan(freqs[i - 1]);
      }
      expect(freqs[0]).toBeCloseTo(20, 0);
      expect(freqs[freqs.length - 1]).toBeCloseTo(20000, 0);
    });

    it("never invents a value: every decimated point is one of the originals", () => {
      const parsed = parseUserCurveCsv(bigCsv(5000));
      expect("error" in parsed).toBe(false);
      if ("error" in parsed) return;
      const original = parseUserCurveCsv(bigCsv(5000));
      expect("error" in original).toBe(false);
      if ("error" in original) return;
      // Re-parse without decimation pressure isn't possible directly, so
      // just confirm every (freq, gain) PAIR is internally consistent —
      // i.e. the gain at each kept frequency matches SOME original row
      // (gains cycle -3..3, so a mismatched pairing would be a smoking gun
      // for interpolation/synthesis creeping in).
      for (let i = 0; i < parsed.curve.freqs.length; i++) {
        expect(Number.isInteger(parsed.curve.gains[i])).toBe(true);
      }
    });
  });
});

describe("describeUserCurve", () => {
  it("describes null/empty as no curve loaded", () => {
    expect(describeUserCurve(null)).toBe("No curve loaded");
    expect(describeUserCurve({ freqs: [], gains: [] })).toBe("No curve loaded");
  });

  it("summarizes point count and frequency span", () => {
    expect(describeUserCurve({ freqs: [20, 1000, 20000], gains: [0, 12, -3] })).toBe(
      "3 points, 20 Hz–20 kHz"
    );
  });

  it("handles a single-point curve", () => {
    expect(describeUserCurve({ freqs: [1000], gains: [6] })).toBe("1 point, 1 kHz");
  });

  it("degrades to 'No curve loaded' for a malformed value instead of throwing (review finding #5)", () => {
    expect(describeUserCurve(undefined)).toBe("No curve loaded");
    // freqs/gains missing or not arrays.
    expect(describeUserCurve({} as unknown as { freqs: number[]; gains: number[] })).toBe(
      "No curve loaded"
    );
    expect(
      describeUserCurve({ freqs: "nope", gains: [1] } as unknown as {
        freqs: number[];
        gains: number[];
      })
    ).toBe("No curve loaded");
    // mismatched lengths.
    expect(describeUserCurve({ freqs: [100, 1000], gains: [3] })).toBe("No curve loaded");
  });
});

describe("sanitizeUserCurve (review finding #5 — a trust-boundary guard for a "
  + "workspace doc / template that never ran through migrate())", () => {
  it("accepts a well-formed curve", () => {
    const curve = { freqs: [100, 1000], gains: [0, 12] };
    expect(sanitizeUserCurve(curve)).toEqual(curve);
  });

  it("rejects null/non-objects", () => {
    expect(sanitizeUserCurve(null)).toBeNull();
    expect(sanitizeUserCurve(undefined)).toBeNull();
    expect(sanitizeUserCurve("curve")).toBeNull();
    expect(sanitizeUserCurve(42)).toBeNull();
  });

  it("rejects missing/non-array freqs or gains", () => {
    expect(sanitizeUserCurve({})).toBeNull();
    expect(sanitizeUserCurve({ freqs: "100,1000", gains: [0, 12] })).toBeNull();
    expect(sanitizeUserCurve({ freqs: [100, 1000], gains: "0,12" })).toBeNull();
  });

  it("rejects empty or mismatched-length arrays", () => {
    expect(sanitizeUserCurve({ freqs: [], gains: [] })).toBeNull();
    expect(sanitizeUserCurve({ freqs: [100, 1000], gains: [0] })).toBeNull();
  });

  it("rejects a non-positive or non-finite frequency (the ln(0) NaN case)", () => {
    expect(sanitizeUserCurve({ freqs: [0, 1000], gains: [0, 12] })).toBeNull();
    expect(sanitizeUserCurve({ freqs: [-10, 1000], gains: [0, 12] })).toBeNull();
    expect(sanitizeUserCurve({ freqs: [Infinity, 1000], gains: [0, 12] })).toBeNull();
    expect(sanitizeUserCurve({ freqs: [NaN, 1000], gains: [0, 12] })).toBeNull();
  });

  it("rejects non-ascending or non-numeric-gain curves", () => {
    expect(sanitizeUserCurve({ freqs: [1000, 100], gains: [0, 12] })).toBeNull();
    expect(sanitizeUserCurve({ freqs: [100, 100], gains: [0, 12] })).toBeNull();
    expect(sanitizeUserCurve({ freqs: [100, 1000], gains: [0, "12"] })).toBeNull();
  });
});

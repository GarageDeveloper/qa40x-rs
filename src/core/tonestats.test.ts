// Port of the mixer.test.ts tone-list headroom invariants (M2): peak / RMS /
// crest of the phased sum — the numbers the tone editor shows.
import { describe, expect, it } from "vitest";
import type { Tone } from "../gen";
import { toneListStats } from "./tonestats";

const tone = (f: number, a: number, ph = 0, enabled = true): Tone => ({
  enabled,
  frequency_hz: f,
  amplitude_vrms: a,
  phase_degrees: ph,
});

describe("tone-list headroom stats (peak / RMS / crest of the phased sum)", () => {
  it("a single tone: peak = amplitude, crest ≈ 3.01 dB (a sine)", () => {
    const s = toneListStats([tone(1000, 0.5)]);
    expect(s.peak).toBeCloseTo(0.5, 3);
    expect(s.rms).toBeCloseTo(0.5 / Math.SQRT2, 3);
    expect(s.crestDb).toBeCloseTo(20 * Math.log10(Math.SQRT2), 2);
  });

  it("two equal in-phase tones at one frequency double the peak, same crest", () => {
    const s = toneListStats([tone(1000, 0.5), tone(1000, 0.5, 0)]);
    expect(s.peak).toBeCloseTo(1.0, 3);
    expect(s.crestDb).toBeCloseTo(3.01, 1);
  });

  it("antiphase tones cancel — phase reaches the sum, not just the label", () => {
    const s = toneListStats([tone(1000, 0.5), tone(1000, 0.5, 180)]);
    expect(s.peak).toBeLessThan(1e-9);
    expect(s.rms).toBeLessThan(1e-9);
  });

  it("phase sets the crest of a two-frequency sum (the headroom the UI shows)", () => {
    // sin(θ) + sin(2θ) peaks at ≈1.760 (RMS 1) — crest ≈ 4.9 dB…
    const zero = toneListStats([tone(1000, 1), tone(2000, 1)]);
    expect(zero.peak).toBeCloseTo(1.76, 2);
    expect(zero.rms).toBeCloseTo(1.0, 3);
    // …while shifting the second tone 90° reshapes the sum: same RMS (power
    // adds regardless of phase), a different peak — phase costs headroom.
    const shifted = toneListStats([tone(1000, 1), tone(2000, 1, 90)]);
    expect(shifted.rms).toBeCloseTo(zero.rms, 3);
    expect(Math.abs(shifted.peak - zero.peak)).toBeGreaterThan(0.1);
  });

  it("disabled tones are excluded; a silent list reports zeros", () => {
    const one = toneListStats([tone(1000, 0.5), tone(2000, 0.5, 0, false)]);
    expect(one.peak).toBeCloseTo(0.5, 3);
    expect(toneListStats([])).toEqual({ peak: 0, rms: 0, crestDb: 0 });
    expect(toneListStats([tone(1000, 0.5, 0, false)])).toEqual({
      peak: 0,
      rms: 0,
      crestDb: 0,
    });
  });
});

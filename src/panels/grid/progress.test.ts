import { describe, expect, it } from "vitest";
import { acquisitionProgress } from "./progress";

describe("acquisitionProgress", () => {
  it("stays silent while fast frames flow (fps readout is enough)", () => {
    // 32k at 48 kHz ≈ 1.1 s expected — normal cadence shows nothing.
    expect(acquisitionProgress(300, 32768, 48000)).toBeNull();
  });

  it("shows progress through a long acquisition (1M FFT ≈ 22 s)", () => {
    const expected = (1048576 / 48000) * 1000 + 400;
    const pct = acquisitionProgress(expected / 2, 1048576, 48000);
    expect(pct).toBe(50);
    // Early in the frame it already shows (the user asked for feedback
    // precisely when nothing has displayed yet).
    expect(acquisitionProgress(2000, 1048576, 48000)).toBe(9);
  });

  it("a stalled fast stream surfaces too, capped at 99%", () => {
    // 8k FFT should frame in ~0.6 s; 5 s of silence is a stall.
    expect(acquisitionProgress(5000, 8192, 48000)).toBe(99);
    // Never reports 100: only a received frame completes a frame.
    expect(acquisitionProgress(60_000, 1048576, 48000)).toBe(99);
  });
});

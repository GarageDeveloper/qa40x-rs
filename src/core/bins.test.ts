// The bin-grid leaf (issue #25 lot F3): pins the extraction of
// `playedFrequencyHz`'s pure half bit-identical — stream.test.ts keeps
// pinning the state-reading wrapper on top.
import { describe, expect, it } from "vitest";
import { playedFrequency, snapToBin } from "./bins";

describe("snapToBin", () => {
  it("snaps 1 kHz at 32768/48k to the e2e-pinned grid value", () => {
    // The value sources-panel.pw.ts (and the F3 per-target readouts) print.
    expect(snapToBin(1000, 32768, 48000)).toBeCloseTo(1000.48828125, 9);
  });

  it("never snaps below bin 1 (DC is not a tone)", () => {
    expect(snapToBin(0.0001, 32768, 48000)).toBeCloseTo(48000 / 32768, 9);
  });
});

describe("playedFrequency — clamp then conditional snap", () => {
  it("clamps the ask to 1 Hz at the bottom", () => {
    expect(playedFrequency(0, 48000, false, 32768)).toBe(1);
  });

  it("clamps the ask to 0.98·Nyquist at the top, per the TARGET rate", () => {
    expect(playedFrequency(1e9, 48000, false, 32768)).toBe(24000 * 0.98);
    expect(playedFrequency(1e9, 192000, false, 32768)).toBe(96000 * 0.98);
  });

  it("bin-snaps only when the coherent toggle is on", () => {
    expect(playedFrequency(1000, 48000, true, 32768)).toBeCloseTo(1000.48828125, 9);
    expect(playedFrequency(1000, 48000, false, 32768)).toBe(1000);
  });

  it("two rates give the same ask two different grid values (the per-target readout premise)", () => {
    const at48k = playedFrequency(1000, 48000, true, 32768);
    const at192k = playedFrequency(1000, 192000, true, 32768);
    expect(at48k).not.toBe(at192k);
    expect(at192k).toBeCloseTo(1001.953125, 9);
  });
});

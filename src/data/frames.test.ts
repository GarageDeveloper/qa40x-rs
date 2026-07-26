/**
 * `wireToSweep` (issue #27 review finding #1): the ONE place the backend's
 * wire `Frame` becomes the cache's `DecodedSweep`, and the ONE place the
 * `xUnit` param — the frame's authoritative x-axis unit — is attached. No
 * dedicated test existed for this function before issue #27 gave it a
 * second (optional) argument; these pin its exact passthrough behavior.
 */
import { describe, expect, it } from "vitest";
import type { Frame } from "../gen";
import { wireToSweep } from "./frames";

function sweepFrame(): Frame {
  return {
    domain: "sweep",
    freqs: [20, 1000, 20000],
    curves: [{ label: "Left", values: [-100, -110, -90], phase_deg: null }],
  };
}

describe("wireToSweep", () => {
  it("attaches the given xUnit to the decoded frame", () => {
    const d = wireToSweep(sweepFrame(), "dBFS");
    expect(d?.xUnit).toBe("dBFS");
    expect(Array.from(d!.freqs)).toEqual([20, 1000, 20000]);
    expect(Array.from(d!.curves[0].values)).toEqual([-100, -110, -90]);
  });

  it("Hz is passed through the same way as dBFS — no special-casing", () => {
    const d = wireToSweep(sweepFrame(), "Hz");
    expect(d?.xUnit).toBe("Hz");
  });

  it("an omitted xUnit decodes to undefined, not a default — the caller's fallback chain (sweepXUnit) owns defaulting, not this function", () => {
    const d = wireToSweep(sweepFrame());
    expect(d?.xUnit).toBeUndefined();
    // The rest of the decode is unaffected by the missing axis.
    expect(Array.from(d!.freqs)).toEqual([20, 1000, 20000]);
  });

  it("a non-sweep frame decodes to undefined regardless of xUnit", () => {
    const tdFrame: Frame = { domain: "td", sample_rate: 48000, t0: 0, samples: [0, 1, 2] };
    expect(wireToSweep(tdFrame, "dBFS")).toBeUndefined();
  });
});

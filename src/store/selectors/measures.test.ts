/**
 * Measure-request selector (issue #26 lot B): the display-budget projection
 * for the scope measurement suite — an endpoint is measured only when a
 * visible tile shows a suite chip AND its readouts follow that endpoint.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { clearAllFrames } from "../../data/frames";
import { HW_TRACE_IDS, initialState, type AppState } from "../state";
import { measureRequest } from "./measures";

function tile(s: AppState, id = "tile-1") {
  return s.layout.tiles[id];
}

describe("measureRequest", () => {
  beforeEach(() => clearAllFrames());

  it("no suite chips anywhere → all off (the backend skips every scan)", () => {
    const s = initialState();
    expect(measureRequest(s)).toEqual({
      input_l: false,
      input_r: false,
      output_l: false,
      output_r: false,
    });
  });

  it("a suite chip requests the tile's chip-source endpoint only", () => {
    const s = initialState();
    s.layout.pattern = "1";
    tile(s).measures = ["freq", "rms"];
    expect(measureRequest(s)).toEqual({
      input_l: true, // tile-1 shows Input L
      input_r: false,
      output_l: false,
      output_r: false,
    });
  });

  it("non-suite chips (rms/peak/thd…) do NOT request the suite", () => {
    const s = initialState();
    s.layout.pattern = "1";
    tile(s).measures = ["rms", "peak", "thd"];
    expect(measureRequest(s).input_l).toBe(false);
  });

  it("an explicit chip source routes the request to that endpoint", () => {
    const s = initialState();
    s.layout.pattern = "1";
    tile(s).traces = [HW_TRACE_IDS.inputL, HW_TRACE_IDS.inputR];
    tile(s).chipSource = HW_TRACE_IDS.inputR;
    tile(s).measures = ["vpp"];
    const req = measureRequest(s);
    expect(req.input_r).toBe(true);
    expect(req.input_l).toBe(false);
  });

  it("suite chips work on ANY tile kind with a chip strip — but never sweeps", () => {
    const s = initialState();
    s.layout.pattern = "1";
    tile(s).kind = "spectrum";
    tile(s).measures = ["acrms"];
    expect(measureRequest(s).input_l).toBe(true);

    tile(s).kind = "sweep";
    expect(measureRequest(s).input_l).toBe(false);
  });

  it("a tile hidden by the pattern does not request (display budget)", () => {
    const s = initialState();
    s.layout.pattern = "1"; // only tile-1 visible
    s.layout.tiles["tile-4"].measures = ["freq"]; // tile-4 follows Input R
    expect(measureRequest(s).input_r).toBe(false);
  });
});

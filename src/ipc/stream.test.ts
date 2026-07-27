/**
 * decodeFrame wire-compat (issue #25 lot C): the frame's `device_id` decodes
 * to `deviceId`, and an OLD payload without the key (pre-lot-C backend, or a
 * device opened outside the registry serializing `null`) decodes to `null` —
 * the same absent-key contract as `measures` in stream.rs.
 */
import { describe, expect, it } from "vitest";
import type { StreamMsg } from "../gen";
import { decodeFrame } from "./stream";

type WireFrame = Extract<StreamMsg, { type: "frame" }>;

function wireFrame(): WireFrame {
  return {
    type: "frame",
    seq: 7,
    device_id: "usb/AB12_CD34",
    captured: { left_channel: [0.1], right_channel: [0.2], sample_rate: 48000 },
    stimulus: null,
    spectra: { frequencies: [], input_l: null, input_r: null, output_l: null, output_r: null },
    metrics: { input_l: null, input_r: null, harmonics_l: null, harmonics_r: null },
    trigger: { input_l: null, input_r: null, output_l: null, output_r: null },
    measures: { input_l: null, input_r: null, output_l: null, output_r: null },
    mix: { sigma_peak_dbv: null, clip_input: "none", clip_output: false, fitted_output_range_dbv: 8 },
    offsets: { input_l: 0, input_r: 0, output_l: 0, output_r: 0, calibrated: true },
    stats: { frames: 7, fps: 8, frame_ms: 120 },
    errors: [],
  };
}

describe("decodeFrame — device identity (issue #25 lot C)", () => {
  it("decodes device_id to deviceId", () => {
    expect(decodeFrame(wireFrame()).deviceId).toBe("usb/AB12_CD34");
  });

  it("an explicit null decodes to null", () => {
    const msg = { ...wireFrame(), device_id: null };
    expect(decodeFrame(msg).deviceId).toBeNull();
  });

  it("an OLD payload without the key decodes to null, not undefined", () => {
    const msg = wireFrame() as Record<string, unknown>;
    delete msg.device_id;
    expect(decodeFrame(msg as unknown as WireFrame).deviceId).toBeNull();
  });
});

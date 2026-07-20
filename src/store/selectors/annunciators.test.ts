import { describe, expect, test } from "vitest";
import { initialState, type AppState } from "../state";
import { annunciators, attenEngaged } from "./annunciators";

function withInputRange(dbv: number): AppState {
  const s = initialState();
  return {
    ...s,
    device: {
      ...s.device,
      status: "connected",
      config: { input_gain: dbv, output_gain: 18, sample_rate: 48000 },
    },
  };
}

const badge = (s: AppState, key: string) =>
  annunciators(s).find((b) => b.key === key)!;

describe("ATTEN derivation (no register — hardware engages at ≥ 24 dBV)", () => {
  test.each([
    [0, false],
    [18, false],
    [24, true],
    [42, true],
  ])("input range %i dBV → engaged=%s", (dbv, engaged) => {
    expect(attenEngaged(dbv)).toBe(engaged);
    expect(badge(withInputRange(dbv), "atten").lit).toBe(engaged);
  });

  test("no config (disconnected) → ATTEN unlit", () => {
    expect(badge(initialState(), "atten").lit).toBe(false);
  });
});

describe("other badges", () => {
  test("clip badges follow run.clip and are alarms", () => {
    const s = initialState();
    const clipped: AppState = {
      ...s,
      run: { ...s.run, clip: { input: "clip", output: true } },
    };
    expect(badge(s, "clip").lit).toBe(false);
    expect(badge(clipped, "clip")).toMatchObject({ lit: true, alarm: true });
    expect(badge(clipped, "outclip")).toMatchObject({ lit: true, alarm: true });
  });

  test("near full scale lights CLIP as a warning, not an alarm (backend tri-state)", () => {
    const s = initialState();
    const near: AppState = {
      ...s,
      run: { ...s.run, clip: { input: "near", output: false } },
    };
    expect(badge(near, "clip")).toMatchObject({ lit: true, warn: true, alarm: false });
    expect(badge(near, "outclip").lit).toBe(false);
  });

  test("averaging badge carries the count", () => {
    const s = initialState();
    const avg: AppState = {
      ...s,
      acquisition: { ...s.acquisition, averaging: { mode: "power", count: 8 } },
    };
    expect(badge(s, "avg").lit).toBe(false);
    expect(badge(avg, "avg")).toMatchObject({ lit: true, label: "AVG ×8" });
  });
});

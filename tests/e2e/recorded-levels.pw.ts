/**
 * INVARIANT FAMILY B (absolute) — levels against RECORDED hardware frames,
 * ported from tests/e2e/recorded-levels.pw.ts to the v2 push-stream page.
 *
 * The fixtures are real QA402 coax-loopback captures (input 18 dBV, output
 * 8 dBV, 48 kHz, 8192 samples — `cargo run --example record_fixtures`).
 * As in v1, no golden absolutes are asserted — only relationships that must
 * hold for real data: the driven channel carries the tone far above its own
 * floor, the undriven channel does not, and two Input traces show DIFFERENT
 * spectra (#58). Readings come from the spectrum view-model — the exact
 * arrays the renderer draws, in the tile's display unit.
 *
 * M1 note: the v2 sources slice is sine-only until M2, so the "both driven"
 * capture is selected by driving TWO sines (fixture selection keys on the
 * driven-channel signature; the replayed ADC data is what's asserted).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./adapter/fixtures";
import type { RecordedFixture } from "./harness/frames";

const IN_L = "hw-in-left";
const IN_R = "hw-in-right";

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "./fixtures"
);

function loadFixture(name: string): RecordedFixture | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), "utf8")
    ) as RecordedFixture;
  } catch {
    return null;
  }
}

const idle = loadFixture("idle");
const sineL = loadFixture("sine-1k-left");
const mix = loadFixture("mix-sine-l-square-r");

test.beforeEach(async ({ app }) => {
  await app.waitConnected();
  // Match the recorded register state: input 18 dBV, FFT 8192 (the fixture
  // block length); output 8 dBV is what the auto-range fits for −12 dBV.
  await app.setSelect("input-range", "18");
  await app.setSelect("fft-size", "8192");
});

test("a recorded loopback tone reads back on the driven channel only, well above the floor", async ({
  app,
}) => {
  test.skip(!idle || !sineL, "awaiting recorded fixtures (#54)");
  await app.useFixtures([idle, sineL]);
  const id = await app.addSine(); // 1 kHz, −12 dBV, Out L — the recorded drive
  await app.playSine(id); // play auto-starts the stream (M2)
  await app.setTraceVisible(IN_R, true);
  await app.waitForSeries("Input L");
  await app.waitForSeries("Input R");
  await app.setTileUnit("dbv");

  const l1k = await app.curvePeakDb("Input L", 1000);
  const lFloor = await app.curvePeakDb("Input L", 15000, 500);
  const r1k = await app.curvePeakDb("Input R", 1000);
  expect(l1k).not.toBeNull();
  expect(lFloor).not.toBeNull();
  expect(r1k).not.toBeNull();

  // The recorded fundamental stands far above the same trace's own HF
  // floor — real signal, not a flat fabrication.
  expect(l1k! - lFloor!).toBeGreaterThan(40);
  // Channel isolation: the undriven Input R must NOT show the tone (a
  // shared-offset/shared-buffer bug would leak it — #50/#58 family).
  expect(l1k! - r1k!).toBeGreaterThan(40);
});

test("the mix capture shows DIFFERENT spectra on the two Input traces (#58, real data)", async ({
  app,
}) => {
  test.skip(!idle || !sineL || !mix, "awaiting recorded fixtures (#54)");
  await app.useFixtures([idle, sineL, mix]);
  // Two driven channels select the recorded MIX frame (sine L + square R).
  const driveL = await app.addSine();
  const driveR = await app.addSine();
  await app.setSineRoute(driveR, "right");
  await app.playSine(driveL); // play auto-starts the stream (M2)
  await app.playSine(driveR);
  await app.setTraceVisible(IN_R, true);
  await app.waitForSeries("Input L");
  await app.waitForSeries("Input R");
  await app.setTileUnit("dbv");

  const l1k = await app.curvePeakDb("Input L", 1000);
  const r1k = await app.curvePeakDb("Input R", 1000);
  const l3k = await app.curvePeakDb("Input L", 3000);
  const r3k = await app.curvePeakDb("Input R", 3000);
  expect(l1k).not.toBeNull();
  expect(r1k).not.toBeNull();

  // Both fundamentals present (the recorded mix drives both channels)…
  expect(Math.abs(l1k! - r1k!)).toBeLessThan(6);
  // …and the square's 3rd harmonic lives on ITS channel only: strong on R,
  // absent on L. Two Input traces MUST differ (#58).
  expect(r3k! - r1k!).toBeGreaterThan(-25);
  expect(r3k! - l3k!).toBeGreaterThan(40);
});

/**
 * INVARIANT FAMILY A — "one value where there must be N" (#49/#50/#58),
 * ported to v2. The recurring bug class: code written as if there were ONE
 * source / ONE stimulus spectrum / ONE input spectrum, surviving until two
 * are actually on screen. Every test puts TWO of something side by side on
 * ONE tile and asserts each keeps its own identity, relationally (own-band
 * level vs the other's band, wide 40 dB margin — no golden values).
 */
import { expect, test } from "./adapter/fixtures";

const IN_R = "hw-in-right";
const OUT_L = "hw-out-left";
const OUT_R = "hw-out-right";

test.beforeEach(async ({ app }) => {
  await app.waitConnected();
});

/** Two sources with distinct tones on distinct channels: 1 kHz → Out L,
 * 3 kHz → Out R. Distinct frequencies make ownership visible. */
async function addSplitPair(app: import("./adapter/app").AppV2): Promise<void> {
  const a = await app.addSine();
  await app.setSineRoute(a, "left");
  const b = await app.addSine();
  await app.setSineFrequency(b, 3000);
  await app.setSineRoute(b, "right");
  await app.playSine(a);
  await app.playSine(b);
}

test("two sources routed L and R, both played, BOTH are in the mix", async ({ app }) => {
  await addSplitPair(app);
  // Each channel carries one −12 dBV source, so the SUM's peak is −12: the
  // second source joined the mix instead of replacing the first.
  await expect
    .poll(async () => (await app.mixReadout()).peakDbv, { timeout: 10_000 })
    .toBeCloseTo(-12, 0);
});

test("Output L and Output R each carry their OWN spectrum (#50)", async ({ app }) => {
  await addSplitPair(app);
  await app.setTraceVisible(OUT_L, true);
  await app.setTraceVisible(OUT_R, true);
  await app.setTileUnit("dbv");
  await app.waitForSeries("Output L");
  await app.waitForSeries("Output R");
  await expect
    .poll(() => app.curvePeakDb("Output R", 3000), { timeout: 10_000 })
    .toBeCloseTo(-12, 0);

  const l1k = await app.curvePeakDb("Output L", 1000);
  const l3k = await app.curvePeakDb("Output L", 3000);
  const r1k = await app.curvePeakDb("Output R", 1000);
  const r3k = await app.curvePeakDb("Output R", 3000);
  expect(l1k).not.toBeNull();
  expect(r3k).not.toBeNull();

  // Each channel owns its tone at the asked level…
  expect(l1k!).toBeGreaterThan(-13);
  expect(l1k!).toBeLessThan(-11);
  expect(r3k!).toBeCloseTo(l1k!, 0);
  // …and does NOT carry the other channel's tone: if both series drew one
  // shared spectrum (the bug), these margins collapse to ~0 dB.
  expect(l1k! - r1k!).toBeGreaterThan(40);
  expect(r3k! - l3k!).toBeGreaterThan(40);
});

test("Input L and Input R on ONE fd tile each draw their OWN spectrum (#58)", async ({
  app,
}) => {
  await addSplitPair(app);
  await app.setTraceVisible(IN_R, true); // Input L is on the tile by default
  await app.setTileUnit("dbv");
  await app.waitForSeries("Input L");
  await app.waitForSeries("Input R");
  await expect
    .poll(() => app.curvePeakDb("Input R", 3000), { timeout: 10_000 })
    .toBeCloseTo(-12, 0);

  // The loopback puts 1 kHz on the left ADC and 3 kHz on the right one; a
  // per-channel capture must keep them apart on the SAME tile.
  const l1k = await app.curvePeakDb("Input L", 1000);
  const l3k = await app.curvePeakDb("Input L", 3000);
  const r1k = await app.curvePeakDb("Input R", 1000);
  const r3k = await app.curvePeakDb("Input R", 3000);
  expect(l1k).not.toBeNull();
  expect(r3k).not.toBeNull();
  expect(l1k!).toBeGreaterThan(-13);
  expect(l1k!).toBeLessThan(-11);
  expect(r3k!).toBeCloseTo(l1k!, 0);
  expect(l1k! - r1k!).toBeGreaterThan(40);
  expect(r3k! - l3k!).toBeGreaterThan(40);

  await app.screenshot("dual-input-spectra");
});

test("the scope shows each trace through ITS converter's volts (#60 twin)", async ({
  app,
}) => {
  const id = await app.addSine(); // −12 dBV → 0.251 Vrms, 0.355 Vpk
  await app.playSine(id);
  await app.setTileKind("scope");
  await app.setTraceVisible(OUT_L, true);
  await app.setTileUnit("v");
  // Both series are converted through their OWN converter offset; on the
  // unity loopback both must show the same physical volts (~0.36 Vpk).
  await expect
    .poll(
      async () =>
        (await app.scopeSeries()).find((s) => s.label === "Output L")?.peak ?? null,
      { timeout: 10_000 }
    )
    .toBeCloseTo(0.355, 1);
  const inL = (await app.scopeSeries()).find((s) => s.label === "Input L");
  expect(inL?.peak ?? 0).toBeCloseTo(0.355, 1);

  // An ADC range step must not move the DAC trace's volts (#60): step the
  // input range 42 → 30 dBV and re-read.
  const before = (await app.scopeSeries()).find((s) => s.label === "Output L")!.peak;
  await app.setSelect("input-range", "30");
  const seq = await app.frameCount();
  await expect
    .poll(() => app.frameCount(), { timeout: 10_000 })
    .toBeGreaterThan(seq + 1);
  const after = (await app.scopeSeries()).find((s) => s.label === "Output L")!.peak;
  expect(after).toBeCloseTo(before, 2);
  // …and the Input trace's absolute volts are range-invariant too.
  const inAfter = (await app.scopeSeries()).find((s) => s.label === "Input L")!.peak;
  expect(inAfter).toBeCloseTo(0.355, 1);
});

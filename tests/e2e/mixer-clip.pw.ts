/**
 * INVARIANT FAMILY D — the mixer's sum and the clip contract, ported from
 * tests/e2e/mixer-clip.pw.ts to the v2 push-stream page — plus the M2
 * range-stability invariant.
 *
 * Levels add in the SAMPLE domain, not in dB: two equal in-phase sines on
 * one channel peak 6 dB above one of them, and the same two split L/R leave
 * each channel's peak untouched. When the sum exceeds what the output stage
 * can produce, the app must REPORT clipping — never silently rescale the
 * user's mix: the sources' asked levels and the displayed Σ-peak keep
 * telling the pre-clip truth. (The ~100 ms latch itself is backend-owned
 * now and pinned by mixer::range_tests; the fake reports per-frame clip, so
 * these specs assert the report/never-rescale contract, not hold timing.)
 *
 * And the hysteresis contract, as an e2e invariant: a STABLE signal must
 * produce a STABLE output range — the fitted range must not oscillate frame
 * to frame (plan §4.2 M2).
 */
import { expect, test } from "./adapter/fixtures";

test.beforeEach(async ({ app }) => {
  await app.waitConnected();
});

test("two equal sources on ONE channel sum +6 dB; split across L/R they don't", async ({
  app,
}) => {
  // Same frequency (bin-snapped identically) and phase 0 → coherent sum.
  const a = await app.addSine(); // −12 dBV, Out L
  const b = await app.addSine();
  await app.setSineRoute(b, "right");
  await app.playSine(a); // play auto-starts the stream (M2)
  await app.playSine(b);

  // Split L/R: each channel carries one −12 dBV sine — Σ peak is −12,
  // exactly as if each played alone (the split leaves both unchanged).
  await expect
    .poll(async () => (await app.mixReadout()).peakDbv, { timeout: 10_000 })
    .toBeCloseTo(-12, 0);

  // Move B onto the SAME channel as A: coherent equal sum → +6.02 dB.
  await app.setSineRoute(b, "left");
  await expect
    .poll(async () => (await app.mixReadout()).peakDbv, { timeout: 10_000 })
    .toBeCloseTo(-6, 0);

  // And back: the split restores each channel's own peak.
  await app.setSineRoute(b, "right");
  await expect
    .poll(async () => (await app.mixReadout()).peakDbv, { timeout: 10_000 })
    .toBeCloseTo(-12, 0);
});

test("a clipping sum lights the clip dot and is never silently rescaled", async ({
  app,
}) => {
  // Each source alone is legal (+15 dBV ≤ the +18 dBV top range); their
  // coherent sum (+21 dBV) exceeds anything the output stage can produce.
  const a = await app.addSine();
  const b = await app.addSine();
  await app.setSineLevel(a, 15);
  await app.setSineLevel(b, 15);
  await app.playSine(a);
  await app.playSine(b);

  // The overloaded sum is what the footer reports, and the clip dot lights.
  await expect
    .poll(async () => (await app.mixReadout()).peakDbv, { timeout: 10_000 })
    .toBeCloseTo(21, 0);
  await expect
    .poll(async () => (await app.mixReadout()).clipLit, { timeout: 10_000 })
    .toBe(true);

  // NOTHING was rescaled to hide it: Σ-peak reports the true pre-clip sum
  // (+21 dB, over the +18 range ceiling) and both sources still show the
  // level the user asked for.
  const readout = await app.mixReadout();
  expect(readout.peakDbv!).toBeGreaterThan(20);
  expect(readout.peakDbv!).toBeLessThan(22);
  expect(readout.rangeDbv).toBe(18);
  expect(await app.sourceLevelValue(a)).toBe(15);
  expect(await app.sourceLevelValue(b)).toBe(15);

  // Cure the overload (drop B far below A): the clip report ends.
  await app.setSineLevel(b, -12);
  await expect
    .poll(async () => (await app.mixReadout()).peakDbv, { timeout: 10_000 })
    .toBeLessThan(16); // A alone ≈ +15.4: below the ceiling
  await expect
    .poll(async () => (await app.mixReadout()).clipLit, { timeout: 10_000 })
    .toBe(false);
  expect(await app.sourceLevelValue(a)).toBe(15);
  expect(await app.sourceLevelValue(b)).toBe(-12);
});

test("a stable signal produces a STABLE output range (no hysteresis oscillation)", async ({
  app,
}) => {
  const id = await app.addSine(); // −12 dBV → the +8 dBV range
  await app.playSine(id);
  await expect
    .poll(() => app.fittedOutputRange(), { timeout: 10_000 })
    .toBe(8);

  // Watch the fitted range across ≥ 8 successive frames: it must never move.
  const watch = async (want: number): Promise<void> => {
    const from = await app.frameCount();
    let seen = from;
    while (seen < from + 8) {
      await expect
        .poll(() => app.frameCount(), { timeout: 10_000 })
        .toBeGreaterThan(seen);
      seen = await app.frameCount();
      expect(await app.fittedOutputRange()).toBe(want);
    }
  };
  await watch(8);

  // A level within the +1 dB margin of the +8 ceiling forces +18 — and must
  // be just as stable there (the down-hysteresis holds it).
  await app.setSineLevel(id, 7.5);
  await expect
    .poll(() => app.fittedOutputRange(), { timeout: 10_000 })
    .toBe(18);
  await watch(18);
});

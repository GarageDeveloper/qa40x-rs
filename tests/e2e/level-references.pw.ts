/**
 * INVARIANT FAMILY B — level references (the #51 bug class), ported from
 * tests/e2e/level-references.pw.ts to the v2 push-stream page.
 *
 * Two converters, two independent dBFS references: the ADC's moves with the
 * input range (reg 5), the DAC's with the output range (reg 6). The bug
 * class is collapsing them into one value. In v2 the guard is structural —
 * every pushed frame carries its own per-converter offsets (B-3) and each
 * trace converts through its OWN converter's offset in the chartvm selector
 * — and these specs pin it end-to-end through the real UI:
 *
 *  1. an INPUT-range step re-references the ADC's dBFS by exactly the step,
 *     and moves NO absolute dBV reading — neither the Input trace (same
 *     volts at the jack) nor the Output/DAC trace (#51 regression pin);
 *  2. Output and Input traces agree on the fundamental in dBV, follow the
 *     asked level, and an ask that forces the output range to step moves
 *     both by exactly the asked delta (the range switch itself moves 0).
 *
 * Levels are read from the spectrum view-model (band peak — the app
 * bin-snaps tones). Synthetic loopback provider: it models the register
 * scaling honestly (frames.ts) and lets ranges move freely, which recorded
 * fixtures pin to their capture-time registers.
 */
import { expect, test } from "./adapter/fixtures";

const OUT_L = "hw-out-left";

test.beforeEach(async ({ app }) => {
  await app.waitConnected();
});

test("an input-range step re-references dBFS by the step and moves NO absolute dBV reading", async ({
  app,
}) => {
  const id = await app.addSine(); // 1 kHz, −12 dBV, Out L
  await app.playSine(id); // play auto-starts the stream (M2)
  await app.setTraceVisible(OUT_L, true);
  await app.waitForSeries("Input L");
  await app.waitForSeries("Output L");

  // Connect forces the safe 42 dBV input range; start from there.
  expect(await app.selectValue("input-range")).toBe("42");

  await app.setTileUnit("dbv");
  const inDbvBefore = await app.curvePeakDb("Input L", 1000);
  const outDbvBefore = await app.curvePeakDb("Output L", 1000);
  await app.setTileUnit("dbfs");
  const inDbfsBefore = await app.curvePeakDb("Input L", 1000);

  // Step the input range 42 → 30 dBV through the real control path, then
  // wait for a frame captured under the new register state.
  const seqAtStep = await app.maxSeriesSeq();
  await app.setSelect("input-range", "30");
  await app.waitForSeries("Input L", seqAtStep + 2);

  // dBFS (the ADC's own reference) moves by exactly the step: the signal
  // sits 12 dB closer to the smaller range's full scale.
  const inDbfsAfter = await app.curvePeakDb("Input L", 1000);
  expect(inDbfsAfter!).toBeCloseTo(inDbfsBefore! + 12, 0);

  await app.setTileUnit("dbv");
  // The volts at the jack did not change: the Input trace's absolute dBV
  // is range-invariant…
  const inDbvAfter = await app.curvePeakDb("Input L", 1000);
  expect(inDbvAfter!).toBeCloseTo(inDbvBefore!, 1);
  // …and the DAC trace CANNOT move on an ADC range step (#51: an Output
  // trace must never borrow the ADC's reference).
  const outDbvAfter = await app.curvePeakDb("Output L", 1000);
  expect(outDbvAfter!).toBeCloseTo(outDbvBefore!, 1);
});

test("Output and Input agree on the fundamental, and follow the asked level through a range switch", async ({
  app,
}) => {
  const id = await app.addSine(); // default ask: −12 dBV
  await app.playSine(id); // play auto-starts the stream (M2)
  await app.setTraceVisible(OUT_L, true);
  await app.waitForSeries("Input L");
  await app.waitForSeries("Output L");
  await app.setTileUnit("dbv");

  // Loopback: what was sent is what is read — Output and Input agree on
  // the fundamental, and both sit at the asked −12 dBV.
  const out1 = await app.curvePeakDb("Output L", 1000);
  const in1 = await app.curvePeakDb("Input L", 1000);
  expect(in1!).toBeCloseTo(out1!, 0);
  expect(out1!).toBeGreaterThan(-13);
  expect(out1!).toBeLessThan(-11);
  // −12 dBV fits the +8 dBV output range (auto-fit, +1 dB margin).
  expect(await app.selectValue("output-range")).toBe("8");

  // Re-ask +10 dBV: peak + margin no longer fits +8 → the range steps to
  // +18, and BOTH traces move by exactly the asked +22 dB. The range
  // switch itself must move nothing.
  const seqAtAsk = await app.maxSeriesSeq();
  await app.setSineLevel(id, 10);
  await app.waitForSeries("Output L", seqAtAsk + 2);

  await expect
    .poll(() => app.selectValue("output-range"), { timeout: 5000 })
    .toBe("18");
  const out2 = await app.curvePeakDb("Output L", 1000);
  const in2 = await app.curvePeakDb("Input L", 1000);
  expect(out2! - out1!).toBeCloseTo(22, 0);
  expect(in2! - in1!).toBeCloseTo(22, 0);
});

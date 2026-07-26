/**
 * THD-vs-level sweep (issue #27): the backend's frequency-axis THD sweep
 * (`measure_thd_vs_frequency`) has a level-axis sibling, `measure_thd_vs_level`
 * — same one-stream batched-capture program, swept axis flipped (linear dBFS
 * steps at a fixed tone instead of log-spaced Hz at a fixed level). This spec
 * covers the wiring this issue adds on top of the already-tested backend:
 *
 *   - the sweep dialog's axis selector swaps in the level-axis fields (tone
 *     frequency, start/end level) and hides the frequency-axis ones (and
 *     vice-versa) — no layout left half-configured either way;
 *   - running the program calls the LEVEL command, not the frequency one,
 *     and lands `level_dbfs` (not `frequency`) as the sweep frame's x-axis;
 *   - the sweep tile's view-model reports a "dBFS" x-unit so the renderer
 *     draws a linear dB axis instead of the frequency sweep's log Hz one.
 *
 * The fake backend's result is a stub (see harness/fake-device.ts
 * thdLevelSweep) — this spec asserts the plumbing and the exact x-values it
 * is given, never invented "real" THD numbers.
 */
import { expect, test } from "./adapter/fixtures";

test("the sweep dialog's axis select swaps frequency-axis and level-axis fields", async ({
  app,
}) => {
  await app.waitConnected();
  const id = await app.addProgram("thd");

  await app.drv.click(`[data-testid="prog-gear-${id}"]`);

  // Default axis is "frequency" (DEFAULT_SWEEP_PARAMS) — the original
  // frequency-sweep fields show, the level-axis-only ones stay hidden.
  expect(await app.dialogRowHidden(`sweep-start-${id}`)).toBe(false);
  expect(await app.dialogRowHidden(`sweep-end-${id}`)).toBe(false);
  expect(await app.dialogRowHidden(`sweep-level-${id}`)).toBe(false);
  expect(await app.dialogRowHidden(`sweep-tone-${id}`)).toBe(true);
  expect(await app.dialogRowHidden(`sweep-startdb-${id}`)).toBe(true);
  expect(await app.dialogRowHidden(`sweep-enddb-${id}`)).toBe(true);

  await app.setSelect(`sweep-axis-${id}`, "level");

  // Flipped: level-axis fields show, frequency-axis ones (incl. the constant
  // stimulus Level, meaningless once level itself is swept) hide.
  expect(await app.dialogRowHidden(`sweep-start-${id}`)).toBe(true);
  expect(await app.dialogRowHidden(`sweep-end-${id}`)).toBe(true);
  expect(await app.dialogRowHidden(`sweep-level-${id}`)).toBe(true);
  expect(await app.dialogRowHidden(`sweep-tone-${id}`)).toBe(false);
  expect(await app.dialogRowHidden(`sweep-startdb-${id}`)).toBe(false);
  expect(await app.dialogRowHidden(`sweep-enddb-${id}`)).toBe(false);
  await app.screenshot("thd-level-sweep-dialog");

  // Frequency response has no axis choice at all (a chirp IS a frequency
  // sweep) — the axis row itself hides.
  await app.setSelect(`sweep-measurement-${id}`, "fr");
  expect(await app.dialogRowHidden(`sweep-axis-${id}`)).toBe(true);

  await app.closeDialog();
});

test("a THD level-axis program calls the level command, labels its own range, and lands level_dbfs as the sweep tile's dBFS x-axis", async ({
  app,
}) => {
  await app.waitConnected();
  const id = await app.addProgram("thd");

  await app.drv.click(`[data-testid="prog-gear-${id}"]`);
  await app.setSelect(`sweep-axis-${id}`, "level");
  await app.setNumber(`sweep-tone-${id}`, 1000);
  await app.setNumber(`sweep-startdb-${id}`, -40);
  await app.setNumber(`sweep-enddb-${id}`, 0);
  await app.setNumber(`sweep-points-${id}`, 5);
  await app.drv.click(`[data-testid="sweep-apply-${id}"]`);

  // The auto-label follows the SWEPT range (its own axis), not the unused
  // frequency bounds — "Sweep -40–0 dBFS", not "...20–20000 Hz".
  expect(await app.traceLabel(id)).toBe("Sweep -40–0 dBFS");

  await app.holdPrograms();
  await app.playProgram(id);
  await expect.poll(() => app.programRun(id)).toBe("running");
  await app.releasePrograms();
  await expect.poll(() => app.programRun(id), { timeout: 10_000 }).toBe("idle");

  expect(await app.traceDomains(id)).toContain("sweep");
  await app.setTileKind("sweep", "tile-1");
  await app.setTraceVisible(id, true, "tile-1");
  await expect
    .poll(async () => (await app.sweepSeries("tile-1")).length)
    .toBeGreaterThan(0);
  const [series] = await app.sweepSeries("tile-1");
  expect(series.points).toBe(5);
  // The x-axis unit flips to dBFS (linear) — not the frequency sweep's Hz
  // (log) — and its extent IS the requested level range.
  expect(series.xUnit).toBe("dBFS");
  expect(series.xFirst).toBe(-40);
  expect(series.xLast).toBe(0);
  await app.screenshot("thd-level-sweep-tile");
});

test("a tile mixing a frequency sweep and a level sweep omits the mismatched one and marks its legend chip (review finding #3)", async ({
  app,
}) => {
  await app.waitConnected();

  // A plain frequency-axis THD sweep (the default axis)...
  const freqProg = await app.addProgram("thd");
  await app.holdPrograms();
  await app.playProgram(freqProg);
  await expect.poll(() => app.programRun(freqProg)).toBe("running");
  await app.releasePrograms();
  await expect.poll(() => app.programRun(freqProg), { timeout: 10_000 }).toBe("idle");

  // ...and a level-axis one.
  const levelProg = await app.addProgram("thd");
  await app.drv.click(`[data-testid="prog-gear-${levelProg}"]`);
  await app.setSelect(`sweep-axis-${levelProg}`, "level");
  await app.drv.click(`[data-testid="sweep-apply-${levelProg}"]`);
  await app.holdPrograms();
  await app.playProgram(levelProg);
  await expect.poll(() => app.programRun(levelProg)).toBe("running");
  await app.releasePrograms();
  await expect.poll(() => app.programRun(levelProg), { timeout: 10_000 }).toBe("idle");

  // Both land on ONE tile, frequency sweep first.
  await app.setTileKind("sweep", "tile-1");
  await app.setTraceVisible(freqProg, true, "tile-1");
  await app.setTraceVisible(levelProg, true, "tile-1");

  // Only the FIRST-landed trace's axis is drawn — the level sweep is
  // excluded entirely (never plotted on a mismatched scale), not NaN'd.
  await expect.poll(async () => (await app.sweepSeries("tile-1")).length).toBe(1);
  const [series] = await app.sweepSeries("tile-1");
  expect(series.xUnit).toBe("Hz");
  expect(series.label).toBe(await app.traceLabel(freqProg));

  // The excluded trace's legend chip is still there, marked — not silently
  // vanished (no layout shift: same chip, a discreet class + tooltip).
  const chip = await app.drv.eval(
    (x: { tileId: string; traceId: string }) => {
      const n = document.querySelector<HTMLElement>(
        `[data-testid="tile-trace-${x.tileId}-${x.traceId}"]`
      );
      return {
        present: n !== null,
        mismatch: n?.classList.contains("tile__trace--axis-mismatch") ?? false,
        title: n?.title ?? "",
      };
    },
    { tileId: "tile-1", traceId: levelProg }
  );
  expect(chip.present).toBe(true);
  expect(chip.mismatch).toBe(true);
  expect(chip.title).toContain("Different sweep axis");
  await app.screenshot("thd-mixed-axis-tile");
});

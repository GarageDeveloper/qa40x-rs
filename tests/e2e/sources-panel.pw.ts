/**
 * M2 Sources panel invariants on the fake backend:
 *
 * - a broken slot is NAMED on its own row and the rest of the mix keeps
 *   playing (the fake honestly refuses Rhai scripts — that refusal IS a
 *   named per-slot error, exactly the plumbing the real backend uses for a
 *   script that fails to compile);
 * - the sine tone editor reaches the mix: an equal antiphase extra tone
 *   cancels the primary (phase reaches the render, not just the label);
 * - output-only mode hands the DAC over: stream loop → gap-free generator,
 *   edits rebuild the loop buffer, unchecking resumes capture + analysis;
 * - a hidden multi-tone is never silent state: the collapsed row's Tones
 *   button carries the enabled extra-tone count, and the editor's
 *   open/closed state survives a reload (issue #17).
 */
import { expect, test } from "./adapter/fixtures";

test.beforeEach(async ({ app }) => {
  await app.waitConnected();
});

test("a broken slot is named on ITS row; the other source keeps playing", async ({
  app,
}) => {
  const sine = await app.addSine();
  const script = await app.addSource("script");
  await app.playSine(sine); // play auto-starts the stream (M2)
  await app.playSine(script);

  // The script's failure is named on the script row — and only there.
  await expect
    .poll(() => app.sourceError(script), { timeout: 10_000 })
    .toContain("does not execute Rhai scripts");
  expect(await app.sourceError(sine)).toBe("");

  // The sine keeps playing at its asked level: one bad slot never tears
  // down the mix.
  await expect
    .poll(async () => (await app.mixReadout()).peakDbv, { timeout: 10_000 })
    .toBeCloseTo(-12, 0);
});

test("an equal antiphase extra tone cancels the primary (phase reaches the sum)", async ({
  app,
}) => {
  const id = await app.addSine(); // 1 kHz, −12 dBV
  await app.playSine(id);
  await expect
    .poll(async () => (await app.mixReadout()).peakDbv, { timeout: 10_000 })
    .toBeCloseTo(-12, 0);

  // Open the tone editor and add one extra tone at the SAME frequency and
  // level, 180° out: both are bin-snapped identically, so the pair cancels
  // to silence (down to sin(x+π) float residue — assert "far below any
  // signal", not exact zero: Σ either reads "—" or a < −100 dBV residue).
  await app.drv.click(`[data-testid="src-more-${id}"]`);
  await app.drv.click(`[data-testid="src-tone-add-${id}"]`);
  await app.setNumber(`src-tone-freq-${id}-0`, 1000);
  await app.setNumber(`src-tone-level-${id}-0`, -12);
  await app.setNumber(`src-tone-phase-${id}-0`, 180);
  await expect
    .poll(
      async () => ((await app.mixReadout()).peakDbv ?? -999) < -100,
      { timeout: 10_000 }
    )
    .toBe(true);

  // Disable the extra tone: the classic sine slot returns, and so does Σ.
  await app.drv.click(`[data-testid="src-tone-en-${id}-0"]`);
  await expect
    .poll(async () => (await app.mixReadout()).peakDbv, { timeout: 10_000 })
    .toBeCloseTo(-12, 0);
});

test("output-only hands the DAC over and back: generator on, capture off, then resume", async ({
  app,
}) => {
  const id = await app.addSine();
  await app.playSine(id);
  await expect.poll(() => app.streaming(), { timeout: 10_000 }).toBe(true);

  // Mode on: the gap-free generator takes the DAC, the capture stream stops,
  // and the footer keeps reporting the mix from the start status.
  await app.setOutputOnly(true);
  await expect.poll(() => app.generatorRunning(), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => app.streaming(), { timeout: 10_000 }).toBe(false);
  expect((await app.mixReadout()).peakDbv).toBeCloseTo(-12, 0);

  // An edit while the mode is on rebuilds the FIXED loop buffer — the DAC
  // must never keep emitting a mix the rows no longer describe (v1 #49).
  await app.setSineLevel(id, -20);
  await expect
    .poll(async () => (await app.mixReadout()).peakDbv, { timeout: 10_000 })
    .toBeCloseTo(-20, 0);
  expect(await app.generatorRunning()).toBe(true);

  // Mode off: capture + analysis resume (a session must not stay deaf).
  await app.setOutputOnly(false);
  await expect.poll(() => app.generatorRunning(), { timeout: 10_000 }).toBe(false);
  await expect.poll(() => app.streaming(), { timeout: 10_000 }).toBe(true);
});

test("a hidden extra tone lights the collapsed row; the editor's open state survives a reload", async ({
  app,
}) => {
  const id = await app.addSine();
  const moreBtn = `[data-testid="src-more-${id}"]`;
  const editorOpen = () =>
    app.drv.eval(
      (sel: string) =>
        document
          .querySelector(sel)!
          .closest(".sources__detail")!
          .classList.contains("sources__detail--open"),
      `[data-testid="src-tones-${id}"]`
    );

  // No extra tones: a plain, unlit button.
  expect(await app.drv.text(moreBtn)).toBe("Tones");

  // An enabled extra tone must show on the collapsed row: count + lit style.
  await app.drv.click(moreBtn);
  await app.drv.click(`[data-testid="src-tone-add-${id}"]`);
  await expect.poll(() => app.drv.text(moreBtn)).toBe("Tones ×1");
  expect(
    await app.drv.eval(
      (sel: string) => document.querySelector(sel)!.classList.contains("btn--primary"),
      moreBtn
    )
  ).toBe(true);

  // The badge counts ENABLED tones, not rows: disabling clears it.
  await app.drv.click(`[data-testid="src-tone-en-${id}-0"]`);
  await expect.poll(() => app.drv.text(moreBtn)).toBe("Tones");
  await app.drv.click(`[data-testid="src-tone-en-${id}-0"]`);
  await expect.poll(() => app.drv.text(moreBtn)).toBe("Tones ×1");

  // Left OPEN across a reload: comes back open, badge still lit — a restored
  // multi-tone is never invisible (the bug this guards against).
  await app.saveWorkspaceAs("tones bench");
  await app.waitForAutoSave("tones bench");
  await app.boot();
  await app.waitConnected();
  expect(await editorOpen()).toBe(true);
  expect(await app.drv.text(moreBtn)).toBe("Tones ×1");

  // Closed across a reload: stays closed, but the badge still betrays the
  // active extra tone.
  await app.drv.click(moreBtn);
  await app.boot();
  await app.waitConnected();
  expect(await editorOpen()).toBe(false);
  expect(await app.drv.text(moreBtn)).toBe("Tones ×1");
});

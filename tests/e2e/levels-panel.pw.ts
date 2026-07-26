/**
 * Levels panel (issue #29 — exposes `measure_levels`): the SAME
 * exclusive-device-lock discipline as a sweep program (device-lock.pw.ts),
 * but the result is one scalar reading, not a trace. The fake's
 * `measure_levels` is a STUB (see tests/e2e/README.md) — these tests assert
 * PLUMBING (the lock holds every transport, every readout fills in, no
 * layout shift, the stimulus frequency clamp), never the fake's numbers.
 */
import { expect, test } from "./adapter/fixtures";

const LEVELS_LOCK = 'measurement "Levels" is running';

const readoutIds = [
  "levels-readout-unweighted",
  "levels-readout-a",
  "levels-readout-c",
  "levels-readout-peak",
  "levels-readout-vrms",
  "levels-readout-dbv",
  "levels-readout-dbu",
  "levels-readout-a-dbv",
  "levels-readout-cal",
  "levels-readout-clip",
  "levels-readout-played",
];

test("readouts are ALWAYS present (no layout shift) — dashes before the first measurement", async ({
  app,
}) => {
  await app.waitConnected();
  for (const id of readoutIds) {
    expect(await app.drv.text(`[data-testid="${id}"]`)).toBe("—");
  }
});

test("Measure locks every transport by name, then fills every readout with correct units", async ({
  app,
}) => {
  await app.waitConnected();

  await app.holdPrograms(); // gates measure_levels too — same programGate as the THD sweep
  await app.drv.click('[data-testid="levels-measure"]');

  // Same device-lock family as a sweep program (device-lock.pw.ts): every
  // transport greys out WITH THE MEASUREMENT'S NAME, never silently inert.
  await expect
    .poll(() => app.drv.text('[data-testid="levels-measure"]'))
    .toBe("Measuring…");
  const runWhileLocked = await app.runButtonState();
  expect(runWhileLocked.disabled).toBe(true);
  expect(runWhileLocked.title).toContain(LEVELS_LOCK);
  await expect.poll(() => app.sourcesLockNote()).toContain(LEVELS_LOCK);

  await app.releasePrograms();

  // The lock lifts...
  await expect.poll(() => app.drv.text('[data-testid="levels-measure"]')).toBe("Measure");
  await expect.poll(async () => (await app.runButtonState()).disabled).toBe(false);
  await expect.poll(() => app.sourcesLockNote()).toBeNull();

  // ...and every readout landed (plumbing only — stub values, never golden).
  for (const id of readoutIds) {
    await expect.poll(() => app.drv.text(`[data-testid="${id}"]`)).not.toBe("—");
  }
  expect(await app.drv.text('[data-testid="levels-readout-cal"]')).toBe("yes");
  expect(await app.drv.text('[data-testid="levels-readout-clip"]')).toBe("ok");

  // Unit suffixes are correct (review finding #9b) — dBV/dBu readouts must
  // never just say "dB".
  expect(await app.drv.text('[data-testid="levels-readout-unweighted"]')).toMatch(/dBFS$/);
  expect(await app.drv.text('[data-testid="levels-readout-a"]')).toMatch(/dBFS$/);
  expect(await app.drv.text('[data-testid="levels-readout-c"]')).toMatch(/dBFS$/);
  expect(await app.drv.text('[data-testid="levels-readout-peak"]')).toMatch(/dBFS$/);
  expect(await app.drv.text('[data-testid="levels-readout-dbv"]')).toMatch(/dBV$/);
  expect(await app.drv.text('[data-testid="levels-readout-dbu"]')).toMatch(/dBu$/);
  expect(await app.drv.text('[data-testid="levels-readout-a-dbv"]')).toMatch(/dBV$/);
});

test("a stimulus above Nyquist is clamped, and the PLAYED frequency (not the request) is shown", async ({
  app,
}) => {
  await app.waitConnected(); // boots at the default 48 kHz sample rate

  // 30 kHz at 48 kHz would alias past Nyquist (24 kHz) — the input itself
  // clamps to 0.98*Nyquist = 23520 Hz immediately (review finding #1).
  await app.drv.eval(() => {
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="levels-stimulus-freq"]'
    )!;
    input.value = "30000";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, undefined as void);
  await expect
    .poll(() =>
      app.drv.eval(
        () =>
          Number(
            document.querySelector<HTMLInputElement>('[data-testid="levels-stimulus-freq"]')
              ?.value
          ),
        undefined as void
      )
    )
    .toBeCloseTo(23520, -1);

  await app.drv.click('[data-testid="levels-measure"]');
  // The readout reflects what the BACKEND actually played (echoed back
  // through the result), not a bare copy of the input field.
  await expect
    .poll(() => app.drv.text('[data-testid="levels-readout-played"]'))
    .not.toBe("—");
  const played = await app.drv.text('[data-testid="levels-readout-played"]');
  expect(played).toMatch(/kHz$/);
});

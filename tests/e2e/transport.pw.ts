/**
 * Transport state machine (the M3 lockup report): play/pause cycles, a
 * single Stop press, then play again MUST restart the stream. The original
 * bug was a start/stop race — concurrent Tauri commands let a stale stop
 * flag kill the next loop (or a draining loop reject the next start), and
 * the app was stuck until restart. Backend starts now TAKE OVER a draining
 * loop; the frontend sequences a start behind an in-flight stop.
 */
import { expect, test } from "./adapter/fixtures";

const SINE = "src-sine-1"; // the boot workspace's ready-to-play sine

test.beforeEach(async ({ app }) => {
  await app.waitConnected();
});

test("first Run with nothing playing starts the bench sources too", async ({
  app,
}) => {
  // Fresh boot: the ready sine sits paused. A user's first Run must never
  // show an empty capture next to it (maintainer, M5 review) — Run plays
  // the bench, like the v1 "Run all".
  expect(await app.sourcePlaying(SINE)).toBe(false);
  await app.clickRun();
  await expect.poll(() => app.streaming(), { timeout: 10_000 }).toBe(true);
  expect(await app.sourcePlaying(SINE)).toBe(true);

  // Pausing DURING the run is respected (monitor an external signal):
  // the stream keeps going and a later Run leaves already-playing mixes
  // alone — the auto-play only fires when NOTHING plays.
  await app.playSine(SINE); // toggle → pause
  expect(await app.sourcePlaying(SINE)).toBe(false);
  expect(await app.streaming()).toBe(true);
});

test("play → pause ×2 → stop → play restarts the stream", async ({ app }) => {
  // Play auto-starts the run.
  await app.playSine(SINE);
  await expect.poll(() => app.streaming(), { timeout: 10_000 }).toBe(true);
  const n1 = await app.frameCount();
  await expect
    .poll(() => app.frameCount(), { timeout: 10_000 })
    .toBeGreaterThan(n1);

  // Pause: the run keeps monitoring (capture without stimulus).
  await app.playSine(SINE);
  const n2 = await app.frameCount();
  await expect
    .poll(() => app.frameCount(), { timeout: 10_000 })
    .toBeGreaterThan(n2);

  // Play / pause once more (the reported sequence).
  await app.playSine(SINE);
  await app.playSine(SINE);
  expect(await app.streaming()).toBe(true);

  // ONE Stop press stops it — the transport reflects it immediately.
  await app.clickRun();
  await expect.poll(() => app.streaming(), { timeout: 10_000 }).toBe(false);

  // Un-pausing the sine right after MUST bring the stream back — and the
  // TRACES must advance, not just the stats: a restarted backend loop
  // counts its wire seq from 1 again, and the cache stale-drop used to
  // discard every frame of the new run (frozen charts, live fps readout).
  const vmSeq = await app.maxSeriesSeq();
  await app.playSine(SINE);
  await expect.poll(() => app.streaming(), { timeout: 10_000 }).toBe(true);
  await expect
    .poll(() => app.maxSeriesSeq(), { timeout: 10_000 })
    .toBeGreaterThan(vmSeq);
});

test("stop immediately followed by play never wedges (take-over)", async ({ app }) => {
  await app.playSine(SINE);
  await expect.poll(() => app.streaming(), { timeout: 10_000 }).toBe(true);

  // No waiting between the two gestures — the exact race window.
  const vmSeq = await app.maxSeriesSeq();
  await app.clickRun(); // stop
  await app.playSine(SINE); // pause (state toggle)…
  await app.playSine(SINE); // …and play again → restart
  await expect.poll(() => app.streaming(), { timeout: 10_000 }).toBe(true);
  await expect
    .poll(() => app.maxSeriesSeq(), { timeout: 10_000 })
    .toBeGreaterThan(vmSeq); // traces advance — the charts really update
});

test("disconnect while streaming stops the stream cleanly — no error toast", async ({
  app,
}) => {
  await app.playSine(SINE);
  await expect.poll(() => app.streaming(), { timeout: 10_000 }).toBe(true);

  // Manual disconnect: the backend hands the device back (stream stopped,
  // clean Stopped on the channel) BEFORE closing — a capture must never be
  // cut mid-flight into a "Stream: capture failed" toast (M4 report).
  await app.clickConnect(); // now "Disconnect"
  await expect.poll(() => app.connectLabel()).toBe("Connect");
  await expect.poll(() => app.streaming(), { timeout: 10_000 }).toBe(false);
  expect(await app.toastCount("Stream:")).toBe(0);
});

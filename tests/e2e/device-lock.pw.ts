/**
 * INVARIANT FAMILY C — the measurement-program device lock (v2 port).
 *
 * A measurement program owns the single USB stream exclusively (the one REAL
 * hardware constraint). The v2 UI contract around that:
 *
 *   - while a program runs, every transport (source play, global Run) is
 *     disabled WITH THE PROGRAM'S NAME (visibly locked, never silently
 *     inert), and the sources panel says so in words;
 *   - starting the program STOPS the capture stream deterministically; the
 *     sources' playing INTENT is untouched (data kept on screen);
 *   - completion resumes exactly the session that ran — the stream comes
 *     back for the playing source, an idle source stays idle.
 *
 * The fake backend serves one program (the THD sweep) for exactly this
 * test; its numeric result is a stub and nothing here reads its values —
 * only that a sweep frame LANDED and reached the sweep tile's view-model.
 * The program is held in flight by the harness gate (holdPrograms /
 * releasePrograms), so the locked state is OBSERVED, not raced.
 */
import { expect, test } from "./adapter/fixtures";

const BOOT_SINE = "src-sine-1"; // the ready-to-play boot workspace sine
const SWEEP_LOCK = 'measurement "Sweep 20–20000 Hz" is running';

test("a running program locks the transports by name; completion resumes exactly what ran", async ({
  app,
}) => {
  await app.waitConnected();

  // One playing source (auto-starts the stream), one idle source — the
  // resume must distinguish them.
  const idle = await app.addSource("sine");
  await app.playSine(BOOT_SINE);
  await expect.poll(() => app.streaming(), { timeout: 15_000 }).toBe(true);
  expect(await app.sourcesLockNote()).toBeNull();

  const prog = await app.addProgram("thd");
  await app.holdPrograms(); // the sweep will stay in flight until released
  await app.playProgram(prog);
  await expect.poll(() => app.programRun(prog)).toBe("running");

  // The stream was handed over BEFORE the program drives the device.
  await expect.poll(() => app.streaming()).toBe(false);

  // The lock is legible: the panel note, every source transport and the
  // global Run carry the program's NAME, not a bare grey-out.
  const note = await app.sourcesLockNote();
  expect(note).toContain(SWEEP_LOCK);
  for (const id of [BOOT_SINE, idle]) {
    const b = await app.playButtonState(id);
    expect(b.disabled).toBe(true);
    expect(b.title).toContain(SWEEP_LOCK);
  }
  const run = await app.runButtonState();
  expect(run.disabled).toBe(true);
  expect(run.title).toContain(SWEEP_LOCK);
  await app.screenshot("program-lock");

  // Program finishes → the lock lifts and the session comes back EXACTLY:
  // the playing source streams again, the idle one stayed idle.
  await app.releasePrograms();
  await expect.poll(() => app.programRun(prog), { timeout: 10_000 }).toBe("idle");
  await expect.poll(() => app.sourcesLockNote(), { timeout: 10_000 }).toBeNull();
  await expect.poll(() => app.streaming(), { timeout: 15_000 }).toBe(true);
  expect(await app.sourcePlaying(BOOT_SINE)).toBe(true);
  expect(await app.sourcePlaying(idle)).toBe(false);

  // The sweep landed on the program's trace and reaches a sweep tile's
  // view-model (stub numbers — plumbing only, never values).
  expect(await app.traceDomains(prog)).toContain("sweep");
  await app.setTileKind("sweep", "tile-1");
  await app.setTraceVisible(prog, true, "tile-1");
  await expect
    .poll(async () => (await app.sweepSeries("tile-1")).length)
    .toBeGreaterThan(0);
  const series = await app.sweepSeries("tile-1");
  expect(series[0].points).toBeGreaterThan(2);
  expect(series[0].unit).toBe("dB");
  await app.screenshot("program-sweep-tile");
});

test("a running sweep shows its progress ON the tile that draws its trace", async ({
  app,
}) => {
  await app.waitConnected();
  const prog = await app.addProgram("thd");
  // Membership first: the overlay belongs to tiles that DRAW the program's
  // result trace — a tile without it must stay clean.
  await app.setTileKind("sweep", "tile-1");
  await app.setTraceVisible(prog, true, "tile-1");

  const overlay = (tileId: string): Promise<{ hidden: boolean; text: string }> =>
    app.drv.eval(
      (x: { tileId: string }) => {
        const n = document.querySelector<HTMLElement>(
          `[data-testid="tile-progress-${x.tileId}"]`
        );
        return { hidden: n?.hidden !== false, text: n?.textContent ?? "" };
      },
      { tileId }
    );

  expect((await overlay("tile-1")).hidden).toBe(true);

  await app.holdPrograms();
  await app.playProgram(prog);
  await expect.poll(() => app.programRun(prog)).toBe("running");

  // The overlay appears on the member tile, labeled with the program's
  // name — and NOT on a tile that doesn't draw the trace.
  await expect.poll(async () => (await overlay("tile-1")).hidden).toBe(false);
  const { text } = await overlay("tile-1");
  expect(text).toContain("Sweep 20–20000 Hz");
  expect((await overlay("tile-2")).hidden).toBe(true);
  await app.screenshot("program-tile-progress");

  await app.releasePrograms();
  await expect.poll(() => app.programRun(prog), { timeout: 10_000 }).toBe("idle");
  await expect.poll(async () => (await overlay("tile-1")).hidden).toBe(true);
});

test("a second program is refused while one runs", async ({ app }) => {
  await app.waitConnected();
  const a = await app.addProgram("thd");
  const b = await app.addProgram("thd");
  await app.holdPrograms();
  await app.playProgram(a);
  await expect.poll(() => app.programRun(a)).toBe("running");

  // The other program's Play is disabled with the running one's name.
  const state = await app.drv.eval(
    (x: { id: string }) => {
      const btn = document.querySelector<HTMLButtonElement>(
        `[data-testid="prog-play-${x.id}"]`
      );
      return { disabled: btn?.disabled === true, title: btn?.title ?? "" };
    },
    { id: b }
  );
  expect(state.disabled).toBe(true);
  expect(state.title).toContain(SWEEP_LOCK);

  await app.releasePrograms();
  await expect.poll(() => app.programRun(a), { timeout: 10_000 }).toBe("idle");
});

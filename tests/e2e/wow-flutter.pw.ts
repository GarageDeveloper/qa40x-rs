/**
 * Wow & flutter dialog (issue #28) — a one-shot measurement, not a
 * persisted program: `btn-wow-flutter` opens a dialog (Programs panel),
 * "Run" drives `measure_wow_flutter` under the SAME exclusive device lock a
 * sweep uses, and the result renders inline in the dialog (never on a
 * workspace trace).
 *
 * The fake backend's `wowFlutter` stub synthesizes the result a known
 * 3150 Hz tone, FM-modulated by a 4 Hz / 0.15%-peak wow (the same signal
 * the Rust `recovers_known_wow` unit test pins), would produce — using the
 * SAME decimation/window/cap constants as the real `deviation_spectrum`, so
 * the rendered axis/resolution are physically consistent — see
 * `harness/fake-device.ts`. Assertions here are the dialog's PLUMBING and
 * the device-lock invariant (issue #25's twin: the lock is legible by
 * name, never a bare grey-out), never the fake's exact numbers.
 */
import { expect, test } from "./adapter/fixtures";

const BOOT_SINE = "src-sine-1";
const WF_LOCK = 'measurement "Wow & flutter" is running';

test("the wow & flutter dialog defaults to the DIN/IEC 386 reference tone and shows a result", async ({
  app,
}) => {
  await app.waitConnected();

  await app.drv.click('[data-testid="btn-wow-flutter"]');
  expect(await app.drv.text('[data-testid="wow-flutter-dialog"] .dialog__title')).toBe(
    "Wow & flutter"
  );

  // Defaults the UI states outright (the DIN/IEC 386 test tone, a short
  // capture, both channels on Left, generating the tone itself).
  expect(
    await app.drv.eval(
      () =>
        (document.querySelector('[data-testid="wf-reference-freq"]') as HTMLInputElement).value,
      undefined as void
    )
  ).toBe("3150");
  expect(
    await app.drv.eval(
      () => (document.querySelector('[data-testid="wf-duration"]') as HTMLInputElement).value,
      undefined as void
    )
  ).toBe("4");
  expect(
    await app.drv.eval(
      () => (document.querySelector('[data-testid="wf-generate"]') as HTMLInputElement).checked,
      undefined as void
    )
  ).toBe(true);

  await app.drv.click('[data-testid="wf-run"]');

  await expect
    .poll(async () => app.drv.text('[data-testid="wf-weighted"]'))
    .not.toBeNull();

  const weightedTxt = await app.drv.text('[data-testid="wf-weighted"]');
  const unweightedTxt = await app.drv.text('[data-testid="wf-unweighted"]');
  const peakTxt = await app.drv.text('[data-testid="wf-peak"]');
  const offsetTxt = await app.drv.text('[data-testid="wf-offset"]');
  const weighted = parseFloat(weightedTxt ?? "");
  const unweighted = parseFloat(unweightedTxt ?? "");
  const peak = parseFloat(peakTxt ?? "");

  // Relational, not golden (Rule 2): the DIN/IEC weighting curve peaks at
  // 4 Hz but isn't unity gain there, so a pure 4 Hz wow reads weighted <
  // unweighted; the reported peak sits above the RMS.
  expect(weighted).toBeGreaterThan(0);
  expect(weighted).toBeLessThan(unweighted);
  expect(peak).toBeGreaterThan(weighted);
  expect(offsetTxt).toContain("Hz");
  expect(offsetTxt).toContain("¢");

  // The deviation-spectrum plot rendered (peaked near 4 Hz per the fake's
  // synthetic FM tone) — never scrape its pixels, just that it's there.
  expect(
    await app.drv.eval(
      () => document.querySelector('[data-testid="wf-spectrum-svg"] path') !== null,
      undefined as void
    )
  ).toBe(true);

  await app.screenshot("wow-flutter-result");
});

test("Stop cancels an in-flight measurement instead of waiting out the capture, and the session resumes", async ({
  app,
}) => {
  await app.waitConnected();
  await app.playSine(BOOT_SINE);
  await expect.poll(() => app.streaming(), { timeout: 15_000 }).toBe(true);

  const buttons = () =>
    app.drv.eval(
      () => ({
        runHidden:
          (document.querySelector('[data-testid="wf-run"]') as HTMLButtonElement | null)
            ?.hidden ?? true,
        stopHidden:
          (document.querySelector('[data-testid="wf-stop"]') as HTMLButtonElement | null)
            ?.hidden ?? true,
      }),
      undefined as void
    );

  await app.drv.click('[data-testid="btn-wow-flutter"]');
  await app.holdPrograms(); // stays in flight until released OR cancelled
  await app.drv.click('[data-testid="wf-run"]');
  await expect.poll(() => app.streaming()).toBe(false);
  await expect.poll(() => app.sourcesLockNote()).toContain(WF_LOCK);
  expect(await buttons()).toEqual({ runHidden: true, stopHidden: false });

  await app.drv.click('[data-testid="wf-stop"]');

  // The measurement rejects right away (never waits out the held capture)
  // and the lock lifts — the session resumes exactly as it was, and the
  // dialog goes back to its idle (Run-visible) state (issue #28 review
  // point 7 — closing/stopping used to leave every transport frozen).
  await expect.poll(() => app.sourcesLockNote(), { timeout: 5_000 }).toBeNull();
  await expect.poll(() => app.streaming(), { timeout: 10_000 }).toBe(true);
  expect(await app.sourcePlaying(BOOT_SINE)).toBe(true);
  expect(await app.toastCount("stopped")).toBeGreaterThan(0);
  expect(await buttons()).toEqual({ runHidden: false, stopHidden: true });

  await app.releasePrograms(); // hygiene: the gate itself is still armed
});

test("dismissing the dialog while measuring cancels it, instead of holding the lock for the full capture", async ({
  app,
}) => {
  await app.waitConnected();

  await app.drv.click('[data-testid="btn-wow-flutter"]');
  await app.holdPrograms();
  await app.drv.click('[data-testid="wf-run"]');
  await expect.poll(() => app.sourcesLockNote()).toContain(WF_LOCK);

  // ✕ (not Stop, not the "Close" footer button) — every dismissal path
  // must cancel, not just the ones the dialog names explicitly.
  await app.drv.click('[data-testid="wow-flutter-dialog"] [aria-label="Close"]');

  await expect.poll(() => app.sourcesLockNote(), { timeout: 5_000 }).toBeNull();
  expect(await app.toastCount("stopped")).toBeGreaterThan(0);
  await app.releasePrograms();
});

test("a running wow & flutter measurement locks the transports by name, like a sweep", async ({
  app,
}) => {
  await app.waitConnected();
  await app.playSine(BOOT_SINE);
  await expect.poll(() => app.streaming(), { timeout: 15_000 }).toBe(true);
  expect(await app.sourcesLockNote()).toBeNull();

  await app.drv.click('[data-testid="btn-wow-flutter"]');
  await app.holdPrograms(); // the measurement stays in flight until released
  await app.drv.click('[data-testid="wf-run"]');

  // The stream was handed over BEFORE the measurement drives the device —
  // the same handover contract `runProgram` uses (store/actions/wowflutter.ts).
  await expect.poll(() => app.streaming()).toBe(false);
  await expect.poll(() => app.sourcesLockNote()).toContain(WF_LOCK);

  const play = await app.playButtonState(BOOT_SINE);
  expect(play.disabled).toBe(true);
  expect(play.title).toContain(WF_LOCK);
  const run = await app.runButtonState();
  expect(run.disabled).toBe(true);
  expect(run.title).toContain(WF_LOCK);

  // Release → the lock lifts, the session resumes exactly (the playing
  // source streams again), and the dialog's own result lands.
  await app.releasePrograms();
  await expect.poll(() => app.sourcesLockNote(), { timeout: 10_000 }).toBeNull();
  await expect.poll(() => app.streaming(), { timeout: 15_000 }).toBe(true);
  expect(await app.sourcePlaying(BOOT_SINE)).toBe(true);
  await expect
    .poll(async () => app.drv.text('[data-testid="wf-weighted"]'))
    .not.toBeNull();
});

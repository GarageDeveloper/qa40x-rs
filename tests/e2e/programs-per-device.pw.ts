/**
 * Programs per device (issue #25 lot F4).
 *
 * The lock flipped from bench-global to PER DEVICE: a program binds to one
 * session at entry (its ⚙ Device pin, or the focus) and programs on
 * different devices run concurrently — each row shows its own device and
 * progress, each ⏹ routes to its own unit, and a program on a BUSY device
 * still refuses with the runner's name. `programCalls` is fake-side truth
 * (what rode the wire, with which deviceId); the store projection comes
 * from the debug hook like everywhere else.
 *
 * NOT covered here, deliberately: the bench-global script gate (the fake
 * backend honestly refuses Rhai, so a script run completes ~instantly and
 * the gate window is unobservable) — pinned in
 * src/store/actions/programs.test.ts instead.
 */
import { expect, test } from "./adapter/fixtures";
import type { AppV2 } from "./adapter/app";

const UNIT_B = "usb/E2E-FAKE-0002";

/** Unit A connected on slot 0, unit B added onto slot 1 (the
 * multi-device.pw.ts boot path). */
async function addUnitB(app: AppV2): Promise<void> {
  await app.waitConnected();
  await app.setUnits(2);
  await expect
    .poll(() => app.addableOptions(), { timeout: 15_000 })
    .toContain(UNIT_B);
  await app.addDeviceFromPanel(UNIT_B);
  await expect.poll(() => app.groupCount()).toBe(2);
  await expect.poll(() => app.groupRunDisabled(1)).toBe(false);
}

test("a sweep pinned to B and one on A run CONCURRENTLY, each routed to its unit — no focus gesture; a third on the busy device refuses by name", async ({
  app,
}) => {
  await addUnitB(app);
  const a = await app.addProgram("thd");
  const b = await app.addProgram("thd");
  const c = await app.addProgram("thd");
  await app.setProgramDevice(b, 1);

  await app.holdPrograms();
  await app.playProgram(a);
  await expect.poll(() => app.programRun(a)).toBe("running");
  await app.playProgram(b);
  await expect.poll(() => app.programRun(b)).toBe("running");

  // The focus never moved — the pin alone routed B's sweep.
  expect((await app.sessions()).focused).toBe("slot-0");
  const calls = await app.programCalls();
  const sweeps = calls.filter((x) => x.cmd === "measure_thd_vs_frequency");
  expect(sweeps.map((x) => x.deviceId).sort()).toEqual([UNIT_B, null].sort());

  // Two independent rows: each names its device, neither greys the other.
  expect(await app.programTypeLine(a)).toContain("on #1");
  expect(await app.programTypeLine(b)).toContain("on #2");
  expect((await app.programPlayState(a)).disabled).toBe(false); // it's a ⏹
  expect((await app.programPlayState(b)).disabled).toBe(false);

  // A third program resolving onto BUSY slot 0 refuses with A's name.
  const cState = await app.programPlayState(c);
  expect(cState.disabled).toBe(true);
  expect(cState.title).toContain("is running on this device");
  await app.screenshot("programs-two-devices-running");

  await app.releasePrograms();
  await expect.poll(() => app.programRun(a), { timeout: 10_000 }).toBe("idle");
  await expect.poll(() => app.programRun(b), { timeout: 10_000 }).toBe("idle");
  // Both curves landed on their own traces.
  expect(await app.traceDomains(a)).toContain("sweep");
  expect(await app.traceDomains(b)).toContain("sweep");
});

test("⏹ on the B-pinned sweep routes sweep_stop to B ONLY and leaves A's sweep running", async ({
  app,
}) => {
  await addUnitB(app);
  const a = await app.addProgram("thd");
  const b = await app.addProgram("thd");
  await app.setProgramDevice(b, 1);

  await app.holdPrograms();
  await app.playProgram(a);
  await expect.poll(() => app.programRun(a)).toBe("running");
  await app.playProgram(b);
  await expect.poll(() => app.programRun(b)).toBe("running");

  await app.playProgram(b); // the same button is ⏹ while running
  const stops = (await app.programCalls()).filter((x) => x.cmd === "sweep_stop");
  expect(stops).toEqual([{ cmd: "sweep_stop", deviceId: UNIT_B }]);
  expect(await app.programRun(a)).toBe("running");

  await app.releasePrograms();
  await expect.poll(() => app.programRun(a), { timeout: 10_000 }).toBe("idle");
  await expect.poll(() => app.programRun(b), { timeout: 10_000 }).toBe("idle");
  // A's curve landed; B's cancelled run did not.
  expect(await app.traceDomains(a)).toContain("sweep");
  expect(await app.traceDomains(b)).not.toContain("sweep");
});

test("a tile drawing BOTH result traces overlays one progress line per running program", async ({
  app,
}) => {
  await addUnitB(app);
  const a = await app.addProgram("thd");
  const b = await app.addProgram("thd");
  await app.setProgramDevice(b, 1);
  await app.setTileKind("sweep", "tile-1");
  await app.setTraceVisible(a, true, "tile-1");
  await app.setTraceVisible(b, true, "tile-1");

  const overlay = (): Promise<{ hidden: boolean; text: string }> =>
    app.drv.eval(() => {
      const n = document.querySelector<HTMLElement>(
        '[data-testid="tile-progress-tile-1"]'
      );
      return { hidden: n?.hidden !== false, text: n?.textContent ?? "" };
    }, undefined as void);

  await app.holdPrograms();
  await app.playProgram(a);
  await app.playProgram(b);
  await expect.poll(() => app.programRun(a)).toBe("running");
  await expect.poll(() => app.programRun(b)).toBe("running");

  await expect.poll(async () => (await overlay()).hidden).toBe(false);
  await expect
    .poll(async () => (await overlay()).text.split("\n").length, { timeout: 5_000 })
    .toBe(2);
  const labelA = await app.traceLabel(a);
  const labelB = await app.traceLabel(b);
  const { text } = await overlay();
  expect(text).toContain(labelA as string);
  expect(text).toContain(labelB as string);
  await app.screenshot("programs-two-overlay-lines");

  await app.releasePrograms();
  await expect.poll(() => app.programRun(a), { timeout: 10_000 }).toBe("idle");
  await expect.poll(() => app.programRun(b), { timeout: 10_000 }).toBe("idle");
  await expect.poll(async () => (await overlay()).hidden).toBe(true);
});

test("the ⚙ Device row hides on a single-device bench and appears with the second session (byte-identical dialog otherwise)", async ({
  app,
}) => {
  await app.waitConnected();
  const prog = await app.addProgram("thd");

  // One live session, no pin → the row is hidden.
  await app.drv.click(`[data-testid="prog-gear-${prog}"]`);
  expect(await app.dialogRowHidden(`prog-device-${prog}`)).toBe(true);
  await app.closeDialog();
  // And the type line carries no device note.
  expect(await app.programTypeLine(prog)).not.toContain("on #");

  await app.setUnits(2);
  await expect
    .poll(() => app.addableOptions(), { timeout: 15_000 })
    .toContain(UNIT_B);
  await app.addDeviceFromPanel(UNIT_B);
  await expect.poll(() => app.groupCount()).toBe(2);

  // Two live sessions → the row shows; pinning B annotates the type line.
  await app.drv.click(`[data-testid="prog-gear-${prog}"]`);
  expect(await app.dialogRowHidden(`prog-device-${prog}`)).toBe(false);
  await app.closeDialog();
  await app.setProgramDevice(prog, 1);
  await expect.poll(() => app.programTypeLine(prog)).toContain("on #2");
});

/**
 * Front-panel I2S output (issue #71): the per-device port toggle +
 * reference on the Traces-panel group, the I2S routing dimension on the
 * Signal Sources rows (legacy pair and matrix editor), and the fake-side
 * wire truth (`i2s_apply` declarations, per-unit port state).
 *
 * Same discipline as source-routing.pw.ts: units are plugged and added
 * BEFORE any stream starts.
 */
import { expect, test } from "./adapter/fixtures";
import type { AppV2 } from "./adapter/app";

const UNIT_B = "usb/E2E-FAKE-0002";

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

test("the port toggle declares the I2S mix and the readout reports it — one device, legacy pair", async ({
  app,
}) => {
  await app.waitConnected();

  // The readout exists BEFORE anything is enabled (no-layout-shift rule).
  expect(await app.i2sReadout(0)).toBe("off");

  // A playing source routed to the port's left channel only — through the
  // legacy row's I2S pair (no matrix, single device).
  const id = await app.addSine();
  await app.setSineI2sRoute(id, "left");
  await app.setSineRoute(id, "off"); // I2S-only: the DAC slot goes silent
  await app.playSine(id);

  await app.setI2sEnabled(0, true);

  // Wire truth: ONE i2s_apply enabled with the source's slot, and the
  // fake's port runs with device-paced blocks.
  await expect
    .poll(async () => (await app.i2sApplyCalls()).filter((c) => c.enabled).length)
    .toBeGreaterThan(0);
  const call = (await app.i2sApplyCalls()).filter((c) => c.enabled).at(-1)!;
  expect(call.slotIds).toEqual([id]);
  expect(call.deviceId).toBeNull(); // slot 0 rides the arg-less default
  await expect.poll(async () => (await app.unitI2s(0))?.running).toBe(true);
  await expect
    .poll(async () => (await app.unitI2s(0))?.blocks ?? 0)
    .toBeGreaterThan(2);

  // The readout says what plays (48 kHz pin, 32-bit, the mix's Σ peak).
  await expect.poll(() => app.i2sReadout(0)).toContain("48 kHz · 32-bit · Σ");

  // The DAC program carries the source as a SILENT slot (route off) — the
  // I2S dimension never leaks into the Line-out mix.
  const dacSlots = await app.unitStreamSlots(0);
  if (dacSlots !== null && dacSlots.length > 0) {
    expect(dacSlots).toEqual([expect.objectContaining({ id, route: "off" })]);
  }

  // Off again: the fake's port stops and the readout returns to "off" —
  // the node itself never disappears (no-layout-shift).
  await app.setI2sEnabled(0, false);
  await expect.poll(async () => (await app.unitI2s(0))?.running).toBe(false);
  await expect.poll(() => app.i2sReadout(0)).toBe("off");
});

test("a source routed to I2S while the port is off says so — and plays the moment the port goes on", async ({
  app,
}) => {
  await addUnitB(app);

  const id = await app.addSine();
  await app.openSourceRouting(id);
  await app.setSourceTargetI2sRoute(id, "1", "both");
  await app.playSine(id);

  // The matrix row's note explains the silence instead of pretending.
  await expect
    .poll(() => app.sourceTargetNote(id, "1"))
    .toContain("I2S port off");

  await app.setI2sEnabled(1, true);
  await expect.poll(async () => (await app.unitI2s(1))?.running).toBe(true);
  // The note clears once the port is on (the cell now genuinely plays).
  await expect
    .poll(() => app.sourceTargetNote(id, "1"))
    .not.toContain("I2S port off");
  // And the declared I2S mix carries exactly this source.
  const call = (await app.i2sApplyCalls()).filter((c) => c.enabled).at(-1)!;
  expect(call.deviceId).toBe(UNIT_B);
  expect(call.slotIds).toEqual([id]);
});

test("the port is per device: toggling A leaves B untouched (the #25 per-device pin)", async ({
  app,
}) => {
  await addUnitB(app);

  const id = await app.addSine();
  // Two live sessions ⇒ the row renders the matrix editor; the focus cell
  // resolves onto device A.
  await app.openSourceRouting(id);
  await app.setSourceTargetI2sRoute(id, "focus", "both");
  await app.playSine(id);

  await app.setI2sEnabled(0, true);
  await expect.poll(async () => (await app.unitI2s(0))?.running).toBe(true);

  // B's port never saw an enable: no i2s_apply routed to it, its fake
  // state idle, its readout off.
  const bCalls = (await app.i2sApplyCalls()).filter((c) => c.deviceId === UNIT_B);
  expect(bCalls.filter((c) => c.enabled)).toEqual([]);
  expect((await app.unitI2s(1))?.running ?? false).toBe(false);
  expect(await app.i2sReadout(1)).toBe("off");

  // And A's disable leaves B's toggle available (independent gates).
  await app.setI2sEnabled(0, false);
  expect((await app.i2sToggleState(1)).disabled).toBe(false);
});

test("the reference level rides every declaration and the clip verdict follows it", async ({
  app,
}) => {
  await app.waitConnected();

  const id = await app.addSine();
  await app.setSineLevel(id, -6);
  await app.setSineI2sRoute(id, "both");
  await app.playSine(id);
  await app.setI2sEnabled(0, true);
  await expect.poll(async () => (await app.unitI2s(0))?.running).toBe(true);
  // Default reference 0 dBV: a −6 dBV sine fits (no clip).
  expect((await app.unitI2s(0))?.clipped).toBe(false);

  // Reference −20 dBV: the −6 dBV source now exceeds digital full scale —
  // clamped and REPORTED (never rescaled), like the analog range contract.
  await app.setNumber("i2s-ref-0", -20);
  await expect
    .poll(async () => (await app.unitI2s(0))?.referenceDbv)
    .toBe(-20);
  await expect.poll(async () => (await app.unitI2s(0))?.clipped).toBe(true);
  await expect.poll(() => app.i2sReadout(0)).toContain("CLIP");
});

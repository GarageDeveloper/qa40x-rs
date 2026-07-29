/**
 * Per-source device × channel routing (issue #25 lot F3): the sources-panel
 * row editor drives ANY device without a focus gesture — the R1 matrix
 * (Raphaël 2026-07-29) made UI. Fake-side `unitStreamSlots` is the wire
 * truth (what each unit's DAC program actually carries); the app-side
 * probes read the row editor's own testids.
 *
 * Same discipline as multi-device.pw.ts: units are plugged and added
 * BEFORE any stream starts (the enumeration refresh rides the 2 s idle
 * tick, gated on an idle bench).
 */
import { expect, test } from "./adapter/fixtures";
import type { AppV2 } from "./adapter/app";

const UNIT_B = "usb/E2E-FAKE-0002";

/** Boot path shared by every two-unit spec (multi-device.pw.ts's addUnitB,
 * duplicated here so that spec file stays untouched — appended files only). */
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

test("a source pinned to B plays on B while A stays focused — no focus gesture", async ({
  app,
}) => {
  await addUnitB(app);

  const id = await app.addSine();
  await app.openSourceRouting(id);
  await app.setSourceTargetRoute(id, "1", "left");
  await app.removeSourceTarget(id, "focus");
  expect(await app.sourceRoutingSummary(id)).toBe("→ #2 L");

  // Play: the source AUTO-STARTS its own target's capture — device B —
  // while the focus never moves off A.
  await app.playSine(id);
  await expect
    .poll(async () => (await app.sessions()).byKey["slot-1"].streaming)
    .toBe(true);
  await expect.poll(() => app.unitFrameCount(1)).toBeGreaterThan(0);
  expect((await app.sessions()).focused).toBe("slot-0");
  expect(await app.focusMode()).toBe("focus");

  // Wire truth: B's DAC program carries the source on Out L; A never saw a
  // config (its stream never started) — and no misrouted command toasted.
  expect(await app.unitStreamSlots(1)).toEqual([
    { id, route: "left", frequencyHz: expect.any(Number) },
  ]);
  expect(await app.unitStreamSlots(0)).toBeNull();
  expect(await app.toastCount("Unknown device")).toBe(0);

  // A's own capture stays a monitor: started explicitly, its program is empty.
  await app.groupRun(0);
  await expect.poll(() => app.unitFrameCount(0)).toBeGreaterThan(0);
  expect(await app.unitStreamSlots(0)).toEqual([]);
});

test("the picker is absent at one device — the legacy checkboxes still drive the mix", async ({
  app,
}) => {
  await app.waitConnected();
  const id = await app.addSine();
  expect(await app.hasSourceRouting(id)).toBe(false);

  await app.setSineRoute(id, "right");
  await app.playSine(id);
  await expect.poll(() => app.unitFrameCount(0)).toBeGreaterThan(0);
  expect(await app.unitStreamSlots(0)).toEqual([
    { id, route: "right", frequencyHz: expect.any(Number) },
  ]);
});

test("one source, two devices, two different channels", async ({ app }) => {
  await addUnitB(app);

  const id = await app.addSine(); // implicit focus target, route "left"
  await app.openSourceRouting(id);
  await app.setSourceTargetRoute(id, "1", "right");
  expect(await app.sourceRoutingSummary(id)).toBe("→ focus L · #2 R");

  // Play auto-starts EVERY live target's capture: A (focus-followed cell)
  // and B (pinned cell) in the one gesture.
  await app.playSine(id);
  await expect.poll(() => app.unitFrameCount(0)).toBeGreaterThan(0);
  await expect.poll(() => app.unitFrameCount(1)).toBeGreaterThan(0);

  expect(await app.unitStreamSlots(0)).toEqual([
    { id, route: "left", frequencyHz: expect.any(Number) },
  ]);
  expect(await app.unitStreamSlots(1)).toEqual([
    { id, route: "right", frequencyHz: expect.any(Number) },
  ]);
});

test("the played readout is per target — each device's own bin grid, and the wire agrees (#14 class)", async ({
  app,
}) => {
  await addUnitB(app);

  const id = await app.addSine();
  await app.openSourceRouting(id);
  await app.setSourceTargetRoute(id, "1", "right");
  await app.setSelect("group-sample-rate-1", "192000");

  // Two live targets, two rates, two grid values — and no single value for
  // the params line to pretend with.
  await expect.poll(() => app.sourceTargetPlayed(id, "focus")).toBe("1000.4883 Hz");
  await expect.poll(() => app.sourceTargetPlayed(id, "1")).toBe("1001.9531 Hz");
  expect(await app.sourceSnapped(id)).toBe("→ 2 values");

  // The WIRE carries the 192 k grid value to unit B (the readout is honest,
  // not cosmetic): 1 kHz snapped on 32768 bins at 192 kHz.
  await app.playSine(id);
  await expect.poll(() => app.unitFrameCount(1)).toBeGreaterThan(0);
  const slots = await app.unitStreamSlots(1);
  expect(slots).toHaveLength(1);
  expect(slots![0].frequencyHz).toBeCloseTo(1001.953125, 6);
});

test("a dormant target is silent and says so — never a silent retarget", async ({
  app,
}) => {
  await addUnitB(app);

  const id = await app.addSine();
  await app.openSourceRouting(id);
  await app.setSourceTargetRoute(id, "1", "both");
  await app.removeSourceTarget(id, "focus"); // pinned to #2 ONLY
  await app.playSine(id);
  await expect.poll(() => app.unitFrameCount(1)).toBeGreaterThan(0);
  await app.groupRun(0); // A monitors alongside
  await expect.poll(() => app.unitFrameCount(0)).toBeGreaterThan(0);

  await app.unplugUnit(UNIT_B);
  await expect
    .poll(async () => (await app.sessions()).byKey["slot-1"])
    .toBeUndefined();

  // The row KEEPS its pinned cell (evict-on-disconnect preserves targets —
  // the revive contract) and says why nothing plays.
  await expect.poll(() => app.sourceTargetNote(id, "1")).toBe("not connected");
  expect(await app.sourceRoutingSummary(id)).toBe("→ #2 LR ⚠");
  expect(await app.sourceSnapped(id)).toBe("→ —");

  // A's still-running capture never gained the source (no retarget)…
  expect(await app.unitStreamSlots(0)).toEqual([]);

  // …and once paused, the source cannot be restarted while routed only at
  // a dead target — the reason is named on the button.
  await app.playSine(id); // pause
  const play = await app.sourcePlayState(id);
  expect(play.disabled).toBe(true);
  expect(play.title).toContain("not connected — open Routing");
});

test("the bench shrinking drops the pinned cells (D5) and the legacy checkboxes come back truthful", async ({
  app,
}) => {
  await addUnitB(app);

  const id = await app.addSine(); // focus cell "left"
  await app.openSourceRouting(id);
  await app.setSourceTargetRoute(id, "1", "right");
  expect(await app.hasSourceRouting(id)).toBe(true);

  await app.groupRemove(1);
  await expect.poll(() => app.groupCount()).toBe(1);

  // Slot 1's cell dropped (D5), the lone focus cell compacted back to the
  // legacy form — the row is a plain L/R pair again, reading "left".
  await expect.poll(() => app.hasSourceRouting(id)).toBe(false);
  await app.setSineRoute(id, "right"); // still fully functional
  await app.playSine(id);
  await expect.poll(() => app.unitFrameCount(0)).toBeGreaterThan(0);
  expect(await app.unitStreamSlots(0)).toEqual([
    { id, route: "right", frequencyHz: expect.any(Number) },
  ]);
});

test("a routing matrix survives a save → reload, dormant until its device returns", async ({
  app,
}) => {
  await addUnitB(app);

  const id = await app.addSine();
  await app.openSourceRouting(id);
  await app.setSourceTargetRoute(id, "1", "right");
  await app.saveWorkspaceAs("F3 routing bench");
  await app.waitForAutoSave("F3 routing bench");

  await app.boot();
  await app.waitConnected();

  // One live session, but the matrix is explicit: the editor renders with
  // a dormant #2 row (slot-keyed doc — no device id, bench-portable).
  await expect.poll(() => app.hasSourceRouting(id)).toBe(true);
  expect(await app.sourceRoutingSummary(id)).toBe("→ focus L · #2 R ⚠");
  expect(await app.sourceTargetNote(id, "1")).toBe("not connected");

  // The unit returns: the cell goes live and plays there again.
  await addUnitB(app);
  await expect.poll(() => app.sourceTargetNote(id, "1")).toBe("");
  await app.playSine(id);
  await expect.poll(() => app.unitFrameCount(1)).toBeGreaterThan(0);
  expect(await app.unitStreamSlots(1)).toEqual([
    { id, route: "right", frequencyHz: expect.any(Number) },
  ]);
});

test("screenshot: the routing editor at two devices", async ({ app }) => {
  await addUnitB(app);
  const id = await app.addSine();
  await app.openSourceRouting(id);
  await app.setSourceTargetRoute(id, "1", "right");
  await app.playSine(id);
  await expect.poll(() => app.unitFrameCount(1)).toBeGreaterThan(0);
  await app.screenshot("f3-source-routing");
});

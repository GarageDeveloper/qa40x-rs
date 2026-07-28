/**
 * Multi-device bench (issue #25 lot E4): the Traces panel's device groups,
 * the add-device flow, per-group transports, the toolbar focus selector,
 * and the per-unit unplug story. Runs against the per-unit fake
 * (harness/fake-unit.ts): `streamConfigOf`/`frameCountOf`/`openSlots` are
 * FAKE-side truth — what actually rode the wire to which unit — while
 * `sessions()` is the app's own store projection.
 *
 * The enumeration refresh rides the 2 s idle tick and is GATED on an idle
 * bench (anyBusy), so every spec plugs units in and adds devices BEFORE
 * starting any stream.
 */
import { expect, test } from "./adapter/fixtures";
import type { AppV2 } from "./adapter/app";

const UNIT_B = "usb/E2E-FAKE-0002";
const SLOT0_IDS = ["hw-in-left", "hw-in-right", "hw-out-left", "hw-out-right"];
const SLOT1_IDS = [
  "hw-in-left@1",
  "hw-in-right@1",
  "hw-out-left@1",
  "hw-out-right@1",
];

/** Boot path shared by every spec: unit A connected on slot 0, unit B on
 * the bus and offered by the + device menu, then added onto slot 1. */
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

test("adding a device grows a second group with its own labelled endpoints", async ({
  app,
}) => {
  await addUnitB(app);

  // The group header names the unit; the slot-0 group is untouched.
  expect(await app.groupTitle(1)).toContain("QA402");
  expect(await app.groupTitle(1)).toContain("E2E-FAKE-0002");

  // 8 endpoint rows: slot 0's four verbatim ids, then slot 1's @1 ids with
  // slot-derived labels (never the alias — E3 decision D2).
  const rows = await app.poolRows();
  expect(rows.map((r) => r.id)).toEqual([...SLOT0_IDS, ...SLOT1_IDS]);
  expect(rows.find((r) => r.id === "hw-in-left@1")?.label).toBe("Input L #2");

  // The session adopted the id FROM THE CONNECT ANSWER (bookkeeping #1).
  const sessions = await app.sessions();
  expect(sessions.byKey["slot-1"].deviceId).toBe(UNIT_B);
  expect(sessions.byKey["slot-1"].status).toBe("connected");
  expect(await app.openSlots()).toEqual([0, 1]);
});

test("an added device is routable from the first instant — its Run touches only its own unit", async ({
  app,
}) => {
  await addUnitB(app);

  await app.groupRun(1);
  // The stream landed on UNIT B's slot; slot 0 never saw a config.
  await expect.poll(() => app.unitFrameCount(1)).toBeGreaterThan(0);
  expect(await app.unitStreamSlotCount(1)).not.toBeNull();
  expect(await app.unitStreamSlotCount(0)).toBeNull();
  const sessions = await app.sessions();
  expect(sessions.byKey["slot-1"].streaming).toBe(true);
  expect(sessions.byKey["slot-0"].streaming).toBe(false);
  // No misrouted command: an "Unknown device" would toast as an error.
  expect(await app.toastCount("Unknown device")).toBe(0);
});

test("monitor mode is the default: only the FOCUSED device carries the bench sources", async ({
  app,
}) => {
  await addUnitB(app);

  // Toolbar Run = the focused device (slot 0), arming the bench sources.
  await app.clickRun();
  await expect.poll(() => app.unitFrameCount(0)).toBeGreaterThan(0);
  await app.groupRun(1);
  await expect.poll(() => app.unitFrameCount(1)).toBeGreaterThan(0);

  // Slot 0's config carries the playing sine; slot 1 captures silence.
  expect(await app.unitStreamSlotCount(0)).toBeGreaterThan(0);
  expect(await app.unitStreamSlotCount(1)).toBe(0);
});

test("per-group Run/Stop drive their own device only", async ({ app }) => {
  await addUnitB(app);

  await app.groupRun(1);
  await expect
    .poll(async () => (await app.sessions()).byKey["slot-1"].streaming)
    .toBe(true);
  expect((await app.sessions()).byKey["slot-0"].streaming).toBe(false);

  await app.groupRun(0);
  await expect
    .poll(async () => (await app.sessions()).byKey["slot-0"].streaming)
    .toBe(true);

  // Stopping slot 1 leaves slot 0's capture running and its frames rising.
  await app.groupRun(1);
  await expect
    .poll(async () => (await app.sessions()).byKey["slot-1"].streaming)
    .toBe(false);
  const f0 = (await app.sessions()).byKey["slot-0"].frames;
  await expect
    .poll(async () => (await app.sessions()).byKey["slot-0"].frames)
    .toBeGreaterThan(f0);
});

test("a focus switch moves the stimulus in the same gesture", async ({
  app,
}) => {
  await addUnitB(app);
  expect(await app.focusMode()).toBe("focus");

  await app.clickRun(); // slot 0 (focused) streams WITH the sources
  await app.groupRun(1); // slot 1 monitors
  await expect.poll(() => app.unitStreamSlotCount(0)).toBeGreaterThan(0);
  await expect.poll(() => app.unitStreamSlotCount(1)).toBe(0);

  await app.pickFocus("slot-1");
  // The DAC program follows the focus atomically: slot 1's running stream
  // gains the slots, slot 0's drops them — no other gesture in between.
  await expect.poll(() => app.unitStreamSlotCount(1)).toBeGreaterThan(0);
  await expect.poll(() => app.unitStreamSlotCount(0)).toBe(0);
});

test("toolbar Run and the spacebar act on the FOCUSED device", async ({
  app,
}) => {
  await addUnitB(app);
  await app.pickFocus("slot-1");

  await app.clickRun();
  await expect
    .poll(async () => (await app.sessions()).byKey["slot-1"].streaming)
    .toBe(true);
  expect((await app.sessions()).byKey["slot-0"].streaming).toBe(false);

  await app.pressSpace(); // Space = transport toggle on the focused device
  await expect
    .poll(async () => (await app.sessions()).byKey["slot-1"].streaming)
    .toBe(false);
  expect((await app.sessions()).byKey["slot-0"].streaming).toBe(false);
});

test("unplugging B while A streams: A keeps streaming, B's group goes dormant, its rows survive", async ({
  app,
}) => {
  await addUnitB(app);
  await app.clickRun(); // slot 0 streams
  await app.groupRun(1); // slot 1 streams too
  await expect.poll(() => app.unitFrameCount(1)).toBeGreaterThan(0);

  await app.unplugUnit(UNIT_B);

  // B's session is EVICTED (decision B4) — the group survives, dormant.
  await expect
    .poll(async () => (await app.sessions()).byKey["slot-1"])
    .toBeUndefined();
  await expect.poll(() => app.groupTitle(1)).toContain("not connected");
  expect(await app.groupCount()).toBe(2);
  // Its four rows stay in the pool (D1: never delete on loss).
  const rows = await app.poolRows();
  expect(rows.map((r) => r.id)).toEqual([...SLOT0_IDS, ...SLOT1_IDS]);

  // A never blinked: still streaming, frames still rising.
  expect((await app.sessions()).byKey["slot-0"].streaming).toBe(true);
  const f0 = (await app.sessions()).byKey["slot-0"].frames;
  await expect
    .poll(async () => (await app.sessions()).byKey["slot-0"].frames)
    .toBeGreaterThan(f0);
});

test("removing a device purges its slot and the toolbar select returns to the lot-D picker", async ({
  app,
}) => {
  await addUnitB(app);
  expect(await app.focusMode()).toBe("focus");

  await app.groupRemove(1);

  await expect.poll(() => app.groupCount()).toBe(1);
  const rows = await app.poolRows();
  expect(rows.map((r) => r.id)).toEqual(SLOT0_IDS);
  // Back to one session: the select is the lot-D picker again.
  await expect.poll(() => app.focusMode()).toBe("pick");
  expect((await app.sessions()).byKey["slot-1"]).toBeUndefined();
  expect(await app.openSlots()).toEqual([0]);
});

test("a second virtual unit (the real-app shape) adds, and an alias renames its chrome — never its persisted labels", async ({
  app,
}) => {
  await app.waitConnected();
  await app.setVirtualUnits(2);
  await expect
    .poll(() => app.addableOptions(), { timeout: 15_000 })
    .toContain("virtual/E2E-VIRT-0002");
  await app.addDeviceFromPanel("virtual/E2E-VIRT-0002");
  await expect.poll(() => app.groupCount()).toBe(2);

  await app.setGroupAlias(1, "DUT rig");
  // The alias reaches the group header and the focus selector…
  await expect.poll(() => app.groupTitle(1)).toContain("DUT rig");
  expect(await app.deviceOptionLabels()).toContain("DUT rig");
  // …persists app-side only…
  const stored = await app.drv.eval(
    () => localStorage.getItem("qa40x-v2-device-aliases") ?? "",
    undefined as void
  );
  expect(stored).toContain("DUT rig");
  // …and never enters the slot-derived trace labels (E3 decision D2).
  const rows = await app.poolRows();
  expect(rows.find((r) => r.id === "hw-in-left@1")?.label).toBe("Input L #2");
});

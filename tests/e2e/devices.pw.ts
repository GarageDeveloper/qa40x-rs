/**
 * Unit picker (issue #25 lot D): hidden with 0 or 1 physical unit (the bar
 * stays byte-for-byte the pre-lot-D bar — pixel identity), listing every
 * available unit at ≥2, disabled while connected, and the P3 rule on the
 * wire — a deviceId rides `connect_device` only after an explicit pick.
 * The list refreshes on the 2 s idle tick, hence the polls.
 */
import { expect, test } from "./adapter/fixtures";

test("one unit: no picker, and the connect controls are the classic set", async ({
  app,
}) => {
  await app.waitConnected();
  expect(await app.devicePickerVisible()).toBe(false);
  // The classic bar: Connect reads "Disconnect", no Demo while connected.
  expect(await app.connectLabel()).toBe("Disconnect");
  expect(await app.demoButtonVisible()).toBe(false);
  // Auto-connect used the legacy arg-less call (P3: untouched picker).
  expect(await app.connectDeviceIds()).toEqual([null]);
});

test("two units: the picker appears listing both (and the virtual), disabled while connected", async ({
  app,
}) => {
  await app.waitConnected();
  await app.setUnits(2);
  await expect
    .poll(() => app.devicePickerVisible(), { timeout: 15_000 })
    .toBe(true);
  expect(await app.deviceOptions()).toEqual([
    "usb/E2E-FAKE-0001",
    "usb/E2E-FAKE-0002",
    "virtual/E2E-VIRT-0001",
  ]);
  // Connected: switching units goes through Disconnect first.
  expect(await app.devicePickerDisabled()).toBe(true);
  // The picker mirrors the OPEN unit.
  expect(await app.selectValue("device-select")).toBe("usb/E2E-FAKE-0001");
});

test("picking unit B routes the connect: deviceId rides the wire", async ({
  app,
}) => {
  await app.waitConnected();
  await app.clickConnect(); // manual disconnect — auto-reconnect holds off
  await app.waitDisconnected();
  await app.setUnits(2);
  await expect
    .poll(() => app.devicePickerVisible(), { timeout: 15_000 })
    .toBe(true);
  expect(await app.devicePickerDisabled()).toBe(false);

  await app.pickDevice("usb/E2E-FAKE-0002");
  await app.clickConnect();
  await app.waitConnected();

  const ids = await app.connectDeviceIds();
  expect(ids[ids.length - 1]).toBe("usb/E2E-FAKE-0002");
  expect(await app.selectValue("device-select")).toBe("usb/E2E-FAKE-0002");
});

test("unplugging the picked unit leaves the bar usable — Connect falls back to the legacy call", async ({
  app,
}) => {
  await app.waitConnected();
  await app.clickConnect();
  await app.waitDisconnected();
  await app.setUnits(2);
  await expect
    .poll(() => app.devicePickerVisible(), { timeout: 15_000 })
    .toBe(true);
  await app.pickDevice("usb/E2E-FAKE-0002");

  // The picked unit vanishes: back to one physical unit → the picker hides
  // again (pixel identity) and the stale pick must not poison Connect.
  await app.setUnits(1);
  await expect
    .poll(() => app.devicePickerVisible(), { timeout: 15_000 })
    .toBe(false);

  await app.clickConnect();
  await app.waitConnected();
  const ids = await app.connectDeviceIds();
  // A vanished pick falls back to the arg-less legacy call (P3).
  expect(ids[ids.length - 1]).toBeNull();
});

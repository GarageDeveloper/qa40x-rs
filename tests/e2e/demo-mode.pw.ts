/**
 * Demo mode (embedded virtual QA40x): with nothing on the USB bus, the Demo
 * button attaches the in-process virtual device in one click. The session is
 * badged DEMO — a demo screen must never pass for a hardware measurement —
 * and disconnecting returns to the normal disconnected UI with the Demo
 * entry point back.
 *
 * Since lot E4 (Raphaël 2026-07-29) the button ADDS the virtual unit
 * through the add-device path and focuses it — never a slot-0 supersede:
 * slot 0 stays the hardware's, so a unit (re)appearing on the bus connects
 * ALONGSIDE the running demo instead of the old hand-over teardown.
 */
import { expect, test } from "./adapter/fixtures";

test("demo button connects the virtual device and badges the session", async ({
  app,
}) => {
  // The fake boots "present" and the app auto-connects; unplug first — demo
  // mode exists exactly for the no-hardware situation.
  await app.waitConnected();
  await app.setPresent(false);
  await app.waitDisconnected();

  expect(await app.demoButtonVisible()).toBe(true);
  expect(await app.demoChipVisible()).toBe(false);

  await app.clickDemo();
  await app.waitConnected();
  expect(await app.demoChipVisible()).toBe(true);
  expect(await app.connectLabel()).toBe("Disconnect");
  // While connected, the demo entry point is hidden.
  expect(await app.demoButtonVisible()).toBe(false);

  await app.clickConnect(); // reads "Disconnect" while connected
  await app.waitDisconnected();
  expect(await app.demoChipVisible()).toBe(false);
  expect(await app.demoButtonVisible()).toBe(true);
});

test("the demo lands on a slot ≥ 1 as an ADDED device — slot 0 stays the hardware's", async ({
  app,
}) => {
  await app.waitConnected();
  await app.setPresent(false);
  await app.waitDisconnected();

  await app.clickDemo();
  await app.waitConnected();
  const sessions = await app.sessions();
  expect(sessions.focused).toBe("slot-1");
  expect(sessions.byKey["slot-1"].status).toBe("connected");
  expect(sessions.byKey["slot-0"].status).toBe("disconnected");
  expect(await app.groupCount()).toBe(2);
});

test("plugging real hardware in mid-demo ADDS it alongside — the demo keeps running (lot E4: no more hand-over teardown)", async ({
  app,
}) => {
  await app.waitConnected();
  await app.setPresent(false);
  await app.waitDisconnected();

  await app.clickDemo();
  await app.waitConnected();
  expect(await app.demoChipVisible()).toBe(true);

  // A unit appears on the bus: the auto-connect tick claims SLOT 0 for it
  // (the demo never took it), while the focused demo session keeps
  // running untouched — the multi-device coexistence the old hand-over
  // teardown predates.
  await app.setPresent(true);
  await expect
    .poll(async () => (await app.sessions()).byKey["slot-0"]?.status, {
      timeout: 15_000,
    })
    .toBe("connected");
  const sessions = await app.sessions();
  expect(sessions.focused).toBe("slot-1");
  expect(sessions.byKey["slot-1"].status).toBe("connected");
  expect(await app.demoChipVisible()).toBe(true);
  expect(await app.groupCount()).toBe(2);
});

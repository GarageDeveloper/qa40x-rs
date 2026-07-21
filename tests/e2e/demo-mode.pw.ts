/**
 * Demo mode (embedded virtual QA40x): with nothing on the USB bus, the Demo
 * button attaches the in-process virtual device in one click. The session is
 * badged DEMO — a demo screen must never pass for a hardware measurement —
 * and disconnecting returns to the normal disconnected UI with the Demo
 * entry point back.
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

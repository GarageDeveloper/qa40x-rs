/**
 * M0 smoke: the v2 skeleton against the fake device.
 *
 * - auto-connect at boot (v1 parity), manual disconnect suppresses it;
 * - identity + telemetry in the bottom status bar (never the top bar, so
 *   connecting must not shift the controls);
 * - config round-trip: a range change lands in the backend and reads back;
 * - controls are greyed out while disconnected;
 * - the ATTEN invariant: lit at ≥ 24 dBV input range, unlit below — the
 *   annunciator is DERIVED from the range (no register exists), so this
 *   must hold against any backend, fake or real.
 */
import { expect, test } from "./adapter/fixtures";

// Auto-connect polls every 2 s; give a suppressed reconnect 2+ ticks to
// (wrongly) fire before declaring it suppressed.
const AUTOCONNECT_QUIET_MS = 4500;

test("auto-connects at boot; manual disconnect stays disconnected", async ({
  app,
}) => {
  // No click: the device is present, the app must connect on its own.
  await app.waitConnected();
  expect(await app.connectLabel()).toBe("Disconnect");
  expect(await app.identity()).toContain("QA402");
  await expect
    .poll(() => app.telemetry(), { timeout: 5_000 })
    .toContain("USB");

  // Manual disconnect must hold: no auto-reconnect while the device is
  // still present (userDisconnected rule).
  await app.clickConnect(); // now "Disconnect"
  await expect.poll(() => app.connectLabel()).toBe("Connect");
  await new Promise((r) => setTimeout(r, AUTOCONNECT_QUIET_MS));
  expect(await app.connectLabel()).toBe("Connect");

  // A manual connect re-arms everything.
  await app.clickConnect();
  await app.waitConnected();
});

test("duplicate device-disconnected events produce ONE toast", async ({
  app,
}) => {
  await app.waitConnected();

  // The backend monitor can echo after a manual disconnect (and stacked
  // monitors used to fire several times) — the handler must be idempotent.
  await app.emit("device-disconnected");
  await app.emit("device-disconnected");

  await expect.poll(() => app.connectLabel()).toBe("Connect");
  expect(await app.toastCount("Device disconnected")).toBe(1);

  // It is an info toast: it must auto-dismiss (only ERROR toasts persist).
  await expect
    .poll(() => app.toastCount("Device disconnected"), { timeout: 8_000 })
    .toBe(0);
});

test("controls are greyed out while disconnected", async ({ app }) => {
  await app.waitConnected();
  expect(await app.controlsDisabled()).toBe(false);

  await app.clickConnect(); // disconnect
  await expect.poll(() => app.controlsDisabled()).toBe(true);
});

test("input range round-trips through the backend", async ({ app }) => {
  await app.waitConnected();

  await app.setSelect("input-range", "18");
  // The UI re-reads the config after a set — poll until it lands.
  await expect.poll(() => app.selectValue("input-range")).toBe("18");

  await app.setSelect("input-range", "6");
  await expect.poll(() => app.selectValue("input-range")).toBe("6");
});

test("ATTEN is derived from the input range: ≥ 24 dBV lit, below unlit", async ({
  app,
}) => {
  await app.waitConnected();

  await app.setSelect("input-range", "24");
  await expect.poll(() => app.annunciatorLit("atten")).toBe(true);

  await app.setSelect("input-range", "18");
  await expect.poll(() => app.annunciatorLit("atten")).toBe(false);

  await app.setSelect("input-range", "42");
  await expect.poll(() => app.annunciatorLit("atten")).toBe(true);
});

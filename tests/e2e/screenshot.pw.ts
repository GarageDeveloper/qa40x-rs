/**
 * Screenshot tour of the v2 skeleton — one connected view into
 * tests/e2e/screenshots/ so every milestone leaves something a human
 * can LOOK at (the project's highest-yield bug-finder).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./adapter/fixtures";
import type { RecordedFixture } from "./harness/frames";

const DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "screenshots"
);

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "./fixtures"
);

function loadFixture(name: string): RecordedFixture | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), "utf8")
    ) as RecordedFixture;
  } catch {
    return null;
  }
}

test("screenshot: connected skeleton", async ({ app }) => {
  await app.waitConnected(); // auto-connect
  await app.setSelect("input-range", "42");
  // Wait for the first telemetry poll so the status bar is fully populated.
  await expect
    .poll(() => app.telemetry(), { timeout: 5_000 })
    .toContain("USB");
  fs.mkdirSync(DIR, { recursive: true });
  await app.drv.screenshot(path.join(DIR, "m0-connected.png"));

  // Disconnected: greyed controls + "No device" status bar.
  await app.clickConnect();
  await expect.poll(() => app.controlsDisabled()).toBe(true);
  await app.drv.screenshot(path.join(DIR, "m0-disconnected.png"));
});

test("screenshot: M1 live spectrum (recorded loopback frame)", async ({
  app,
}) => {
  const idle = loadFixture("idle");
  const sineL = loadFixture("sine-1k-left");
  test.skip(!idle || !sineL, "awaiting recorded fixtures (#54)");
  await app.waitConnected();
  // The recorded 1 kHz loopback frame — a REAL capture on the screen, per
  // the project rule (never fabricate what a user reads).
  await app.setSelect("input-range", "18");
  await app.setSelect("fft-size", "8192");
  await app.useFixtures([idle, sineL]);
  const id = await app.addSine();
  await app.playSine(id); // play auto-starts the stream (M2)
  await app.setTraceVisible("hw-in-right", true);
  await app.setTraceVisible("hw-out-left", true);
  await app.waitForSeries("Input L", 3);
  await app.setTileUnit("dbv");
  fs.mkdirSync(DIR, { recursive: true });
  await app.drv.screenshot(path.join(DIR, "m1-spectrum-live.png"));
});

test("screenshot: M2 sources panel (recorded mix fixture)", async ({ app }) => {
  const idle = loadFixture("idle");
  const mixFix = loadFixture("mix-sine-l-square-r");
  test.skip(!idle || !mixFix, "awaiting recorded fixtures (#54)");
  await app.waitConnected();
  // Match the recorded register state, then drive L (sine) + R (square) so
  // the REAL mix capture replays behind the panel.
  await app.setSelect("input-range", "18");
  await app.setSelect("fft-size", "8192");
  await app.useFixtures([idle, mixFix]);
  const sine = await app.addSine();
  const square = await app.addSource("square");
  await app.setSineRoute(square, "right");
  const script = await app.addSource("script"); // defined but idle
  await app.drv.click(`[data-testid="src-more-${sine}"]`); // tone editor open
  await app.playSine(sine); // play auto-starts the stream (M2)
  await app.playSine(square);
  await app.setTraceVisible("hw-in-right", true);
  await app.waitForSeries("Input L", 3);
  await app.waitForSeries("Input R", 3);
  await app.setTileUnit("dbv");
  fs.mkdirSync(DIR, { recursive: true });
  await app.drv.screenshot(path.join(DIR, "m2-sources-panel.png"));

  // The script editor dialog (modal, presets loader).
  await app.drv.click(`[data-testid="src-edit-${script}"]`);
  await app.drv.screenshot(path.join(DIR, "m2-script-dialog.png"));
});

test("screenshot: M3 grid — 2×2, scope tile, chips, frozen overlay", async ({
  app,
}) => {
  const idle = loadFixture("idle");
  const sineL = loadFixture("sine-1k-left");
  test.skip(!idle || !sineL, "awaiting recorded fixtures (#54)");
  await app.waitConnected();
  await app.setSelect("input-range", "18");
  await app.setSelect("fft-size", "8192");
  await app.useFixtures([idle, sineL]);
  const id = await app.addSine();
  await app.playSine(id);
  await app.setLayoutPattern("2x2");
  // tile-1: spectrum In L (+ frozen ❄ overlay); tile-2: scope In L + Out L
  // in volts; tile-3/4 stay defaults — the preset's face as shipped.
  await app.setTileUnit("dbv");
  await app.waitForSeries("Input L", 3);
  await app.drv.click('[data-testid="tile-freeze-tile-1"]');
  await app.setTileKind("scope", "tile-2");
  await app.setTraceVisible("hw-out-left", true, "tile-2");
  await app.setTileUnit("v", "tile-2");
  await app.waitForSeries("Input L", 5);
  fs.mkdirSync(DIR, { recursive: true });
  await app.drv.screenshot(path.join(DIR, "m3-grid-2x2.png"));

  // The gear dialog, Axis tab (dBr + fixed range controls).
  await app.drv.click('[data-testid="tile-gear-tile-1"]');
  await app.drv.click('[data-testid="gear-tab-axis"]');
  await app.drv.screenshot(path.join(DIR, "m3-gear-axis.png"));
});

/**
 * Per-device export bench headers (issue #25 lot F5), on the two-unit fake:
 * the unprefixed bench block describes the device that OWNS the exported
 * data — never whatever device happens to be focused. Pre-F5, exporting
 * slot 0's data under a slot-1 focus stamped slot 1's model, serial, ranges
 * and converter offsets onto slot 0's numbers (the four-offsets bug class
 * in header form), and a dormant owner borrowed the focused converter.
 */
import { expect, test } from "./adapter/fixtures";
import type { AppV2 } from "./adapter/app";

const UNIT_B = "usb/E2E-FAKE-0002";

/** Unit A on slot 0 (focused), unit B added on slot 1, frames landed on
 * BOTH so every endpoint carries its own capture provenance. */
async function twoUnitsWithFrames(app: AppV2): Promise<void> {
  await app.waitConnected();
  await app.setUnits(2);
  await expect
    .poll(() => app.addableOptions(), { timeout: 15_000 })
    .toContain(UNIT_B);
  await app.addDeviceFromPanel(UNIT_B);
  await expect.poll(() => app.groupCount()).toBe(2);
  await expect.poll(() => app.groupRunDisabled(1)).toBe(false);

  await app.clickRun(); // slot 0 (focused)
  await app.groupRun(1); // slot 1 monitors
  await expect
    .poll(async () => (await app.sessions()).byKey["slot-0"].frames)
    .toBeGreaterThan(0);
  await expect
    .poll(async () => (await app.sessions()).byKey["slot-1"].frames)
    .toBeGreaterThan(0);
}

test("exporting the NON-focused device's trace names THAT device — lean header, no capture_* noise", async ({
  app,
}) => {
  await twoUnitsWithFrames(app);

  // Focus sits on slot 0; export slot 1's Input L.
  // Slot 1 is in no spectrum tile — its endpoints carry TD frames only.
  await app.setSelect("trace-export-hw-in-left@1", "td");
  await expect.poll(async () => (await app.exportedFiles()).length).toBe(1);
  const [f] = await app.exportedFiles();
  const lines = f.text.split("\n");

  // The bench block is unit B's…
  expect(lines).toContain("# device_serial=E2E-FAKE-0002");
  // …nothing of the focused unit A leaks in…
  expect(lines.some((l) => l.includes("E2E-FAKE-0001"))).toBe(false);
  // …and a trace matching its OWN bench keeps the lean pre-#40 header
  // (pre-F5 the gate compared against the FOCUSED bench and would have
  // emitted a spurious capture_* block here).
  expect(lines.some((l) => l.startsWith("# capture_"))).toBe(false);
});

test("a slot-0 export under a slot-1 FOCUS carries slot 0's identity (the F5 headline)", async ({
  app,
}) => {
  await twoUnitsWithFrames(app);

  await app.pickFocus("slot-1");
  await app.setSelect("trace-export-hw-in-left", "fd");
  await expect.poll(async () => (await app.exportedFiles()).length).toBe(1);
  const [f] = await app.exportedFiles();
  const lines = f.text.split("\n");

  expect(lines).toContain("# device_serial=E2E-FAKE-0001");
  expect(lines.some((l) => l.includes("E2E-FAKE-0002"))).toBe(false);
  expect(lines.some((l) => l.startsWith("# capture_"))).toBe(false);
});

test("a DORMANT owner exports device_model=none — the capture_* block carries the identity, never a substituted converter", async ({
  app,
}) => {
  await twoUnitsWithFrames(app);

  await app.unplugUnit(UNIT_B);
  await expect
    .poll(async () => (await app.sessions()).byKey["slot-1"])
    .toBeUndefined();

  // The dormant row keeps its export menu (D1: frames and captures survive
  // the eviction — options gate on domains only).
  // Slot 1 is in no spectrum tile — its endpoints carry TD frames only.
  await app.setSelect("trace-export-hw-in-left@1", "td");
  await expect.poll(async () => (await app.exportedFiles()).length).toBe(1);
  const [f] = await app.exportedFiles();
  const lines = f.text.split("\n");

  // No live owner ⇒ an honest none — NOT the focused unit A's converter.
  expect(lines).toContain("# device_model=none");
  for (const gone of [
    "# device_serial=",
    "# sample_rate_hz=",
    "# input_range_dbv=",
    "# offset_input_l_db=",
  ]) {
    expect(lines.some((l) => l.startsWith(gone))).toBe(false);
  }
  expect(lines).toContain("# calibrated=false");
  // The identity of the unit that produced the data rides the capture block.
  expect(lines).toContain("# capture_device_serial=E2E-FAKE-0002");
  expect(lines.some((l) => l.startsWith("# capture_sample_rate_hz="))).toBe(true);
});

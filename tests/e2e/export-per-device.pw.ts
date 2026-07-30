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

  // No live owner ⇒ an honest none — NOT the focused unit A's converter,
  // and no calibration claim about a converter nobody can see.
  expect(lines).toContain("# device_model=none");
  for (const gone of [
    "# device_serial=",
    "# sample_rate_hz=",
    "# input_range_dbv=",
    "# offset_input_l_db=",
    "# calibrated=",
  ]) {
    expect(lines.some((l) => l.startsWith(gone))).toBe(false);
  }
  // The identity of the unit that produced the data rides the capture
  // block, and the note explains the none.
  expect(lines).toContain("# capture_device_serial=E2E-FAKE-0002");
  expect(lines.some((l) => l.startsWith("# capture_sample_rate_hz="))).toBe(true);
  expect(
    lines.some((l) => l.startsWith("# note=") && l.includes("no longer on the bench"))
  ).toBe(true);
});

test("a tile drawing BOTH devices names them all in export_devices (additive line, format_version stays 1)", async ({
  app,
}) => {
  await twoUnitsWithFrames(app);

  // A spectrum tile can't draw slot 1's td-only endpoint — switch tile-1 to
  // scope and add unit B's Input L next to unit A's.
  await app.setTileKind("scope");
  await app.setSelect("tile-add-trace-tile-1", "hw-in-left@1");

  await app.setSelect("tile-export-tile-1", "csv");
  await expect.poll(async () => (await app.exportedFiles()).length).toBe(1);
  const [f] = await app.exportedFiles();
  const lines = f.text.split("\n");

  expect(lines).toContain("# format_version=1");
  expect(lines).toContain(
    "# export_devices=QA402 E2E-FAKE-0001, QA402 E2E-FAKE-0002"
  );
  // Different benches on one tile flag the capture block as mixed, as
  // before — export_devices is the additive roll call on top.
  expect(lines).toContain("# capture_mixed=true");
});

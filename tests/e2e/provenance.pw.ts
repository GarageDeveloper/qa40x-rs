/**
 * Per-trace capture-time provenance (issue #40), on the fake backend:
 *
 *   - a frozen ❄ trace exported AFTER the bench moved carries `capture_*`
 *     keys describing the bench that PRODUCED it (the issue's founding
 *     example: measure, freeze, reconfigure, export — the old header named
 *     the new bench confidently);
 *   - a LIVE trace whose snapshot still matches the bench exports the same
 *     lean header as before #40 — no capture_* noise;
 *   - a tile mixing members captured under different bench states flags
 *     `capture_mixed=true` (the block then describes the chip source only).
 */
import { expect, test } from "./adapter/fixtures";

test.beforeEach(async ({ app }) => {
  await app.waitConnected();
  await app.playSine("src-sine-1");
  await app.waitForSeries("Input L");
});

test("frozen ❄ then bench moved: the export carries the CAPTURE bench, not just the current one", async ({
  app,
}) => {
  // Freeze the displayed Input L → "Input L ❄1" (mem-1) joins pool + tile.
  await app.drv.click('[data-testid="tile-freeze-tile-1"]');

  // The bench moves: input range 42 → 18 dBV, rate 48 → 96 kHz.
  await app.setSelect("input-range", "18");
  await app.setSelect("sample-rate", "96000");

  await app.setSelect("trace-export-mem-1", "fd");
  await expect.poll(async () => (await app.exportedFiles()).length).toBe(1);
  const [f] = await app.exportedFiles();
  const lines = f.text.split("\n");

  // The capture_* block pins the bench that produced the frozen curve…
  expect(lines).toContain("# capture_device_model=QA402");
  expect(lines).toContain("# capture_device_serial=E2E-FAKE-0001");
  expect(lines).toContain("# capture_sample_rate_hz=48000");
  expect(lines).toContain("# capture_input_range_dbv=42");
  expect(lines.some((l) => l.startsWith("# capture_time="))).toBe(true);
  // …while the unprefixed keys keep describing the bench at export time
  // (additive keys — format_version stays 1).
  expect(lines).toContain("# format_version=1");
  expect(lines).toContain("# sample_rate_hz=96000");
  expect(lines).toContain("# input_range_dbv=18");
  expect(lines.some((l) => l.startsWith("# note=capture_* keys describe"))).toBe(true);
});

test("a live trace matching the bench keeps the lean pre-#40 header", async ({ app }) => {
  await app.setSelect("trace-export-hw-in-left", "fd");
  await expect.poll(async () => (await app.exportedFiles()).length).toBe(1);
  const [f] = await app.exportedFiles();
  const lines = f.text.split("\n");
  expect(lines).toContain("# device_model=QA402");
  expect(lines.some((l) => l.startsWith("# capture_"))).toBe(false);
  expect(lines.some((l) => l.startsWith("# note=header reflects the bench"))).toBe(true);
});

test("a tile mixing capture states flags capture_mixed", async ({ app }) => {
  // Freeze at 48 kHz, then move the bench and let a FRESH live frame land —
  // tile-1 now draws a live 96 kHz curve next to a frozen 48 kHz one.
  await app.drv.click('[data-testid="tile-freeze-tile-1"]');
  await app.setSelect("sample-rate", "96000");
  // Wait on the REAL condition, not a frame counter: a 48 kHz frame in
  // flight during the select round-trip satisfies "one more frame" and
  // exports a not-yet-moved live capture (review finding #8).
  await app.drv.waitUntil(
    () =>
      (
        window as unknown as {
          qa40xV2Debug: {
            state(): {
              traces: {
                byId: Record<string, { capture: { sampleRateHz: number | null } | null }>;
              };
            };
          };
        }
      ).qa40xV2Debug.state().traces.byId["hw-in-left"].capture?.sampleRateHz === 96000,
    undefined as void
  );

  await app.setSelect("tile-export-tile-1", "csv");
  await expect.poll(async () => (await app.exportedFiles()).length).toBe(1);
  const [f] = await app.exportedFiles();
  const lines = f.text.split("\n");
  expect(lines).toContain("# capture_mixed=true");
  // The block describes the CHIP SOURCE (the live Input L, post-move).
  expect(lines).toContain("# capture_sample_rate_hz=96000");
});

test("the SVG lane carries the SAME capture_* provenance as CSV, embedded in its <metadata> (not just the lean live-bench case)", async ({
  app,
}) => {
  // The existing SVG export spec (export.pw.ts) only exercises a LIVE trace
  // matching the bench — the lean pre-#40 header, no capture_* keys at all.
  // export.ts threads the SAME `tileCapture()` result into both the CSV and
  // SVG lanes (`comments(s, lines, tileCapture(s, tile))`); this pins that
  // the SVG lane actually carries it too, on the exact "bench moved" setup
  // as the capture_mixed CSV test above.
  await app.drv.click('[data-testid="tile-freeze-tile-1"]');
  await app.setSelect("sample-rate", "96000");
  // Wait on the REAL condition, not a frame counter: a 48 kHz frame in
  // flight during the select round-trip satisfies "one more frame" and
  // exports a not-yet-moved live capture (review finding #8).
  await app.drv.waitUntil(
    () =>
      (
        window as unknown as {
          qa40xV2Debug: {
            state(): {
              traces: {
                byId: Record<string, { capture: { sampleRateHz: number | null } | null }>;
              };
            };
          };
        }
      ).qa40xV2Debug.state().traces.byId["hw-in-left"].capture?.sampleRateHz === 96000,
    undefined as void
  );

  await app.setSelect("tile-export-tile-1", "svg");
  await expect.poll(async () => (await app.exportedFiles()).length).toBe(1);
  const [f] = await app.exportedFiles();
  expect(f.path).toMatch(/\.svg$/);
  // The metadata block is the SAME "# key=value" lines as the CSV export,
  // XML-escaped and newline-joined inside <metadata>.
  expect(f.text).toContain("<metadata>");
  expect(f.text).toContain("# capture_mixed=true");
  expect(f.text).toContain("# capture_sample_rate_hz=96000");
});

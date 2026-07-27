/**
 * CSV/PNG export with provenance header (issue #30), on the fake backend:
 *
 *   - a tile ⤓ CSV export writes what the tile DISPLAYS (display units, the
 *     chartvm series) under `# key=value` provenance comments carrying the
 *     device identity (#25: model/serial/firmware/virtual from day one),
 *     acquisition settings and calibration state;
 *   - a trace ⤓ CSV export writes the frames-cache WIRE units (dBFS /
 *     full-scale samples) plus the derived absolute column, and names the
 *     trace's source in the header;
 *   - PNG export writes a real PNG file; "Copy image" hands the backend an
 *     RGBA buffer whose size matches its declared dimensions;
 *   - a cancelled save dialog writes nothing (and breaks nothing);
 *   - the App drawer's Export section lists every displayed graph with the
 *     same actions (the "future export section" the drawer reserved).
 *
 * The fake device answers `plugin:dialog|save` itself (it IS the user) and
 * records every `export_write_file` / `export_copy_image` payload — specs
 * assert bytes, never real-filesystem side effects.
 */
import { expect, test } from "./adapter/fixtures";

test.beforeEach(async ({ app }) => {
  await app.waitConnected();
  // The out-of-the-box sine (Sine 1, 1 kHz / −12 dBV, routed Left) — play
  // it so frames land and every trace carries td+fd domains.
  await app.playSine("src-sine-1");
  await app.waitForSeries("Input L");
});

test("tile ⤓ CSV: provenance header + display-unit columns", async ({ app }) => {
  await app.setSelect("tile-export-tile-1", "csv");
  await expect.poll(async () => (await app.exportedFiles()).length).toBe(1);
  const [f] = await app.exportedFiles();

  expect(f.path).toMatch(/^\/e2e\/qa40x-spectrum-\d{8}-\d{6}\.csv$/);
  const lines = f.text.split("\n");
  expect(lines[0]).toBe("# qa40x-rs data export");
  // Device identity from day one (#25) + bench state.
  for (const want of [
    "# format_version=1",
    "# device_model=QA402",
    "# device_serial=E2E-FAKE-0001",
    "# device_firmware=991",
    "# device_virtual=false",
    "# sample_rate_hz=48000",
    "# fft_size=32768",
    "# export=tile",
    "# graph=spectrum",
    "# unit=dBV",
  ]) {
    expect(lines).toContain(want);
  }
  expect(lines.some((l) => l.startsWith("# app_version="))).toBe(true);
  expect(lines.some((l) => l.startsWith("# window="))).toBe(true);
  expect(lines.some((l) => l.startsWith("# calibrated="))).toBe(true);

  // Header row + at least one data row, '.' decimals (no locale commas:
  // every non-comment row splits into exactly 2 cells).
  const data = lines.filter((l) => l.length > 0 && !l.startsWith("#"));
  expect(data[0]).toBe("frequency_hz,Input L (dBV)");
  expect(data.length).toBeGreaterThan(10);
  const cells = data[1].split(",");
  expect(cells).toHaveLength(2);
  expect(Number.parseFloat(cells[0])).not.toBeNaN();
});

test("trace ⤓ CSV: wire units + derived absolute column + source line", async ({ app }) => {
  await app.setSelect("trace-export-hw-in-left", "fd");
  await expect.poll(async () => (await app.exportedFiles()).length).toBe(1);
  let [f] = await app.exportedFiles();
  expect(f.path).toMatch(/^\/e2e\/qa40x-input-l-fd-.*\.csv$/);
  let lines = f.text.split("\n");
  expect(lines).toContain("# export=trace");
  expect(lines).toContain("# trace=Input L");
  expect(lines).toContain("# trace_source=hardware input L");
  expect(lines.some((l) => l.startsWith("# trace_offset_dbv="))).toBe(true);
  expect(lines.filter((l) => !l.startsWith("#"))[0]).toBe(
    "frequency_hz,magnitude_dbfs,magnitude_dbv"
  );

  // The same trace also offers its waveform (td) frame.
  await app.setSelect("trace-export-hw-in-left", "td");
  await expect.poll(async () => (await app.exportedFiles()).length).toBe(2);
  f = (await app.exportedFiles())[1];
  lines = f.text.split("\n");
  expect(lines.some((l) => l.startsWith("# trace_sample_rate_hz=48000"))).toBe(true);
  expect(lines.filter((l) => !l.startsWith("#"))[0]).toBe("time_s,amplitude_fs,amplitude_v");
});

test("tile ⤓ PNG writes a real PNG; Copy hands a size-consistent RGBA image", async ({
  app,
}) => {
  await app.setSelect("tile-export-tile-1", "png");
  await expect.poll(async () => (await app.exportedFiles()).length).toBe(1);
  const [f] = await app.exportedFiles();
  expect(f.path).toMatch(/\.png$/);
  // atob'd binary: the PNG magic survives as latin-1 text.
  expect(f.text.startsWith("\u0089PNG")).toBe(true);

  await app.setSelect("tile-export-tile-1", "copy");
  await expect.poll(async () => (await app.copiedImages()).length).toBe(1);
  const [img] = await app.copiedImages();
  expect(img.width).toBeGreaterThan(0);
  expect(img.height).toBeGreaterThan(0);
  expect(img.byteLength).toBe(img.width * img.height * 4);
});

test("a cancelled save dialog writes nothing", async ({ app }) => {
  await app.cancelNextSaveDialog(true);
  await app.setSelect("tile-export-tile-1", "csv");
  // No landing signal on cancel — give the async flow a beat, then assert
  // the un-cancelled retry is the FIRST write the fake ever saw.
  await new Promise((r) => setTimeout(r, 300));
  expect(await app.exportedFiles()).toHaveLength(0);

  await app.cancelNextSaveDialog(false);
  await app.setSelect("tile-export-tile-1", "csv");
  await expect.poll(async () => (await app.exportedFiles()).length).toBe(1);
});

test("the App drawer's Export section lists every displayed graph", async ({ app }) => {
  await app.drv.click('[data-testid="btn-app-menu"]');
  await app.drv.waitUntil(
    () =>
      document.querySelectorAll('[data-testid="app-export-tiles"] .drawer__row').length > 0,
    undefined as void
  );
  // 2×2 default layout → 4 rows, labeled by kind.
  const labels = await app.drv.eval(
    () =>
      Array.from(
        document.querySelectorAll('[data-testid="app-export-tiles"] .drawer__key')
      ).map((n) => n.textContent),
    undefined as void
  );
  expect(labels).toEqual([
    "Graph 1 — Spectrum",
    "Graph 2 — Scope",
    "Graph 3 — Spectrum",
    "Graph 4 — Scope",
  ]);

  // The drawer's CSV action drives the SAME path as the tile ⤓ (tile-3 =
  // the Input R spectrum).
  await app.drv.click('[data-testid="app-export-csv-tile-3"]');
  await expect.poll(async () => (await app.exportedFiles()).length).toBe(1);
  const [f] = await app.exportedFiles();
  expect(f.text).toContain("Input R (dBV)");
  await app.screenshot("app-drawer-export");
});

test("a program's ⤓ stays disabled until a result lands", async ({ app }) => {
  const id = await app.addProgram("thd");
  const disabled = await app.drv.eval(
    (tid: string) =>
      document.querySelector<HTMLButtonElement>(`[data-testid="${tid}"]`)?.disabled,
    `prog-export-${id}`
  );
  expect(disabled).toBe(true);
});

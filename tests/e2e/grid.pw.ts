/**
 * M3 grid invariants on the fake backend:
 *
 * - layout presets create tiles and keep hidden tiles' config across
 *   round-trips (2x2 → 1 → 2x2 restores);
 * - drag-and-drop reorders the visible tiles;
 * - the measure chips read backend values (peak freq of the played tone,
 *   THD from the stream metrics) — the frontend only formats;
 * - freeze ❄ snapshots the shown traces into deletable memory overlays;
 * - the gear dialog's dBr relabels the axis and re-references the values.
 */
import { expect, test } from "./adapter/fixtures";

test.beforeEach(async ({ app }) => {
  await app.waitConnected();
});

test("boots on 2×2 Spectrum|Scope; hidden tiles keep their config", async ({ app }) => {
  // The out-of-the-box workspace: 2×2, Spectrum | Scope on each row, and a
  // ready-to-play Sine 1 (maintainer defaults, M3 review).
  expect(await app.tileOrder()).toEqual(["tile-1", "tile-2", "tile-3", "tile-4"]);
  expect(await app.selectValue("tile-kind-tile-1")).toBe("spectrum");
  expect(await app.selectValue("tile-kind-tile-2")).toBe("scope");
  expect(await app.selectValue("tile-kind-tile-3")).toBe("spectrum");
  expect(await app.selectValue("tile-kind-tile-4")).toBe("scope");
  expect(
    await app.drv.eval(
      () =>
        (window as unknown as {
          qa40xV2Debug: { state(): { sources: { order: string[] } } };
        }).qa40xV2Debug.state().sources.order,
      undefined as void
    )
  ).toEqual(["src-sine-1"]);

  // Flip tile-2 away from its default, hide it via the 1-tile preset,
  // bring it back: the config survived.
  await app.setTileKind("spectrum", "tile-2");
  await app.setLayoutPattern("1");
  expect(await app.tileOrder()).toEqual(["tile-1"]);
  await app.setLayoutPattern("2x2");
  expect(await app.selectValue("tile-kind-tile-2")).toBe("spectrum");
});

test("drag-and-drop reorders the visible tiles", async ({ app }) => {
  await app.setLayoutPattern("1x3");
  expect(await app.tileOrder()).toEqual(["tile-1", "tile-2", "tile-3"]);
  await app.dragTile("tile-1", "tile-3");
  expect(await app.tileOrder()).toEqual(["tile-2", "tile-3", "tile-1"]);
  // And back to the front.
  await app.dragTile("tile-1", "tile-2");
  expect(await app.tileOrder()).toEqual(["tile-1", "tile-2", "tile-3"]);
});

test("measure chips carry backend values, TS only formats", async ({ app }) => {
  const id = await app.addSine(); // 1 kHz, −12 dBV
  await app.playSine(id);
  await app.waitForSeries("Input L");

  // Defaults on a spectrum tile: THD + Peak freq. The loopback carries the
  // 1 kHz tone, so the loudest bin must read 1 kHz and THD must be a number
  // (the fake's textbook THD of a clean sine — tiny, not "—").
  await expect
    .poll(async () => (await app.tileChips())["peakfreq"], { timeout: 10_000 })
    .toBe("1 kHz");
  const thd = (await app.tileChips())["thd"];
  expect(thd).toMatch(/%$/);
  expect(thd).not.toBe("—");

  // "All" adds every measurement in one gesture (and disables ＋ once full).
  await app.setSelect("tile-chip-add-tile-1", "__all__");
  await expect
    .poll(async () => Object.keys(await app.tileChips()).length, { timeout: 5000 })
    .toBe(11);
  expect(
    await app.drv.eval(
      () =>
        (
          document.querySelector(
            '[data-testid="tile-chip-add-tile-1"]'
          ) as HTMLSelectElement
        ).disabled,
      undefined as void
    )
  ).toBe(true);

  // Kind switch resets the chips to the td defaults — and level chips
  // follow the tile's unit: a scope in volts reads volts (through the
  // trace's own converter offset), not raw dBFS.
  await app.setTileKind("scope");
  await expect
    .poll(async () => (await app.tileChips())["rms"], { timeout: 10_000 })
    .toMatch(/Vrms$/);
  const peak = (await app.tileChips())["peak"];
  expect(peak).toMatch(/Vpk$/);
});

test("freeze ❄ snapshots the shown traces into deletable memory overlays", async ({
  app,
}) => {
  const id = await app.addSine();
  await app.playSine(id);
  await app.waitForSeries("Input L");

  await app.drv.click('[data-testid="tile-freeze-tile-1"]');
  // The frozen copy joins the pool AND the tile (an immediate overlay).
  await expect
    .poll(async () => (await app.poolRows()).map((r) => r.id), { timeout: 5000 })
    .toContain("mem-1");
  const rows = await app.poolRows();
  expect(rows.find((r) => r.id === "mem-1")?.label).toContain("Input L");
  await app.waitForSeries("Input L ❄1");

  // A memory trace never re-freezes: freezing again snapshots only the live
  // trace, not the snapshot.
  await app.drv.click('[data-testid="tile-freeze-tile-1"]');
  await expect
    .poll(async () => (await app.poolRows()).map((r) => r.id), { timeout: 5000 })
    .toContain("mem-2");
  expect((await app.poolRows()).find((r) => r.id === "mem-3")).toBeUndefined();

  // Delete both: pool and tile forget them.
  await app.drv.click('[data-testid="trace-del-mem-1"]');
  await app.drv.click('[data-testid="trace-del-mem-2"]');
  await expect
    .poll(async () => (await app.poolRows()).map((r) => r.id), { timeout: 5000 })
    .toEqual(["hw-in-left", "hw-in-right", "hw-out-left", "hw-out-right"]);
});

test("legend chips toggle a curve without removing it (v1 behavior)", async ({
  app,
}) => {
  const id = await app.addSine();
  await app.playSine(id);
  await app.setTraceVisible("hw-in-right", true);
  await app.waitForSeries("Input L");
  await app.waitForSeries("Input R");

  // Click Input R's legend chip: the curve leaves the view-model (and the
  // fd budget), the chip dims, the membership STAYS.
  await app.toggleLegend("hw-in-right");
  await expect
    .poll(async () => (await app.legendOff("hw-in-right")), { timeout: 5000 })
    .toBe(true);
  await expect
    .poll(() => app.curvePeakDb("Input R", 1000), { timeout: 10_000 })
    .toBeNull();
  expect(await app.curvePeakDb("Input L", 1000)).not.toBeNull();

  // Click again: the curve comes back.
  await app.toggleLegend("hw-in-right");
  await expect
    .poll(async () => (await app.legendOff("hw-in-right")), { timeout: 5000 })
    .toBe(false);
  await app.waitForSeries("Input R");
});

test("gear dBr re-references the level axis (peak reads 0 dBr)", async ({ app }) => {
  const id = await app.addSine();
  await app.playSine(id);
  await app.waitForSeries("Input L");

  await app.drv.click('[data-testid="tile-gear-tile-1"]');
  await app.drv.click('[data-testid="gear-tab-axis"]');
  await app.drv.click('[data-testid="gear-dbr"]');
  // The tile relabels and the tone's peak sits at 0 dBr (auto reference).
  await expect
    .poll(() => app.curvePeakDb("Input L", 1000), { timeout: 10_000 })
    .toBeCloseTo(0, 1);
});

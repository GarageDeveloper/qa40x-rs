/**
 * Scope measurement suite (Lot B, issue #26) on the fake backend: the
 * Freq/Vpp/AC-RMS/Duty chips read the PLAYED tone's true values (the fake
 * loopback preserves levels by design), rise/fall resolve a square wave's
 * one-sample step to its interpolated 10–90 % time, the sliding-window
 * statistics accumulate on the chip tooltip, and a chip added before any
 * frame renders "—" in place (no-layout-shift rule) until values land.
 *
 * Fixture: the `addSine`/`playSine` default — 1 kHz / −12 dBV routed Left,
 * read on tile-2 (the out-of-the-box 2×2 layout's scope tile showing
 * Input L). 1 kHz bin-snaps to 683 × 48000/32768 = 1000.48828125 Hz; the
 * suite's Goertzel refinement must land on THAT, not the asked 1 kHz.
 */
import { expect, test } from "./adapter/fixtures";

/** The frequency the default mix actually plays (bin-snapped 1 kHz). */
const PLAYED_HZ = (Math.round((1000 * 32768) / 48000) * 48000) / 32768;

/** Parse an SI-prefixed chip value ("711 mVpp", "16.7 µs") to base units. */
function parseSi(text: string): number {
  const m = /^(-?[\d.]+)\s*(n|µ|m)?/.exec(text.trim());
  if (!m) return NaN;
  const scale = m[2] === "n" ? 1e-9 : m[2] === "µ" ? 1e-6 : m[2] === "m" ? 1e-3 : 1;
  return parseFloat(m[1]) * scale;
}

test.beforeEach(async ({ app }) => {
  await app.waitConnected();
});

test("sine: Freq/Vpp/AC-RMS/Duty chips read the played tone's true values", async ({ app }) => {
  const id = await app.addSine();

  // Chips join the strip BEFORE any frame: they must render (as "—") in
  // their final place — values later change the text only, never the DOM
  // shape (no-layout-shift rule).
  for (const key of ["freq", "vpp", "acrms", "duty"]) {
    await app.setSelect("tile-chip-add-tile-2", key);
  }
  const idle = await app.tileChips("tile-2");
  expect(idle["freq"]).toBe("—");
  expect(idle["vpp"]).toBe("—");

  await app.playSine(id);
  await app.waitForSeries("Input L");
  await expect
    .poll(async () => (await app.tileChips("tile-2"))["freq"], { timeout: 10_000 })
    .not.toBe("—");

  const chips = await app.tileChips("tile-2");
  // Frequency: the BIN-SNAPPED tone, resolved well under a bin (the whole
  // point of the Goertzel refinement — a crossing count alone couldn't
  // separate 1000.488 from 1000 on a 0.68 s window this tightly).
  expect(Math.abs(parseFloat(chips["freq"]) - PLAYED_HZ)).toBeLessThan(0.05);

  // Levels: −12 dBV sine → 0.2512 Vrms; Vpp = 2√2 × that = 0.7105 V. The
  // fake loopback preserves absolute levels, so the chips read them back
  // through the converter offsets (±5 % — histogram/crossing tolerances).
  const vrms = Math.pow(10, -12 / 20);
  expect(parseSi(chips["acrms"])).toBeGreaterThan(vrms * 0.95);
  expect(parseSi(chips["acrms"])).toBeLessThan(vrms * 1.05);
  expect(parseSi(chips["vpp"])).toBeGreaterThan(2 * Math.SQRT2 * vrms * 0.95);
  expect(parseSi(chips["vpp"])).toBeLessThan(2 * Math.SQRT2 * vrms * 1.05);

  // A sine spends half its time above the mid level.
  expect(Math.abs(parseFloat(chips["duty"]) - 50)).toBeLessThan(2);
});

test("square: duty ~50 %, rise/fall resolve the sub-sample step time", async ({ app }) => {
  const id = await app.addSource("square");
  for (const key of ["duty", "rise", "fall"]) {
    await app.setSelect("tile-chip-add-tile-2", key);
  }
  await app.playSine(id);
  await app.waitForSeries("Input L");
  await expect
    .poll(async () => (await app.tileChips("tile-2"))["duty"], { timeout: 10_000 })
    .not.toBe("—");

  const chips = await app.tileChips("tile-2");
  expect(Math.abs(parseFloat(chips["duty"]) - 50)).toBeLessThan(2);
  // A one-sample edge at 48 kHz: the interpolated 10→90 % time sits under
  // a sample period (≈20.8 µs), and is never reported as a fake zero.
  for (const key of ["rise", "fall"] as const) {
    const t = parseSi(chips[key]);
    expect(t).toBeGreaterThan(1e-6);
    expect(t).toBeLessThan(42e-6);
  }
});

test("sliding stats accumulate on the chip tooltip (avg/min/max/σ/n)", async ({ app }) => {
  const id = await app.addSine();
  await app.setSelect("tile-chip-add-tile-2", "freq");
  await app.playSine(id);
  await app.waitForSeries("Input L");

  // n grows frame over frame — poll until at least 3 readings landed.
  await expect
    .poll(
      async () => {
        const m = /n=(\d+)/.exec(await app.tileChipTitle("tile-2", "freq"));
        return m ? Number(m[1]) : 0;
      },
      { timeout: 15_000 }
    )
    .toBeGreaterThanOrEqual(3);

  const title = await app.tileChipTitle("tile-2", "freq");
  expect(title).toContain("avg ");
  expect(title).toContain("min ");
  expect(title).toContain("max ");
  expect(title).toContain("σ ");
  // The stats describe the same played tone the value chip shows.
  const avg = /avg ([\d.]+) Hz/.exec(title);
  expect(avg).not.toBeNull();
  expect(Math.abs(parseFloat(avg![1]) - PLAYED_HZ)).toBeLessThan(0.05);
});

test("Reset stats (σ↺) drops the window instead of purging over 100 frames", async ({ app }) => {
  const id = await app.addSine();
  await app.setSelect("tile-chip-add-tile-2", "freq");
  await app.playSine(id);
  await app.waitForSeries("Input L");
  await expect
    .poll(
      async () => {
        const m = /n=(\d+)/.exec(await app.tileChipTitle("tile-2", "freq"));
        return m ? Number(m[1]) : 0;
      },
      { timeout: 15_000 }
    )
    .toBeGreaterThanOrEqual(3);

  // Retune 1 kHz → 2 kHz (bin-snapped 1999.512): the sliding window now
  // mixes both tones — `min` legitimately stays at the OLD frequency…
  const RETUNED_HZ = (Math.round((2000 * 32768) / 48000) * 48000) / 32768;
  await app.setSineFrequency(id, 2000);
  await expect
    .poll(async () => parseFloat((await app.tileChips("tile-2"))["freq"]), { timeout: 10_000 })
    .toBeGreaterThan(1900);
  const mixed = await app.tileChipTitle("tile-2", "freq");
  expect(parseFloat(/min ([\d.]+) Hz/.exec(mixed)![1])).toBeLessThan(1500);

  // …until σ↺ drops it: the very next history describes only the new tone.
  await app.drv.click('[data-testid="btn-stats-reset"]');
  await expect
    .poll(
      async () => {
        const m = /min ([\d.]+) Hz/.exec(await app.tileChipTitle("tile-2", "freq"));
        return m ? parseFloat(m[1]) : 0;
      },
      { timeout: 10_000 }
    )
    .toBeGreaterThan(1900);
  const fresh = await app.tileChipTitle("tile-2", "freq");
  expect(Math.abs(parseFloat(/avg ([\d.]+) Hz/.exec(fresh)![1]) - RETUNED_HZ)).toBeLessThan(0.05);
});

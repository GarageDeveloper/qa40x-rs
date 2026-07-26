/**
 * Scope trigger (Lot A, issue #26) on the fake backend: AUTO stabilizes a
 * rising edge, NORMAL freezes the held picture above the signal peak,
 * SINGLE latches once and Arm re-fires it, the header chip + Arm button
 * never leave the DOM across every mode, and the ⚙ Trigger tab round-trips
 * into the per-endpoint (`AppState.triggers`) and per-tile config.
 *
 * Fixture: a 1 kHz / −12 dBV sine routed Left (the `addSine`/`playSine`
 * default), read on tile-2 — the out-of-the-box 2×2 layout's scope tile
 * showing Input L.
 */
import { expect, test } from "./adapter/fixtures";

test.beforeEach(async ({ app }) => {
  await app.waitConnected();
});

test("AUTO + rising + level 0 stabilizes the displayed edge", async ({ app }) => {
  const id = await app.addSine();
  await app.playSine(id);
  await app.waitForSeries("Input L");

  // Position 0 %: the trigger point IS the first displayed sample, so the
  // rising-edge alignment can be read directly off series[0]/series[1].
  await app.setTileTrigger("tile-2", { mode: "auto", edge: "rising", levelV: 0, positionPct: 0 });

  await expect
    .poll(async () => (await app.scopeTrigger("tile-2"))?.state, { timeout: 10_000 })
    .toBe("triggered");

  const series = await app.scopeSamples("tile-2");
  expect(series.length).toBeGreaterThan(1);
  const peak = Math.max(...series.map((v) => Math.abs(v)), 1e-9);
  // The trigger sample is at/just after the level-0 rising crossing: close
  // to zero relative to the waveform's own peak, and still climbing.
  expect(Math.abs(series[0])).toBeLessThan(peak * 0.15);
  expect(series[1]).toBeGreaterThan(series[0]);

  // Stability: the whole point of triggering — the value AT the trigger
  // position barely moves across consecutive frames, even though the raw
  // capture keeps sliding in time.
  const atEdge: number[] = [];
  let frames = await app.frameCount();
  for (let i = 0; i < 5; i++) {
    await expect.poll(async () => app.frameCount(), { timeout: 5000 }).toBeGreaterThan(frames);
    frames = await app.frameCount();
    atEdge.push((await app.scopeSamples("tile-2"))[0]);
  }
  const spread = Math.max(...atEdge) - Math.min(...atEdge);
  expect(spread).toBeLessThan(peak * 0.15);
});

test("NORMAL above the signal peak holds the last picture (frozen)", async ({ app }) => {
  const id = await app.addSine();
  await app.playSine(id);
  await app.waitForSeries("Input L");

  // AUTO first to latch a real snapshot — a NORMAL trigger that never finds
  // an edge has nothing of its own to hold.
  await app.setTileTrigger("tile-2", { mode: "auto", edge: "rising", levelV: 0 });
  await expect
    .poll(async () => (await app.scopeTrigger("tile-2"))?.state, { timeout: 10_000 })
    .toBe("triggered");

  // A level far above any real peak: NORMAL can never find an edge again.
  await app.setTileTrigger("tile-2", { mode: "normal", levelV: 999 });
  await expect
    .poll(async () => (await app.scopeTrigger("tile-2"))?.state, { timeout: 10_000 })
    .toBe("waiting");
  expect((await app.scopeTrigger("tile-2"))?.held).toBe(true);

  const held = await app.scopeSamples("tile-2");
  let frames = await app.frameCount();
  for (let i = 0; i < 3; i++) {
    await expect.poll(async () => app.frameCount(), { timeout: 5000 }).toBeGreaterThan(frames);
    frames = await app.frameCount();
    expect(await app.scopeSamples("tile-2")).toEqual(held);
  }
});

test("SINGLE fires exactly one shot then STOPs; Arm re-fires it", async ({ app }) => {
  const id = await app.addSine();
  await app.playSine(id);
  await app.waitForSeries("Input L");

  await app.setTileTrigger("tile-2", { mode: "single", edge: "rising", levelV: 0 });

  await expect.poll(async () => app.triggerChip("tile-2"), { timeout: 10_000 }).toMatch(/SINGLE · STOP/);
  const first = await app.scopeTrigger("tile-2");
  expect(first?.state === "triggered" || first?.state === "stopped").toBe(true);

  // The held picture freezes — the latch stops the loop from re-scanning.
  const held = await app.scopeSamples("tile-2");
  let frames = await app.frameCount();
  await expect.poll(async () => app.frameCount(), { timeout: 5000 }).toBeGreaterThan(frames);
  expect(await app.scopeSamples("tile-2")).toEqual(held);

  const armEpochBefore = await app.drv.eval(
    () =>
      (
        window as unknown as {
          qa40xV2Debug: { state(): { triggers: Record<string, { armEpoch: number }> } };
        }
      ).qa40xV2Debug.state().triggers["hw-in-left"].armEpoch,
    undefined as void
  );

  await app.armTrigger("tile-2");

  const armEpochAfter = await app.drv.eval(
    () =>
      (
        window as unknown as {
          qa40xV2Debug: { state(): { triggers: Record<string, { armEpoch: number }> } };
        }
      ).qa40xV2Debug.state().triggers["hw-in-left"].armEpoch,
    undefined as void
  );
  expect(armEpochAfter).toBeGreaterThan(armEpochBefore);

  // Re-fire proof: a NEW snapshot lands (the held picture is no longer the
  // pre-arm one) — race-free, unlike trying to catch the one-frame
  // "triggered" transient before it flips back to "stopped".
  await expect
    .poll(async () => JSON.stringify(await app.scopeSamples("tile-2")) !== JSON.stringify(held), {
      timeout: 5000,
    })
    .toBe(true);
  await expect.poll(async () => app.triggerChip("tile-2"), { timeout: 10_000 }).toMatch(/SINGLE · STOP/);
});

test("chip + Arm stay in the DOM across every trigger mode (no layout shift)", async ({ app }) => {
  const id = await app.addSine();
  await app.playSine(id);
  await app.waitForSeries("Input L");

  for (const mode of ["off", "auto", "normal", "single"] as const) {
    await app.setTileTrigger("tile-2", { mode });
    const present = await app.drv.eval(
      () =>
        document.querySelector('[data-testid="tile-trigger-tile-2"]') !== null &&
        document.querySelector('[data-testid="tile-trigger-arm-tile-2"]') !== null,
      undefined as void
    );
    expect(present).toBe(true);
    expect(await app.triggerChip("tile-2")).not.toBeNull();
  }
});

test("gear Trigger tab round-trips into per-endpoint and per-tile state", async ({ app }) => {
  await app.setTileTrigger("tile-2", {
    mode: "normal",
    edge: "falling",
    levelV: 0.25,
    hystV: 0.05,
    positionPct: 30,
    markers: false,
  });

  const s = await app.drv.eval(
    () =>
      (
        window as unknown as {
          qa40xV2Debug: {
            state(): {
              triggers: Record<
                string,
                { mode: string; edge: string; levelV: number; hystV: number | null }
              >;
              layout: {
                tiles: Record<string, { triggerPositionPct: number; showTriggerMarkers: boolean }>;
              };
            };
          };
        }
      ).qa40xV2Debug.state(),
    undefined as void
  );

  // Per-endpoint (shared by every tile whose trigger resolves to hw-in-left).
  expect(s.triggers["hw-in-left"].mode).toBe("normal");
  expect(s.triggers["hw-in-left"].edge).toBe("falling");
  expect(s.triggers["hw-in-left"].levelV).toBeCloseTo(0.25, 6);
  expect(s.triggers["hw-in-left"].hystV).toBeCloseTo(0.05, 6);

  // Per-tile.
  expect(s.layout.tiles["tile-2"].triggerPositionPct).toBe(30);
  expect(s.layout.tiles["tile-2"].showTriggerMarkers).toBe(false);
});

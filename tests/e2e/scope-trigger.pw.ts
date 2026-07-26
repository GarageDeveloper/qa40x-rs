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

test("chip + Arm are hidden (not just DOM-present) on spectrum and sweep tiles", async ({ app }) => {
  const id = await app.addSine();
  await app.playSine(id);
  await app.waitForSeries("Input L");

  // In-DOM-but-hidden is the invariant: the elements never leave the DOM
  // (no layout shift), but only a scope tile may DISPLAY them. This pins
  // the .tile__hidden CSS actually winning over .tile__trigwrap's own
  // display rule (it silently lost before this test existed).
  const visible = () =>
    app.drv.eval(
      () => {
        const chip = document.querySelector('[data-testid="tile-trigger-tile-2"]');
        const arm = document.querySelector('[data-testid="tile-trigger-arm-tile-2"]');
        const shown = (n: Element | null) =>
          n !== null && (n as HTMLElement).offsetParent !== null;
        return { chip: shown(chip), arm: shown(arm), inDom: chip !== null && arm !== null };
      },
      undefined as void
    );

  expect(await visible()).toEqual({ chip: true, arm: true, inDom: true });

  for (const kind of ["spectrum", "sweep"] as const) {
    await app.setTileKind(kind, "tile-2");
    expect(await visible()).toEqual({ chip: false, arm: false, inDom: true });
  }

  await app.setTileKind("scope", "tile-2");
  expect(await visible()).toEqual({ chip: true, arm: true, inDom: true });
});

test("trigger-source dropdown lists only the 4 hw endpoints, never a memory trace (review #9)", async ({ app }) => {
  const id = await app.addSine();
  await app.playSine(id);
  await app.waitForSeries("Input L");

  // Freeze tile-2 (Input L): the ❄ copy joins BOTH the pool and the tile
  // (freezeTile), so the tile now has a memory member alongside Input L.
  await app.drv.click('[data-testid="tile-freeze-tile-2"]');

  await app.drv.click('[data-testid="tile-gear-tile-2"]');
  await app.drv.click('[data-testid="gear-tab-trigger"]');
  const values = await app.drv.eval(
    () =>
      Array.from(
        document.querySelectorAll('[data-testid="gear-trigger-source"] option')
      ).map((o) => (o as HTMLOptionElement).value),
    undefined as void
  );
  await app.closeDialog();

  expect(values).toContain("auto");
  expect(values).toContain("hw-in-left");
  // No memory trace id (they're all "mem-N") ever appears — only "auto" and
  // the hw endpoint ids can trigger.
  expect(values.some((v) => v.startsWith("mem-"))).toBe(false);
});

test("chip updates from a gear change even while the stream is STOPPED (review #6)", async ({ app }) => {
  // No addSine/playSine here — the stream is never started, so nothing ever
  // pushes a new frame to drive the grid's usual re-feed trigger (a trace
  // seq bump). The chip must still update from the config change alone: the
  // grid's re-feed selector key must include `s.triggers` / `s.run.triggers`
  // directly, not rely on frame traffic to notice them.
  expect(await app.triggerChip("tile-2")).toBe("T off");
  await app.setTileTrigger("tile-2", { mode: "auto", edge: "rising" });
  expect(await app.triggerChip("tile-2")).toBe("T ▲ AUTO");
});

test("Arm button highlights while a SINGLE shot is armed, clears once it lands", async ({ app }) => {
  const id = await app.addSine();
  await app.playSine(id);
  await app.waitForSeries("Input L");

  // Armed but unable to fire: raise the level ABOVE the peak first, THEN
  // select SINGLE — the other order fires instantly at the default level 0
  // and the shot lands before the level change (setTileTrigger applies its
  // fields in a fixed order, mode before level).
  await app.setTileTrigger("tile-2", { levelV: 999, edge: "rising" });
  await app.setTileTrigger("tile-2", { mode: "single" });
  await expect.poll(async () => app.armHighlighted("tile-2"), { timeout: 10_000 }).toBe(true);

  // Drop the level into the signal: the shot lands and disarms.
  await app.setTileTrigger("tile-2", { levelV: 0 });
  await expect.poll(async () => app.armHighlighted("tile-2"), { timeout: 10_000 }).toBe(false);
  await expect.poll(async () => app.triggerChip("tile-2"), { timeout: 10_000 }).toMatch(/STOP/);

  // Off mode never highlights (and the button is disabled anyway).
  await app.setTileTrigger("tile-2", { mode: "off" });
  await expect.poll(async () => app.armHighlighted("tile-2"), { timeout: 5000 }).toBe(false);
});

test("the chip's quick menu sets mode and edge without opening the gear", async ({ app }) => {
  const id = await app.addSine();
  await app.playSine(id);
  await app.waitForSeries("Input L");

  await app.clickTriggerChip("tile-2");
  expect(await app.triggerMenuOpen("tile-2")).toBe(true);
  await app.clickTriggerMenuItem("tile-2", "mode-normal");
  expect(await app.triggerMenuOpen("tile-2")).toBe(false);

  await app.clickTriggerChip("tile-2");
  await app.clickTriggerMenuItem("tile-2", "edge-falling");

  const s = await app.drv.eval(
    () =>
      (
        window as unknown as {
          qa40xV2Debug: {
            state(): { triggers: Record<string, { mode: string; edge: string }> };
          };
        }
      ).qa40xV2Debug.state().triggers,
    undefined as void
  );
  expect(s["hw-in-left"].mode).toBe("normal");
  expect(s["hw-in-left"].edge).toBe("falling");
  expect(await app.triggerChip("tile-2")).toContain("▼");
});

test("right-clicking the chip opens the settings straight on the Trigger tab", async ({ app }) => {
  await app.contextClickTriggerChip("tile-2");
  // The dialog is open AND the Trigger pane is the visible one (its mode
  // select is in the DOM without any tab click).
  const paneShown = await app.drv.eval(
    () =>
      document.querySelector('[data-testid="gear-dialog"]') !== null &&
      document.querySelector('[data-testid="gear-trigger-mode"]') !== null,
    undefined as void
  );
  expect(paneShown).toBe(true);
  await app.closeDialog();
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

/**
 * Draggable marker coverage (review follow-up): the level line + right-
 * gutter "T" handle and the top-strip "▼" position handle are only
 * unit-tested at the canvas-class level (onPointerDown/Move/Up on a bare
 * ScopeChart). These three exercise the SAME gestures through the real DOM
 * — `[data-testid="tile-chart-tile-2"] canvas` — end to end into the store,
 * and pin the hit-test precedence between the position handle and an A/B
 * time marker sharing its top strip (canvas.ts's `markerSlotNear(x) < 0`
 * guard, review #11a) so a future edit can't silently swap the winner.
 *
 * Plot geometry mirrors `ScopeChart.drawStatic`'s margins (canvas.ts:
 * `this.plot = { x: 54, y: 14, w: this.w - 54 - 16, h: this.h - 14 - 32 }`)
 * — computed from the live canvas rect so the test isn't tied to a
 * particular tile size, only to those margins.
 */
function scopePlot(rect: { x: number; y: number; width: number; height: number }) {
  return {
    x: rect.x + 54,
    y: rect.y + 14,
    w: rect.width - 54 - 16,
    h: rect.height - 14 - 32,
  };
}

test("dragging the level handle moves the trigger level in the store (#26 review coverage)", async ({
  app,
}) => {
  const id = await app.addSine();
  await app.playSine(id);
  await app.waitForSeries("Input L");

  await app.setTileTrigger("tile-2", { mode: "auto", edge: "rising", levelV: 0, positionPct: 50 });
  await expect
    .poll(async () => (await app.scopeTrigger("tile-2"))?.state, { timeout: 10_000 })
    .toBe("triggered");

  const before = await app.drv.eval(
    () =>
      (
        window as unknown as {
          qa40xV2Debug: { state(): { triggers: Record<string, { levelV: number }> } };
        }
      ).qa40xV2Debug.state().triggers["hw-in-left"].levelV,
    undefined as void
  );
  expect(before).toBeCloseTo(0, 6);

  const rect = await app.chartCanvasRect("tile-2");
  const p = scopePlot(rect);
  // Grab via the right-gutter "T" handle (x independent of the current
  // level — hitTriggerLevel's gutter branch spans the whole plot height),
  // then drag UP a quarter of the plot: `valueAtY` maps a smaller y to a
  // LARGER display value, so the level must come out strictly positive.
  await app.dragOnScopeCanvas("tile-2", [
    { x: p.x + p.w + 7, y: p.y + p.h * 0.5 },
    { x: p.x + p.w + 7, y: p.y + p.h * 0.2 },
    { x: p.x + p.w + 7, y: p.y + p.h * 0.2 },
  ]);

  const after = await app.drv.eval(
    () =>
      (
        window as unknown as {
          qa40xV2Debug: { state(): { triggers: Record<string, { levelV: number }> } };
        }
      ).qa40xV2Debug.state().triggers["hw-in-left"].levelV,
    undefined as void
  );
  expect(after).toBeGreaterThan(before);
});

test("dragging the top-strip handle moves the tile's trigger position in the store (#26 review coverage)", async ({
  app,
}) => {
  const id = await app.addSine();
  await app.playSine(id);
  await app.waitForSeries("Input L");

  await app.setTileTrigger("tile-2", { mode: "auto", edge: "rising", levelV: 0, positionPct: 20 });
  await expect
    .poll(async () => (await app.scopeTrigger("tile-2"))?.state, { timeout: 10_000 })
    .toBe("triggered");

  const rect = await app.chartCanvasRect("tile-2");
  const p = scopePlot(rect);
  // Grab the "▼" handle at its current 20% position (top strip, y ≤ 12 px
  // from the plot top) and drag it to 60%.
  await app.dragOnScopeCanvas("tile-2", [
    { x: p.x + 0.2 * p.w, y: p.y + 6 },
    { x: p.x + 0.6 * p.w, y: p.y + 6 },
    { x: p.x + 0.6 * p.w, y: p.y + 6 },
  ]);

  const pct = await app.drv.eval(
    () =>
      (
        window as unknown as {
          qa40xV2Debug: {
            state(): { layout: { tiles: Record<string, { triggerPositionPct: number }> } };
          };
        }
      ).qa40xV2Debug.state().layout.tiles["tile-2"].triggerPositionPct,
    undefined as void
  );
  expect(pct).toBeCloseTo(60, 0);
});

test("an A/B marker sharing the position handle's row wins the drag, not the trigger (#26 review #11a)", async ({
  app,
}) => {
  const id = await app.addSine();
  await app.playSine(id);
  await app.waitForSeries("Input L");

  await app.setTileTrigger("tile-2", { mode: "auto", edge: "rising", levelV: 0, positionPct: 50 });
  await expect
    .poll(async () => (await app.scopeTrigger("tile-2"))?.state, { timeout: 10_000 })
    .toBe("triggered");

  const rect = await app.chartCanvasRect("tile-2");
  const p = scopePlot(rect);
  const markerX = p.x + 0.5 * p.w; // same X as the 50% position handle

  // Drop an A marker at that X, well below the top strip and away from the
  // (level 0 ⇒ mid-height) level line, so its own creation click can't be
  // shadowed by either trigger handle.
  await app.dragOnScopeCanvas("tile-2", [{ x: markerX, y: p.y + 0.75 * p.h }]);
  const before = await app.scopeMarkerRow("tile-2", "A");
  expect(before).not.toBeNull();

  // Now drag from the SAME X, but in the top strip — the row the position
  // handle claims. The marker's vertical line spans the full plot height,
  // so `markerSlotNear` must give it first refusal: this drag should move
  // the MARKER, and the trigger position must stay untouched.
  await app.dragOnScopeCanvas("tile-2", [
    { x: markerX, y: p.y + 6 },
    { x: p.x + 0.7 * p.w, y: p.y + 6 },
    { x: p.x + 0.7 * p.w, y: p.y + 6 },
  ]);

  const after = await app.scopeMarkerRow("tile-2", "A");
  expect(after).not.toBeNull();
  expect(after?.freq).not.toBe(before?.freq);

  const pct = await app.drv.eval(
    () =>
      (
        window as unknown as {
          qa40xV2Debug: {
            state(): { layout: { tiles: Record<string, { triggerPositionPct: number }> } };
          };
        }
      ).qa40xV2Debug.state().layout.tiles["tile-2"].triggerPositionPct,
    undefined as void
  );
  expect(pct).toBe(50);
});

/**
 * Wow & flutter as a PROGRAM (issue #28 second pass): it fits the exact same
 * "sweep" program shape as THD/FR — added via the "+" menu, configured via
 * the gear dialog, run with ▶ under the standard exclusive device lock,
 * stoppable with the standard ⏹, freezable (❄), and persisted with the
 * workspace. Its deviation spectrum lands as a real sweep-domain frame
 * (rate Hz, log-scaled by the chart, vs % deviation); the scalar readout
 * (weighted/unweighted %, peak, static offset) rides on the program card,
 * in a slot that's ALWAYS present (never a layout-shifting conditional row —
 * "not run yet" before, the real numbers after).
 *
 * The fake backend's `wowFlutter` stub (harness/fake-device.ts) synthesizes
 * the result a known 3150 Hz tone, FM-modulated by a 4 Hz / 0.15 %-peak wow,
 * would produce, at the SAME decimation/window/cap the real backend uses.
 * Assertions here are the PLUMBING — device lock, curve shape, persistence —
 * never the fake's exact numbers (Rule 2).
 */
import { expect, test } from "./adapter/fixtures";
import type { AppV2 } from "./adapter/app";

const BOOT_SINE = "src-sine-1";
const WF_LOCK = 'measurement "W&F 3150 Hz" is running';

async function wowSummaryText(app: AppV2, id: string): Promise<string | null> {
  return app.drv.eval(
    (a: { id: string }) => {
      const n = document.querySelector<HTMLElement>(`[data-testid="prog-wow-${a.id}"]`);
      return n ? n.textContent : null;
    },
    { id }
  );
}

async function lastTraceId(app: AppV2): Promise<string> {
  return app.drv.eval(() => {
    const dbg = (
      window as unknown as { qa40xV2Debug: { state(): { traces: { order: string[] } } } }
    ).qa40xV2Debug;
    const order = dbg.state().traces.order;
    return order[order.length - 1];
  }, undefined as void);
}

test("the gear dialog shows wow & flutter's own fields and hides THD/FR ones", async ({ app }) => {
  await app.waitConnected();
  const id = await app.addProgram("wowflutter");

  await app.drv.click(`[data-testid="prog-gear-${id}"]`);

  // Wow & flutter's own rows show...
  expect(await app.dialogRowHidden(`sweep-wowref-${id}`)).toBe(false);
  expect(await app.dialogRowHidden(`sweep-wowout-${id}`)).toBe(false);
  expect(await app.dialogRowHidden(`sweep-wowin-${id}`)).toBe(false);
  expect(await app.dialogRowHidden(`sweep-wowgen-${id}`)).toBe(false);
  expect(await app.dialogRowHidden(`sweep-duration-${id}`)).toBe(false); // shared w/ FR

  // ...THD/FR-only rows (including the generic "both/left/right" channel —
  // wow & flutter has its own independent output/input selects instead) hide.
  expect(await app.dialogRowHidden(`sweep-axis-${id}`)).toBe(true);
  expect(await app.dialogRowHidden(`sweep-start-${id}`)).toBe(true);
  expect(await app.dialogRowHidden(`sweep-end-${id}`)).toBe(true);
  expect(await app.dialogRowHidden(`sweep-level-${id}`)).toBe(true);
  expect(await app.dialogRowHidden(`sweep-points-${id}`)).toBe(true);
  expect(await app.dialogRowHidden(`sweep-metric-${id}`)).toBe(true);
  expect(await app.dialogRowHidden(`sweep-channel-${id}`)).toBe(true);

  await app.screenshot("wow-flutter-dialog");
  await app.closeDialog();
});

test("configuring the reference tone updates the program's auto-label", async ({ app }) => {
  await app.waitConnected();
  const id = await app.addProgram("wowflutter");
  expect(await app.traceLabel(id)).toBe("W&F 3150 Hz");

  await app.drv.click(`[data-testid="prog-gear-${id}"]`);
  await app.setNumber(`sweep-wowref-${id}`, 3000);
  await app.drv.click(`[data-testid="sweep-apply-${id}"]`);

  expect(await app.traceLabel(id)).toBe("W&F 3000 Hz");
});

test("running wow & flutter locks the transports by name, lands its curve, and updates the card readout without reopening anything", async ({
  app,
}) => {
  await app.waitConnected();
  await app.playSine(BOOT_SINE);
  await expect.poll(() => app.streaming(), { timeout: 15_000 }).toBe(true);
  expect(await app.sourcesLockNote()).toBeNull();

  const id = await app.addProgram("wowflutter");
  // No-layout-shift: the readout SLOT exists before any run, just empty text.
  expect(await wowSummaryText(app, id)).toBe("not run yet");

  await app.holdPrograms();
  await app.playProgram(id);
  await expect.poll(() => app.programRun(id)).toBe("running");

  // The stream was handed over BEFORE the measurement drives the device —
  // same handover every sweep program uses.
  await expect.poll(() => app.streaming()).toBe(false);
  const note = await app.sourcesLockNote();
  expect(note).toContain(WF_LOCK);
  const play = await app.playButtonState(BOOT_SINE);
  expect(play.disabled).toBe(true);
  expect(play.title).toContain(WF_LOCK);
  const run = await app.runButtonState();
  expect(run.disabled).toBe(true);
  expect(run.title).toContain(WF_LOCK);
  await app.screenshot("wow-flutter-program-lock");

  await app.releasePrograms();
  await expect.poll(() => app.programRun(id), { timeout: 10_000 }).toBe("idle");
  await expect.poll(() => app.sourcesLockNote(), { timeout: 10_000 }).toBeNull();
  await expect.poll(() => app.streaming(), { timeout: 15_000 }).toBe(true);
  expect(await app.sourcePlaying(BOOT_SINE)).toBe(true);

  // The curve landed as a sweep-domain frame: percent Y, Hz X (log-scaled
  // by the chart — the same "Hz" bucket a frequency sweep uses).
  expect(await app.traceDomains(id)).toContain("sweep");
  await app.setTileKind("sweep", "tile-1");
  await app.setTraceVisible(id, true, "tile-1");
  await expect.poll(async () => (await app.sweepSeries("tile-1")).length).toBeGreaterThan(0);
  const [series] = await app.sweepSeries("tile-1");
  expect(series.unit).toBe("%");
  // "rateHz", not "Hz" — a DIFFERENT quantity (modulation rate) from
  // stimulus frequency, with its own log-axis floor (issue #28 second-pass
  // review findings #3/#7) so a THD/FR sweep on the same tile never
  // silently shares (or clashes with) this axis.
  expect(series.xUnit).toBe("rateHz");
  expect(series.points).toBeGreaterThan(2);
  expect(series.xFirst).toBeGreaterThan(0); // the DC (0 Hz) bin is dropped

  // The scalar readout updated in place — same slot, real numbers now.
  const summary = await wowSummaryText(app, id);
  expect(summary).not.toBe("not run yet");
  expect(summary).toContain("weighted");
  expect(summary).toContain("unweighted");
  expect(summary).toContain("peak");
  expect(summary).toContain("offset");
  await app.screenshot("wow-flutter-program-result");

  // Freeze ❄ — the "figer/comparer" use case (before/after a belt change,
  // deck A vs deck B): a named, comparable snapshot of this exact result.
  await app.drv.click(`[data-testid="prog-freeze-${id}"]`);
  const frozenId = await lastTraceId(app);
  expect(frozenId).not.toBe(id);
  await app.setTraceVisible(frozenId, true, "tile-1");
  const frozenLabel = await app.traceLabel(frozenId);
  await expect
    .poll(async () => (await app.sweepSeries("tile-1")).some((s) => s.label === frozenLabel))
    .toBe(true);
});

test("Stop cancels an in-flight wow & flutter run, and the session resumes", async ({ app }) => {
  await app.waitConnected();
  await app.playSine(BOOT_SINE);
  await expect.poll(() => app.streaming(), { timeout: 15_000 }).toBe(true);

  const id = await app.addProgram("wowflutter");
  await app.holdPrograms();
  await app.playProgram(id);
  await expect.poll(() => app.programRun(id)).toBe("running");
  await expect.poll(() => app.streaming()).toBe(false);

  // ⏹ is the SAME button, now toggled — the standard program stop, wired
  // to sweep_stop (the backend cancel this measurement already supports).
  await app.drv.click(`[data-testid="prog-play-${id}"]`);

  await expect.poll(() => app.programRun(id), { timeout: 10_000 }).toBe("idle");
  await expect.poll(() => app.sourcesLockNote(), { timeout: 10_000 }).toBeNull();
  await expect.poll(() => app.streaming(), { timeout: 15_000 }).toBe(true);
  expect(await app.sourcePlaying(BOOT_SINE)).toBe(true);
  expect(await app.toastCount("stopped")).toBeGreaterThan(0);
});

test("save → load round-trips a wow & flutter program's configuration, and a frozen result survives", async ({
  app,
}) => {
  await app.waitConnected();
  const id = await app.addProgram("wowflutter");
  await app.drv.click(`[data-testid="prog-gear-${id}"]`);
  await app.setNumber(`sweep-wowref-${id}`, 3000);
  await app.drv.click(`[data-testid="sweep-apply-${id}"]`);

  await app.holdPrograms();
  await app.playProgram(id);
  await expect.poll(() => app.programRun(id)).toBe("running");
  await app.releasePrograms();
  await expect.poll(() => app.programRun(id), { timeout: 10_000 }).toBe("idle");

  await app.drv.click(`[data-testid="prog-freeze-${id}"]`);
  const frozenId = await lastTraceId(app);
  await app.setTileKind("sweep", "tile-1");
  await app.setTraceVisible(frozenId, true, "tile-1");
  await expect.poll(async () => (await app.sweepSeries("tile-1")).length).toBeGreaterThan(0);
  const beforeSeries = (await app.sweepSeries("tile-1"))[0];
  const beforePoints = beforeSeries.points;
  // The frozen trace has NO originating program anymore to derive its unit
  // from (freezeTrace makes a program-less `memory` trace) — this is only
  // "%" here because the unit rides ON THE FRAME (issue #28 second-pass
  // review finding #5), asserted again after reload below.
  expect(beforeSeries.unit).toBe("%");
  expect(beforeSeries.xUnit).toBe("rateHz");

  await app.saveWorkspaceAs("e2e wow-flutter round-trip");
  const before = await app.workspaceDigest();

  await app.loadWorkspace("Quick THD Check", "template");
  expect(await app.workspaceDigest()).not.toEqual(before);

  await app.loadWorkspace("e2e wow-flutter round-trip", "saved");
  expect(await app.workspaceDigest()).toEqual(before);

  // The program's configuration (its own reference frequency) survived...
  expect(await app.traceLabel(id)).toBe("W&F 3000 Hz");
  // ...and the FROZEN result's curve data survived too (refFrames — a live
  // program's own result does NOT persist its data, only a frozen copy
  // does, same rule as THD/FR) — INCLUDING its "%" y-unit and "rateHz"
  // x-unit, which used to fall back to "dB"/"Hz" once the frozen trace's
  // program was out of the picture (findings #3/#5).
  await expect.poll(async () => (await app.sweepSeries("tile-1")).length).toBeGreaterThan(0);
  const afterSeries = (await app.sweepSeries("tile-1"))[0];
  expect(afterSeries.points).toBe(beforePoints);
  expect(afterSeries.unit).toBe("%");
  expect(afterSeries.xUnit).toBe("rateHz");
});

test("the sweep-only W&F trace is offered only on a sweep tile's + picker; a blank hardware endpoint stays offered everywhere (issue #28 second-pass review finding #9)", async ({
  app,
}) => {
  await app.waitConnected();
  const id = await app.addProgram("wowflutter");
  await app.holdPrograms();
  await app.playProgram(id);
  await expect.poll(() => app.programRun(id)).toBe("running");
  await app.releasePrograms();
  await expect.poll(() => app.programRun(id), { timeout: 10_000 }).toBe("idle");
  expect(await app.traceDomains(id)).toEqual(["sweep"]);

  // Default 2×2 boot layout: tile-1 spectrum, tile-2 scope (grid.pw.ts),
  // each already showing "Input L" — pick "Input R" instead, a candidate
  // that's NOT yet a member anywhere and has streamed nothing (domains
  // still empty), to prove the domain-less exception.
  const HW_IN_R = "hw-in-right";
  expect(await app.addTraceOptions("tile-1")).not.toContain(id);
  expect(await app.addTraceOptions("tile-1")).toContain(HW_IN_R);
  expect(await app.addTraceOptions("tile-2")).not.toContain(id);
  expect(await app.addTraceOptions("tile-2")).toContain(HW_IN_R);

  await app.setTileKind("sweep", "tile-1");
  expect(await app.addTraceOptions("tile-1")).toContain(id);
  expect(await app.addTraceOptions("tile-1")).toContain(HW_IN_R); // domain-less: everywhere
});

test("two wow & flutter programs land on ONE tile together — the A/B comparison use case (deck A vs deck B, before/after a belt change)", async ({
  app,
}) => {
  // The central reason wow & flutter is a full program (not the old
  // one-shot dialog): two independent runs, each kept as its own program
  // card, shown side by side on the SAME sweep tile. Both share the exact
  // same axis semantic (rateHz / %), so unlike a frequency-vs-level THD mix
  // (thd-level-sweep.pw.ts review finding #3) NEITHER is omitted.
  await app.waitConnected();

  const idA = await app.addProgram("wowflutter"); // default "W&F 3150 Hz"
  await app.holdPrograms();
  await app.playProgram(idA);
  await expect.poll(() => app.programRun(idA)).toBe("running");
  await app.releasePrograms();
  await expect.poll(() => app.programRun(idA), { timeout: 10_000 }).toBe("idle");

  const idB = await app.addProgram("wowflutter");
  await app.drv.click(`[data-testid="prog-gear-${idB}"]`);
  await app.setNumber(`sweep-wowref-${idB}`, 1000);
  await app.drv.click(`[data-testid="sweep-apply-${idB}"]`); // "W&F 1000 Hz"
  await app.holdPrograms();
  await app.playProgram(idB);
  await expect.poll(() => app.programRun(idB)).toBe("running");
  await app.releasePrograms();
  await expect.poll(() => app.programRun(idB), { timeout: 10_000 }).toBe("idle");

  await app.setTileKind("sweep", "tile-1");
  await app.setTraceVisible(idA, true, "tile-1");
  await app.setTraceVisible(idB, true, "tile-1");

  await expect.poll(async () => (await app.sweepSeries("tile-1")).length).toBe(2);
  const series = await app.sweepSeries("tile-1");
  expect(series.every((s) => s.xUnit === "rateHz")).toBe(true);
  expect(series.every((s) => s.unit === "%")).toBe(true);
  const labels = series.map((s) => s.label).sort();
  expect(labels).toEqual([await app.traceLabel(idA), await app.traceLabel(idB)].sort());

  // Neither trace's legend chip is marked as an axis mismatch — the omitted
  // path (thd-level-sweep.pw.ts) never engages for two same-axis W&F runs.
  const mismatch = await app.drv.eval(
    (x: { tileId: string; a: string; b: string }) => {
      const cls = (id: string) =>
        document
          .querySelector(`[data-testid="tile-trace-${x.tileId}-${id}"]`)
          ?.classList.contains("tile__trace--axis-mismatch") ?? null;
      return { a: cls(x.a), b: cls(x.b) };
    },
    { tileId: "tile-1", a: idA, b: idB }
  );
  expect(mismatch.a).toBe(false);
  expect(mismatch.b).toBe(false);

  await app.screenshot("wow-flutter-two-programs-one-tile");
});

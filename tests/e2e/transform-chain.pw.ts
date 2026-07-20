/**
 * Transform-trace plumbing (M4): + fx → chain dialog → backend
 * apply_transform_chain → frames cache → spectrum view-model. The fake's
 * chain is an IDENTITY (it does no DSP) — assert the plumbing (the derived
 * trace exists, recomputes from its input, reaches the chart feed), never
 * transformed values (those are the Rust dashboard.rs tests' job).
 */
import { expect, test } from "./adapter/fixtures";

const BOOT_SINE = "src-sine-1";

test("a transform endpoint derives from its input and reaches the spectrum VM", async ({
  app,
}) => {
  await app.waitConnected();
  await app.playSine(BOOT_SINE); // auto-starts the stream
  await app.waitForSeries("Input L", 1);

  // + fx opens the chain dialog on a fresh endpoint (input: Input L).
  await app.drv.click('[data-testid="btn-add-transform"]');
  const fx = await app.drv.eval(() => {
    const dbg = (
      window as unknown as {
        qa40xV2Debug: { state(): { traces: { order: string[] } } };
      }
    ).qa40xV2Debug;
    const order = dbg.state().traces.order;
    return order[order.length - 1];
  }, undefined as void);

  // Pick A-weighting so the chain is non-trivial (a real backend round
  // trip, not the synchronous identity copy) and Apply.
  await app.setSelect(`fx-weighting-${fx}`, "a");
  await app.drv.click(`[data-testid="fx-apply-${fx}"]`);

  // The label follows the chain; the endpoint recomputes on live frames.
  await expect
    .poll(async () => {
      const rows = await app.poolRows();
      return rows.some((r) => r.id === fx && r.label === "A-weighted");
    })
    .toBe(true);

  // Show it on the first spectrum tile: the derived curve reaches the VM
  // and keeps refreshing with its input.
  await app.setTraceVisible(fx, true, "tile-1");
  await app.waitForSeries("A-weighted", 1);
  await expect.poll(() => app.traceDomains(fx)).toContain("fd");
  const before = await app.maxSeriesSeq();
  await app.waitForSeries("A-weighted", before + 1); // still live, not a one-shot
});

test("＋wt on a trace row creates the same weighted-copy transform, no dialog", async ({
  app,
}) => {
  await app.waitConnected();
  await app.playSine(BOOT_SINE);
  await app.waitForSeries("Input L", 1);

  // The one-click shortcut on the Input L row (M6 discoverability).
  await app.setSelect("trace-wt-hw-in-left", "a");

  // Same transform model as + transform: a derived endpoint, auto-labelled
  // with its source, computed by the backend chain on live frames.
  await expect
    .poll(async () => {
      const rows = await app.poolRows();
      return rows.some((r) => r.label === "A-weighted (Input L)");
    })
    .toBe(true);
  const fx = await app.drv.eval(() => {
    const dbg = (
      window as unknown as {
        qa40xV2Debug: { state(): { traces: { order: string[] } } };
      }
    ).qa40xV2Debug;
    const order = dbg.state().traces.order;
    return order[order.length - 1];
  }, undefined as void);
  await expect.poll(() => app.traceDomains(fx)).toContain("fd");
});

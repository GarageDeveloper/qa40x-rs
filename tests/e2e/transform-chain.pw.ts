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

/** Full `AppState` slices this spec reads back via the debug hook — kept
 * narrow (never the whole state type) so the eval stays self-contained. */
interface DebugState {
  traces: {
    byId: Record<
      string,
      { source: { kind: string; steps?: { type: string; mode?: string; curve?: unknown }[] } }
    >;
  };
  weighting: { userCurve: { freqs: number[]; gains: number[] } | null };
}

test("User curve…: CSV import → workspace curve → embedded in the weighting step", async ({
  app,
}) => {
  await app.waitConnected();
  await app.playSine(BOOT_SINE);
  await app.waitForSeries("Input L", 1);

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

  // No curve loaded yet — the readout is always present (no layout shift),
  // just says so.
  await expect(app.drv.text(`[data-testid="fx-usercurve-status-${fx}"]`)).resolves.toBe(
    "No curve loaded"
  );

  // Deliberately do NOT touch the weighting select first: a successful
  // import must flip it to "user" by itself (field-tested — importing with
  // the select left on "None" used to Apply an unweighted identity chain
  // with no error, and the two curves sat exactly on top of each other).

  // Import a simple "freq_hz, gain_db" CSV through the real file input (a
  // File + change event — the harness never Playwright-shortcuts around a
  // component's own event wiring).
  await app.drv.eval(
    (a: { testid: string; csv: string }) => {
      const input = document.querySelector(
        `[data-testid="${a.testid}"]`
      ) as HTMLInputElement;
      const file = new File([a.csv], "my-curve.csv", { type: "text/csv" });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { testid: `fx-usercurve-file-${fx}`, csv: "100,0\n1000,12\n10000,-3\n" }
  );

  // The status readout updates once the (async) file read resolves.
  await expect
    .poll(() => app.drv.text(`[data-testid="fx-usercurve-status-${fx}"]`))
    .toBe('"my-curve.csv": 3 points, 100 Hz–10 kHz');

  // …and the weighting select auto-flipped to "User curve…".
  const selectedWeighting = await app.drv.eval(
    (testid: string) =>
      (document.querySelector(`[data-testid="${testid}"]`) as HTMLSelectElement).value,
    `fx-weighting-${fx}`
  );
  expect(selectedWeighting).toBe("user");

  // STAGED, not yet committed (review finding #7): a mere file pick must
  // NOT touch the bench's workspace-persisted curve (and so must not touch
  // the auto-save) before Apply.
  const curveLenBeforeApply = await app.drv.eval(() => {
    const dbg = (window as unknown as { qa40xV2Debug: { state(): DebugState } }).qa40xV2Debug;
    return dbg.state().weighting.userCurve?.freqs.length ?? null;
  }, undefined as void);
  expect(curveLenBeforeApply).toBeNull();

  await app.drv.click(`[data-testid="fx-apply-${fx}"]`);

  // NOW it lands in the workspace slice (issue #29 — per-workspace, never
  // a device-keyed global).
  await expect
    .poll(() =>
      app.drv.eval(() => {
        const dbg = (
          window as unknown as { qa40xV2Debug: { state(): DebugState } }
        ).qa40xV2Debug;
        return dbg.state().weighting.userCurve?.freqs.length ?? null;
      }, undefined as void)
    )
    .toBe(3);

  // The label follows the "user" chain, and the step embeds a CURVE
  // SNAPSHOT — not just a mode flag (dashboard.rs applies it per-step, no
  // module-global weighting state, issue #25).
  await expect
    .poll(async () => {
      const rows = await app.poolRows();
      return rows.some((r) => r.id === fx && r.label === "User-weighted");
    })
    .toBe(true);

  const step = await app.drv.eval(
    (id: string) => {
      const dbg = (
        window as unknown as { qa40xV2Debug: { state(): DebugState } }
      ).qa40xV2Debug;
      const steps = dbg.state().traces.byId[id]?.source.steps ?? [];
      return steps.find((s) => s.type === "weighting") ?? null;
    },
    fx
  );
  expect(step?.mode).toBe("user");
  expect(
    (step?.curve as { freqs: number[]; gains: number[] } | undefined)?.freqs
  ).toEqual([100, 1000, 10000]);
});

test("User curve… with nothing imported refuses Apply instead of silently dropping the weighting (review finding #6)", async ({
  app,
}) => {
  await app.waitConnected();
  await app.playSine(BOOT_SINE);
  await app.waitForSeries("Input L", 1);

  await app.drv.click('[data-testid="btn-add-transform"]');
  const fx = await app.drv.eval(() => {
    const dbg = (
      window as unknown as { qa40xV2Debug: { state(): { traces: { order: string[] } } } }
    ).qa40xV2Debug;
    const order = dbg.state().traces.order;
    return order[order.length - 1];
  }, undefined as void);

  await app.setSelect(`fx-weighting-${fx}`, "user");
  // No file ever picked in this dialog session — Apply must refuse rather
  // than silently create an unweighted (Z) transform under the "user" label.
  await app.drv.click(`[data-testid="fx-apply-${fx}"]`);

  // The dialog stayed open (Apply was refused): the trace is still the
  // untouched fresh endpoint, never labelled "User-weighted".
  const rows = await app.poolRows();
  expect(rows.some((r) => r.id === fx && r.label === "User-weighted")).toBe(false);
  await expect(app.drv.text(`[data-testid="fx-apply-${fx}"]`)).resolves.toBe("Apply");
});

test("Cancel never commits a staged curve to the bench (review finding #7)", async ({ app }) => {
  await app.waitConnected();
  await app.playSine(BOOT_SINE);
  await app.waitForSeries("Input L", 1);

  await app.drv.click('[data-testid="btn-add-transform"]');
  const fx = await app.drv.eval(() => {
    const dbg = (
      window as unknown as { qa40xV2Debug: { state(): { traces: { order: string[] } } } }
    ).qa40xV2Debug;
    const order = dbg.state().traces.order;
    return order[order.length - 1];
  }, undefined as void);

  await app.setSelect(`fx-weighting-${fx}`, "user");
  await app.drv.eval(
    (a: { testid: string; csv: string }) => {
      const input = document.querySelector(`[data-testid="${a.testid}"]`) as HTMLInputElement;
      const file = new File([a.csv], "cancelled-curve.csv", { type: "text/csv" });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { testid: `fx-usercurve-file-${fx}`, csv: "100,0\n1000,12\n" }
  );
  await expect
    .poll(() => app.drv.text(`[data-testid="fx-usercurve-status-${fx}"]`))
    .toBe('"cancelled-curve.csv": 2 points, 100 Hz–1 kHz');

  // Cancel, not Apply.
  await app.drv.clickByText(".dialog__foot button", "Cancel");

  const curveAfterCancel = await app.drv.eval(() => {
    const dbg = (
      window as unknown as { qa40xV2Debug: { state(): DebugState } }
    ).qa40xV2Debug;
    return dbg.state().weighting.userCurve;
  }, undefined as void);
  expect(curveAfterCancel).toBeNull();
});

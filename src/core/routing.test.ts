// Port of the mixer.test.ts routing-matrix invariants (M2).
import { describe, expect, it } from "vitest";
import type { SourceRoute, SourceTarget } from "../store/state";
import {
  routeChecks,
  routeFromChecks,
  sourceRouting,
  unionRoutes,
  writeTarget,
} from "./routing";

/** A cell with the I2S dimension defaulted off — most invariants below are
 * about the Line-out dimension and predate issue #71. */
function cell(slot: number | null, route: SourceRoute, i2sRoute: SourceRoute = "off"): SourceTarget {
  return { slot, route, i2sRoute };
}

describe("routing matrix: route ↔ Out L / Out R checkboxes", () => {
  it("maps every check pair to its route, and back (a bijection)", () => {
    const cases: [boolean, boolean, SourceRoute][] = [
      [true, true, "both"],
      [true, false, "left"],
      [false, true, "right"],
      [false, false, "off"],
    ];
    for (const [left, right, route] of cases) {
      expect(routeFromChecks(left, right)).toBe(route);
      expect(routeChecks(route)).toEqual({ left, right });
    }
  });

  it("unchecking both boxes is the UI's one path to the backend Off route", () => {
    // Off is backend-complete (the mixer skips the render); the matrix is
    // what makes it reachable.
    expect(routeFromChecks(false, false)).toBe("off");
  });
});

describe("sourceRouting — the device × channel matrix's one read path (issue #25 lot F2)", () => {
  it("empty targets materialize as the implicit focus-following target carrying BOTH legacy routes", () => {
    for (const route of ["left", "right", "both", "off"] as const) {
      expect(sourceRouting({ route, i2sRoute: "off", targets: [] })).toEqual([
        { slot: null, route, i2sRoute: "off" },
      ]);
      // The I2S half rides the same implicit cell (issue #71).
      expect(sourceRouting({ route: "off", i2sRoute: route, targets: [] })).toEqual([
        { slot: null, route: "off", i2sRoute: route },
      ]);
    }
  });

  it("non-empty targets pass through untouched and the legacy routes are ignored", () => {
    const targets: SourceTarget[] = [cell(0, "left"), cell(2, "both", "left")];
    const out = sourceRouting({ route: "right", i2sRoute: "both", targets });
    expect(out).toBe(targets); // same reference: no per-call allocation
    expect(out.some((t) => t.route === "right")).toBe(false);
  });

  it("is idempotent over its own materialization", () => {
    const once = sourceRouting({ route: "left", i2sRoute: "off", targets: [] });
    expect(sourceRouting({ route: "off", i2sRoute: "off", targets: once })).toBe(once);
  });
});

describe("writeTarget — the matrix's one write path (issue #25 lot F3)", () => {
  const CAP = 9;

  it("adding a slot cell to the legacy compact form makes the implicit focus cell explicit", () => {
    expect(
      writeTarget({ route: "left", i2sRoute: "off", targets: [] }, 1, { route: "right" }, CAP)
    ).toEqual({
      route: "left",
      i2sRoute: "off",
      targets: [cell(null, "left"), cell(1, "right")],
    });
  });

  it("updates an existing cell in place — order kept", () => {
    const src = {
      route: "left" as const,
      i2sRoute: "off" as const,
      targets: [cell(null, "both"), cell(1, "left")],
    };
    expect(writeTarget(src, 1, { route: "both" }, CAP).targets).toEqual([
      cell(null, "both"),
      cell(1, "both"),
    ]);
  });

  it("a Line-out edit preserves the cell's I2S half and vice versa (issue #71 partial patch)", () => {
    const src = {
      route: "left" as const,
      i2sRoute: "off" as const,
      targets: [cell(1, "left", "both")],
    };
    // Editing the Line dimension leaves I2S untouched…
    expect(writeTarget(src, 1, { route: "right" }, CAP).targets).toEqual([
      cell(1, "right", "both"),
    ]);
    // …and editing I2S leaves Line untouched.
    expect(writeTarget(src, 1, { i2sRoute: "left" }, CAP).targets).toEqual([
      cell(1, "left", "left"),
    ]);
  });

  it("a patch that CREATES a cell fills the unnamed dimension off", () => {
    const start = { route: "off" as const, i2sRoute: "off" as const, targets: [] };
    const out = writeTarget(start, 1, { i2sRoute: "both" }, CAP);
    expect(out.targets).toContainEqual(cell(1, "off", "both"));
  });

  it("an 'off' write KEEPS the cell (silent DAC program); only null removes it", () => {
    const src = {
      route: "left" as const,
      i2sRoute: "off" as const,
      targets: [cell(null, "left"), cell(1, "both")],
    };
    const off = writeTarget(src, 1, { route: "off" }, CAP);
    expect(off.targets).toContainEqual(cell(1, "off"));
    const gone = writeTarget(src, 1, null, CAP);
    expect(gone).toEqual({ route: "left", i2sRoute: "off", targets: [] }); // focus-only ⇒ compacted
  });

  it("a matrix of exactly one focus cell compacts back to the legacy form (round trip)", () => {
    const start = { route: "left" as const, i2sRoute: "off" as const, targets: [] };
    const widened = writeTarget(start, 1, { route: "right" }, CAP);
    const shrunk = writeTarget(widened, 1, null, CAP);
    expect(shrunk).toEqual(start);
    // The compact routes follow the focus CELL's current values, not history
    // — the I2S half included (issue #71).
    const retoned = writeTarget(widened, null, { route: "both", i2sRoute: "left" }, CAP);
    expect(writeTarget(retoned, 1, null, CAP)).toEqual({
      route: "both",
      i2sRoute: "left",
      targets: [],
    });
  });

  it("removing the LAST cell stores the silent legacy form", () => {
    const src = {
      route: "left" as const,
      i2sRoute: "both" as const,
      targets: [cell(2, "both", "left")],
    };
    expect(writeTarget(src, 2, null, CAP)).toEqual({
      route: "off",
      i2sRoute: "off",
      targets: [],
    });
  });

  it("a doc-loaded Off cell on another slot survives edits that don't touch it", () => {
    const src = {
      route: "left" as const,
      i2sRoute: "off" as const,
      targets: [cell(1, "off")],
    };
    const out = writeTarget(src, null, { route: "both" }, CAP);
    expect(out.targets).toEqual([cell(1, "off"), cell(null, "both")]);
  });

  it("removing a cell the matrix never had is a no-op in content", () => {
    const src = {
      route: "left" as const,
      i2sRoute: "off" as const,
      targets: [cell(null, "left"), cell(1, "both")],
    };
    expect(writeTarget(src, 7, null, CAP)).toEqual(src);
  });

  it("cell creation beyond the cap is refused unchanged (the sanitizer's cap-9 rule)", () => {
    const full = {
      route: "left" as const,
      i2sRoute: "off" as const,
      targets: Array.from({ length: 9 }, (_, i) => cell(i, "left")),
    };
    expect(writeTarget(full, 42, { route: "both" }, 9)).toEqual(full);
    // Updating an EXISTING cell at the cap still works.
    expect(writeTarget(full, 0, { route: "both" }, 9).targets[0]).toEqual(cell(0, "both"));
  });

  describe("canonical-form invariants over an exhaustive small matrix (create/update/remove × {null,0,1,2} × every route)", () => {
    // Every reachable op from every reachable start: a lone focus cell never
    // survives as an explicit target, an empty cell set is never stored as
    // `targets: []` alongside a stale non-off `route` remnant of another
    // path, and no two cells ever name the same slot (dedupe holds under
    // repeated updates in place).
    const SLOTS: (number | null)[] = [null, 0, 1, 2];
    const ROUTES: SourceRoute[] = ["left", "right", "both", "off"];
    const WRITES: ({ route?: SourceRoute; i2sRoute?: SourceRoute } | null)[] = [
      ...ROUTES.map((route) => ({ route })),
      ...ROUTES.map((i2sRoute) => ({ i2sRoute })),
      null,
    ];

    function assertCanonical(out: {
      route: SourceRoute;
      i2sRoute: SourceRoute;
      targets: SourceTarget[];
    }): void {
      // Never a lone focus cell in explicit targets — it must have compacted.
      expect(
        out.targets.length === 1 && out.targets[0].slot === null
      ).toBe(false);
      // Never a non-empty length with every cell somehow absent (structural
      // sanity: every entry is a real, present cell object).
      for (const t of out.targets) {
        expect(t).toHaveProperty("slot");
        expect(ROUTES).toContain(t.route);
        expect(ROUTES).toContain(t.i2sRoute);
      }
      // Dedupe: no two cells claim the same slot.
      const slots = out.targets.map((t) => t.slot);
      expect(new Set(slots).size).toBe(slots.length);
    }

    it("every single-op result from the empty legacy start is canonical", () => {
      for (const route of ROUTES) {
        for (const slot of SLOTS) {
          for (const write of WRITES) {
            const start = { route, i2sRoute: "off" as const, targets: [] as SourceTarget[] };
            assertCanonical(writeTarget(start, slot, write, 9));
          }
        }
      }
    });

    it("every op composed onto a 2-cell matrix (focus + slot 1) stays canonical, incl. the all-removed case", () => {
      const base: { route: SourceRoute; i2sRoute: SourceRoute; targets: SourceTarget[] } = {
        route: "left",
        i2sRoute: "off",
        targets: [cell(null, "left"), cell(1, "right", "both")],
      };
      for (const slot of SLOTS) {
        for (const write of WRITES) {
          assertCanonical(writeTarget(base, slot, write, 9));
        }
      }
      // Removing BOTH cells in sequence lands on the fully-silent compact
      // form, never a stray `targets: []` with a leftover truthy route.
      const oneGone = writeTarget(base, null, null, 9);
      const allGone = writeTarget(oneGone, 1, null, 9);
      expect(allGone).toEqual({ route: "off", i2sRoute: "off", targets: [] });
    });

    it("updating a cell in place never changes the slot set (no accidental duplicate)", () => {
      const base: { route: SourceRoute; i2sRoute: SourceRoute; targets: SourceTarget[] } = {
        route: "left",
        i2sRoute: "off",
        targets: [cell(0, "left"), cell(2, "both")],
      };
      for (const slot of [0, 2]) {
        for (const route of ROUTES) {
          const out = writeTarget(base, slot, { route }, 9);
          expect(out.targets.map((t) => t.slot).sort()).toEqual([0, 2]);
        }
      }
    });
  });
});

describe("unionRoutes — cell-wise OR (the coalescing rule for one source resolving twice onto one session)", () => {
  it("matches the full truth table incl. off as the identity", () => {
    const all: SourceRoute[] = ["left", "right", "both", "off"];
    for (const a of all) {
      expect(unionRoutes(a, "off")).toBe(a);
      expect(unionRoutes("off", a)).toBe(a);
      expect(unionRoutes(a, "both")).toBe("both");
      expect(unionRoutes(a, a)).toBe(a);
    }
    expect(unionRoutes("left", "right")).toBe("both");
    expect(unionRoutes("right", "left")).toBe("both");
  });
});

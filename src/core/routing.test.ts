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
  it("empty targets materialize as the implicit focus-following target carrying the legacy route", () => {
    for (const route of ["left", "right", "both", "off"] as const) {
      expect(sourceRouting({ route, targets: [] })).toEqual([{ slot: null, route }]);
    }
  });

  it("non-empty targets pass through untouched and the legacy route is ignored", () => {
    const targets: SourceTarget[] = [
      { slot: 0, route: "left" },
      { slot: 2, route: "both" },
    ];
    const out = sourceRouting({ route: "right", targets });
    expect(out).toBe(targets); // same reference: no per-call allocation
    expect(out.some((t) => t.route === "right")).toBe(false);
  });

  it("is idempotent over its own materialization", () => {
    const once = sourceRouting({ route: "left", targets: [] });
    expect(sourceRouting({ route: "off", targets: once })).toBe(once);
  });
});

describe("writeTarget — the matrix's one write path (issue #25 lot F3)", () => {
  const CAP = 9;

  it("adding a slot cell to the legacy compact form makes the implicit focus cell explicit", () => {
    expect(writeTarget({ route: "left", targets: [] }, 1, "right", CAP)).toEqual({
      route: "left",
      targets: [
        { slot: null, route: "left" },
        { slot: 1, route: "right" },
      ],
    });
  });

  it("updates an existing cell in place — order kept", () => {
    const src = {
      route: "left" as const,
      targets: [
        { slot: null, route: "both" as const },
        { slot: 1, route: "left" as const },
      ],
    };
    expect(writeTarget(src, 1, "both", CAP).targets).toEqual([
      { slot: null, route: "both" },
      { slot: 1, route: "both" },
    ]);
  });

  it("an 'off' write KEEPS the cell (silent DAC program); only null removes it", () => {
    const src = {
      route: "left" as const,
      targets: [
        { slot: null, route: "left" as const },
        { slot: 1, route: "both" as const },
      ],
    };
    const off = writeTarget(src, 1, "off", CAP);
    expect(off.targets).toContainEqual({ slot: 1, route: "off" });
    const gone = writeTarget(src, 1, null, CAP);
    expect(gone).toEqual({ route: "left", targets: [] }); // focus-only ⇒ compacted
  });

  it("a matrix of exactly one focus cell compacts back to the legacy form (round trip)", () => {
    const start = { route: "left" as const, targets: [] };
    const widened = writeTarget(start, 1, "right", CAP);
    const shrunk = writeTarget(widened, 1, null, CAP);
    expect(shrunk).toEqual(start);
    // The compact route follows the focus CELL's current value, not history.
    const retoned = writeTarget(widened, null, "both", CAP);
    expect(writeTarget(retoned, 1, null, CAP)).toEqual({ route: "both", targets: [] });
  });

  it("removing the LAST cell stores the silent legacy form", () => {
    const src = { route: "left" as const, targets: [{ slot: 2, route: "both" as const }] };
    expect(writeTarget(src, 2, null, CAP)).toEqual({ route: "off", targets: [] });
  });

  it("a doc-loaded Off cell on another slot survives edits that don't touch it", () => {
    const src = { route: "left" as const, targets: [{ slot: 1, route: "off" as const }] };
    const out = writeTarget(src, null, "both", CAP);
    expect(out.targets).toEqual([
      { slot: 1, route: "off" },
      { slot: null, route: "both" },
    ]);
  });

  it("removing a cell the matrix never had is a no-op in content", () => {
    const src = {
      route: "left" as const,
      targets: [
        { slot: null, route: "left" as const },
        { slot: 1, route: "both" as const },
      ],
    };
    expect(writeTarget(src, 7, null, CAP)).toEqual(src);
  });

  it("cell creation beyond the cap is refused unchanged (the sanitizer's cap-9 rule)", () => {
    const full = {
      route: "left" as const,
      targets: Array.from({ length: 9 }, (_, i) => ({
        slot: i,
        route: "left" as const,
      })),
    };
    expect(writeTarget(full, 42, "both", 9)).toEqual(full);
    // Updating an EXISTING cell at the cap still works.
    expect(writeTarget(full, 0, "both", 9).targets[0]).toEqual({ slot: 0, route: "both" });
  });

  describe("canonical-form invariants over an exhaustive small matrix (create/update/remove × {null,0,1,2} × every route)", () => {
    // Every reachable op from every reachable start: a lone focus cell never
    // survives as an explicit target, an empty cell set is never stored as
    // `targets: []` alongside a stale non-off `route` remnant of another
    // path, and no two cells ever name the same slot (dedupe holds under
    // repeated updates in place).
    const SLOTS: (number | null)[] = [null, 0, 1, 2];
    const ROUTES: SourceRoute[] = ["left", "right", "both", "off"];
    const WRITES: (SourceRoute | null)[] = [...ROUTES, null];

    function assertCanonical(out: { route: SourceRoute; targets: SourceTarget[] }): void {
      // Never a lone focus cell in explicit targets — it must have compacted.
      expect(
        out.targets.length === 1 && out.targets[0].slot === null
      ).toBe(false);
      // Never a non-empty length with every cell somehow absent (structural
      // sanity: every entry is a real, present cell object).
      for (const t of out.targets) {
        expect(t).toHaveProperty("slot");
        expect(ROUTES).toContain(t.route);
      }
      // Dedupe: no two cells claim the same slot.
      const slots = out.targets.map((t) => t.slot);
      expect(new Set(slots).size).toBe(slots.length);
    }

    it("every single-op result from the empty legacy start is canonical", () => {
      for (const route of ROUTES) {
        for (const slot of SLOTS) {
          for (const write of WRITES) {
            const start = { route, targets: [] as SourceTarget[] };
            assertCanonical(writeTarget(start, slot, write, 9));
          }
        }
      }
    });

    it("every op composed onto a 2-cell matrix (focus + slot 1) stays canonical, incl. the all-removed case", () => {
      const base: { route: SourceRoute; targets: SourceTarget[] } = {
        route: "left",
        targets: [
          { slot: null, route: "left" },
          { slot: 1, route: "right" },
        ],
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
      expect(allGone).toEqual({ route: "off", targets: [] });
    });

    it("updating a cell in place never changes the slot set (no accidental duplicate)", () => {
      const base: { route: SourceRoute; targets: SourceTarget[] } = {
        route: "left",
        targets: [
          { slot: 0, route: "left" },
          { slot: 2, route: "both" },
        ],
      };
      for (const slot of [0, 2]) {
        for (const route of ROUTES) {
          const out = writeTarget(base, slot, route, 9);
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

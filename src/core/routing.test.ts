// Port of the mixer.test.ts routing-matrix invariants (M2).
import { describe, expect, it } from "vitest";
import type { SourceRoute, SourceTarget } from "../store/state";
import { routeChecks, routeFromChecks, sourceRouting, unionRoutes } from "./routing";

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

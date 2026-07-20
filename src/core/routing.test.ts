// Port of the mixer.test.ts routing-matrix invariants (M2).
import { describe, expect, it } from "vitest";
import type { SourceRoute } from "../store/state";
import { routeChecks, routeFromChecks } from "./routing";

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

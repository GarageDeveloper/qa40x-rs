/**
 * The routing matrix bijection: a source's two Out L / Out R checkboxes ↔ its
 * route. Unchecking both is "off" — the only UI path to the backend's Off
 * route: the source stays defined and playing but contributes nothing to the
 * sum (maintainer-preferred over a dropdown; never regress to a select).
 */
import type { SourceRoute, SourceTarget } from "../store/state";

export function routeFromChecks(left: boolean, right: boolean): SourceRoute {
  return left && right ? "both" : left ? "left" : right ? "right" : "off";
}

export function routeChecks(route: SourceRoute): { left: boolean; right: boolean } {
  return {
    left: route === "left" || route === "both",
    right: route === "right" || route === "both",
  };
}

/**
 * A source's routing matrix, materialized (issue #25 lot F2): the explicit
 * `targets` when any exist, else the implicit focus-following target built
 * from the legacy `route` field — `targets.length` is the tag of that
 * two-state union (see `SourceBase` in store/state.ts). This is the ONE
 * read path for "where does this source go"; reading `route` beside a
 * non-empty `targets` is a bug.
 *
 * Structural parameter (not `SourceMeta`): core/ stays type-only over the
 * store.
 */
export function sourceRouting(src: {
  route: SourceRoute;
  targets: SourceTarget[];
}): SourceTarget[] {
  return src.targets.length > 0 ? src.targets : [{ slot: null, route: src.route }];
}

/**
 * The matrix's ONE write path (issue #25 lot F3) — the editing twin of
 * `sourceRouting`. Applies one cell edit to the MATERIALIZED matrix (so the
 * legacy compact form's implicit focus cell is a first-class row), then
 * re-canonicalizes (decision D-F3-4):
 *  - `route: null` removes the cell; removing the last one stores the legacy
 *    compact `{ targets: [], route: "off" }` (a silent source, same as the
 *    unchecked legacy pair);
 *  - a matrix that is exactly one focus cell compacts back to
 *    `{ targets: [], route: <that route> }` — a bench shrinking to one
 *    device finds truthful legacy checkboxes and byte-identical docs;
 *  - anything else stays explicit, `route` untouched (a dead field then —
 *    `targets.length` is the union tag, per state.ts).
 * Writing `route: "off"` KEEPS the cell (the legacy Off meaning: a silent
 * DAC program — what `sessionHasSources` counts); only `null` removes it.
 *
 * `cap` bounds cell creation (pass MAX_SOURCE_TARGETS — a structural param
 * so core/ stays type-only over the store): an add beyond it is a no-op,
 * matching the persist sanitizer's cap-9 rule.
 */
export function writeTarget(
  src: { route: SourceRoute; targets: SourceTarget[] },
  slot: number | null,
  route: SourceRoute | null,
  cap: number
): { route: SourceRoute; targets: SourceTarget[] } {
  const matrix = sourceRouting(src);
  let next: SourceTarget[];
  if (route === null) {
    next = matrix.filter((t) => t.slot !== slot);
  } else if (matrix.some((t) => t.slot === slot)) {
    next = matrix.map((t) => (t.slot === slot ? { slot, route } : t));
  } else if (matrix.length >= cap) {
    return { route: src.route, targets: src.targets };
  } else {
    next = [...matrix, { slot, route }];
  }
  if (next.length === 0) return { route: "off", targets: [] };
  if (next.length === 1 && next[0].slot === null) {
    return { route: next[0].route, targets: [] };
  }
  return { route: src.route, targets: next };
}

/** Cell-wise OR of two routes (L|L, R|R): what one session plays when a
 * source resolves onto it twice — e.g. an implicit focus target plus an
 * explicit target naming the focused slot. The caller COALESCES with this
 * instead of emitting two mixer slots with the same id, which the backend
 * mixer would SUM (+6 dB of unintended stimulus into a DUT). */
export function unionRoutes(a: SourceRoute, b: SourceRoute): SourceRoute {
  const ca = routeChecks(a);
  const cb = routeChecks(b);
  return routeFromChecks(ca.left || cb.left, ca.right || cb.right);
}

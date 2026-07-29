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

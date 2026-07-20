/**
 * The routing matrix bijection: a source's two Out L / Out R checkboxes ↔ its
 * route. Unchecking both is "off" — the only UI path to the backend's Off
 * route: the source stays defined and playing but contributes nothing to the
 * sum (maintainer-preferred over a dropdown; never regress to a select).
 */
import type { SourceRoute } from "../store/state";

export function routeFromChecks(left: boolean, right: boolean): SourceRoute {
  return left && right ? "both" : left ? "left" : right ? "right" : "off";
}

export function routeChecks(route: SourceRoute): { left: boolean; right: boolean } {
  return {
    left: route === "left" || route === "both",
    right: route === "right" || route === "both",
  };
}

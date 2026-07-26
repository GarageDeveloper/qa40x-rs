/**
 * Which pool traces are valid "+" add-trace candidates for a given tile
 * (issue #28 second-pass review finding #9): a trace whose domains are
 * already KNOWN AND FIXED must carry the domain the tile's kind actually
 * draws — spectrum → fd, scope → td, sweep → sweep — or adding it just
 * shows an empty tile (the wow & flutter program trace is sweep-only;
 * offering it on a scope or spectrum tile was a real, reachable dead end).
 *
 * "Known and fixed" excludes hardware endpoints (`hw_input`/`hw_output`)
 * on purpose: their domain set is DISPLAY-DERIVED (a spectrum is computed
 * only for a trace some fd tile actually shows, domain-badges.pw.ts), so a
 * playing endpoint can be perfectly healthy with only "td" today and gain
 * "fd" the moment it's added to a spectrum tile — that addition is
 * precisely what makes the fd start flowing. Gating candidacy on their
 * CURRENT domains would make that bootstrap impossible. Program/memory
 * traces have no such mechanism (a sweep program's result is always and
 * only "sweep"; a frozen ❄ snapshot never re-acquires anything), so their
 * domains are trustworthy the moment they're non-empty.
 *
 * A trace with NO domains yet at all (nothing landed, of any kind) stays
 * listable EVERYWHERE too: domain absence is "not yet known", never
 * "incompatible" — excluding it would make a brand new tile's picker start
 * empty before the first frame ever lands.
 */
import type { Domain } from "../../core/model";
import type { GraphKind, TraceMeta } from "../../store/state";

const TILE_KIND_DOMAIN: Record<GraphKind, Domain> = {
  spectrum: "fd",
  scope: "td",
  sweep: "sweep",
};

/**
 * @param order - the trace pool's display order (`s.traces.order`).
 * @param byId - the trace pool (`s.traces.byId`).
 * @param currentMembers - trace ids already on the tile (`tile.traces`) —
 *   excluded regardless of domain (already a member).
 * @param tileKind - the tile's own kind, deciding the wanted domain.
 */
export function addTraceCandidates(
  order: readonly string[],
  byId: Record<string, TraceMeta>,
  currentMembers: readonly string[],
  tileKind: GraphKind
): string[] {
  const wantDomain = TILE_KIND_DOMAIN[tileKind];
  return order.filter((id) => {
    if (currentMembers.includes(id)) return false;
    const meta = byId[id];
    if (!meta) return false; // no metadata at all — nothing to offer
    if (meta.source.kind === "hw_input" || meta.source.kind === "hw_output") return true;
    if (meta.domains.length === 0) return true; // nothing landed yet — unknown, not incompatible
    return meta.domains.includes(wantDomain);
  });
}

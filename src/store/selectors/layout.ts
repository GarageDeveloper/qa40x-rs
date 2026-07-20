/**
 * Layout selectors: which tiles the pattern shows, and the display budget
 * they impose on the backend (#52 — a spectrum is computed only for traces
 * some fd tile actually shows).
 */
import type { TraceId } from "../../core/model";
import type { AppState, TileConfig } from "../state";
import { patternTileCount } from "../state";

/** The tiles the current pattern actually displays, in grid order. */
export function visibleTiles(s: AppState): TileConfig[] {
  return s.layout.order
    .slice(0, patternTileCount(s.layout.pattern))
    .map((id) => s.layout.tiles[id])
    .filter((t): t is TileConfig => !!t);
}

export function focusedTile(s: AppState): TileConfig | null {
  return s.layout.focus ? (s.layout.tiles[s.layout.focus] ?? null) : null;
}

/** A tile's traces that are actually drawn (members minus legend-hidden). */
export function shownTraces(tile: TileConfig): TraceId[] {
  return tile.hidden.length === 0
    ? tile.traces
    : tile.traces.filter((id) => !tile.hidden.includes(id));
}

/**
 * Traces needing a backend spectrum: SHOWN members of a displayed spectrum
 * tile (a legend-hidden curve costs no FFT). Focus does NOT shrink the
 * budget — leaving focus must not cost a stream reconfigure + averaging
 * reset.
 *
 * A transform endpoint (M4) is derived: showing it needs its INPUT's
 * spectrum computed (resolved recursively — a chain can feed a chain), plus
 * any deconvolve reference. The visited set breaks cycles.
 */
export function fdShownTraceIds(s: AppState): Set<TraceId> {
  const ids = new Set<TraceId>();
  const add = (id: TraceId): void => {
    if (ids.has(id)) return;
    ids.add(id);
    const t = s.traces.byId[id];
    if (t?.source.kind !== "transform") return;
    add(t.source.input);
    for (const st of t.source.steps) {
      if (st.type === "deconvolve") add(st.ref);
    }
  };
  for (const tile of visibleTiles(s)) {
    if (tile.kind !== "spectrum") continue;
    for (const id of shownTraces(tile)) add(id);
  }
  return ids;
}

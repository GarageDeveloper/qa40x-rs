/**
 * Layout actions (M3): the multi-tile grid — pattern presets, per-tile
 * config (kind / units / trace membership / chips / axis), focus and
 * drag-reorder. Anything that changes which spectra the backend must
 * compute (membership, kind, pattern) syncs the stream config LAST.
 */
import type { Ipc } from "../../ipc/ipc";
import type { FdUnit, TdUnit, TraceId } from "../../core/model";
import type { Store } from "../store";
import type {
  AppState,
  GraphKind,
  LayoutPattern,
  TileAxis,
  TileConfig,
} from "../state";
import {
  DEFAULT_FD_MEASURES,
  DEFAULT_TD_MEASURES,
  defaultTile,
  patternTileCount,
} from "../state";
import { syncStream } from "./stream";

function patchTile(
  store: Store<AppState>,
  action: string,
  tileId: string,
  patch: (tile: TileConfig) => TileConfig
): void {
  store.update(action, (s) => {
    const tile = s.layout.tiles[tileId];
    if (!tile) return s;
    const next = patch(tile);
    if (next === tile) return s;
    return {
      ...s,
      layout: { ...s.layout, tiles: { ...s.layout.tiles, [tileId]: next } },
    };
  });
}

/** Switch the grid preset, creating fresh default tiles for new slots.
 * Hidden tiles keep their config (2x2 → 1 → 2x2 restores them). */
export function setPattern(
  store: Store<AppState>,
  ipc: Ipc,
  pattern: LayoutPattern
): void {
  store.update("layout/pattern", (s) => {
    const need = patternTileCount(pattern);
    let { order, tiles } = s.layout;
    if (order.length < need) {
      order = [...order];
      tiles = { ...tiles };
      let serial = 0;
      for (const id of order) {
        const m = /^tile-(\d+)$/.exec(id);
        if (m) serial = Math.max(serial, Number(m[1]));
      }
      while (order.length < need) {
        serial += 1;
        const id = `tile-${serial}`;
        tiles[id] = defaultTile(id);
        order.push(id);
      }
    }
    // A focused tile that the new pattern hides would leave the grid empty.
    const shown = order.slice(0, need);
    const focus = s.layout.focus && shown.includes(s.layout.focus) ? s.layout.focus : null;
    return { ...s, layout: { pattern, order, tiles, focus } };
  });
  syncStream(store, ipc);
}

/** Swap a tile's graph kind. Chips whose domain no longer matches are reset
 * to the kind's defaults (the v1 behavior); a sweep graph reads measurement
 * curves, not frames — it carries no chips. */
export function setTileKind(
  store: Store<AppState>,
  ipc: Ipc,
  tileId: string,
  kind: GraphKind
): void {
  patchTile(store, "layout/tile-kind", tileId, (t) =>
    t.kind === kind
      ? t
      : {
          ...t,
          kind,
          measures:
            kind === "spectrum"
              ? [...DEFAULT_FD_MEASURES]
              : kind === "scope"
                ? [...DEFAULT_TD_MEASURES]
                : [],
        }
  );
  syncStream(store, ipc);
}

export function setTileFdUnit(store: Store<AppState>, tileId: string, fdUnit: FdUnit): void {
  patchTile(store, "layout/fd-unit", tileId, (t) => (t.fdUnit === fdUnit ? t : { ...t, fdUnit }));
}

export function setTileTdUnit(store: Store<AppState>, tileId: string, tdUnit: TdUnit): void {
  patchTile(store, "layout/td-unit", tileId, (t) => (t.tdUnit === tdUnit ? t : { ...t, tdUnit }));
}

export function addTraceToTile(
  store: Store<AppState>,
  ipc: Ipc,
  tileId: string,
  traceId: TraceId
): void {
  patchTile(store, "layout/add-trace", tileId, (t) =>
    t.traces.includes(traceId) ? t : { ...t, traces: [...t.traces, traceId] }
  );
  syncStream(store, ipc);
}

export function removeTraceFromTile(
  store: Store<AppState>,
  ipc: Ipc,
  tileId: string,
  traceId: TraceId
): void {
  patchTile(store, "layout/remove-trace", tileId, (t) => {
    if (!t.traces.includes(traceId)) return t;
    const hiddenCurves = { ...t.hiddenCurves };
    delete hiddenCurves[traceId];
    return {
      ...t,
      traces: t.traces.filter((id) => id !== traceId),
      hidden: t.hidden.filter((id) => id !== traceId),
      hiddenCurves,
    };
  });
  syncStream(store, ipc);
}

/** Legend-chip toggle for ONE curve of a multi-curve sweep trace (v1: each
 * curve has its own chip and an independent hide). Display-only — sweep
 * curves never enter the fd budget, no stream sync needed. */
export function toggleCurveHidden(
  store: Store<AppState>,
  tileId: string,
  traceId: TraceId,
  curveLabel: string
): void {
  patchTile(store, "layout/toggle-curve-hidden", tileId, (t) => {
    if (!t.traces.includes(traceId)) return t;
    const cur = t.hiddenCurves[traceId] ?? [];
    const next = cur.includes(curveLabel)
      ? cur.filter((c) => c !== curveLabel)
      : [...cur, curveLabel];
    return { ...t, hiddenCurves: { ...t.hiddenCurves, [traceId]: next } };
  });
}

/** Legend-chip toggle (v1): flip whether a member trace is drawn. */
export function toggleTraceHidden(
  store: Store<AppState>,
  ipc: Ipc,
  tileId: string,
  traceId: TraceId
): void {
  patchTile(store, "layout/toggle-hidden", tileId, (t) => {
    if (!t.traces.includes(traceId)) return t;
    return {
      ...t,
      hidden: t.hidden.includes(traceId)
        ? t.hidden.filter((id) => id !== traceId)
        : [...t.hidden, traceId],
    };
  });
  syncStream(store, ipc); // hidden curves leave the fd budget
}

/** Replace a tile's whole membership (gear dialog Traces tab). */
export function setTileTraces(
  store: Store<AppState>,
  ipc: Ipc,
  tileId: string,
  traces: TraceId[]
): void {
  patchTile(store, "layout/set-traces", tileId, (t) => ({ ...t, traces: [...traces] }));
  syncStream(store, ipc);
}

/** Move the tile at visible position `from` to position `to` (drag-reorder).
 * Operates on the visible window; the hidden tail is untouched. */
export function moveTile(store: Store<AppState>, from: number, to: number): void {
  store.update("layout/move-tile", (s) => {
    const count = patternTileCount(s.layout.pattern);
    if (
      from === to ||
      from < 0 || from >= count ||
      to < 0 || to >= count ||
      from >= s.layout.order.length ||
      to >= s.layout.order.length
    ) {
      return s;
    }
    const order = [...s.layout.order];
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    return { ...s, layout: { ...s.layout, order } };
  });
}

export function setFocusTile(store: Store<AppState>, tileId: string | null): void {
  store.update("layout/focus", (s) =>
    s.layout.focus === tileId ? s : { ...s, layout: { ...s.layout, focus: tileId } }
  );
}

export function setTileMeasures(store: Store<AppState>, tileId: string, measures: string[]): void {
  patchTile(store, "layout/measures", tileId, (t) => ({ ...t, measures: [...measures] }));
}

export function setTileChipSource(
  store: Store<AppState>,
  tileId: string,
  chipSource: "auto" | TraceId
): void {
  patchTile(store, "layout/chip-source", tileId, (t) =>
    t.chipSource === chipSource ? t : { ...t, chipSource }
  );
}

export function setTileAxis(
  store: Store<AppState>,
  tileId: string,
  axis: Partial<TileAxis>
): void {
  patchTile(store, "layout/axis", tileId, (t) => ({ ...t, axis: { ...t.axis, ...axis } }));
}

/** Sweep tiles: toggle the ∠ phase overlay (persisted with the tile). */
export function setTileShowPhase(
  store: Store<AppState>,
  tileId: string,
  showPhase: boolean
): void {
  patchTile(store, "layout/show-phase", tileId, (t) =>
    t.showPhase === showPhase ? t : { ...t, showPhase }
  );
}

/** Spectrum tiles: toggle the harmonic markers (persisted with the tile). */
export function setTileShowHarmonics(
  store: Store<AppState>,
  tileId: string,
  showHarmonics: boolean
): void {
  patchTile(store, "layout/show-harmonics", tileId, (t) =>
    t.showHarmonics === showHarmonics ? t : { ...t, showHarmonics }
  );
}

export function setTileTimeWindow(
  store: Store<AppState>,
  tileId: string,
  timeWindowMs: number | null
): void {
  patchTile(store, "layout/time-window", tileId, (t) =>
    t.timeWindowMs === timeWindowMs ? t : { ...t, timeWindowMs }
  );
}

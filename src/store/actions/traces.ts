/**
 * Trace-pool actions: freeze ❄ (snapshot → memory trace), transform
 * endpoints (M4: `input → steps → this trace`, recomputed by data/chains),
 * and user-trace deletion. Hardware endpoints are permanent; what a tile
 * SHOWS is tile membership (actions/layout.ts) — there is no global
 * visibility.
 */
import type { Ipc } from "../../ipc/ipc";
import type { TraceId } from "../../core/model";
import type { TransformStep } from "../../gen";
import { transformLabel } from "../../core/transforms";
import { clearFrames, getFrames, putFrames } from "../../data/frames";
import { resetChain, syncChains } from "../../data/chains";
import { clearMeasures } from "../../data/measures";
import { shownTraces } from "../selectors/layout";
import type { Store } from "../store";
import type { AppState, TraceMeta } from "../state";
import { HW_TRACE_IDS, isRatioTrace, nextTraceColor } from "../state";
import { syncStream } from "./stream";

/** Muted overlay tint for a frozen copy of `color` (8-digit hex alpha). */
function frozenColor(color: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? `${color}99` : color;
}

/**
 * Freeze one trace: copy its CURRENT frames into a new memory trace (seq 1,
 * offset baked at snapshot time — a later range change must never move a
 * frozen curve) and return the new id, or null if the trace has no data yet.
 */
function freezeOne(s: AppState, id: TraceId, serial: number): { meta: TraceMeta; from: TraceId } | null {
  const src = s.traces.byId[id];
  const frames = getFrames(id);
  if (!src || !frames || (!frames.td && !frames.fd && !frames.sweep)) return null;
  const memId = `mem-${serial}`;
  const meta: TraceMeta = {
    id: memId,
    label: `${src.label} ❄${serial}`,
    color: frozenColor(src.color),
    // The ratio flag survives the freeze (the offset stays for the SCOPE:
    // a deconvolved trace's td passes through as absolute volts).
    source: { kind: "memory", frozenFrom: id, ratio: isRatioTrace(src) || undefined },
    domains: [...src.domains],
    seq: 1,
    offsetDb: src.offsetDb,
  };
  return { meta, from: id };
}

/** Next free mem-N serial across the pool. */
function nextMemSerial(s: AppState): number {
  let serial = 0;
  for (const id of s.traces.order) {
    const m = /^mem-(\d+)$/.exec(id);
    if (m) serial = Math.max(serial, Number(m[1]));
  }
  return serial + 1;
}

/** Copy a frozen source's frames into the cache under its new memory id. */
function copyFrozenFrames(frozen: { meta: TraceMeta; from: TraceId }[]): void {
  for (const f of frozen) {
    const src = getFrames(f.from);
    if (src) {
      putFrames(f.meta.id, 1, {
        td: src.td,
        fd: src.fd,
        sweep: src.sweep,
        metrics: src.metrics,
      });
    }
  }
}

/**
 * Freeze every trace currently DRAWN on `tileId` that has data (a
 * legend-hidden curve isn't part of the picture being kept). The frozen
 * copies join the pool AND the tile, so the overlay comparison is immediate
 * (the v1 ❄ freeze-reference behavior).
 */
export function freezeTile(store: Store<AppState>, tileId: string): void {
  const s = store.get();
  const tile = s.layout.tiles[tileId];
  if (!tile) return;
  let serial = nextMemSerial(s);
  const frozen: { meta: TraceMeta; from: TraceId }[] = [];
  for (const id of shownTraces(tile)) {
    if (s.traces.byId[id]?.source.kind === "memory") continue; // never re-freeze a snapshot
    const f = freezeOne(s, id, serial);
    if (f) {
      frozen.push(f);
      serial += 1;
    }
  }
  if (frozen.length === 0) return;

  // Cache first, then the store update that reveals the new ids (§3.1).
  copyFrozenFrames(frozen);
  store.update("traces/freeze", (st) => {
    const t = st.layout.tiles[tileId];
    if (!t) return st;
    return {
      ...st,
      traces: {
        order: [...st.traces.order, ...frozen.map((f) => f.meta.id)],
        byId: {
          ...st.traces.byId,
          ...Object.fromEntries(frozen.map((f) => [f.meta.id, f.meta])),
        },
      },
      layout: {
        ...st.layout,
        tiles: {
          ...st.layout.tiles,
          [tileId]: { ...t, traces: [...t.traces, ...frozen.map((f) => f.meta.id)] },
        },
      },
    };
  });
}

/** Freeze ONE trace into a memory snapshot (the pool/programs ❄ button —
 * no tile membership involved). Returns the new id, or null without data. */
export function freezeTrace(store: Store<AppState>, id: TraceId): TraceId | null {
  const s = store.get();
  if (s.traces.byId[id]?.source.kind === "memory") return null;
  const f = freezeOne(s, id, nextMemSerial(s));
  if (!f) return null;
  copyFrozenFrames([f]);
  store.update("traces/freeze-one", (st) => ({
    ...st,
    traces: {
      order: [...st.traces.order, f.meta.id],
      byId: { ...st.traces.byId, [f.meta.id]: f.meta },
    },
  }));
  return f.meta.id;
}

/** Delete a user-created trace (memory / transform): pool, every tile's
 * membership, frames + measures caches. Hardware endpoints and program
 * traces are permanent here (a program trace leaves with its program). */
export function deleteTrace(store: Store<AppState>, ipc: Ipc, id: TraceId): void {
  const meta = store.get().traces.byId[id];
  if (!meta || (meta.source.kind !== "memory" && meta.source.kind !== "transform")) return;
  removeTraceEverywhere(store, id);
  syncStream(store, ipc);
}

/** Shared pool/tiles/cache removal (also used when a program is removed). */
export function removeTraceEverywhere(store: Store<AppState>, id: TraceId): void {
  store.update("traces/remove", (s) => {
    const byId = { ...s.traces.byId };
    delete byId[id];
    const tiles = Object.fromEntries(
      Object.entries(s.layout.tiles).map(([tid, tile]) => [
        tid,
        tile.traces.includes(id)
          ? {
              ...tile,
              traces: tile.traces.filter((t) => t !== id),
              hidden: tile.hidden.filter((t) => t !== id),
            }
          : tile,
      ])
    );
    return {
      ...s,
      traces: { order: s.traces.order.filter((t) => t !== id), byId },
      layout: { ...s.layout, tiles },
    };
  });
  resetChain(id);
  clearFrames(id);
  clearMeasures(id);
}

/** Backward-compatible alias (M3 name) for deleting a ❄ memory trace. */
export function deleteMemoryTrace(store: Store<AppState>, ipc: Ipc, id: TraceId): void {
  deleteTrace(store, ipc, id);
}

/* ------------------------------------------------------------------ */
/* Transform endpoints (M4)                                            */
/* ------------------------------------------------------------------ */

let nextFxId = 1;

/** Add a transform endpoint (default: identity chain on Input L) and return
 * its id. The chain watcher computes its frames. */
export function addTransformTrace(
  store: Store<AppState>,
  input: TraceId = HW_TRACE_IDS.inputL,
  steps: TransformStep[] = []
): TraceId {
  const s = store.get();
  let id = `fx-${nextFxId++}`;
  while (s.traces.byId[id]) id = `fx-${nextFxId++}`;
  const meta: TraceMeta = {
    id,
    label: transformLabel(steps),
    color: nextTraceColor(s),
    source: { kind: "transform", input, steps },
    domains: [],
    seq: 0,
    offsetDb: null,
  };
  store.update("traces/add-transform", (st) => ({
    ...st,
    traces: {
      order: [...st.traces.order, id],
      byId: { ...st.traces.byId, [id]: meta },
    },
  }));
  return id;
}

/** Recolor a trace (M6 gap 10a — the pool dot is a color picker). Pure
 * display metadata: charts read `meta.color` from the store on the next
 * feed; nothing backend-side. */
export function setTraceColor(store: Store<AppState>, id: TraceId, color: string): void {
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) return;
  store.update("traces/color", (s) => {
    const t = s.traces.byId[id];
    if (!t || t.color === color) return s;
    return {
      ...s,
      traces: { ...s.traces, byId: { ...s.traces.byId, [id]: { ...t, color } } },
    };
  });
}

/**
 * The one-click "weighted copy" shortcut (M6 discoverability): the same
 * per-trace transform model as the dialog — a backend-DSP derived trace —
 * created without the dialog trip. Labelled "A-weighted (Input L)".
 */
export function addWeightedCopy(
  store: Store<AppState>,
  ipc: Ipc,
  input: TraceId,
  mode: "a" | "c" | "riaa"
): TraceId {
  const src = store.get().traces.byId[input];
  const steps: TransformStep[] = [{ type: "weighting", mode }];
  const id = addTransformTrace(store, input, steps);
  const label = src ? `${transformLabel(steps)} (${src.label})` : transformLabel(steps);
  configureTransform(store, ipc, id, { label, input, steps });
  return id;
}

/** Reconfigure a transform endpoint (input, steps, label). Clears its
 * scheduling state so the SAME input frame recomputes under the new chain;
 * the watcher then schedules the run. */
export function configureTransform(
  store: Store<AppState>,
  ipc: Ipc,
  id: TraceId,
  cfg: { label: string; input: TraceId; steps: TransformStep[] }
): void {
  const t = store.get().traces.byId[id];
  if (!t || t.source.kind !== "transform") return;
  resetChain(id);
  clearMeasures(id);
  store.update("traces/configure-transform", (s) => {
    const cur = s.traces.byId[id];
    if (!cur || cur.source.kind !== "transform") return s;
    const next: TraceMeta = {
      ...cur,
      label: cfg.label,
      source: { kind: "transform", input: cfg.input, steps: cfg.steps },
      domains: [],
    };
    return { ...s, traces: { ...s.traces, byId: { ...s.traces.byId, [id]: next } } };
  });
  // The transform may read a hardware endpoint no displayed tile shows —
  // the fd display budget resolves through it (selectors/layout.ts).
  syncStream(store, ipc);
  syncChains(store, ipc);
}

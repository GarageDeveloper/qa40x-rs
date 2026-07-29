/**
 * Trace-pool actions: freeze ❄ (snapshot → memory trace), transform
 * endpoints (M4: `input → steps → this trace`, recomputed by data/chains),
 * and user-trace deletion. Hardware endpoints are permanent; what a tile
 * SHOWS is tile membership (actions/layout.ts) — there is no global
 * visibility.
 */
import type { Ipc } from "../../ipc/ipc";
import type { TraceId } from "../../core/model";
import type { DeviceMeta, TransformStep } from "../../gen";
import { transformLabel } from "../../core/transforms";
import { clearFrames, getFrames, putFrames } from "../../data/frames";
import { resetChain, syncChains } from "../../data/chains";
import { clearMeasures } from "../../data/measures";
import { shownTraces } from "../selectors/layout";
import { sessionKeys } from "../selectors/session";
import type { Store } from "../store";
import type { AppState, HwTraceSource, TraceMeta, TraceSource } from "../state";
import {
  HW_TRACE_IDS,
  hwTraceIds,
  hwTraceMetas,
  hwTraceSource,
  isRatioTrace,
  nextTraceColor,
  slotOfSessionKey,
} from "../state";
import { syncAllStreams } from "./stream";

/** Two hw sources are the same endpoint. */
function sameHwSource(a: TraceSource, b: HwTraceSource): boolean {
  return (
    (a.kind === "hw_input" || a.kind === "hw_output") &&
    a.kind === b.kind &&
    a.channel === b.channel
  );
}

/**
 * Reconcile the hardware-endpoint pool against the LIVE sessions (issue #25
 * lot E3, the F6 fix): every open slot gets its 4 endpoint traces, and any
 * pool entry whose id names a hw endpoint gets its `source` forced back to
 * the canonical one — a hand-edited doc must not turn `hw-in-left` into a
 * `memory` trace (user `label`/`color` are kept: those are theirs).
 *
 * NEVER deletes (D1, 2026-07-28): a slot-n endpoint trace with no live
 * session stays in the pool, dormant — a doc from a 2-device bench loaded on
 * a 1-device bench keeps its layout and revives when the device comes back
 * (E4's add-device). Idempotent and reference-stable: returns `s` UNCHANGED
 * when nothing is missing, so the auto-save dedupe never thrashes.
 *
 * Callers: `applyWorkspaceDoc` (a doc replaces the pool wholesale — this
 * restores the live bench's endpoints), and E4's session-mint path via
 * `store.update("traces/reconcile-hw", reconcileHwTraces)` when a slot ≥ 1
 * session appears (dormant in E3 — no E3 flow mints one).
 */
export function reconcileHwTraces(s: AppState): AppState {
  let nextById: Record<TraceId, TraceMeta> | null = null;
  let nextOrder: TraceId[] | null = null;
  const touch = (): Record<TraceId, TraceMeta> => (nextById ??= { ...s.traces.byId });

  for (const id of s.traces.order) {
    const canonical = hwTraceSource(id);
    const t = s.traces.byId[id];
    if (!canonical || !t) continue;
    if (!sameHwSource(t.source, canonical)) {
      touch()[id] = { ...t, source: canonical };
    }
  }

  // Slot-then-endpoint append order: stable for the traces panel and pinned.
  // Presence means BOTH halves (E3 review #2): a doc whose `order` omits an
  // id its `byId` still holds would otherwise leave that endpoint without a
  // panel row or + picker entry forever, while ingest keeps stamping it.
  const inOrder = new Set(s.traces.order);
  for (const key of sessionKeys(s)) {
    for (const meta of hwTraceMetas(slotOfSessionKey(key))) {
      if (!(nextById ?? s.traces.byId)[meta.id]) touch()[meta.id] = meta;
      if (!inOrder.has(meta.id)) {
        (nextOrder ??= [...s.traces.order]).push(meta.id);
        inOrder.add(meta.id);
      }
    }
  }

  if (!nextById && !nextOrder) return s;
  return {
    ...s,
    traces: { order: nextOrder ?? s.traces.order, byId: nextById ?? s.traces.byId },
  };
}

/**
 * Fresh-slate `slot`'s 4 endpoint traces (issue #25 lot E4, decision B6):
 * called at session MINT, because `free_or_new_runtime` REUSES freed
 * slots — a different unit can land on a slot whose dormant traces still
 * hold the previous unit's frames, and its first captures must never blend
 * into them. Clears the caches and zeroes the data-derived meta fields
 * (domains / offsetDb / capture); user label/color edits are kept (theirs).
 * `seq` bumps so tiles re-read — and find nothing.
 */
export function resetSlotEndpointTraces(store: Store<AppState>, slot: number): void {
  const ids = Object.values(hwTraceIds(slot));
  for (const id of ids) {
    clearFrames(id);
    clearMeasures(id);
  }
  store.update("traces/reset-slot-endpoints", (s) => {
    let byId: Record<TraceId, TraceMeta> | null = null;
    for (const id of ids) {
      const t = s.traces.byId[id];
      if (!t) continue;
      if (t.domains.length === 0 && t.offsetDb === null && t.capture === null) continue;
      (byId ??= { ...s.traces.byId })[id] = {
        ...t,
        domains: [],
        seq: t.seq + 1,
        offsetDb: null,
        capture: null,
      };
    }
    return byId ? { ...s, traces: { ...s.traces, byId } } : s;
  });
}

/**
 * Stamp the OPENED unit's identity on `slot`'s endpoint traces (issue #25
 * lot F, Raphaël's second F1-validation round): identity-only capture
 * (device block set, everything else null — same shape as programCapture's
 * "unknown, never guessed" rule), applied right after the add's
 * `get_device_info` lands. Without it, a device ADDED BUT NEVER STREAMED
 * has nothing to persist — the mint's fresh slate (B6) zeroed the previous
 * capture, ingest only re-stamps on the first FRAME, and after a
 * save/restart the dormant group had no model+serial for the one-click
 * revive to match ("Connect" greyed, generic "Device #2" title). Identity
 * comes from the OPEN, frames merely enrich it: the first ingested frame
 * replaces this with the full frame-bound snapshot
 * (`frameCaptureProvenance` — different bench signature, so the memo
 * can't serve the identity-only object). Only fills a NULL capture — a
 * frame-bound stamp already present always wins.
 */
export function stampSlotEndpointIdentity(
  store: Store<AppState>,
  slot: number,
  info: DeviceMeta
): void {
  const ids = Object.values(hwTraceIds(slot));
  store.update("traces/stamp-endpoint-identity", (s) => {
    let byId: Record<TraceId, TraceMeta> | null = null;
    for (const id of ids) {
      const t = s.traces.byId[id];
      if (!t || t.capture !== null) continue;
      (byId ??= { ...s.traces.byId })[id] = {
        ...t,
        capture: {
          device: {
            model: info.model,
            serial: info.serial,
            firmware: info.firmware_version,
            isVirtual: info.is_virtual,
          },
          sampleRateHz: null,
          inputRangeDbv: null,
          outputRangeDbv: null,
          offsets: null,
          fftSize: null,
          window: null,
          averaging: null,
          capturedAt: null,
        },
      };
    }
    return byId ? { ...s, traces: { ...s.traces, byId } } : s;
  });
}

/**
 * Purge `slot`'s 4 endpoint traces from the whole bench (issue #25 lot E4,
 * decision B5 — the "remove device" gesture on a group header): pool +
 * order, every tile's membership / hidden / hiddenCurves, chip and trigger
 * sources pointing at them (back to "auto"), the per-endpoint trigger
 * settings, and the frames/measures/chain caches. Slot 0 is refused — the
 * default device's endpoints are permanent (the delete-guard invariant
 * stays unconditional: an hw endpoint row never carries a ✕).
 */
export function purgeSlotEndpointTraces(store: Store<AppState>, ipc: Ipc, slot: number): void {
  if (slot === 0) return;
  const ids = new Set<TraceId>(Object.values(hwTraceIds(slot)));
  // Transform traces bound to a purged endpoint go with it (review #8),
  // transitively (a chain can feed a chain, and a deconvolve ref counts):
  // the endpoint id is RECREATED when another unit lands on the freed
  // slot, and an "A-weighted Input L #2" silently re-binding onto a
  // physically different converter is the four-offsets bug class in trace
  // form. Computed BEFORE the removal below, while byId still holds them.
  const doomed = new Set<TraceId>(ids);
  let grew = true;
  while (grew) {
    grew = false;
    const s = store.get();
    for (const id of s.traces.order) {
      const t = s.traces.byId[id];
      if (
        t?.source.kind === "transform" &&
        !doomed.has(id) &&
        (doomed.has(t.source.input) ||
          t.source.steps.some(
            (st) => st.type === "deconvolve" && doomed.has(st.ref)
          ))
      ) {
        doomed.add(id);
        grew = true;
      }
    }
  }
  for (const id of doomed) {
    if (!ids.has(id)) removeTraceEverywhere(store, id);
  }
  store.update("traces/purge-slot-endpoints", (s) => {
    const order = s.traces.order.filter((id) => !ids.has(id));
    const byId = { ...s.traces.byId };
    for (const id of ids) delete byId[id];
    const tiles = Object.fromEntries(
      Object.entries(s.layout.tiles).map(([tid, tile]) => {
        const touched =
          tile.traces.some((id) => ids.has(id)) ||
          tile.hidden.some((id) => ids.has(id)) ||
          Object.keys(tile.hiddenCurves).some((id) => ids.has(id)) ||
          ids.has(tile.chipSource as TraceId) ||
          ids.has(tile.triggerSource as TraceId);
        if (!touched) return [tid, tile];
        const hiddenCurves = Object.fromEntries(
          Object.entries(tile.hiddenCurves).filter(([id]) => !ids.has(id))
        );
        return [
          tid,
          {
            ...tile,
            traces: tile.traces.filter((id) => !ids.has(id)),
            hidden: tile.hidden.filter((id) => !ids.has(id)),
            hiddenCurves,
            chipSource: ids.has(tile.chipSource as TraceId) ? ("auto" as const) : tile.chipSource,
            triggerSource: ids.has(tile.triggerSource as TraceId)
              ? ("auto" as const)
              : tile.triggerSource,
          },
        ];
      })
    );
    const triggers = { ...s.triggers };
    for (const id of ids) delete triggers[id];
    return {
      ...s,
      traces: { order, byId },
      layout: { ...s.layout, tiles },
      triggers,
    };
  });
  for (const id of ids) {
    resetChain(id);
    clearFrames(id);
    clearMeasures(id);
  }
  syncAllStreams(store, ipc);
}

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
    // The capture snapshot travels with the copy (issue #40); a live trace's
    // snapshot has no instant yet — the freeze IS that instant (the data
    // being kept is the frame on screen right now).
    capture: src.capture
      ? { ...src.capture, capturedAt: src.capture.capturedAt ?? new Date().toISOString() }
      : null,
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
  syncAllStreams(store, ipc);
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
    capture: null,
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
  syncAllStreams(store, ipc);
  syncChains(store, ipc);
}

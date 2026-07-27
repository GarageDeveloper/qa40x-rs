/**
 * Transform-chain scheduling (M4) — the near-verbatim port of the v1 pool's
 * chain orchestration (pool.ts:159-223, which was already correct):
 *
 * - a transform endpoint is DERIVED: its frames are recomputed from its
 *   input's whenever the input lands a newer frame or the chain changes;
 * - the DSP itself runs backend-side (`apply_transform_chain`) — this module
 *   only orchestrates: busy set (one run in flight per endpoint; frames
 *   arriving meanwhile are dropped), dedup key (input seq + steps JSON), and
 *   a finally-reschedule so a dropped frame re-runs from the freshest input;
 * - an identity chain (no steps) copies the input synchronously — no
 *   backend round trip;
 * - sweep frames never enter the chain: they pass through unchanged;
 * - the endpoint's seq MIRRORS its input's (like v1): a cycle (a → b → a)
 *   therefore converges instead of ping-ponging two fresh counters forever.
 *
 * `watchChains` mounts one store subscription that calls `syncChains` when
 * any transform definition or any input seq changes; actions that edit a
 * chain clear the endpoint's cache first (`resetChain`) so a same-seq
 * recompute isn't stale-dropped.
 */
import type { Frame, TransformStep } from "../gen";
import type { Ipc } from "../ipc/ipc";
import type { Store } from "../store/store";
import type { AppState, CaptureProvenance, TraceMeta } from "../store/state";
import { captureBenchSignature } from "../store/state";
import type { Domain, TraceId } from "../core/model";
import {
  clearFrames,
  fdToWire,
  getFrames,
  putFrames,
  tdToWire,
  wireToFd,
  wireToTd,
  type TraceFrames,
} from "./frames";

/** Endpoints with a chain run in flight (drop frames while busy). */
const busy = new Set<TraceId>();
/** Last completed chain key per endpoint (`inputSeq:steps`) — dedups. */
const done = new Map<TraceId, string>();

/** Forget an endpoint's scheduling state AND cached frames — call when its
 * chain is edited (same input seq must recompute) or the trace is removed. */
export function resetChain(id: TraceId): void {
  done.delete(id);
  clearFrames(id);
}

/** Test seam: drop all scheduling state (busy survives — an in-flight run
 * belongs to its endpoint). */
export function resetAllChains(): void {
  done.clear();
}

/**
 * The capture snapshot a transform endpoint inherits (issue #40): the
 * PRIMARY input's, marked `derived` (this data was computed, not captured).
 * A deconvolve reference captured under a DIFFERENT bench state additionally
 * flags the snapshot `mixed` — it then describes the primary input only.
 */
export function derivedCapture(
  s: AppState,
  input: TraceMeta,
  steps: TransformStep[]
): CaptureProvenance | null {
  const base = input.capture;
  if (!base) return null;
  let mixed = base.mixed === true;
  const baseSig = captureBenchSignature(base);
  for (const st of steps) {
    if (st.type !== "deconvolve") continue;
    const ref = s.traces.byId[st.ref];
    // A missing/dataless ref contributed nothing to the result; a ref WITH
    // data but no snapshot (pre-#40 doc) is an UNKNOWN bench — silence
    // there would vouch for data nobody stamped (review finding #5).
    if (!ref || ref.domains.length === 0) continue;
    if (!ref.capture || captureBenchSignature(ref.capture) !== baseSig) mixed = true;
  }
  return mixed ? { ...base, derived: true, mixed: true } : { ...base, derived: true };
}

/** Land a recompute on the endpoint: cache first, then ONE store update
 * carrying seq/domains/offset (plan §3.1). The seq mirrors the input's. */
function land(
  store: Store<AppState>,
  id: TraceId,
  seq: number,
  frames: { td?: TraceFrames["td"]; fd?: TraceFrames["fd"]; sweep?: TraceFrames["sweep"] },
  offsetDb: number | null,
  capture: CaptureProvenance | null
): void {
  const domains: Domain[] = [];
  if (frames.td) domains.push("td");
  if (frames.fd) domains.push("fd");
  if (frames.sweep) domains.push("sweep");
  if (domains.length > 0 && !putFrames(id, seq, frames)) return; // stale-drop
  if (domains.length === 0) clearFrames(id);
  store.update("chains/land", (s) => {
    const t = s.traces.byId[id];
    if (!t || t.source.kind !== "transform") return s;
    const next: TraceMeta = { ...t, seq: Math.max(t.seq, seq), domains, offsetDb, capture };
    return { ...s, traces: { ...s.traces, byId: { ...s.traces.byId, [id]: next } } };
  });
}

/**
 * Recompute every transform endpoint that is out of date. Reentrant-safe:
 * a land triggers the watcher again, and the dedup keys make it settle.
 */
export function syncChains(store: Store<AppState>, ipc: Ipc): void {
  const s = store.get();
  for (const id of s.traces.order) {
    const t = s.traces.byId[id];
    if (!t || t.source.kind !== "transform") continue;
    const { input: inputId, steps } = t.source;

    // Missing input (or a self-reference) clears the endpoint — it is
    // derived, never stale.
    const input = inputId !== id ? s.traces.byId[inputId] : undefined;
    const inputFrames = input ? getFrames(inputId) : undefined;
    if (!input || !inputFrames || busy.has(id)) {
      if (!input && t.domains.length > 0) {
        done.delete(id);
        land(store, id, t.seq, {}, null, null);
      }
      continue;
    }

    const key = `${inputFrames.seq}:${JSON.stringify(steps)}`;
    if (done.get(id) === key) continue;

    if (steps.length === 0) {
      // Identity chain: copy the input synchronously (no backend trip).
      done.set(id, key);
      land(
        store,
        id,
        inputFrames.seq,
        { td: inputFrames.td, fd: inputFrames.fd, sweep: inputFrames.sweep },
        input.offsetDb,
        derivedCapture(s, input, steps)
      );
      continue;
    }

    scheduleRun(
      store,
      ipc,
      id,
      steps,
      inputId,
      inputFrames,
      key,
      input.offsetDb,
      derivedCapture(s, input, steps)
    );
  }
}

/** Kick one async backend chain run for an endpoint. */
function scheduleRun(
  store: Store<AppState>,
  ipc: Ipc,
  id: TraceId,
  steps: TransformStep[],
  inputId: TraceId,
  inputFrames: TraceFrames,
  key: string,
  offsetDb: number | null,
  capture: CaptureProvenance | null
): void {
  busy.add(id);
  const stepsJson = JSON.stringify(steps);
  // Resolve deconvolve references to their CURRENT spectra.
  const refs: Record<TraceId, Frame> = {};
  for (const st of steps) {
    if (st.type === "deconvolve") {
      const fd = getFrames(st.ref)?.fd;
      if (fd) refs[st.ref] = fdToWire(fd);
    }
  }
  const seq = inputFrames.seq;
  void ipc
    .call("apply_transform_chain", {
      td: inputFrames.td ? tdToWire(inputFrames.td) : null,
      fd: inputFrames.fd ? fdToWire(inputFrames.fd) : null,
      steps,
      refs,
    })
    .then((res) => {
      done.set(id, key);
      if (res.script_error) console.error("[transform script]", res.script_error);
      // The endpoint may have been rewired/deleted while the chain ran —
      // then this result describes a chain that no longer exists.
      const cur = store.get().traces.byId[id];
      if (
        !cur ||
        cur.source.kind !== "transform" ||
        cur.source.input !== inputId ||
        JSON.stringify(cur.source.steps) !== stepsJson
      ) {
        return;
      }
      land(
        store,
        id,
        seq,
        {
          td: res.td ? wireToTd(res.td) : undefined,
          fd: res.fd ? wireToFd(res.fd) : undefined,
          sweep: inputFrames.sweep, // passes through, never transformed
        },
        offsetDb,
        capture
      );
    })
    .catch((err) => console.error("[transform chain]", err))
    .finally(() => {
      busy.delete(id);
      // A newer input frame may have been dropped while this run was in
      // flight — re-check and re-run from the freshest input.
      syncChains(store, ipc);
    });
}

/**
 * A user weighting curve's cheap IDENTITY (issue #29 review finding #2):
 * the watcher below stringifies its whole signature on EVERY store batch
 * (every live frame, not just a chain edit) to detect changes — embedding
 * the actual curve array there would re-serialize it that often too. Curve
 * OBJECTS are only ever created at Apply time (core/transforms.ts snapshots
 * one into the step); the same object reference rides unchanged through
 * every batch until the next Apply, so a `WeakMap`-assigned integer id
 * stands in for the whole array with the same change-detection power at
 * O(1) instead of O(points).
 */
const curveIds = new WeakMap<object, number>();
let nextCurveId = 1;
function curveIdentity(curve: object): number {
  let id = curveIds.get(curve);
  if (id === undefined) {
    id = nextCurveId++;
    curveIds.set(curve, id);
  }
  return id;
}

/** A transform step, lightened for the watcher's signature: a "user"
 * weighting step's curve array is replaced by its cheap identity number
 * (see `curveIdentity`) — every other step shape is small already and
 * rides through unchanged. */
function lightStep(step: TransformStep): unknown {
  if (step.type === "weighting" && step.mode === "user" && step.curve) {
    return { ...step, curve: curveIdentity(step.curve) };
  }
  return step;
}

/**
 * Mount the chain watcher: recompute when any transform definition, any
 * input's freshness, or a deconvolve reference moves. One subscription for
 * the whole pool (signature-keyed, fires once per store batch).
 */
export function watchChains(store: Store<AppState>, ipc: Ipc): void {
  store.select(
    (s) => {
      const sig: unknown[] = [];
      for (const id of s.traces.order) {
        const t = s.traces.byId[id];
        if (!t || t.source.kind !== "transform") continue;
        const refSeqs = t.source.steps
          .filter((st) => st.type === "deconvolve")
          .map((st) => (st.type === "deconvolve" ? (s.traces.byId[st.ref]?.seq ?? -1) : -1));
        const lightSource = { ...t.source, steps: t.source.steps.map(lightStep) };
        sig.push([id, lightSource, s.traces.byId[t.source.input]?.seq ?? -1, refSeqs]);
      }
      return JSON.stringify(sig);
    },
    () => syncChains(store, ipc)
  );
}

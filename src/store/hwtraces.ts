/**
 * Slot-keyed hardware endpoint trace ids (issue #25 lot E3) — a LEAF module
 * beside store/sessionkey.ts, with the same discipline: values are imported
 * only from leaves (core/model), state.ts types come in TYPE-ONLY (erased at
 * build), so state.ts's runtime import of these values creates no cycle
 * (the E2 review-#8 class).
 *
 * The SLOT rides the trace id — `hw-in-left` for slot 0, `hw-in-left@1` for
 * slot 1 — and the id is the SINGLE carrier: no `slot` field on TraceSource
 * (a second carrier could disagree with the id, and hw metas are persisted
 * verbatim in workspace docs). Slot 0 returns the four historic ids
 * VERBATIM, by an explicit early return: every existing workspace, template
 * and e2e spec is untouched by construction, not by coincidence. Docs
 * persist the slot (via the id), never a device id — a doc carried to
 * another bench must not be bench-bound; device identity already rides
 * `TraceMeta.capture` (issue #40).
 */
import type { Chan, TraceId } from "../core/model";
import type { TraceMeta, TraceSource } from "./state";

export interface HwEndpointDef {
  key: "inputL" | "inputR" | "outputL" | "outputR";
  base: TraceId;
  label: string;
  /** Slot 0's exact hex — the validated series palette (In L/R keep the
   * classic L/R hues). Slots ≥ 1 draw from EXTRA_TRACE_COLORS instead. */
  color: string;
  kind: "hw_input" | "hw_output";
  channel: Chan;
}

/** The 4 hardware endpoints of one device — always present for every live
 * slot, never deletable (Traces V2). Order matters: it is the pool order
 * within a slot and the color-stepping index for slots ≥ 1. */
export const HW_ENDPOINTS: readonly HwEndpointDef[] = [
  { key: "inputL", base: "hw-in-left", label: "Input L", color: "#3987e5", kind: "hw_input", channel: "left" },
  { key: "inputR", base: "hw-in-right", label: "Input R", color: "#199e70", kind: "hw_input", channel: "right" },
  { key: "outputL", base: "hw-out-left", label: "Output L", color: "#e6a23c", kind: "hw_output", channel: "left" },
  { key: "outputR", base: "hw-out-right", label: "Output R", color: "#e06ca6", kind: "hw_output", channel: "right" },
];

/** Colors handed to user-created traces (transforms, programs) and to
 * slot ≥ 1 hardware endpoints, cycling — distinct from slot 0's 4 hues.
 * (Moved here from state.ts in lot E3; state.ts re-imports it.) */
export const EXTRA_TRACE_COLORS = [
  "#9a6ee2", "#4dc4cf", "#d1793c", "#7fb069", "#c95d63", "#5a7bd8",
];

export interface HwTraceIdSet {
  inputL: TraceId;
  inputR: TraceId;
  outputL: TraceId;
  outputR: TraceId;
}

const SLOT0_IDS: HwTraceIdSet = Object.freeze({
  inputL: "hw-in-left",
  inputR: "hw-in-right",
  outputL: "hw-out-left",
  outputR: "hw-out-right",
});

/** Memoized per slot: `hwTraceIds(n)` returns the SAME frozen object across
 * calls — id sets are read in per-frame paths (ingest, stream config). */
const idSetCache = new Map<number, HwTraceIdSet>();

/** The 4 endpoint trace ids of `slot`. Slot 0 → the historic ids VERBATIM;
 * slot n ≥ 1 → `<base>@<n>`. Callers pass a real session slot (a small
 * non-negative integer — the E1 registry contract, MAX_DEVICES-bounded). */
export function hwTraceIds(slot: number): HwTraceIdSet {
  if (slot === 0) return SLOT0_IDS;
  let ids = idSetCache.get(slot);
  if (!ids) {
    ids = Object.freeze({
      inputL: `hw-in-left@${slot}`,
      inputR: `hw-in-right@${slot}`,
      outputL: `hw-out-left@${slot}`,
      outputR: `hw-out-right@${slot}`,
    });
    idSetCache.set(slot, ids);
  }
  return ids;
}

/** Strict reverse: `<base>` → 0, `<base>@<n≥1>` → n, anything else → null.
 * `@0`, `@01`, `@x` and near-miss names all return null (NEVER slot 0):
 * a hand-edited doc must not be able to alias the default device's ids. */
const HW_ID_RE = /^(hw-in-left|hw-in-right|hw-out-left|hw-out-right)(?:@([1-9][0-9]*))?$/;

export function hwSlotOfTraceId(id: TraceId): number | null {
  const m = HW_ID_RE.exec(id);
  if (!m) return null;
  return m[2] === undefined ? 0 : Number(m[2]);
}

export function isHwTraceId(id: TraceId): boolean {
  return hwSlotOfTraceId(id) !== null;
}

/** The canonical TraceSource for a hw endpoint id, or null for non-hw ids —
 * what `reconcileHwTraces` forces back onto canonical ids (a hand-edited
 * doc must not turn `hw-in-left` into a `memory` trace). */
export function hwTraceSource(id: TraceId): TraceSource | null {
  const m = HW_ID_RE.exec(id);
  if (!m) return null;
  const def = HW_ENDPOINTS.find((e) => e.base === m[1])!;
  return { kind: def.kind, channel: def.channel };
}

/** Slot ≥ 1 labels are SLOT-derived (`Input L #2`, human-numbered), never
 * the device alias: aliases are bench-bound (localStorage, by registry id)
 * and must not leak into persisted TraceMeta.label. */
function hwLabel(def: HwEndpointDef, slot: number): string {
  return slot === 0 ? def.label : `${def.label} #${slot + 1}`;
}

/** Deterministic slot ≥ 1 endpoint color — a doc round-trips stably. */
function hwColor(def: HwEndpointDef, slot: number, index: number): string {
  if (slot === 0) return def.color;
  return EXTRA_TRACE_COLORS[((slot - 1) * HW_ENDPOINTS.length + index) % EXTRA_TRACE_COLORS.length];
}

/** Fresh TraceMeta[] for `slot`'s 4 endpoints (slot 0 ≡ the historic
 * initialTraces() metas, pinned in vitest). Fresh objects each call — the
 * store owns their lifecycle. */
export function hwTraceMetas(slot: number): TraceMeta[] {
  const ids = hwTraceIds(slot);
  return HW_ENDPOINTS.map((def, i) => ({
    id: ids[def.key],
    label: hwLabel(def, slot),
    color: hwColor(def, slot, i),
    source: { kind: def.kind, channel: def.channel },
    domains: [],
    seq: 0,
    offsetDb: null,
    capture: null,
  }));
}

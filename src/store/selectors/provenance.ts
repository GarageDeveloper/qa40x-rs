/**
 * Export-owner resolution (issue #25 lot F5): which DEVICE an exported
 * trace's bench header describes. Before this module, every export header
 * read the FOCUSED session — exporting slot 0's data under a slot-1 focus
 * stamped slot 1's model, serial, ranges and converter OFFSETS onto slot 0's
 * numbers (the four-offsets bug class in header form).
 *
 * The unprefixed bench block's meaning with F5: "the bench at export time,
 * for the device that OWNS this data" — three outcomes only:
 *
 *  - the owning session is live and its identity is consistent with the
 *    trace's capture → that session's device, never another's;
 *  - the owner is KNOWN but not live (dormant slot, slot recycled to a
 *    different unit, evicted session) → null: `device_model=none`, no
 *    substituted converter — the identity lives in the `capture_*` block,
 *    which the emit gate then always writes (a null-device live bench can't
 *    match any real capture signature);
 *  - the owner is UNKNOWN (no slot in the id, no program binding, no origin,
 *    no stamped identity) → the focused session, exactly as before F5 —
 *    nothing is being contradicted, and this keeps single-device benches
 *    byte-identical.
 *
 * Deliberately NOT reused: `sessionKeyForTrace` silently answers "the focus"
 * for every non-hw id — that is precisely the skew, wearing a helper's
 * name. `deviceForTrace` (E3/E4) is correct for hw ids; this module is its
 * generalisation over program bindings, origin chains and identity revival.
 */
import type { TraceId } from "../../core/model";
import type { AppState, DeviceState, TraceMeta, TraceSource } from "../state";
import { hwSlotOfTraceId } from "../hwtraces";
import { sessionKeyForSlot } from "../sessionkey";
import type { SessionKey } from "../sessionkey";
import { focusedDevice, session } from "./session";

export type ExportOwner =
  | { kind: "session"; key: SessionKey; device: DeviceState }
  | { kind: "dormant"; key: SessionKey | null }
  | { kind: "unknown" };

/** The model+serial identity a trace's own capture snapshot claims. Held
 * fixed through the whole resolution — the exported DATA's identity, never
 * re-read from whatever session a structural key lands on. */
type Identity = { model: string; serial: string };

function traceIdentity(meta: TraceMeta): Identity | null {
  const d = meta.capture?.device;
  return d ? { model: d.model, serial: d.serial } : null;
}

/** Origin chains are user-built (freeze of a transform of a freeze…); the
 * cap keeps a hand-edited cyclic doc from hanging the export. 8 covers any
 * chain a human plausibly builds through the UI. */
const MAX_ORIGIN_DEPTH = 8;

/**
 * The session key a trace STRUCTURALLY belongs to, or null:
 *  1. the slot in a hw endpoint id (`hw-in-left@1` → slot 1);
 *  2. a program's run binding (`runKey`, captured at run entry), then its
 *     `deviceSlot` pin — `runKey` clears at completion and `deviceSlot`
 *     null means follows-focus, so this often falls through, by design;
 *  3. the origin walk: `memory` → `frozenFrom`, `transform` → `input` —
 *     capture provenance rides the copy verbatim, so the walk only has to
 *     find the SLOT, depth-capped with a visited set.
 */
function structuralKey(s: AppState, meta: TraceMeta): SessionKey | null {
  const visited = new Set<TraceId>();
  let cur: TraceMeta | undefined = meta;
  for (let depth = 0; cur && depth <= MAX_ORIGIN_DEPTH; depth++) {
    if (visited.has(cur.id)) return null;
    visited.add(cur.id);
    const slot = hwSlotOfTraceId(cur.id);
    if (slot !== null) return sessionKeyForSlot(slot);
    const p = s.programs.byId[cur.id];
    if (p) {
      if (p.runKey !== null) return p.runKey;
      if (p.deviceSlot !== null) return sessionKeyForSlot(p.deviceSlot);
    }
    const src: TraceSource = cur.source;
    const next: TraceId | null =
      src.kind === "memory" ? src.frozenFrom : src.kind === "transform" ? src.input : null;
    if (next === null) return null;
    cur = s.traces.byId[next];
  }
  return null;
}

/** The live session whose open unit IS the trace's captured device
 * (model+serial — the `reviveCandidateId` matching rule). Rescues a frozen
 * copy whose origin trace was deleted, and a completed follows-focus
 * program after the focus moved. Slot order for determinism. */
function identityOwner(s: AppState, identity: Identity): ExportOwner | null {
  const sessions = Object.values(s.devices.sessions).sort((a, b) => a.slot - b.slot);
  for (const sess of sessions) {
    const info = sess.device.info;
    if (info && info.model === identity.model && info.serial === identity.serial) {
      return { kind: "session", key: sess.key, device: sess.device };
    }
  }
  return null;
}

/** Resolve the device that owns `id`'s data — see the module doc for the
 * three outcomes and the priority order. */
export function traceExportOwner(s: AppState, id: TraceId | null): ExportOwner {
  const meta = id !== null ? s.traces.byId[id] : undefined;
  if (!meta) return { kind: "unknown" };
  const identity = traceIdentity(meta);
  const key = structuralKey(s, meta);
  if (key !== null) {
    const sess = session(s, key);
    const info = sess?.device.info ?? null;
    // Trust the structural session only while it is LIVE and does not
    // contradict the data's identity: a recycled slot (different unit now
    // open there) or a disconnected slot-0 session (info nulled) must
    // never lend its converter to another device's numbers.
    if (sess && info) {
      if (!identity || (info.model === identity.model && info.serial === identity.serial)) {
        return { kind: "session", key, device: sess.device };
      }
    } else if (sess && !identity) {
      // A live-but-dead session (disconnected slot 0) owning unstamped
      // data: nothing to revive by identity, honest none below.
      return { kind: "dormant", key };
    }
    if (identity) {
      const revived = identityOwner(s, identity);
      if (revived) return revived;
    }
    return { kind: "dormant", key };
  }
  if (identity) {
    const revived = identityOwner(s, identity);
    if (revived) return revived;
    return { kind: "dormant", key: null };
  }
  return { kind: "unknown" };
}

/** The DeviceState an export header should describe for `o` — null means
 * "no device": `device_model=none`, no rates, no ranges, NO offsets. This
 * is the ONE place the focused fallback lives (the `unknown` branch, the
 * pre-F5 compatibility rule). */
export function exportOwnerDevice(s: AppState, o: ExportOwner): DeviceState | null {
  switch (o.kind) {
    case "session":
      return o.device;
    case "dormant":
      return null;
    case "unknown":
      return focusedDevice(s);
  }
}

/**
 * The distinct device identities behind a set of drawn traces, in column
 * order — each member's own capture identity, else its resolved owner's.
 * The tile export writes these as one additive `export_devices` line when
 * there are ≥ 2 (the file's answer to "which devices are in here");
 * model+serial only, bench-portable like every export line.
 */
export function exportDeviceRollCall(s: AppState, ids: TraceId[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const meta = s.traces.byId[id];
    if (!meta) continue;
    let identity = traceIdentity(meta);
    if (!identity) {
      const owner = traceExportOwner(s, id);
      const info = owner.kind === "session" ? owner.device.info : null;
      identity = info ? { model: info.model, serial: info.serial } : null;
    }
    if (!identity) continue;
    const label = `${identity.model} ${identity.serial}`;
    if (!seen.has(label)) {
      seen.add(label);
      out.push(label);
    }
  }
  return out;
}

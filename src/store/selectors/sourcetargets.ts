/**
 * Per-target view of one source's routing matrix (issue #25 lot F3): what
 * the Signal Sources row editor renders — one row per POTENTIAL target (the
 * focus pseudo-target, every live session, then the dormant slots the matrix
 * still names), each carrying its own cell state, its own bin-grid readout
 * (snapped on the TARGET session's rate — the #14 class: the focused grid
 * next to a 192 kHz-pinned source lies), its own slot error and a note that
 * says WHY a target is silent (dormant, unadopted, off) instead of silently
 * retargeting (lot-F recorded default).
 *
 * Selector discipline: leaf values only (`core/bins`, `core/routing`,
 * `store/sessionkey`) plus sibling selectors — never an action module.
 */
import { playedFrequency } from "../../core/bins";
import { routeChecks, sourceRouting } from "../../core/routing";
import type { AppState, SourceMeta, SourceRoute } from "../state";
import { isRoutable, session, sessionKeys } from "./session";
import { liveSessionCount, sessionLabel } from "./devices";
import { sessionKeyForSlot, slotOfSessionKey } from "../sessionkey";
import type { SessionKey } from "../sessionkey";

/** A target row's identity in testids and handlers: `"focus"` for the
 * focus-following pseudo-target (`slot: null`), the decimal slot otherwise. */
export type TargetTag = string;

export function tagOfSlot(slot: number | null): TargetTag {
  return slot === null ? "focus" : String(slot);
}

export interface SourceTargetVM {
  tag: TargetTag;
  slot: number | null;
  key: SessionKey;
  /** Row label: `Follows focus — #1 now` / `#2 QA402 · 0DE0` / `#3 — not connected`. */
  label: string;
  /** The unit's display name (alias-aware), "" for an absent slot. */
  deviceName: string;
  /** Display number: the row's slot + 1 (the focus row shows the focused
   * session's — the number group headers and exports use everywhere). */
  n: number;
  /** The matrix has a cell for this target. */
  present: boolean;
  route: SourceRoute;
  left: boolean;
  right: boolean;
  status: "disconnected" | "connecting" | "connected" | "absent";
  /** Session exists and is connected — the target can actually play. */
  live: boolean;
  routable: boolean;
  /** The grid value THIS target's converter would play, null while its rate
   * is unknown — never the 48 kHz wire fallback: printing a confident
   * number for an absent converter is the deviceForTrace bug class. */
  playedHz: number | null;
  /** THIS session's backend slot error for the source (never the focused
   * session's — error attribution follows the target). */
  error: string | null;
  note: string;
  noteErr: boolean;
  /** This row and another resolve onto the SAME session right now — the
   * mixer coalesces them into one slot with the union route (F2 pin). */
  sameAsFocus: boolean;
}

function routeGlyph(route: SourceRoute): string {
  return route === "both" ? "LR" : route === "left" ? "L" : route === "right" ? "R" : "–";
}

function routeLong(route: SourceRoute): string {
  return route === "both"
    ? "Out L+R"
    : route === "left"
      ? "Out L"
      : route === "right"
        ? "Out R"
        : "off";
}

const COMBINED_NOTE = "same device as Focused right now — channels are combined";

/** The editor rows for `srcId`, in display order: focus first, live sessions
 * by slot, then the dormant slots the matrix still pins. Empty for an
 * unknown source id. */
export function sourceTargetVMs(s: AppState, srcId: string): SourceTargetVM[] {
  const src = s.sources.byId[srcId];
  if (!src) return [];
  const cells = new Map(sourceRouting(src).map((t) => [tagOfSlot(t.slot), t.route]));
  const focusSlot = slotOfSessionKey(s.devices.focus);
  // Coalescing tell: the implicit focus cell and an explicit cell for the
  // focused slot resolve onto ONE session — flag both rows.
  const combined = cells.has("focus") && cells.has(String(focusSlot));

  const rows: Array<{ tag: TargetTag; slot: number | null; key: SessionKey }> = [
    { tag: "focus", slot: null, key: s.devices.focus },
  ];
  const liveSlots = new Set<number>();
  for (const key of sessionKeys(s)) {
    const slot = slotOfSessionKey(key);
    liveSlots.add(slot);
    rows.push({ tag: String(slot), slot, key });
  }
  const dormant = [...cells.keys()]
    .filter((tag) => tag !== "focus" && !liveSlots.has(Number(tag)))
    .map(Number)
    .sort((a, b) => a - b);
  for (const slot of dormant) {
    rows.push({ tag: String(slot), slot, key: sessionKeyForSlot(slot) });
  }

  const hasFreq = src.kind !== "script" && "frequencyHz" in src;
  return rows.map(({ tag, slot, key }) => {
    const sess = session(s, key);
    const status = sess?.device.status ?? "absent";
    const live = status === "connected";
    const routable = sess !== null && isRoutable(s, key);
    const n = (slot ?? focusSlot) + 1;
    const deviceName = sess ? sessionLabel(s, key) : "";
    const label =
      slot === null
        ? `Follows focus — #${n} now`
        : sess
          ? `#${n} ${deviceName}`
          : `#${n} — not connected`;
    const route = cells.get(tag) ?? null;
    const present = route !== null;
    const checks = routeChecks(route ?? "off");
    const rate = sess?.device.config?.sample_rate ?? null;
    const playedHz =
      hasFreq && rate !== null
        ? playedFrequency(
            (src as { frequencyHz: number }).frequencyHz,
            rate,
            s.acquisition.coherentGen,
            s.acquisition.fftSize
          )
        : null;
    const error =
      present && sess
        ? sess.run.slotErrors.find((e) => e.id === srcId)?.error ?? null
        : null;
    const sameAsFocus = combined && (slot === null || key === s.devices.focus);
    const lockId = sess?.run.programLock ?? null;
    let note = "";
    let noteErr = false;
    if (status === "absent" || status === "disconnected") note = "not connected";
    else if (status === "connecting") note = "connecting…";
    else if (!routable) note = "device id not adopted yet";
    else if (error !== null) {
      note = error;
      noteErr = true;
    } else if (present && lockId !== null) {
      // A routing edit on a program-locked session is ACCEPTED but deferred
      // (outputonly's gate refuses the DAC touch mid-sweep) — say so
      // instead of letting the summary claim a mix the device is not
      // playing yet (F3 review #4). Since lot F4 the promise is real:
      // runProgram's release path re-arms the session for routings that
      // APPEARED during the run (armSessionForSources), and a session
      // that ran resumes with its rebuilt mix. Recorded limit (F4 review
      // note #8): a session sitting in output-only MODE with its
      // generator idle at program start is not re-armed — the edit lands
      // on the next source gesture there.
      const label = s.traces.byId[lockId]?.label ?? "program";
      note = `measurement "${label}" is running — applies when it finishes`;
    } else if (sameAsFocus) note = COMBINED_NOTE;
    else if (present && route === "off") note = "off (no channel)";
    return {
      tag,
      slot,
      key,
      label,
      deviceName,
      n,
      present,
      route: route ?? "off",
      left: present && checks.left,
      right: present && checks.right,
      status,
      live,
      routable,
      playedHz,
      error,
      note,
      noteErr,
      sameAsFocus,
    };
  });
}

/** The row's collapsed button: a STABLE `Routing` label (Raphaël,
 * 2026-07-30 — the per-cell `→ focus LR · #2 L` text was cryptic and
 * jittered as cells changed), plus a ⚠ when some cell's target cannot play
 * right now — dead session OR a connected-but-unadopted slot ≥ 1 (every
 * transport verb refuses it too, F3 review #5). The full map (compact line
 * + one line per device) lives in the title. */
export function routingSummary(vms: SourceTargetVM[]): { text: string; title: string } {
  const present = vms
    .filter((v) => v.present)
    .sort((a, b) => (a.slot === null ? -1 : b.slot === null ? 1 : a.slot - b.slot));
  const warn = present.some((v) => !(v.live && v.routable));
  const tokens = present.map((v) => {
    const tagText = v.slot === null ? "focus" : `#${v.n}`;
    return `${tagText} ${routeGlyph(v.route)}${v.live && v.routable ? "" : " ⚠"}`;
  });
  const lines = present.map((v) => {
    if (!v.live) return `#${v.n}: not connected — nothing plays there`;
    const name = v.slot === null ? `Follows focus (${v.deviceName})` : `#${v.n} ${v.deviceName}`;
    return `${name}: ${routeLong(v.route)}${v.routable ? "" : " (device id not adopted yet)"}`;
  });
  return {
    text: `Routing${warn ? " ⚠" : ""}`,
    title: [
      tokens.length ? `→ ${tokens.join(" · ")}` : "→ off",
      ...lines,
      "Click to edit where this source plays.",
    ].join("\n"),
  };
}

/** The params-line grid readout in matrix mode: the shared value when every
 * live target agrees (byte-identical wording to the legacy readout), a
 * count when they disagree (each converter has its own grid — no single
 * value to show, the F2-carried gap), an honest `—` when nothing connected
 * plays the source. */
export function snappedReadout(
  vms: SourceTargetVM[],
  askedHz: number
): { text: string; title: string } {
  // Cells routed OFF don't count: a fully-silent matrix must read `→ —`,
  // not print a confident grid value next to a source that drives nothing
  // (Raphaël validation round 2 — it read as "the sine still plays").
  const live = vms.filter(
    (v) => v.present && v.live && v.route !== "off" && v.playedHz !== null
  );
  const values = [...new Set(live.map((v) => v.playedHz as number))];
  if (values.length === 0) {
    return { text: "→ —", title: "Not routed to any connected device" };
  }
  if (values.length === 1) {
    const moved = Math.abs(values[0] - askedHz) > 1e-9;
    return {
      text: `→ ${values[0].toFixed(4)} Hz`,
      title: moved
        ? "Actually-played frequency: the tone is rounded onto the FFT bin " +
          "grid (Round to eliminate leakage)"
        : "Actually-played frequency (the ask, played verbatim)",
    };
  }
  const perDevice = live.map((v) => `#${v.n} ${(v.playedHz as number).toFixed(4)} Hz`);
  return {
    text: `→ ${values.length} values`,
    title:
      perDevice.join(" · ") +
      "\nEach device rounds onto its own bin grid — open Routing for the per-device values.",
  };
}

/** Which silhouette a source row renders (decision D-F3-1): the per-device
 * matrix editor at ≥ 2 live sessions OR whenever the matrix is explicit (a
 * doc from a bigger bench must keep its pinned routing editable — the
 * editor IS the way out); the byte-identical legacy L/R pair otherwise. */
export function sourceRowMode(s: AppState, src: SourceMeta): "legacy" | "matrix" {
  return liveSessionCount(s) >= 2 || src.targets.length > 0 ? "matrix" : "legacy";
}

/** The source can drive at least one CONNECTED device (an `off` cell counts:
 * a silent DAC program is still a program — sessionHasSources' rule). */
export function hasLiveTarget(vms: SourceTargetVM[]): boolean {
  return vms.some((v) => v.present && v.live);
}

/** The row's error badge: each error attributed to ITS target session —
 * prefixed with the device number once several sessions are live, bare (the
 * pre-F3 byte-identical form) otherwise. Deduped by SESSION (the coalesced
 * focus + focused-slot pair reads the same slotErrors entry — one line, not
 * two). Null when no target errs. */
export function rowErrorText(vms: SourceTargetVM[], multi: boolean): string | null {
  const seen = new Set<string>();
  const errs = vms.filter((v) => {
    if (v.error === null || seen.has(v.key)) return false;
    seen.add(v.key);
    return true;
  });
  if (errs.length === 0) return null;
  return errs.map((v) => (multi ? `#${v.n}: ${v.error}` : (v.error as string))).join("\n");
}

/**
 * Source-routing selectors (issue #25 lot F2): which sources drive which
 * SESSION, resolved through each source's device × channel matrix
 * (`core/routing.ts::sourceRouting` — explicit `targets`, or the implicit
 * focus-following one). This module is where the matrix meets the live
 * bench; the mixer-slot building on top lives in `actions/stream.ts`.
 *
 * Import discipline (E2 review #8): VALUES only from the LEAF modules
 * (`store/sessionkey.ts`, `core/routing.ts` — no runtime imports of their
 * own) and from `selectors/session.ts`; `store/state.ts` types are erased
 * at compile time. Never import SLOT0/values from state.ts here.
 */
import { sourceRouting, unionRoutes } from "../../core/routing";
import type { AppState, SourceMeta, SourceRoute, SourceTarget } from "../state";
import { session } from "./session";
import { sessionKeyForSlot } from "../sessionkey";
import type { SessionKey } from "../sessionkey";

/** One source as ONE session receives it: the coalesced route of every
 * matrix cell that resolved onto that session — both dimensions (Line out
 * and the I2S port, issue #71) coalesced independently. */
export interface RoutedSource {
  src: SourceMeta;
  route: SourceRoute;
  i2sRoute: SourceRoute;
}

/** The session a matrix cell resolves to: the FOCUSED session for the
 * implicit `slot: null` target, the slot's own session key otherwise. The
 * returned key may name no live session (a pinned target for an absent
 * device) — comparisons against LIVE keys then simply never match, which
 * is the whole dormant-target policy (silent, lot-F recorded default). */
export function targetSessionKey(s: AppState, t: SourceTarget): SessionKey {
  return t.slot === null ? s.devices.focus : sessionKeyForSlot(t.slot);
}

/**
 * The playing sources that resolve onto `key`, in pool order, each with
 * its coalesced route. Coalescing is mandatory, not a nicety: a source
 * resolving twice onto one session (implicit focus target + an explicit
 * target naming the focused slot) would otherwise emit two mixer slots
 * with the SAME id — the backend mixer SUMS them (+6 dB of unintended
 * stimulus into a DUT) and SlotError naming would be ambiguous. Routes
 * are OR-ed cell-wise instead (`unionRoutes`).
 *
 * `route: "off"` cells still resolve (matching the pre-F2 rule that
 * `slotsFromSources` filters on `playing` only): an Off slot is a DAC
 * program with a silent source, not an absent one — which is what makes
 * `sessionHasSources` mean "this session owns a DAC program".
 */
export function sourcesForSession(s: AppState, key: SessionKey): RoutedSource[] {
  const out: RoutedSource[] = [];
  const at = new Map<string, number>();
  for (const id of s.sources.order) {
    const src = s.sources.byId[id];
    if (!src || !src.playing) continue;
    for (const t of sourceRouting(src)) {
      if (targetSessionKey(s, t) !== key) continue;
      const i = at.get(src.id);
      if (i === undefined) {
        at.set(src.id, out.length);
        out.push({ src, route: t.route, i2sRoute: t.i2sRoute });
      } else {
        out[i] = {
          src: out[i].src,
          route: unionRoutes(out[i].route, t.route),
          i2sRoute: unionRoutes(out[i].i2sRoute, t.i2sRoute),
        };
      }
    }
  }
  return out;
}

/** Whether `key`'s session owns a DAC program — the per-session successor
 * of the bench-global "any source playing" predicate (outputonly.ts). */
export function sessionHasSources(s: AppState, key: SessionKey): boolean {
  return sourcesForSession(s, key).length > 0;
}

/** Whether some playing source AUDIBLY routes to `key`'s I2S port (issue
 * #71). Off cells don't count here — unlike `sessionHasSources`, this
 * feeds the port UI's "routed but the port is off" note, where a silent
 * cell has nothing to announce. The port itself streams silence while
 * enabled regardless. */
export function sessionHasI2sSources(s: AppState, key: SessionKey): boolean {
  return sourcesForSession(s, key).some((r) => r.i2sRoute !== "off");
}

/** The LIVE sessions one source currently resolves onto (pinned targets
 * for absent slots drop out — nothing to drive). Play/pause fan-out and
 * the F3 row UI read this. */
export function sessionsForSource(s: AppState, id: string): SessionKey[] {
  const src = s.sources.byId[id];
  if (!src) return [];
  const out: SessionKey[] = [];
  for (const t of sourceRouting(src)) {
    const key = targetSessionKey(s, t);
    if (session(s, key) && !out.includes(key)) out.push(key);
  }
  return out;
}

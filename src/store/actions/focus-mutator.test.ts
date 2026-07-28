/**
 * Source-scan pin (issue #25 lot E4, tester-gate item 9): `devices.focus`
 * (the SessionKey the WIRE-VISIBLE `setFocusedSession` doc block warns
 * about — `buildStreamConfig`'s `slots` follow it, so a stray write
 * anywhere else would let the DAC program silently drift from what the
 * chrome shows) must be written from exactly ONE production module,
 * actions/devices.ts (mintSession/dropSession/setFocusedSession/
 * deriveDevices all live there), plus its state.ts boot seed.
 *
 * A pure TEXT scan, not a type-level check: the violation this guards
 * against is textual, not structural — `{ ...s.devices, focus: someKey }`
 * typechecks fine from ANY module that has `DevicesState` in scope, because
 * nothing in the type system confines the write to one file. If a future
 * change needs a second legitimate writer, this test is the one-line
 * update that makes the new writer visible in review, rather than a silent
 * bypass of setFocusedSession's mandatory re-sync-every-stream gesture
 * (E3 review #1).
 *
 * Heuristic, deliberately coarse (documented rather than asserted
 * exhaustive): a file is flagged when it contains BOTH the word `devices`
 * and a tight `focus:` object-literal key (no space before the colon —
 * this codebase's prettier formatting always writes object keys as
 * `key: value`, never `key : value`). The no-space requirement is what
 * keeps this from false-positiving on `s.devices.focus : sessionKeyForSlot(slot)`
 * (selectors/session.ts's `sessionKeyForTrace` — a TERNARY, not a write:
 * prettier spaces both sides of `?`/`:` there). Every CURRENT writer of the
 * unrelated `layout.focus` field (tile focus — layout.ts, templates.ts,
 * persist.ts, workspace.ts) never mentions the word "devices" at all
 * (verified by inspection when writing this pin), so the co-occurrence
 * requirement doesn't need to distinguish the two `focus:` fields by
 * shape — only by which file bothers to mention devices at all. A future
 * file that legitimately needs both words without writing devices.focus
 * would need a tighter regex here — a one-line fix, not a silent hole.
 */
import { describe, expect, it } from "vitest";

const sources = import.meta.glob("/src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** The one legitimate mutator, plus the boot seed. Test files (fixtures
 * hand-build session maps directly — never production code) are excluded
 * separately, by suffix. */
const ALLOWLISTED_PATHS = ["/src/store/actions/devices.ts", "/src/store/state.ts"];

function isAllowlisted(path: string): boolean {
  return (
    ALLOWLISTED_PATHS.includes(path) ||
    path.endsWith(".test.ts") ||
    path.endsWith(".fixtures.ts")
  );
}

/** A file is a candidate offender when it mentions `devices` at all AND
 * carries a tight (no-space-before-colon) `focus:` object-literal key. */
function looksLikeADevicesFocusWrite(text: string): boolean {
  return /\bdevices\b/.test(text) && /\bfocus:/.test(text);
}

describe("devices.focus is written from exactly one place (issue #25 lot E4)", () => {
  it("no module outside actions/devices.ts (and state.ts's boot seed) carries a devices-context `focus:` key", () => {
    const offenders = Object.entries(sources)
      .filter(([path]) => !isAllowlisted(path))
      .filter(([, text]) => looksLikeADevicesFocusWrite(text))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("sanity: the allowlisted files DO carry the pattern the scan looks for — the regex isn't vacuously passing", () => {
    const devicesTs = sources["/src/store/actions/devices.ts"];
    const stateTs = sources["/src/store/state.ts"];
    expect(devicesTs, "devices.ts must be present in the glob").toBeDefined();
    expect(stateTs, "state.ts must be present in the glob").toBeDefined();
    expect(looksLikeADevicesFocusWrite(devicesTs)).toBe(true);
    expect(looksLikeADevicesFocusWrite(stateTs)).toBe(true);
  });

  it("sanity: the ternary ('focus :' with a space, selectors/session.ts) does NOT trip the tight regex — proving the false-positive it was built to avoid is actually avoided", () => {
    const sessionTs = sources["/src/store/selectors/session.ts"];
    expect(sessionTs, "selectors/session.ts must be present in the glob").toBeDefined();
    expect(sessionTs).toMatch(/\bdevices\b/); // it DOES mention devices...
    expect(sessionTs).toContain("s.devices.focus :"); // ...and DOES have the ternary spelling...
    expect(looksLikeADevicesFocusWrite(sessionTs)).toBe(false); // ...but the tight regex passes it through
  });
});

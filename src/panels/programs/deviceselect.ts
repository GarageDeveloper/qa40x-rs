/**
 * The ⚙ dialogs' Device row (issue #25 lot F4): which SLOT a program
 * targets — "Follows focus" (the default, `deviceSlot: null`) or an
 * explicit session pin. Hidden on a single-device bench with no existing
 * pin, so the historical dialogs stay byte-identical; a pin naming a slot
 * with NO live session (a bigger bench's doc) stays selectable, honestly
 * labeled — the same escape-hatch rule as F3's routing editor.
 */
import type { Store } from "../../store/store";
import type { AppState } from "../../store/state";
import { session, sessionKeys } from "../../store/selectors/session";
import { liveSessionCount, sessionLabel } from "../../store/selectors/devices";
import { sessionKeyForSlot, slotOfSessionKey } from "../../store/sessionkey";
import { el } from "../../ui/dom";

export interface ProgramDeviceChoice {
  /** The `deviceSlot` value this choice writes (null = follows the focus). */
  slot: number | null;
  label: string;
}

/** The device choices a program offers — the ⚙ dialogs' Device row and the
 * row's inline "· on #N" picker (panel.ts) share this list, so the two
 * surfaces can never drift: "Follows focus" first, then every live
 * session, then (when the pin names a slot with no live session) the
 * honest "not connected" entry. */
export function programDeviceChoices(
  s: AppState,
  id: string
): ProgramDeviceChoice[] {
  const pinned = s.programs.byId[id]?.deviceSlot ?? null;
  const keys = sessionKeys(s);
  const focusSlot = slotOfSessionKey(s.devices.focus);
  const choices: ProgramDeviceChoice[] = [
    { slot: null, label: `Follows focus — #${focusSlot + 1} now` },
    ...keys.map((key) => {
      const slot = slotOfSessionKey(key);
      return { slot, label: `#${slot + 1} — ${sessionLabel(s, key)}` };
    }),
  ];
  if (pinned !== null && !keys.includes(sessionKeyForSlot(pinned))) {
    choices.push({ slot: pinned, label: `#${pinned + 1} — not connected` });
  }
  return choices;
}

export interface ProgramDeviceRow {
  row: HTMLElement;
  select: HTMLSelectElement;
  /** The selection as a `deviceSlot` value (null = follows the focus). */
  value(): number | null;
  /** The selection's CURRENT sample rate (Hz) — the focused session's for
   * "Follows focus", the pinned session's otherwise; 48 k when the pinned
   * slot has no live session (the historical fallback). */
  sampleRateHz(): number;
}

export function programDeviceRow(
  store: Store<AppState>,
  id: string
): ProgramDeviceRow {
  const s = store.get();
  const prog = s.programs.byId[id];
  const pinned = prog?.deviceSlot ?? null;

  const select = el("select.field", {
    "data-testid": `prog-device-${id}`,
  }) as HTMLSelectElement;
  select.append(
    ...programDeviceChoices(s, id).map((c) =>
      el("option", { value: c.slot === null ? "" : String(c.slot) }, c.label)
    )
  );
  select.value = pinned === null ? "" : String(pinned);
  if (prog?.run === "running") {
    // A running program keeps the binding it started with
    // (`setProgramDeviceSlot` refuses a re-pin mid-run) — disabling the
    // select with the reason beats an Apply that silently drops the pick
    // ("never silently inert", review SHOULD-FIX #3).
    select.disabled = true;
    select.title = "The program is running — its device was bound at start. Stop it to re-pin.";
  }

  const row = el(
    "label.dialog__row",
    {
      title:
        "Which device this program drives. A running program keeps the " +
        "binding it started with — moving the focus never migrates it.",
    },
    el("span.dialog__label", {}, "Device"),
    select
  );
  if (liveSessionCount(s) <= 1 && pinned === null) row.classList.add("u-hidden");

  const value = (): number | null => (select.value === "" ? null : Number(select.value));
  return {
    row,
    select,
    value,
    sampleRateHz: () => {
      const s2 = store.get();
      const slot = value();
      const key = slot === null ? s2.devices.focus : sessionKeyForSlot(slot);
      return session(s2, key)?.device.config?.sample_rate ?? 48000;
    },
  };
}

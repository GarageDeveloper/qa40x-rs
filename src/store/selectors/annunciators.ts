/**
 * Annunciator badges derived from state — pure, unit-testable.
 *
 * ATTEN is *derived*, never read: the QA40x input attenuator has no
 * register; the hardware engages it at input range ≥ 24 dBV (measured —
 * see CLAUDE.md "Hardware facts"). Modeling it as anything but a
 * derivation was an early mistake; keep it a pure function of the range.
 */
import type { AppState } from "../state";
import { focusedDevice, focusedRun } from "./session";

export const ATTEN_THRESHOLD_DBV = 24;

export interface Annunciator {
  key: string;
  label: string;
  /** lit=true renders the badge active. */
  lit: boolean;
  /** Alarm badges (clipping) get the alert styling when lit. */
  alarm?: boolean;
  /** Warning badges (near full scale) get the amber styling when lit —
   * weaker than `alarm`, which wins if both are set. */
  warn?: boolean;
}

export function attenEngaged(inputRangeDbv: number): boolean {
  return inputRangeDbv >= ATTEN_THRESHOLD_DBV;
}

export function annunciators(s: AppState): Annunciator[] {
  const cfg = focusedDevice(s).config;
  const run = focusedRun(s);
  const inputDbv = cfg?.input_gain ?? null;
  const badges: Annunciator[] = [
    {
      key: "atten",
      label: "ATTEN",
      lit: inputDbv !== null && attenEngaged(inputDbv),
    },
    {
      // One badge, three states — the backend judges (ClipState in
      // MixStatus): "clip" = red alarm, "near" = amber warning (within 1 dB
      // of full scale, latched so transients stay visible), "none" = unlit.
      key: "clip",
      label: "CLIP",
      lit: run.clip.input !== "none",
      alarm: run.clip.input === "clip",
      warn: run.clip.input === "near",
    },
    { key: "outclip", label: "OUT CLIP", lit: run.clip.output, alarm: true },
    {
      key: "avg",
      label:
        s.acquisition.averaging.mode === "off"
          ? "AVG"
          : `AVG ×${s.acquisition.averaging.count}`,
      lit: s.acquisition.averaging.mode !== "off",
    },
    { key: "pkhold", label: "PK HOLD", lit: s.acquisition.peakHold },
  ];
  return badges;
}

/**
 * Transform-chain helpers (M4): the auto-label and the dialog's flat model
 * of a chain (ported from v1 transformdialog.ts — the step model itself is
 * an ordered `TransformStep[]`, so a richer editor can replace the flat
 * dialog without a schema change).
 */
import type { TransformStep } from "../gen";
import type { TraceId } from "./model";

/** Mirrors `measurements::filters::DEFAULT_NOTCH_Q` backend-side. */
export const DEFAULT_NOTCH_Q = 8;

/** Auto-name for a transform trace, from its chain: "A-weighted · Notch 60
 * Hz". Kept in sync while the user hasn't renamed. */
export function transformLabel(steps: TransformStep[]): string {
  const tags = steps.map((s) => {
    switch (s.type) {
      case "weighting":
        return s.mode === "riaa" ? "RIAA" : `${s.mode.toUpperCase()}-weighted`;
      case "notch":
        return `Notch ${s.freq} Hz`;
      case "deconvolve":
        return "÷ ref";
      case "script":
        return "script";
    }
  });
  return tags.length ? tags.join(" · ") : "Transform";
}

/** The dialog's flat working model of a chain (one instance of each step). */
export interface TransformDialogModel {
  input: TraceId;
  weighting: "none" | "a" | "c" | "riaa";
  notch: boolean;
  notchFreq: number;
  deconvolve: "none" | TraceId;
  script: string;
}

/** Flatten an ordered chain into the dialog model (first step of each type
 * wins). */
export function stepsToDialogModel(
  input: TraceId,
  steps: TransformStep[]
): TransformDialogModel {
  const m: TransformDialogModel = {
    input,
    weighting: "none",
    notch: false,
    notchFreq: 60,
    deconvolve: "none",
    script: "",
  };
  for (const s of steps) {
    if (s.type === "weighting" && m.weighting === "none") m.weighting = s.mode;
    else if (s.type === "notch" && !m.notch) {
      m.notch = true;
      m.notchFreq = s.freq;
    } else if (s.type === "deconvolve" && m.deconvolve === "none") m.deconvolve = s.ref;
    else if (s.type === "script" && !m.script) m.script = s.source;
  }
  return m;
}

/** Rebuild the ordered chain from the dialog model (weighting → notch →
 * deconvolve → script; the script runs last, in the backend sandbox). */
export function dialogModelToSteps(m: TransformDialogModel): TransformStep[] {
  const steps: TransformStep[] = [];
  if (m.weighting !== "none") steps.push({ type: "weighting", mode: m.weighting });
  if (m.notch && m.notchFreq > 0) {
    steps.push({ type: "notch", freq: m.notchFreq, q: DEFAULT_NOTCH_Q });
  }
  if (m.deconvolve !== "none") steps.push({ type: "deconvolve", ref: m.deconvolve });
  if (m.script.trim()) steps.push({ type: "script", source: m.script });
  return steps;
}

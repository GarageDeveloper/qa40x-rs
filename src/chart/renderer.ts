/**
 * The renderer boundary (plan §3.4): a chart consumes a precomputed
 * view-model — values ALREADY in display units — and draws. No converter
 * offsets, no unit math, no DSP behind this line.
 */
import type {
  HarmonicMarkVM,
  ScopeTriggerVM,
  SeriesVM,
  SweepSeriesVM,
  TdSeriesVM,
} from "../store/selectors/chartvm";

/** Spectrum-tile axis knobs — plain display state, no unit math behind it. */
export interface SpectrumAxis {
  xLog: boolean;
  yAuto: boolean;
  yMin: number;
  yMax: number;
}

export interface SpectrumRenderer {
  /** Replace the drawn series (called once per ingested frame). */
  setSeries(series: SeriesVM[]): void;
  /** Axis label for the level axis (display unit name, e.g. "dBV"). */
  setUnitLabel(label: string): void;
  setAxis(axis: SpectrumAxis): void;
  setPeakHold(on: boolean): void;
  resetPeakHold(): void;
  /** Harmonic markers (display-unit levels from the VM); [] clears them. */
  setHarmonics(marks: HarmonicMarkVM[]): void;
  destroy(): void;
}

/** The trigger drag callbacks (Lot A, issue #26): `onLevel` receives a
 * DISPLAY-unit value (the volts conversion happens in the tile, never in
 * the chart — plan §3.4); `onPosition` receives 0..1 of the window. Wired
 * ONCE per renderer instance (tile.ts, at renderer creation), not per frame.
 * `done` is false on every intermediate pointermove and true exactly once,
 * on pointerup — callers should only sync the value to the running stream
 * (IPC + full grid re-feed) when `done` is true, and just update the store
 * otherwise (review #10: a stream sync on every pointermove is wasteful). */
export interface ScopeTriggerHandlers {
  onLevel: (displayValue: number, done: boolean) => void;
  onPosition: (position: number, done: boolean) => void;
}

export interface ScopeRenderer {
  /** Replace the drawn series (values already in display units). */
  setSeries(series: TdSeriesVM[]): void;
  setUnitLabel(label: string): void;
  /** Displayed time window in ms; null = the whole capture. */
  setTimeWindow(ms: number | null): void;
  /** Trigger overlay, the VM's own shape; `null` draws nothing (trigger off,
   * or the tile's markers toggle is off — tile.ts decides which). */
  setTrigger(trigger: ScopeTriggerVM | null): void;
  setTriggerHandlers(handlers: ScopeTriggerHandlers): void;
  destroy(): void;
}

export interface SweepRenderer {
  /** Replace the drawn curves (values already in measurement units). */
  setSeries(series: SweepSeriesVM[]): void;
  /** Y-axis caption ("dB" / "%"). */
  setUnitLabel(label: string): void;
  /** ∠ phase overlay (FR sweeps carrying phase). */
  setShowPhase(on: boolean): void;
  destroy(): void;
}

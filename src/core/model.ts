/**
 * Core display-model types shared by the store, selectors and panels.
 * (The wire types live in ../gen — generated, never hand-written.)
 */

export type TraceId = string;

export type Chan = "left" | "right";

/** td / fd / sweep — which domains a trace carries (a sweep frame is a
 * swept measurement's curve set, produced by a program). */
export type Domain = "td" | "fd" | "sweep";

/** Display units (canonical amplitude is always Vrms — see units.ts). */
export type Unit =
  | "vrms" | "vpk" | "dbv" | "dbu" | "dbfs" | "dbr" | "watt" | "percent" | "db";

/** The fd display units a spectrum tile offers. */
export type FdUnit = "dbfs" | "dbv" | "dbu";

/** The td display units a scope tile offers: volts, millivolts, or percent
 * of the trace's own converter full scale. */
export type TdUnit = "v" | "mv" | "pctfs";

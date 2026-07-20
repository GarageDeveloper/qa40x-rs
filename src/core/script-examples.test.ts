import { describe, expect, it } from "vitest";
import { SCRIPT_EXAMPLES } from "./script-examples";

/**
 * The example scripts are the script-trace dialog's documentation — keep them
 * well-formed and limited to the API the backend actually registers (script.rs).
 */
const API_FUNCTIONS = [
  "connected",
  "firmware_version",
  "model",
  "default_settings",
  "set_sample_rate",
  "set_input_range",
  "set_output_range",
  "set_buffer_size",
  "set_gen",
  "set_waveform",
  "set_gen_output",
  "sample_rate",
  "input_range",
  "output_range",
  "acquire",
  "thd_db",
  "thd_pct",
  "thdn_db",
  "thdn_pct",
  "snr_db",
  "rms_dbv",
  "peak_dbv",
  "peak_hz",
  "log",
  "sleep_ms",
  // Emission API (script traces, task #39).
  "plot_sweep",
  "plot_spectrum",
  "plot_scope",
];

// Rhai built-ins the examples may also call. (`log` doubles as our output
// function and Rhai's base-10 log — both are fine.)
const RHAI_BUILTINS = [
  "print",
  "debug",
  "to_string",
  "to_float",
  "round",
  "throw",
  "push",
  "len",
  "sin",
  "abs",
];

// Source-script entry points the HOST calls (Traces V2: a script defining
// `fn render(ctx)` is a signal source the mixer renders per frame).
const SOURCE_ENTRY_POINTS = ["render"];

describe("script examples", () => {
  it("exist, are named, and are non-empty", () => {
    expect(SCRIPT_EXAMPLES.length).toBeGreaterThanOrEqual(2);
    for (const ex of SCRIPT_EXAMPLES) {
      expect(ex.name.trim().length).toBeGreaterThan(0);
      expect(ex.source.trim().length).toBeGreaterThan(0);
    }
    expect(new Set(SCRIPT_EXAMPLES.map((e) => e.name)).size).toBe(SCRIPT_EXAMPLES.length);
  });

  it("only call functions the backend registers", () => {
    const known = new Set([...API_FUNCTIONS, ...RHAI_BUILTINS, ...SOURCE_ENTRY_POINTS]);
    for (const ex of SCRIPT_EXAMPLES) {
      // Strip comments and string literals, then collect `name(` call sites.
      const code = ex.source
        .replace(/\/\/[^\n]*/g, "")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""');
      for (const m of code.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
        const name = m[1];
        expect(known.has(name), `unknown function "${name}" in "${ex.name}"`).toBe(true);
      }
    }
  });

  it("cover a THD sweep and a level check", () => {
    const all = SCRIPT_EXAMPLES.map((e) => e.source).join("\n");
    expect(all).toContain("thd_db");
    expect(all).toContain("rms_dbv");
    expect(all).toContain("acquire()");
  });
});

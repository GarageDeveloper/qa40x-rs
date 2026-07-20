/**
 * Script-role classification (M4, ported from v1 model.ts): a Rhai script
 * that calls any device verb is a MEASUREMENT script (exclusive session);
 * one that only generates/plots is a signal source. The role always tracks
 * the source text (recomputed on every dialog Apply).
 */
import type { ScriptRole } from "../gen";

/** Strip Rhai comments (`//` and `/* … *​/`) AND string/char literals so verb
 * detection cannot be fooled by documentation mentioning acquire() — or by a
 * `//` inside a string (e.g. a URL) swallowing a real device call after it.
 * One left-to-right pass: whichever construct opens first consumes its span,
 * so markers nested inside another construct never match. */
export function stripRhaiComments(source: string): string {
  return source.replace(
    /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    " "
  );
}

/** The verbs that make a script a measurement script: they drive the
 * instrument (settings, acquisition, analysis over a capture). Keep in sync
 * with the measurement-only API in src-tauri/src/script.rs. */
const MEASUREMENT_VERBS =
  /\b(?:acquire|default_settings|set_gen|set_waveform|set_gen_output|set_sample_rate|set_input_range|set_output_range|set_buffer_size|auto_level|thd_db|thd_pct|thdn_db|thdn_pct|snr_db|rms_dbv|peak_dbv|peak_hz)\s*\(/;

export function classifyScriptRole(source: string): ScriptRole {
  return MEASUREMENT_VERBS.test(stripRhaiComments(source)) ? "measurement" : "source";
}

/** Starter script for a new measure/plot script program: plots a synthetic
 * curve so it draws something even without hardware, and documents the
 * emission API (the v1 default, minus the fn render(ctx) path — render
 * scripts are Signal Sources here). */
export const DEFAULT_MEASURE_SCRIPT = `// Measurement / plot script: whatever you plot lands on this program's trace.
//   plot_sweep(freqs, values)            -> sweep curve (vs frequency)
//   plot_sweep(label, freqs, values)     -> named curve (multi-curve sweeps)
//   plot_spectrum(freqs, mag_db)         -> spectrum (FD)
//   plot_scope(samples [, sample_rate])  -> scope (TD)
// Or drive the analyzer: set_gen(...) + acquire() shows the capture's
// spectrum + scope automatically (measurements: thd_db, rms_dbv, ...).
let freqs = [];
let vals = [];
let f = 20.0;
while f <= 20000.0 {
    let x = (f / 1000.0).log();
    freqs.push(f);
    vals.push(-6.0 - 3.0 * x * x);   // a synthetic response curve
    f *= 1.1;
}
plot_sweep(freqs, vals);
print("Plotted " + freqs.len() + " points.");
`;

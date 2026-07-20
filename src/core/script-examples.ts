/**
 * Example Rhai scripts for the script-trace dialog (task #39).
 *
 * Pure data (no Tauri imports) so it is unit-testable. The API these scripts
 * use is the curated surface registered in `src-tauri/src/script.rs`, which
 * mirrors the REST automation server's operation set plus the emission API
 * (`plot_sweep` / `plot_spectrum` / `plot_scope`) that draws onto the script
 * trace. Measurements return an object map `#{ left, right }` over the last
 * `acquire()` capture.
 */

export interface ScriptExample {
  name: string;
  source: string;
}

export const SCRIPT_EXAMPLES: ScriptExample[] = [
  {
    name: "Sine at a given frequency",
    source: `// Generate a sine and capture it in loopback.
// How an acquisition works: set_gen(on, freq, level) configures the tone,
// acquire() plays it AND captures the input. After acquire(), the trace
// shows the capture automatically — assign this trace to a Spectrum graph
// (peak at FREQ) and/or a Scope graph via each graph's gear (⚙).
if !connected() {
    throw "Connect the QA40x first.";
}
let FREQ = 1000.0;       // Hz — change me

set_sample_rate(48000);
set_input_range(6);      // input full-scale +6 dBV
set_output_range(8);     // output full-scale +8 dBV
set_waveform("sine");
set_gen(true, FREQ, -6.0);   // on, frequency (Hz), level (dBFS)
set_gen_output("left");      // route the tone: "left" (default) | "right" | "both"
acquire();                   // play the tone + capture the loopback

let pk = peak_hz(20.0, 20000.0);
print("Sine " + FREQ.round().to_string() + " Hz  ->  peak at "
    + pk.left.round().to_string() + " Hz");
`,
  },
  {
    name: "Square wave at a given frequency",
    source: `// Generate a square wave and capture it. On a Spectrum graph you see the
// odd harmonics (f, 3f, 5f, …); on a Scope graph, the square edges (band-
// limited by the DAC/ADC). Same recipe as the sine — only the waveform
// changes. Waveforms: sine, square, triangle, sawtooth.
if !connected() {
    throw "Connect the QA40x first.";
}
let FREQ = 1000.0;       // Hz — change me

set_sample_rate(48000);
set_input_range(6);
set_output_range(8);
set_waveform("square");
set_gen(true, FREQ, -6.0);
acquire();

let pk = peak_hz(20.0, 20000.0);
print("Square " + FREQ.round().to_string() + " Hz  ->  fundamental at "
    + pk.left.round().to_string() + " Hz (odd harmonics above)");
`,
  },
  {
    name: "Square-wave source (plays into the mix)",
    source: `// A SIGNAL SOURCE script: define fn render(ctx) and press Play — this
// trace feeds the mixer and plays TOGETHER with the other playing sources
// (e.g. a sine generator trace). Signal sources sum; they don't take turns.
// Samples are level-volts (1.0 = 0 dBV), so AMP 0.1 plays at -20 dBV. The
// summed peak picks the output range; a clipping sum lights OUT CLIP.
fn render(ctx) {
    let FREQ = 440.0;                     // Hz — change me
    let AMP = 0.1;                        // level-volts (0.1 = -20 dBV)
    let period = ctx.sample_rate / FREQ;  // samples per cycle
    let out = [];
    for i in 0..ctx.buffer_size {
        let phase = (i.to_float() / period) % 1.0;
        out.push(if phase < 0.5 { AMP } else { -AMP });
    }
    out
}
`,
  },
  {
    name: "THD sweep (20 Hz – 20 kHz, plots as it runs)",
    source: `// THD vs frequency: sweep a -6 dBFS tone, ~5 points per decade.
// plot_sweep redraws the trace after every point (progressive), one
// labelled curve per channel; the log prints the numbers too.
if !connected() {
    throw "Connect the QA40x first.";
}
set_sample_rate(48000);
set_input_range(6);      // input full-scale +6 dBV
set_output_range(8);     // output full-scale +8 dBV
set_buffer_size(32768);

let freqs = [];
let thd_l = [];
let thd_r = [];
let f = 20.0;
while f <= 20000.0 {
    set_gen(true, f, -6.0);
    acquire();
    let thd = thd_db(f);
    freqs.push(f);
    thd_l.push(thd.left);
    thd_r.push(thd.right);
    plot_sweep("L", freqs, thd_l);
    plot_sweep("R", freqs, thd_r);
    print(f.round().to_string() + " Hz  THD  L " + thd.left.to_string()
        + " dB   R " + thd.right.to_string() + " dB");
    f *= 1.5849;         // 10^(1/5): five points per decade
}
print("Sweep done.");
`,
  },
  {
    name: "Plot demo (no hardware needed)",
    source: `// The emission API without the device: synthesize data and draw it.
// plot_sweep -> a sweep graph, plot_spectrum -> a Spectrum graph,
// plot_scope -> a Scope graph (assign the trace to graphs via their gear).
let freqs = [];
let vals = [];
let f = 20.0;
while f <= 20000.0 {
    let x = (f / 1000.0).log();
    freqs.push(f);
    vals.push(-6.0 - 3.0 * x * x);
    f *= 1.1;
}
plot_sweep(freqs, vals);

// A synthetic spectrum: a -3 dB tone at 1 kHz over a -110 dB floor.
let sf = [];
let sm = [];
let i = 1;
while i <= 200 {
    let freq = 20.0 * (1000.0 ** (i / 200.0));   // 20 Hz .. 20 kHz, log-spaced
    sf.push(freq);
    if freq > 950.0 && freq < 1050.0 { sm.push(-3.0); } else { sm.push(-110.0); }
    i += 1;
}
plot_spectrum(sf, sm);

// A 10 ms / 100 Hz sine burst on the scope.
let samples = [];
let n = 0;
while n < 480 {
    samples.push(0.5 * (6.283185 * 100.0 * n / 48000.0).sin());
    n += 1;
}
plot_scope(samples, 48000);
print("Plotted sweep + spectrum + scope.");
`,
  },
  {
    name: "Level check (1 kHz, pass/fail)",
    source: `// Level check: play 1 kHz at -12 dBFS in loopback and verify the
// measured RMS level lands within +/- 1 dB of the expected value.
if !connected() {
    throw "Connect the QA40x first.";
}
set_sample_rate(48000);
set_input_range(6);
set_output_range(8);
set_gen(true, 1000.0, -12.0);
acquire();

let peak = peak_hz(20.0, 20000.0);
print("Peak found at " + peak.left.round().to_string() + " Hz");

let rms = rms_dbv(20.0, 20000.0);
print("RMS  L " + rms.left.to_string() + " dBV   R " + rms.right.to_string() + " dBV");

// -12 dBFS on the +8 dBV output range ≈ -7 dBV at the input (loopback).
let expected = -7.0;
if rms.left > expected - 1.0 && rms.left < expected + 1.0 {
    print("PASS: left level within 1 dB of " + expected.to_string() + " dBV");
} else {
    print("FAIL: left level out of range");
}
`,
  },
];

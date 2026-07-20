/**
 * Render-script presets for the script source editor. Pure data. Every
 * preset defines `fn render(ctx)` per the backend contract
 * (src-tauri/src/sources.rs): return an array of ctx.buffer_size samples
 * (mono, applied to both routed channels) or `#{ left: [...], right: [...] }`.
 * Samples are level-volts (1.0 = 0 dBV). No device API exists in a source
 * script by construction.
 */
import { DEFAULT_RENDER_SCRIPT } from "../../store/actions/sources";

export interface ScriptPreset {
  name: string;
  source: string;
}

export const SCRIPT_PRESETS: ScriptPreset[] = [
  { name: "Square wave (mono)", source: DEFAULT_RENDER_SCRIPT },
  {
    name: "Stereo: two tones (left ≠ right)",
    source: `// A stereo source: return #{ left, right } to render the channels
// independently (a mono array would play the same on both). Route the
// source to L, R or both — the route gates where the sum takes it.
fn render(ctx) {
    let FREQ_L = 1000.0;                  // Hz
    let FREQ_R = 1500.0;                  // Hz
    let AMP = 0.1;                        // level-volts (0.1 = -20 dBV)
    let wl = 6.283185307179586 * FREQ_L / ctx.sample_rate;
    let wr = 6.283185307179586 * FREQ_R / ctx.sample_rate;
    let left = [];
    let right = [];
    for i in 0..ctx.buffer_size {
        left.push(AMP * (wl * i).sin());
        right.push(AMP * (wr * i).sin());
    }
    #{ left: left, right: right }
}
`,
  },
  {
    name: "Amplitude-modulated tone",
    source: `// An AM tone: carrier * (1 + depth·sin(mod)). On a spectrum you see the
// carrier and its two sidebands at ±MOD Hz.
fn render(ctx) {
    let CARRIER = 1000.0;                 // Hz
    let MOD = 100.0;                      // Hz
    let DEPTH = 0.5;                      // 0..1
    let AMP = 0.1;                        // level-volts (0.1 = -20 dBV)
    let wc = 6.283185307179586 * CARRIER / ctx.sample_rate;
    let wm = 6.283185307179586 * MOD / ctx.sample_rate;
    let out = [];
    for i in 0..ctx.buffer_size {
        let env = 1.0 + DEPTH * (wm * i).sin();
        out.push(AMP * env * (wc * i).sin() / (1.0 + DEPTH));
    }
    out
}
`,
  },
];

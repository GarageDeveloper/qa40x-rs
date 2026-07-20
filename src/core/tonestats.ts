/**
 * Tone-list headroom: peak / RMS / crest factor of a phased tone sum, in
 * level-volts — the numbers behind the tone editor's readout, so the user can
 * SEE what their phases cost in headroom (N equal tones at zero phase peak
 * 10·log10(N) dB above well-spread phases). Port of the (now-removed) mixer.ts
 * `toneListStats` — its tone-stats half.
 *
 * Computed numerically over one rendered window, mirroring the backend
 * `ToneListSource` (sum of `a·sin(2π·f/sr·i + φ)` per enabled tone), because
 * the peak of a phased sum has no closed form. `sampleRate`/`n` default to a
 * representative window; the exact playing window (the acquisition FFT size)
 * can shift the observed peak slightly — this is a headroom readout, not a
 * calibration. A silent list (nothing enabled / all zero) reports 0/0 with a
 * crest of 0 dB.
 */
import type { Tone } from "../gen";

export interface ToneListStats {
  peak: number;
  rms: number;
  crestDb: number;
}

export function toneListStats(
  tones: Tone[],
  sampleRate = 48000,
  n = 32768
): ToneListStats {
  const active = tones.filter((t) => t.enabled && t.amplitude_vrms > 0);
  if (active.length === 0) return { peak: 0, rms: 0, crestDb: 0 };
  const w = active.map((t) => (2 * Math.PI * t.frequency_hz) / sampleRate);
  const phi = active.map((t) => (t.phase_degrees * Math.PI) / 180);
  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let k = 0; k < active.length; k++) {
      v += active[k].amplitude_vrms * Math.sin(w[k] * i + phi[k]);
    }
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / n);
  const crestDb = rms > 0 && peak > 0 ? 20 * Math.log10(peak / rms) : 0;
  return { peak, rms, crestDb };
}

/**
 * Minimal DSP for the e2e fake backend — just enough that what the app draws
 * genuinely FOLLOWS the samples it played, instead of being hard-coded chart
 * food. A real windowed FFT (radix-2, Hann) means a sine source produces a
 * real spectral peak whose level moves with the source's level and whose
 * frequency moves with the source's frequency; the metrics are crude but are
 * COMPUTED from the data, never invented per-test.
 *
 * This is a stand-in, not a simulator: one window (Hann, whatever the app
 * asks for), no averaging, textbook peak-picking. Precision beyond ~a dB is
 * the suite task's business (recorded fixtures), not this file's.
 */

export interface SpectrumPeak {
  frequency: number;
  magnitude_db: number;
  index: number;
}

export interface SpectrumData {
  frequencies: number[];
  magnitudes_db: number[];
  peaks: SpectrumPeak[];
}

export interface FftResult {
  frequencies: number[];
  magnitudes: number[]; // linear amplitude (digital RMS per bin)
  phases: number[];
  power: number[];
  sample_rate: number;
}

export interface AnalysisResult {
  thd: number; // %
  thd_n: number; // %
  snr: number; // dB
  sinad: number; // dB
  rms: number; // digital full-scale
  peak: number; // digital full-scale
  crest_factor: number; // dB
  dc_offset: number; // digital full-scale
}

/** In-place iterative radix-2 FFT. Lengths must be a power of two. */
function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Largest power of two ≤ n (at least 2). */
function pow2Floor(n: number): number {
  return 1 << Math.max(1, Math.floor(Math.log2(Math.max(2, n))));
}

/**
 * Windowed one-sided amplitude spectrum of a digital signal.
 *
 * Normalization convention (matches the backend the app was written against):
 * magnitudes are **digital-RMS referenced dB** — a sine of digital peak 1.0
 * reads −3.01 dB. Combined with the fake device's dBFS→dBV offsets
 * (input: `range − 6`, output: `range + 3.01`) this makes a played tone read
 * back at its true dBV on BOTH the Input and the Output traces, which is what
 * lets invariant-style tests hold against this fake.
 */
export function amplitudeSpectrum(
  signal: number[],
  sampleRate: number
): { freqs: Float64Array; ampRms: Float64Array } {
  const n = pow2Floor(signal.length);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let winSum = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1))); // Hann
    re[i] = (signal[i] ?? 0) * w;
    winSum += w;
  }
  const coherentGain = winSum / n; // ≈ 0.5 for Hann
  fftInPlace(re, im);
  const bins = n / 2;
  const freqs = new Float64Array(bins);
  const ampRms = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    freqs[k] = (k * sampleRate) / n;
    const mag = Math.hypot(re[k], im[k]);
    const peakAmp = (2 * mag) / (n * coherentGain); // sine-peak estimate
    ampRms[k] = peakAmp / Math.SQRT2;
  }
  return { freqs, ampRms };
}

const dB = (lin: number): number => 20 * Math.log10(Math.max(lin, 1e-12));

/** `analyze_spectrum` stand-in: dB spectrum + the single loudest peak. */
export function analyzeSpectrum(signal: number[], sampleRate: number): SpectrumData {
  const { freqs, ampRms } = amplitudeSpectrum(signal, sampleRate);
  const frequencies: number[] = new Array(freqs.length);
  const magnitudes_db: number[] = new Array(freqs.length);
  let maxIdx = 1;
  for (let k = 0; k < freqs.length; k++) {
    frequencies[k] = freqs[k];
    magnitudes_db[k] = dB(ampRms[k]);
    if (k >= 1 && ampRms[k] > ampRms[maxIdx]) maxIdx = k;
  }
  const peaks: SpectrumPeak[] =
    ampRms[maxIdx] > 1e-9
      ? [{ frequency: frequencies[maxIdx], magnitude_db: magnitudes_db[maxIdx], index: maxIdx }]
      : [];
  return { frequencies, magnitudes_db, peaks };
}

/** `process_fft` stand-in: linear per-bin digital-RMS amplitudes. */
export function processFft(signal: number[], sampleRate: number): FftResult {
  const { freqs, ampRms } = amplitudeSpectrum(signal, sampleRate);
  return {
    frequencies: Array.from(freqs),
    magnitudes: Array.from(ampRms),
    phases: new Array(freqs.length).fill(0), // not simulated
    power: Array.from(ampRms, (a) => a * a),
    sample_rate: sampleRate,
  };
}

/** Band around a frequency (±`span` bins): peak amplitude + total power.
 * The power sum matters: a windowed tone spreads over the mainlobe's bins,
 * so subtracting only the peak bin would leave the skirts counted as
 * "noise" and wreck THD+N/SNR. */
function band(
  mags: number[],
  freqs: number[],
  hz: number,
  span = 4
): { amp: number; power: number } {
  if (freqs.length < 2) return { amp: 0, power: 0 };
  const binHz = freqs[1] - freqs[0];
  const center = Math.round(hz / binHz);
  let amp = 0;
  let power = 0;
  for (let k = Math.max(1, center - span); k <= Math.min(mags.length - 1, center + span); k++) {
    if (mags[k] > amp) amp = mags[k];
    power += mags[k] * mags[k];
  }
  return { amp, power };
}

/* ---- scope trigger (Lot A, issue #26) --------------------------------
 * An EXACT port of src-tauri/src/audio/trigger.rs's `find_edge` /
 * `auto_hysteresis` — same Schmitt-qualification control flow, same edge
 * cases (`from.max(1)`, the armed/candidate state machine, hysteresis == 0
 * degenerating to a plain level crossing) — so the fake backend's trigger
 * picture matches what a real device would report for the same samples.
 * Only the numeric domain differs (JS f64 vs Rust f32); see refineLinear.
 */

export type TriggerEdgePolarity = "rising" | "falling";

export interface TriggerHit {
  /** First sample at/after the crossing. */
  index: number;
  /** Sub-sample residual in [0,1]: the crossing is at `index - 1 + frac`. */
  frac: number;
}

/** Port of `refine_linear`: linear sub-sample crossing fraction between
 * `prev` and `cur`. Degenerates to 0 when there's no slope to interpolate
 * along (mirrors the Rust `f32::EPSILON` guard, at f64 tolerance). */
export function refineLinear(prev: number, cur: number, level: number): number {
  const d = cur - prev;
  if (Math.abs(d) < 1e-7) return 0;
  return Math.min(1, Math.max(0, (level - prev) / d));
}

/**
 * Port of `find_edge`: first Schmitt-qualified `edge` crossing of `level` at
 * index >= `from`. Single pass, `from` clamped to >= 1; `have_low`/`armed`
 * tracks whether a qualifying low(-hysteresis) sample has been seen yet;
 * `candidate` is a plain `level` crossing held until a later sample either
 * confirms it (clears the hysteresis band), a false start re-arms the
 * search, or a later, cleaner crossing of `level` REPLACES the candidate (a
 * sub-hysteresis wiggle before the real edge must not win over the crossing
 * that actually goes on to confirm). The reported crossing is always the
 * plain `level` crossing of the (possibly replaced) candidate, found BEFORE
 * confirmation — alignment is independent of hysteresis width.
 */
export function findEdge(
  samples: ArrayLike<number>,
  level: number,
  hysteresis: number,
  edge: TriggerEdgePolarity,
  from: number
): TriggerHit | null {
  const hyst = Math.abs(hysteresis);
  // Fold polarity into a sign so rising/falling share one scan (mirrors the
  // Rust `s * sample` trick — Falling flips "above/below" without touching
  // the buffer).
  const s = edge === "rising" ? 1 : -1;
  const lvl = s * level;
  const lo = lvl - hyst;
  const hi = lvl + hyst;

  let haveLow = false;
  let candidate: TriggerHit | null = null;

  const start = Math.max(1, from);
  for (let i = start; i < samples.length; i++) {
    const prev = s * samples[i - 1];
    const cur = s * samples[i];

    if (candidate) {
      if (cur >= hi) {
        return candidate;
      } else if (cur <= lo) {
        // False start: dropped back to the low band without ever
        // confirming. `cur` itself re-arms.
        candidate = null;
      } else if (prev < lvl && cur >= lvl) {
        // A later, cleaner crossing of `level` while still pending:
        // REPLACES the candidate, so the reported crossing is always the
        // one on the FINAL run that clears `level + hysteresis`.
        candidate = { index: i, frac: refineLinear(prev, cur, lvl) };
      }
      continue; // between lo and hi, unconfirmed: keep waiting
    }

    if (!haveLow) {
      if (cur <= lo) haveLow = true;
      continue;
    }

    if (prev < lvl && cur >= lvl) {
      const frac = refineLinear(prev, cur, lvl);
      if (cur >= hi) {
        // hysteresis == 0 (or the confirming sample IS the crossing
        // sample): confirmed immediately.
        return { index: i, frac };
      }
      candidate = { index: i, frac };
    }
    // else: still below `level` (or between lo and level) — stay armed.
  }
  return null;
}

/** Port of `auto_hysteresis`: `frac` x peak|x| of the frame, floored at
 * `floor` (so a near-silent frame doesn't collapse the band to ~0). */
export function autoHysteresis(samples: ArrayLike<number>, frac: number, floor: number): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  return Math.max(peak * frac, floor);
}

/**
 * `analyze_audio` stand-in: textbook THD from harmonics 2–10, THD+N from the
 * residual spectral power, time-domain RMS/peak/DC. Crude on purpose.
 */
export function analyzeAudio(
  signal: number[],
  magnitudes: number[],
  frequencies: number[],
  fundamentalFreq: number
): AnalysisResult {
  let sumSq = 0;
  let peak = 0;
  let sum = 0;
  for (const v of signal) {
    sumSq += v * v;
    sum += v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sumSq / Math.max(1, signal.length));
  const dc = sum / Math.max(1, signal.length);

  const nyquist = frequencies.length ? frequencies[frequencies.length - 1] : 0;
  const fundBand = band(magnitudes, frequencies, fundamentalFreq);
  const fund = fundBand.amp;
  let harmSq = 0;
  let harmBandSq = 0;
  for (let h = 2; h <= 10; h++) {
    const f = fundamentalFreq * h;
    if (f >= nyquist) break;
    const b = band(magnitudes, frequencies, f);
    harmSq += b.amp * b.amp;
    harmBandSq += b.power;
  }
  let totalSq = 0;
  for (let k = 1; k < magnitudes.length; k++) totalSq += magnitudes[k] * magnitudes[k];
  const residualSq = Math.max(0, totalSq - fundBand.power);
  const noiseSq = Math.max(0, residualSq - harmBandSq);

  const safeFund = Math.max(fund, 1e-12);
  const thd = (Math.sqrt(harmSq) / safeFund) * 100;
  const thdN = (Math.sqrt(residualSq) / safeFund) * 100;
  const snr = dB(safeFund) - dB(Math.sqrt(Math.max(noiseSq, 1e-24)));
  const sinad = -dB(Math.max(thdN, 1e-10) / 100);
  const crest = dB(peak > 0 && rms > 0 ? peak / rms : 1);
  return {
    thd,
    thd_n: thdN,
    snr,
    sinad,
    rms,
    peak,
    crest_factor: crest,
    dc_offset: dc,
  };
}

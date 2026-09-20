/**
 * Pure bin-grid math (issue #25 lot F3): the sine-snapping half of
 * `actions/stream.ts::playedFrequencyHz`, extracted so SELECTORS can compute
 * per-target readouts without importing an action module (the store's import
 * discipline: no selector imports an action). No store types, no state reads
 * — a leaf like core/routing.ts.
 */

/** Snap a sine to the nearest FFT bin (v1 behavior: a bin-exact tone keeps
 * the windowed FFT clean; the ask stays the user's, only the mix snaps). */
export function snapToBin(freqHz: number, numSamples: number, sampleRate: number): number {
  const bin = Math.max(1, Math.round((freqHz * numSamples) / sampleRate));
  return (bin * sampleRate) / numSamples;
}

/** The frequency the mixer actually plays for an asked `hz` on a converter
 * running at `sampleRate`: clamped to [1 Hz, 0.98·Nyquist], then bin-snapped
 * unless the coherent-generator toggle is off (issue #14 — "Round to
 * eliminate leakage" in the official app). The grid and the clamp are
 * properties of THE TARGET device's rate, never the focused one's — callers
 * pass the rate, they never default it here (the 48 kHz fallback stays in
 * `playedFrequencyHz`, wire-side only: a readout printing a confident value
 * for an absent converter is the deviceForTrace bug class in frequency form). */
export function playedFrequency(
  hz: number,
  sampleRate: number,
  coherent: boolean,
  fftSize: number
): number {
  const clamped = Math.min(Math.max(hz, 1), (sampleRate / 2) * 0.98);
  return coherent ? snapToBin(clamped, fftSize, sampleRate) : clamped;
}

/** The front-panel I2S port's pinned sample rate (issue #71 — the vendor
 * app locks the port at 48 kSPS; `doc/device-notes.md` §10). Lives in this
 * leaf so SELECTORS can compute I2S readouts without importing an action
 * module. */
export const I2S_PORT_RATE_HZ = 48000;

/** The frequency the I2S port actually plays for an asked `hz`: clamped
 * below ITS OWN Nyquist (the port is pinned at 48 kHz whatever the
 * acquisition rate) and NEVER bin-snapped — the FFT grid describes the
 * acquisition, not the port. */
export function i2sPlayedFrequency(hz: number): number {
  return Math.min(Math.max(hz, 1), (I2S_PORT_RATE_HZ / 2) * 0.98);
}

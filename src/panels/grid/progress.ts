/**
 * Acquisition-progress estimate for the transport readout: a big FFT frame
 * is ~fftSize/sampleRate seconds of capture (1M at 48 kHz ≈ 22 s) during
 * which nothing on screen moves — show how far along the current frame
 * should be. Deterministic time math (expected duration is known), not a
 * fabricated measurement; capped at 99% so a stalled stream reads as stuck
 * near the end instead of silently complete.
 */

/** Fixed per-frame overhead beyond the capture itself (stream start-up
 * ~140 ms + FFT + transfer), in ms. Display estimate only. */
const FRAME_OVERHEAD_MS = 400;

/** Below this expected frame duration the fps readout is feedback enough —
 * only long acquisitions (or a stalled stream) show a percentage. */
const SHOW_THRESHOLD_MS = 1500;

/**
 * Percentage (0-99) of the expected current frame elapsed, or null when no
 * progress display is warranted (fast frames arriving normally).
 * `elapsedMs` is the time since the last received frame (or run start).
 */
export function acquisitionProgress(
  elapsedMs: number,
  fftSize: number,
  sampleRate: number
): number | null {
  const expectedMs = (fftSize / Math.max(1, sampleRate)) * 1000 + FRAME_OVERHEAD_MS;
  if (expectedMs < SHOW_THRESHOLD_MS && elapsedMs < SHOW_THRESHOLD_MS) return null;
  return Math.min(99, Math.max(0, Math.round((elapsedMs / expectedMs) * 100)));
}

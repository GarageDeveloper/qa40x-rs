/**
 * The capture seam of the fake device.
 *
 * `generate_and_capture` is the one place where the real instrument injects
 * reality: what the ADC saw while the DAC played. Everything else the fake
 * does (mixer rendering, FFTs) is deterministic bookkeeping the frontend
 * drives; the capture is where a follow-up task will substitute REAL recorded
 * hardware frames for the synthetic loopback below. Keeping it behind this
 * interface means that swap touches nothing else: a fixture provider reads
 * frames from disk instead of computing them, and the whole suite runs
 * against genuine device data.
 */

export interface CaptureContext {
  sampleRate: number;
  /** Output range (reg 6) full scale, dBV — a full-scale DAC sine's RMS. */
  outputRangeDbv: number;
  /** Input range (reg 5) full scale, dBV. */
  inputRangeDbv: number;
}

/**
 * Modeled factory ADC trim, in dB. The real device's input dBFS→dBV offset is
 * NOT the bare `range − 6`: the backend adds a per-range factory calibration
 * read from the device's cal page (device.rs `input_volts_factor`). On the
 * reference QA402 the #51 hardware probe measured the total offset at input
 * range 18 dBV as +20.81 dB — i.e. a trim of +8.81 dB over the base formula.
 * The fake applies that measured trim uniformly to all ranges (per-range trims
 * differ slightly on real hardware, but only self-consistency matters to the
 * synthetic tests, and 18 dBV is the range every recorded fixture uses).
 * Without this, replayed REAL fixtures would display ~8.8 dB low — a −12 dBV
 * recorded sine would read −20.5 dBV, which is exactly the kind of silent
 * level lie this harness exists to prevent.
 */
export const ADC_CAL_DB = 8.81;

/** The fake's input dBFS→dBV offset for a given input range (reg 5), dB:
 * base `range − 6` + the modeled factory ADC trim. Used by BOTH the fake's
 * `get_input_dbv_offset` and the synthetic capture below — they must never
 * disagree, or a synthetic loopback level would read back shifted. */
export function inputDbvOffsetDb(inputRangeDbv: number): number {
  return inputRangeDbv - 6 + ADC_CAL_DB;
}

export interface FrameProvider {
  /**
   * The stereo capture for one `generate_and_capture(left, right)` call.
   * `left`/`right` are the digital DAC buffers the app played (±1 full
   * scale); the return is the digital ADC buffers (±1 full scale).
   */
  capture(
    left: number[],
    right: number[],
    ctx: CaptureContext
  ): { left: number[]; right: number[] };
}

/**
 * Synthetic perfect-coax-loopback provider (the default).
 *
 * Physics kept, everything else idealized: a DAC digital sample maps to
 * volts through the output range (digital RMS 1.0 ≙ √2·10^(out/20) Vrms —
 * a full-scale sine's RMS is the range), and back to ADC digital through the
 * input range + modeled ADC trim (digital RMS 1.0 ≙ 10^(inputDbvOffsetDb/20)
 * Vrms — the same offset `get_input_dbv_offset` reports, so a level read back
 * through the app is exact). So the capture level moves correctly when either range register
 * moves — which is exactly what invariant-style tests lean on. A small white
 * noise floor is added so spectra have a floor instead of −∞ bins.
 *
 * NOT simulated: converter distortion, frequency response, group delay /
 * round-trip latency, crosstalk, relay settling, mains hum. Do not write
 * tests against those against this provider.
 */
export function syntheticLoopbackProvider(noiseAmp = 3e-7): FrameProvider {
  return {
    capture(left, right, ctx) {
      const dacVoltsPerDigital = Math.SQRT2 * Math.pow(10, ctx.outputRangeDbv / 20);
      const adcVoltsPerDigital = Math.pow(10, inputDbvOffsetDb(ctx.inputRangeDbv) / 20);
      const g = dacVoltsPerDigital / adcVoltsPerDigital;
      const pass = (a: number[]): number[] =>
        a.map((v) => v * g + (Math.random() - 0.5) * 2 * noiseAmp);
      return { left: pass(left), right: pass(right) };
    },
  };
}

/* ---- recorded fixtures (task #54) ------------------------------------ */

/** One recorded hardware capture, as written by the fixture recorder
 * (src-tauri/examples/record_fixtures.rs — keep the field names in sync). */
export interface RecordedFixture {
  name: string;
  sampleRate: number;
  inputRangeDbv: number;
  outputRangeDbv: number;
  /** Which DAC channels were driven when this was recorded. */
  driven: "none" | "left" | "right" | "both";
  n: number;
  left: number[];
  right: number[];
}

/** Which channels of a DAC buffer pair actually carry signal. */
function drivenSignature(left: number[], right: number[]): RecordedFixture["driven"] {
  const live = (a: number[]): boolean => a.some((v) => Math.abs(v) > 1e-9);
  const l = live(left);
  const r = live(right);
  return l && r ? "both" : l ? "left" : r ? "right" : "none";
}

/**
 * A provider that replays REAL recorded ADC captures instead of computing an
 * ideal loopback. Selection is by the driven-channel signature of the buffer
 * the app is playing (the only honest key a raw capture offers), so a test
 * must play the same stimulus the fixture was recorded under — the recorder
 * documents each scenario. It refuses loudly (never approximates) when no
 * fixture matches or when the app's ranges / sample rate / buffer size differ
 * from the recording context: a silent mismatch would hand the app frames
 * recorded under a different full-scale, which is exactly the class of level
 * bug this suite exists to catch.
 */
export function fixtureProvider(fixtures: RecordedFixture[]): FrameProvider {
  return {
    capture(left, right, ctx) {
      const driven = drivenSignature(left, right);
      const fix = fixtures.find((f) => f.driven === driven);
      if (!fix) {
        throw new Error(
          `fixture provider: no recorded fixture for driven="${driven}" ` +
            `(have: ${fixtures.map((f) => `${f.name}=${f.driven}`).join(", ") || "none"})`
        );
      }
      const mismatches: string[] = [];
      if (ctx.sampleRate !== fix.sampleRate)
        mismatches.push(`sampleRate ${ctx.sampleRate} ≠ recorded ${fix.sampleRate}`);
      if (ctx.inputRangeDbv !== fix.inputRangeDbv)
        mismatches.push(`inputRange ${ctx.inputRangeDbv} ≠ recorded ${fix.inputRangeDbv}`);
      if (ctx.outputRangeDbv !== fix.outputRangeDbv)
        mismatches.push(`outputRange ${ctx.outputRangeDbv} ≠ recorded ${fix.outputRangeDbv}`);
      if (mismatches.length) {
        throw new Error(
          `fixture provider: "${fix.name}" recorded under a different context — ` +
            mismatches.join("; ") +
            ". Pin the app to the recording context before playing."
        );
      }
      // The app's live loop pads a tone with a capture guard (it plays
      // numSamples + 2·guard and analyses the middle numSamples — see
      // live.ts CAPTURE_GUARD), so the requested length usually exceeds the
      // fixture's. Length-match is met by wrapping the recorded block, BUT
      // the wrap must be ALIGNED to the analysis window: the recorded tone is
      // only nominally bin-periodic (real clocks drift within the block), so
      // a wrap seam carries a small discontinuity. Naive wrap-from-zero puts
      // that seam at the centre of the analysed window — where the Hann
      // weight peaks — and the leakage raises the displayed noise floor
      // ~60 dB above the recording's true one (measured: −66 vs −123 dBV/bin
      // on the sine fixture), corrupting THD+N/SNR. Centering the pristine
      // block under the middle-numSamples window instead keeps every seam
      // inside the discarded guards: the app analyses the recording verbatim.
      const wrap = (src: number[]): number[] => {
        const n = left.length;
        if (n === src.length) return [...src];
        // Sample i of the padded buffer maps to src[i − offset], wrapped;
        // offset = the leading guard, so [offset, offset + src.length) is the
        // recording verbatim. For n < src.length this center-CROPS (offset
        // negative): still one contiguous run, still seam-free.
        const offset = Math.floor((n - src.length) / 2);
        const out = new Array<number>(n);
        for (let i = 0; i < n; i++) {
          out[i] = src[(((i - offset) % src.length) + src.length) % src.length];
        }
        return out;
      };
      return { left: wrap(fix.left), right: wrap(fix.right) };
    },
  };
}

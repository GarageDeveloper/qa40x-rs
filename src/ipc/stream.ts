/**
 * Stream transport: the ONE place that knows the wire shape of a pushed
 * frame (plan §3.2). `decodeFrame` isolates wire → typed-arrays so a later
 * binary payload (header + f32, M6) changes exactly one function.
 */
import type {
  AnalysisResult,
  HarmonicMark,
  LevelOffsetsDb,
  MixStatus,
  ScopeMeasures,
  SlotError,
  StreamMsg,
  StreamStats,
  TriggerAlign,
} from "../gen";
import type { Ipc } from "./ipc";
import { TauriChannel } from "./ipc";
import type { StreamConfig } from "../gen";

export interface DecodedFd {
  freqs: Float64Array;
  magDb: Float64Array;
}

export interface DecodedTd {
  sampleRate: number;
  samples: Float64Array;
}

/** One decoded frame, ready for the frames cache. */
export interface DecodedFrame {
  seq: number;
  sampleRate: number;
  input: { l: DecodedTd; r: DecodedTd };
  /** The summed stimulus actually sent; null in monitor mode. */
  output: { l: DecodedTd; r: DecodedTd } | null;
  fd: {
    inputL: DecodedFd | null;
    inputR: DecodedFd | null;
    outputL: DecodedFd | null;
    outputR: DecodedFd | null;
  };
  /** Backend harmonic analysis of the captured channels (THD/SNR/… chips)
   * and the located harmonic series (spectrum-tile markers). */
  metrics: {
    inputL: AnalysisResult | null;
    inputR: AnalysisResult | null;
    harmonicsL: HarmonicMark[] | null;
    harmonicsR: HarmonicMark[] | null;
  };
  mix: MixStatus;
  offsets: LevelOffsetsDb;
  stats: StreamStats;
  errors: SlotError[];
  /** Alignment-only scope trigger result per hw endpoint (null = that
   * endpoint isn't triggered this frame — the `TriggerRequest` didn't ask,
   * or the config is per-endpoint "off": stream.rs's `SpectraMsg` pattern). */
  trigger: {
    inputL: TriggerAlign | null;
    inputR: TriggerAlign | null;
    outputL: TriggerAlign | null;
    outputR: TriggerAlign | null;
  };
  /** Scope measurement suites per hw endpoint (issue #26 lot B; null =
   * that endpoint isn't measured this frame — the `MeasureRequest` didn't
   * ask, or an output endpoint in monitor mode). */
  measures: {
    inputL: ScopeMeasures | null;
    inputR: ScopeMeasures | null;
    outputL: ScopeMeasures | null;
    outputR: ScopeMeasures | null;
  };
}

type WireFrame = Extract<StreamMsg, { type: "frame" }>;

export function decodeFrame(msg: WireFrame): DecodedFrame {
  const sampleRate = msg.captured.sample_rate;
  const freqs = Float64Array.from(msg.spectra.frequencies);
  const fd = (mags: number[] | null): DecodedFd | null =>
    mags ? { freqs, magDb: Float64Array.from(mags) } : null;
  const td = (samples: number[]): DecodedTd => ({
    sampleRate,
    samples: Float64Array.from(samples),
  });
  return {
    seq: Number(msg.seq),
    sampleRate,
    input: { l: td(msg.captured.left_channel), r: td(msg.captured.right_channel) },
    output: msg.stimulus
      ? { l: td(msg.stimulus.left), r: td(msg.stimulus.right) }
      : null,
    fd: {
      inputL: fd(msg.spectra.input_l),
      inputR: fd(msg.spectra.input_r),
      outputL: fd(msg.spectra.output_l),
      outputR: fd(msg.spectra.output_r),
    },
    metrics: {
      inputL: msg.metrics?.input_l ?? null,
      inputR: msg.metrics?.input_r ?? null,
      harmonicsL: msg.metrics?.harmonics_l ?? null,
      harmonicsR: msg.metrics?.harmonics_r ?? null,
    },
    mix: msg.mix,
    offsets: msg.offsets,
    stats: msg.stats,
    errors: msg.errors,
    trigger: {
      inputL: msg.trigger.input_l,
      inputR: msg.trigger.input_r,
      outputL: msg.trigger.output_l,
      outputR: msg.trigger.output_r,
    },
    measures: {
      inputL: msg.measures.input_l,
      inputR: msg.measures.input_r,
      outputL: msg.measures.output_l,
      outputR: msg.measures.output_r,
    },
  };
}

export interface StreamHandlers {
  onFrame(frame: DecodedFrame): void;
  onError(message: string): void;
  onStopped(): void;
}

/**
 * Start the backend stream: builds the push channel, dispatches decoded
 * messages to the handlers. Resolves when the backend accepted the start.
 */
export async function startStream(
  ipc: Ipc,
  config: StreamConfig,
  handlers: StreamHandlers
): Promise<void> {
  const onFrame = new TauriChannel<StreamMsg>((msg) => {
    switch (msg.type) {
      case "frame":
        handlers.onFrame(decodeFrame(msg));
        break;
      case "error":
        handlers.onError(msg.message);
        break;
      case "stopped":
        handlers.onStopped();
        break;
    }
  });
  await ipc.call("stream_start", { config, onFrame });
}

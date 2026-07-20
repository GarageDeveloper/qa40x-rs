/**
 * The typed IPC facade — the ONLY place in src/ where `invoke()` and
 * backend command names exist (plan §3.3).
 *
 * `Commands` maps every command to its arg and result shapes, built on the
 * ts-rs generated wire types in ../gen. The e2e fake device conforms to
 * the same table, so app, fake and Rust all share one generated contract:
 * changing a command breaks the fake's compile instead of an e2e run.
 *
 * Arg names are camelCase — Tauri v2 converts them to the Rust snake_case
 * parameters (`gainDbv` → `gain_dbv`).
 */
import { invoke, Channel as TauriChannel } from "@tauri-apps/api/core";
import type {
  Channel,
  DeviceConfig,
  DeviceMeta,
  DryRun,
  ExtractionResult,
  Frame,
  FrameMeasures,
  FrequencyResponseTrace,
  InputDbvOffset,
  MixerSlotDesc,
  OutputOnlyStatus,
  ReleaseInfo,
  RestStatus,
  ScriptRole,
  StreamConfig,
  StreamMsg,
  Telemetry,
  ThdSweepResult,
  TransformChainResult,
  TransformStep,
} from "../gen";

export { TauriChannel };

export interface Commands {
  // Connection lifecycle
  connect_device: { args: Record<string, never>; result: string };
  disconnect_device: { args: Record<string, never>; result: string };
  is_device_connected: { args: Record<string, never>; result: boolean };
  is_device_present: { args: Record<string, never>; result: boolean };
  get_device_info: { args: Record<string, never>; result: DeviceMeta | null };

  // Configuration
  get_device_config: { args: Record<string, never>; result: DeviceConfig };
  read_device_config: { args: Record<string, never>; result: DeviceConfig };
  set_input_gain: { args: { gainDbv: number }; result: string };
  set_output_gain: { args: { gainDbv: number }; result: string };
  set_sample_rate: { args: { rateHz: number }; result: string };

  // Per-converter display offsets (one per channel per converter — never
  // borrow the other converter's offset, task #51)
  get_input_dbv_offset: {
    args: { inputChannel: Channel };
    result: InputDbvOffset;
  };
  get_output_dbv_offset: {
    args: { outputChannel: Channel };
    result: InputDbvOffset;
  };

  // The backend run loop (B-2): a tokio task renders sources, fits the
  // output range, captures and analyzes; frames arrive over the Channel.
  // Every frame carries its own per-converter LevelOffsetsDb (B-3).
  stream_start: {
    args: { config: StreamConfig; onFrame: TauriChannel<StreamMsg> };
    result: null;
  };
  stream_update: { args: { config: StreamConfig }; result: null };
  stream_stop: { args: Record<string, never>; result: null };
  stream_status: { args: Record<string, never>; result: boolean };
  stream_reset_averaging: { args: Record<string, never>; result: null };
  sweep_stop: { args: Record<string, never>; result: null };

  // Output-only mode (M2): the summed mix drives the DAC gap-free, no
  // capture. The backend owns render → range-fit → scale; stop via the
  // (pre-existing) generator commands.
  output_only_start: {
    args: { slots: MixerSlotDesc[] };
    result: OutputOnlyStatus;
  };
  stop_generator: { args: Record<string, never>; result: string };
  is_generator_running: { args: Record<string, never>; result: boolean };

  // Per-trace measurements for the tile chips (measurements:: math; the
  // frontend memoizes by trace seq and only formats — plan M3).
  measure_frames: {
    args: { td: Frame | null; fd: Frame | null };
    result: FrameMeasures;
  };

  // Transform chains (M4): the whole chain DSP (weighting / notch /
  // deconvolve / Rhai) runs backend-side; `refs` carries the resolved
  // spectra of any deconvolve reference traces.
  apply_transform_chain: {
    args: {
      td: Frame | null;
      fd: Frame | null;
      steps: TransformStep[];
      refs: Record<string, Frame>;
    };
    result: TransformChainResult;
  };

  // Measurement programs (M4): exclusive device owners — the caller stops
  // the stream loop first and restarts it after (the lock policy lives in
  // actions/programs.ts).
  measure_thd_vs_frequency: {
    args: {
      startFreq: number;
      endFreq: number;
      numPoints: number;
      amplitudeDbfs: number;
      outputChannel: Channel;
      inputChannel: Channel;
    };
    result: ThdSweepResult;
  };
  measure_frequency_response_multi: {
    args: {
      startFreq: number;
      endFreq: number;
      driveLeft: boolean;
      driveRight: boolean;
      wantLeft: boolean;
      wantRight: boolean;
      durationSecs: number;
      amplitudeDbfs: number;
    };
    result: FrequencyResponseTrace[];
  };

  // Measurement scripts (M4): the run streams `script-log` / `script-frame`
  // / `script-state` events; one script at a time.
  script_run: { args: { source: string; role: ScriptRole }; result: null };
  script_stop: { args: Record<string, never>; result: null };
  script_status: { args: Record<string, never>; result: boolean };

  // Telemetry / keepalive
  read_telemetry: { args: Record<string, never>; result: Telemetry };
  keepalive: { args: Record<string, never>; result: Telemetry };
  last_telemetry: { args: Record<string, never>; result: Telemetry | null };

  // REST automation server
  rest_status: { args: Record<string, never>; result: RestStatus };
  rest_set_exposed: { args: { exposed: boolean }; result: RestStatus };
  rest_set_token: { args: { token: string | null }; result: RestStatus };

  // Firmware panel (M5): extract + verify official firmware images, build
  // the dry-run byte plan, and (gated, confirmed) flash the connected unit.
  extract_firmware_from_exe: { args: { path: string }; result: ExtractionResult };
  extract_firmware_from_setup: { args: { path: string }; result: ExtractionResult };
  list_qa40x_releases: { args: Record<string, never>; result: ReleaseInfo[] };
  download_qa40x_setup: { args: { url: string }; result: string };
  flash_dry_run: { args: { sha256: string }; result: DryRun };
  flash_firmware: { args: { sha256: string }; result: null };
}

export type CommandName = keyof Commands;

/** The one `invoke` wrapper. Everything IPC goes through here. */
export function call<K extends CommandName>(
  cmd: K,
  args: Commands[K]["args"]
): Promise<Commands[K]["result"]> {
  return invoke<Commands[K]["result"]>(cmd, args);
}

/**
 * The Ipc seam: panels and actions depend on this interface, so tests and
 * the demo mode substitute an in-page implementation (plan §3.6).
 */
export interface Ipc {
  call<K extends CommandName>(
    cmd: K,
    args: Commands[K]["args"]
  ): Promise<Commands[K]["result"]>;
}

export const tauriIpc: Ipc = { call };

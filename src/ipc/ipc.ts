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
  AddedDevice,
  Channel,
  DeviceConfig,
  DeviceList,
  DeviceMeta,
  DryRun,
  ExtractionResult,
  Frame,
  FrameMeasures,
  FrequencyResponseTrace,
  I2sStatus,
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
  WowFlutterResult,
} from "../gen";

export { TauriChannel };

/**
 * Device-keyed commands accept an optional `deviceId` (issue #25 lot C):
 * omitted ⇒ the backend's default device — every caller predating lot D is
 * unchanged; the devices slice passes it on an explicit pick (rule P3).
 * Backend contract, two rules: `connect_device` accepts any ENUMERATED
 * unit's id (it exists to open one); every other keyed command resolves
 * only an OPEN device's id and rejects anything else
 * (`Unknown device: <id>`), never falls back — so querying a unit's info
 * before connecting it goes through `connect_device` first, by design.
 */
type DeviceScoped = { deviceId?: string };

export interface Commands {
  // Connection lifecycle. `connect_device` with a `deviceId` opens that
  // specific enumerated unit (any source, virtual included); without it,
  // the first physical unit (legacy auto-connect).
  connect_device: { args: DeviceScoped; result: string };
  // Demo mode: attach the embedded virtual QA40x (in-process simulator) —
  // same device surface as hardware, `DeviceMeta.is_virtual` flags it.
  // Names its unit by construction — any-unit opens go through
  // `connect_device` with a `deviceId`.
  connect_virtual_device: { args: Record<string, never>; result: string };
  // Add-device (issue #25 lot E4): open an ADDITIONAL enumerated unit onto
  // a free non-default runtime slot — never a supersede (already-open is
  // rejected). `deviceId` is REQUIRED here, unlike every DeviceScoped
  // command: it names the unit to OPEN, and the answer carries the opened
  // id + slot so the caller mints its session with the id already adopted
  // (no unroutable window). `slot` is the OPTIONAL preferred slot (the
  // revive-a-dormant-group gesture asks for the group's own slot);
  // occupied/invalid hints fall back — the answer's slot is the authority.
  connect_additional_device: {
    args: { deviceId: string; slot?: number };
    result: AddedDevice;
  };
  disconnect_device: { args: DeviceScoped; result: string };
  is_device_connected: { args: DeviceScoped; result: boolean };
  is_device_present: { args: Record<string, never>; result: boolean };
  // Real hardware on the USB bus (the virtual device never counts) — polled
  // during a demo session so a newly plugged QA40x takes over.
  is_hardware_present: { args: Record<string, never>; result: boolean };
  get_device_info: { args: DeviceScoped; result: DeviceMeta | null };
  // Enumeration is registry-level, not device-keyed (no deviceId): it
  // lists EVERY unit the registry can offer, open or not — the open unit's
  // entry enriched (firmware + calibration), the rest carrying what the
  // bus/model tables know.
  list_devices: { args: Record<string, never>; result: DeviceList };

  // Configuration
  get_device_config: { args: DeviceScoped; result: DeviceConfig };
  read_device_config: { args: DeviceScoped; result: DeviceConfig };
  set_input_gain: { args: { gainDbv: number } & DeviceScoped; result: string };
  set_output_gain: { args: { gainDbv: number } & DeviceScoped; result: string };
  set_sample_rate: { args: { rateHz: number } & DeviceScoped; result: string };

  // Per-converter display offsets (one per channel per converter — never
  // borrow the other converter's offset, task #51)
  get_input_dbv_offset: {
    args: { inputChannel: Channel } & DeviceScoped;
    result: InputDbvOffset;
  };
  get_output_dbv_offset: {
    args: { outputChannel: Channel } & DeviceScoped;
    result: InputDbvOffset;
  };

  // The backend run loop (B-2): a tokio task renders sources, fits the
  // output range, captures and analyzes; frames arrive over the Channel.
  // Every frame carries its own per-converter LevelOffsetsDb (B-3).
  stream_start: {
    args: { config: StreamConfig; onFrame: TauriChannel<StreamMsg> } & DeviceScoped;
    result: null;
  };
  stream_update: { args: { config: StreamConfig } & DeviceScoped; result: null };
  stream_stop: { args: DeviceScoped; result: null };
  stream_status: { args: DeviceScoped; result: boolean };
  stream_reset_averaging: { args: DeviceScoped; result: null };
  stream_reset_measure_stats: { args: DeviceScoped; result: null };
  sweep_stop: { args: DeviceScoped; result: null };

  // Output-only mode (M2): the summed mix drives the DAC gap-free, no
  // capture. The backend owns render → range-fit → scale; stop via the
  // (pre-existing) generator commands.
  output_only_start: {
    args: { slots: MixerSlotDesc[] } & DeviceScoped;
    result: OutputOnlyStatus;
  };
  stop_generator: { args: DeviceScoped; result: string };
  is_generator_running: { args: DeviceScoped; result: boolean };

  // Front-panel I2S output (issue #71): one idempotent full-state
  // declaration (enable with a slot set / rebuild / disable) on the
  // device's own I2S engine — 48 kHz pinned, runs concurrently with the
  // acquisition stream. `widthBits` optional (default 32 — the only value
  // the vendor app was observed writing). `i2s_status` is a pure backend
  // cache read, safe to poll during a capture.
  i2s_apply: {
    args: {
      enabled: boolean;
      slots: MixerSlotDesc[];
      referenceDbv: number;
      widthBits?: number;
    } & DeviceScoped;
    result: I2sStatus;
  };
  i2s_status: { args: DeviceScoped; result: I2sStatus };

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
    } & DeviceScoped;
    result: ThdSweepResult;
  };
  // THD vs level (issue #27): sweeps the stimulus level at a fixed tone
  // frequency instead of sweeping frequency at a fixed level — same
  // program lock / batched-capture plumbing as measure_thd_vs_frequency.
  measure_thd_vs_level: {
    args: {
      startLevelDbfs: number;
      endLevelDbfs: number;
      numPoints: number;
      frequencyHz: number;
      outputChannel: Channel;
      inputChannel: Channel;
    } & DeviceScoped;
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
    } & DeviceScoped;
    result: FrequencyResponseTrace[];
  };
  // Wow & flutter (issue #28): FM-demodulate a captured reference tone
  // (DIN/IEC 386 approximation). `generate` plays the reference tone on
  // `outputChannel` (loopback / driven DUT); off, silence is sent and
  // `inputChannel` is just monitored (an external transport already playing
  // the test tone — tape, turntable). Session-scoped like the sweeps above.
  measure_wow_flutter: {
    args: {
      referenceFreq: number;
      durationSecs: number;
      outputChannel: Channel;
      inputChannel: Channel;
      generate: boolean;
    } & DeviceScoped;
    result: WowFlutterResult;
  };
  // Measurement scripts (M4): the run streams `script-log` / `script-frame`
  // / `script-state` events; one script at a time, bench-wide. The exclusive
  // device session is built from `deviceId`'s runtime (issue #25 lot F);
  // callers routing it must gate with isRoutable() like every DeviceScoped
  // verb (lot F4 wires the program's own session key through here).
  script_run: { args: { source: string; role: ScriptRole } & DeviceScoped; result: null };
  script_stop: { args: Record<string, never>; result: null };
  script_status: { args: Record<string, never>; result: boolean };

  // Telemetry / keepalive
  read_telemetry: { args: DeviceScoped; result: Telemetry };
  keepalive: { args: DeviceScoped; result: Telemetry };
  last_telemetry: { args: DeviceScoped; result: Telemetry | null };

  // REST automation server
  rest_status: { args: Record<string, never>; result: RestStatus };
  rest_set_exposed: { args: { exposed: boolean }; result: RestStatus };
  rest_set_token: { args: { token: string | null }; result: RestStatus };

  // Data export (issue #30): the frontend builds the bytes (CSV text, PNG,
  // raw RGBA) — these only put them on disk / the system clipboard.
  export_write_file: { args: { path: string; contentsBase64: string }; result: null };
  export_copy_image: { args: { pngBase64: string }; result: null };

  // Firmware panel (M5): extract + verify official firmware images, build
  // the dry-run byte plan, and (gated, confirmed) flash the connected unit.
  extract_firmware_from_exe: { args: { path: string }; result: ExtractionResult };
  extract_firmware_from_setup: { args: { path: string }; result: ExtractionResult };
  list_qa40x_releases: { args: Record<string, never>; result: ReleaseInfo[] };
  download_qa40x_setup: { args: { url: string }; result: string };
  flash_dry_run: { args: { sha256: string }; result: DryRun };
  flash_firmware: { args: { sha256: string } & DeviceScoped; result: null };
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

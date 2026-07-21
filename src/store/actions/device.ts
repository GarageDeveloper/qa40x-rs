/**
 * Device actions: connection lifecycle + configuration. Each action is the
 * unidirectional path  IPC → store  (never DOM → store, never store → IPC
 * as a side effect of rendering).
 */
import type { Ipc } from "../../ipc/ipc";
import type { Store } from "../store";
import type { AppState, LevelOffsetsDb } from "../state";
import { toast } from "./ui";

/**
 * Read all four per-converter offsets. Four calls, four values — an Input
 * trace must use its own ADC channel offset and an Output trace its own
 * DAC channel offset (bug class #48/#50/#51/#58/#60).
 */
async function readOffsets(ipc: Ipc): Promise<LevelOffsetsDb> {
  const [inL, inR, outL, outR] = await Promise.all([
    ipc.call("get_input_dbv_offset", { inputChannel: "Left" }),
    ipc.call("get_input_dbv_offset", { inputChannel: "Right" }),
    ipc.call("get_output_dbv_offset", { outputChannel: "Left" }),
    ipc.call("get_output_dbv_offset", { outputChannel: "Right" }),
  ]);
  return {
    input_l: inL.offset_db,
    input_r: inR.offset_db,
    output_l: outL.offset_db,
    output_r: outR.offset_db,
    calibrated: inL.calibrated && outL.calibrated,
  };
}

/** Refresh config + offsets together: offsets move with the ranges. */
async function refreshConfig(store: Store<AppState>, ipc: Ipc): Promise<void> {
  const [config, offsets] = await Promise.all([
    ipc.call("get_device_config", {}),
    readOffsets(ipc),
  ]);
  store.update("device/config", (s) => ({
    ...s,
    device: { ...s.device, config, offsets },
  }));
}

export async function connect(
  store: Store<AppState>,
  ipc: Ipc,
  opts: { silent?: boolean } = {}
): Promise<void> {
  store.update("device/connecting", (s) => ({
    ...s,
    device: { ...s.device, status: "connecting", userDisconnected: false },
  }));
  try {
    await ipc.call("connect_device", {});
    const info = await ipc.call("get_device_info", {});
    store.update("device/connected", (s) => ({
      ...s,
      device: { ...s.device, status: "connected", present: true, info },
    }));
    await refreshConfig(store, ipc);
    toast(store, "success", `Connected to ${info?.model ?? "device"}`);
  } catch (e) {
    store.update("device/connect-failed", (s) => ({
      ...s,
      device: { ...s.device, status: "disconnected" },
    }));
    // Auto-connect retries every few seconds — only a MANUAL attempt may
    // toast, or a flaky cable turns into an error firehose.
    if (!opts.silent) toast(store, "error", `Connect failed: ${e}`);
  }
}

/**
 * Hardware presence seen by the LAST demo-session poll. Baseline for the
 * edge detection in {@link autoConnectTick}: a demo session hands over to
 * real hardware on an absent→present TRANSITION (the user plugs a unit in
 * mid-demo), never on mere presence — clicking Demo with a unit already
 * connected to the bus is an explicit choice that must stick.
 * `null` = no baseline yet (first poll after a demo connect only records).
 */
let demoHwPresent: boolean | null = null;

/**
 * Demo mode: connect to the embedded virtual QA40x. No hardware, no
 * download — the backend runs the simulator in-process and the whole app
 * (measurements, generator, REST, scripts) works on it. The session is
 * badged via `DeviceMeta.is_virtual`.
 */
export async function connectVirtual(
  store: Store<AppState>,
  ipc: Ipc
): Promise<void> {
  demoHwPresent = null;
  store.update("device/connecting", (s) => ({
    ...s,
    device: { ...s.device, status: "connecting", userDisconnected: false },
  }));
  try {
    await ipc.call("connect_virtual_device", {});
    const info = await ipc.call("get_device_info", {});
    store.update("device/connected", (s) => ({
      ...s,
      device: { ...s.device, status: "connected", present: true, info },
    }));
    // Seed the hand-over baseline NOW: hardware plugged in from here on is a
    // transition; hardware already on the bus was an explicit non-choice.
    try {
      demoHwPresent = await ipc.call("is_hardware_present", {});
    } catch {
      demoHwPresent = null; // unknown — the tick records a baseline first
    }
    await refreshConfig(store, ipc);
    toast(store, "success", `Demo mode: virtual ${info?.model ?? "QA40x"} connected`);
  } catch (e) {
    store.update("device/connect-failed", (s) => ({
      ...s,
      device: { ...s.device, status: "disconnected" },
    }));
    toast(store, "error", `Demo mode failed: ${e}`);
  }
}

/**
 * Auto-connect tick (v1 parity): while the user hasn't explicitly
 * disconnected, connect whenever a device is present on the bus. Runs at
 * startup and on a slow poll — also what reconnects after a replug.
 */
export async function autoConnectTick(
  store: Store<AppState>,
  ipc: Ipc
): Promise<void> {
  const { status, userDisconnected, info } = store.get().device;

  // Demo session: hand over to real hardware the moment a unit is PLUGGED
  // IN (absent→present edge — see demoHwPresent for why not mere presence).
  // The switch rides the tested manual paths: disconnect() stops the run
  // loop / generator and detaches the simulator, connect() claims the unit.
  if (status === "connected" && info?.is_virtual) {
    try {
      const hw = await ipc.call("is_hardware_present", {});
      const wasAbsent = demoHwPresent === false;
      demoHwPresent = hw;
      if (hw && wasAbsent) {
        toast(store, "info", "QA40x plugged in — leaving demo mode");
        await disconnect(store, ipc);
        await connect(store, ipc);
      }
    } catch {
      // Transient USB error — next tick retries.
    }
    return;
  }

  if (status !== "disconnected" || userDisconnected) return;
  try {
    const present = await ipc.call("is_device_present", {});
    store.update("device/present", (s) =>
      s.device.present === present
        ? s
        : { ...s, device: { ...s.device, present } }
    );
    if (present) await connect(store, ipc, { silent: true });
  } catch {
    // No device / transient USB error — next tick retries.
  }
}

export async function disconnect(
  store: Store<AppState>,
  ipc: Ipc
): Promise<void> {
  try {
    // The backend stops the stream loop / generator BEFORE closing the
    // device (a clean Stopped reaches the channel — no capture error).
    await ipc.call("disconnect_device", {});
  } finally {
    store.update("device/disconnected", (s) => ({
      ...s,
      device: {
        ...s.device,
        status: "disconnected",
        // Manual disconnect: hold off auto-reconnect until a manual connect.
        userDisconnected: true,
        info: null,
        config: null,
        telemetry: null,
        offsets: null,
      },
      run: runStoppedByDisconnect(s),
    }));
  }
}

/** Run-state mirror of a disconnect: nothing drives the DAC anymore, and
 * the output-only session must not silently rebuild on the next edit. */
function runStoppedByDisconnect(s: AppState): AppState["run"] {
  return {
    ...s.run,
    streaming: false,
    generatorRunning: false,
    outputOnly: false,
  };
}

/**
 * Backend pushed a disconnect (USB monitoring event). Idempotent: the
 * monitor also fires after a MANUAL disconnect (it only sees "no longer
 * connected"), and any duplicate event must not re-toast or churn state.
 */
export function deviceLost(store: Store<AppState>): void {
  if (store.get().device.status === "disconnected") return;
  store.update("device/lost", (s) => ({
    ...s,
    device: {
      ...s.device,
      status: "disconnected",
      present: false,
      info: null,
      config: null,
      telemetry: null,
      offsets: null,
    },
    run: runStoppedByDisconnect(s),
  }));
  // Info, not error: an unplug is a state change (LED, greyed controls and
  // the status bar already carry it), and info toasts auto-dismiss —
  // error toasts stay until closed by hand.
  toast(store, "info", "Device disconnected");
}

export async function setInputRange(
  store: Store<AppState>,
  ipc: Ipc,
  gainDbv: number
): Promise<void> {
  try {
    await ipc.call("set_input_gain", { gainDbv });
    await refreshConfig(store, ipc);
  } catch (e) {
    toast(store, "error", `Input range: ${e}`);
  }
}

export async function setOutputRange(
  store: Store<AppState>,
  ipc: Ipc,
  gainDbv: number
): Promise<void> {
  try {
    await ipc.call("set_output_gain", { gainDbv });
    await refreshConfig(store, ipc);
  } catch (e) {
    toast(store, "error", `Output range: ${e}`);
  }
}

export async function setSampleRate(
  store: Store<AppState>,
  ipc: Ipc,
  rateHz: number
): Promise<void> {
  try {
    await ipc.call("set_sample_rate", { rateHz });
    await refreshConfig(store, ipc);
  } catch (e) {
    toast(store, "error", `Sample rate: ${e}`);
  }
}

export async function refreshTelemetry(
  store: Store<AppState>,
  ipc: Ipc
): Promise<void> {
  const { device, run } = store.get();
  if (device.status !== "connected") return;
  try {
    // Idle: fire the ~1 s keepalive — it pings the link register (keeps the
    // LINK LED lit, #31) AND reads fresh telemetry. During a run, never
    // touch the register bus: read the cache the stream's own in-run
    // keepalive maintains (`last_telemetry`, no USB I/O).
    const telemetry = run.streaming
      ? await ipc.call("last_telemetry", {})
      : await ipc.call("keepalive", {});
    if (telemetry) {
      store.update("device/telemetry", (s) => ({
        ...s,
        device: { ...s.device, telemetry },
      }));
    }
  } catch {
    // Telemetry is best-effort; a failed poll must not toast-spam.
  }
}

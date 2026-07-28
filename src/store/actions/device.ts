/**
 * Device actions: connection lifecycle + configuration. Each action is the
 * unidirectional path  IPC → store  (never DOM → store, never store → IPC
 * as a side effect of rendering).
 */
import type { Ipc } from "../../ipc/ipc";
import type { Store } from "../store";
import type { AppState, LevelOffsetsDb, RunState, SessionKey } from "../state";
import { SLOT0 } from "../state";
import { autoConnectDeviceId } from "../selectors/devices";
import {
  session,
  sessionArgs,
  updateDevice,
  updateRun,
} from "../selectors/session";
import { refreshDevices } from "./devices";
import { syncStream } from "./stream";
import { toast } from "./ui";

/**
 * Read all four per-converter offsets. Four calls, four values — an Input
 * trace must use its own ADC channel offset and an Output trace its own
 * DAC channel offset (bug class #48/#50/#51/#58/#60).
 */
async function readOffsets(
  ipc: Ipc,
  scope: { deviceId?: string }
): Promise<LevelOffsetsDb> {
  const [inL, inR, outL, outR] = await Promise.all([
    ipc.call("get_input_dbv_offset", { inputChannel: "Left", ...scope }),
    ipc.call("get_input_dbv_offset", { inputChannel: "Right", ...scope }),
    ipc.call("get_output_dbv_offset", { outputChannel: "Left", ...scope }),
    ipc.call("get_output_dbv_offset", { outputChannel: "Right", ...scope }),
  ]);
  return {
    input_l: inL.offset_db,
    input_r: inR.offset_db,
    output_l: outL.offset_db,
    output_r: outR.offset_db,
    calibrated: inL.calibrated && outL.calibrated,
  };
}

/** Refresh config + offsets together: offsets move with the ranges. KEYED
 * (E2 review #4): the wire is arg-less for slot 0 (sessionArgs contract),
 * and the answer lands on the SAME session it was read from — a connect on
 * slot 0 with the focus elsewhere must never overwrite the focused unit's
 * four-offsets record (the #48/#50/#51 class). */
async function refreshConfig(
  store: Store<AppState>,
  ipc: Ipc,
  key: SessionKey
): Promise<void> {
  const scope = sessionArgs(store.get(), key);
  const [config, offsets] = await Promise.all([
    ipc.call("get_device_config", scope),
    readOffsets(ipc, scope),
  ]);
  store.update("device/config", (s) =>
    updateDevice(s, key, (d) => ({ ...d, config, offsets }))
  );
}

export async function connect(
  store: Store<AppState>,
  ipc: Ipc,
  opts: { silent?: boolean; deviceId?: string } = {}
): Promise<void> {
  // The connect/demo flows OWN slot 0 (the E1 contract: open/
  // open_first_physical/open_virtual all target the default runtime) —
  // keyed on SLOT0, not the focus, so a future focus on slot ≥ 1 can never
  // reroute the legacy connect path. `connect_additional_device` (E4) gets
  // its own action.
  store.update("device/connecting", (s) =>
    updateDevice(s, SLOT0, (d) => ({ ...d, status: "connecting", userDisconnected: false }))
  );
  try {
    // Rule P3 (issue #25 lot D) lives at the CALL SITES: `deviceId` is
    // passed only when the user explicitly picked a unit (see
    // selectors/devices.ts) — the arg-less call is the legacy
    // first-physical auto-connect, byte-identical to pre-lot-D. Passing the
    // primary here instead would turn an empty bench into auto-demo (the
    // virtual unit is always enumerable).
    const args = opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {};
    await ipc.call("connect_device", args);
    const info = await ipc.call("get_device_info", args);
    store.update("device/connected", (s) =>
      updateDevice(s, SLOT0, (d) => ({ ...d, status: "connected", present: true, info }))
    );
    // An explicit pick can open the VIRTUAL unit through this path too
    // (review #4): seed the demo hand-over baseline exactly like
    // connectVirtual, or a stale `false` baseline would read the existing
    // hardware as a plug-in edge and tear the chosen session down in 2 s.
    if (info?.is_virtual) {
      try {
        demoHwPresent.set(SLOT0, await ipc.call("is_hardware_present", {}));
      } catch {
        demoHwPresent.set(SLOT0, null); // unknown — the tick records a baseline first
      }
    }
    await refreshConfig(store, ipc, SLOT0);
    toast(store, "success", `Connected to ${info?.model ?? "device"}`);
  } catch (e) {
    store.update("device/connect-failed", (s) =>
      updateDevice(s, SLOT0, (d) => ({ ...d, status: "disconnected" }))
    );
    // Auto-connect retries every few seconds — only a MANUAL attempt may
    // toast, or a flaky cable turns into an error firehose.
    if (!opts.silent) toast(store, "error", `Connect failed: ${e}`);
  }
  // Either way the open/enumeration picture changed (or a stale pick just
  // failed) — refresh the devices slice; fire-and-forget, UI already moved.
  void refreshDevices(store, ipc);
}

/**
 * Hardware presence seen by the LAST demo-session poll, PER SESSION (issue
 * #25: no device-global module state — though demo remains a slot-0 flow
 * in practice). Baseline for the edge detection in {@link autoConnectTick}:
 * a demo session hands over to real hardware on an absent→present
 * TRANSITION (the user plugs a unit in mid-demo), never on mere presence —
 * clicking Demo with a unit already connected to the bus is an explicit
 * choice that must stick. Absent/`null` = no baseline yet (first poll
 * after a demo connect only records).
 */
const demoHwPresent = new Map<SessionKey, boolean | null>();

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
  demoHwPresent.set(SLOT0, null);
  store.update("device/connecting", (s) =>
    updateDevice(s, SLOT0, (d) => ({ ...d, status: "connecting", userDisconnected: false }))
  );
  try {
    await ipc.call("connect_virtual_device", {});
    const info = await ipc.call("get_device_info", {});
    store.update("device/connected", (s) =>
      updateDevice(s, SLOT0, (d) => ({ ...d, status: "connected", present: true, info }))
    );
    // Seed the hand-over baseline NOW: hardware plugged in from here on is a
    // transition; hardware already on the bus was an explicit non-choice.
    try {
      demoHwPresent.set(SLOT0, await ipc.call("is_hardware_present", {}));
    } catch {
      demoHwPresent.set(SLOT0, null); // unknown — the tick records a baseline first
    }
    await refreshConfig(store, ipc, SLOT0);
    toast(store, "success", `Demo mode: virtual ${info?.model ?? "QA40x"} connected`);
  } catch (e) {
    store.update("device/connect-failed", (s) =>
      updateDevice(s, SLOT0, (d) => ({ ...d, status: "disconnected" }))
    );
    toast(store, "error", `Demo mode failed: ${e}`);
  }
  void refreshDevices(store, ipc);
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
  // The tick manages SLOT 0 only, like the connect flows it drives: added
  // units (slots ≥ 1, lot E4) are opened explicitly and never auto-anything.
  const slot0 = session(store.get(), SLOT0);
  if (!slot0) return;
  const { status, userDisconnected, info } = slot0.device;

  // Demo session: hand over to real hardware the moment a unit is PLUGGED
  // IN (absent→present edge — see demoHwPresent for why not mere presence).
  // The switch rides the tested manual paths: disconnect() stops the run
  // loop / generator and detaches the simulator, connect() claims the unit.
  if (status === "connected" && info?.is_virtual) {
    try {
      const hw = await ipc.call("is_hardware_present", {});
      const wasAbsent = demoHwPresent.get(SLOT0) === false;
      demoHwPresent.set(SLOT0, hw);
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
      session(s, SLOT0)?.device.present === present
        ? s
        : updateDevice(s, SLOT0, (d) => ({ ...d, present }))
    );
    // Rule P4: honor an explicit PHYSICAL pick (else the picker and the
    // tick would fight — the user picks unit B, the tick opens unit A). A
    // virtual pick never flows in here: auto-connect must not auto-demo.
    if (present) {
      await connect(store, ipc, {
        silent: true,
        deviceId: autoConnectDeviceId(store.get()),
      });
    }
  } catch {
    // No device / transient USB error — next tick retries.
  }
}

export async function disconnect(
  store: Store<AppState>,
  ipc: Ipc,
  sessionKey: SessionKey = SLOT0
): Promise<void> {
  try {
    // The backend stops the stream loop / generator BEFORE closing the
    // device (a clean Stopped reaches the channel — no capture error).
    // Arg-less for slot 0 by the sessionArgs contract (the top-bar
    // Disconnect); E4's group headers pass their own session key.
    await ipc.call("disconnect_device", sessionArgs(store.get(), sessionKey));
  } finally {
    store.update("device/disconnected", (s) =>
      updateRun(
        updateDevice(s, sessionKey, (d) => ({
          ...d,
          status: "disconnected",
          // Manual disconnect: hold off auto-reconnect until a manual connect.
          userDisconnected: true,
          info: null,
          config: null,
          telemetry: null,
          offsets: null,
        })),
        sessionKey,
        runStoppedByDisconnect
      )
    );
  }
  void refreshDevices(store, ipc);
}

/** Run-state mirror of a disconnect: nothing drives the DAC anymore, and
 * the output-only session must not silently rebuild on the next edit. */
function runStoppedByDisconnect(r: RunState): RunState {
  return {
    ...r,
    streaming: false,
    generatorRunning: false,
    outputOnly: false,
  };
}

/**
 * Backend pushed a disconnect (USB monitoring event). Idempotent: the
 * monitor also fires after a MANUAL disconnect (it only sees "no longer
 * connected"), and any duplicate event must not re-toast or churn state.
 *
 * `deviceId` names the lost unit (issue #25 lot C); the loss is ROUTED to
 * the session holding that id (lot E2) so unit A's loss never tears down
 * unit B's session. Fallback to slot 0 covers the payload-less event
 * (older backend, the e2e fake) AND an id no session has adopted yet (the
 * post-connect enumeration hasn't landed) — the pre-E2 behavior for the
 * only session that can be open then; E4 revisits when several are.
 */
export function deviceLost(store: Store<AppState>, deviceId: string | null = null): void {
  const s0 = store.get();
  const matched =
    deviceId !== null
      ? Object.values(s0.devices.sessions).find((x) => x.deviceId === deviceId)?.key
      : undefined;
  // SLOT0 fallback ONLY for the payload-less event or while slot 0 is the
  // lone session (the pre-adoption window right after connect). With
  // several sessions, an id nobody holds must be a NO-OP (E2 review #5): a
  // stale enumeration can transiently clear a session's adopted id, and
  // tearing down slot 0 for ANOTHER unit's loss would kill the wrong
  // capture.
  const key =
    matched ??
    (deviceId === null || Object.keys(s0.devices.sessions).length === 1
      ? SLOT0
      : undefined);
  if (key === undefined) return;
  // Idempotence: already disconnected (or no such session at all) — a
  // duplicate monitor event must not re-toast or churn state. A session
  // still "connecting" DOES tear down (pre-E2 behavior kept: the monitor
  // can outrace a doomed connect's own failure path).
  const status = session(s0, key)?.device.status;
  if (status === undefined || status === "disconnected") return;
  store.update("device/lost", (s) =>
    updateRun(
      updateDevice(s, key, (d) => ({
        ...d,
        status: "disconnected",
        present: false,
        info: null,
        config: null,
        telemetry: null,
        offsets: null,
      })),
      key,
      runStoppedByDisconnect
    )
  );
  // Info, not error: an unplug is a state change (LED, greyed controls and
  // the status bar already carry it), and info toasts auto-dismiss —
  // error toasts stay until closed by hand.
  toast(store, "info", "Device disconnected");
}

/* The range/rate setters are KEYED with a SLOT0 default (E2 review #4):
 * the wire call and the refreshConfig read-back must name the SAME session,
 * or a focus elsewhere would land slot 0's fresh offsets on another unit's
 * session. The top-bar menus drive slot 0 in E2; E4's per-group controls
 * pass their own key. */

export async function setInputRange(
  store: Store<AppState>,
  ipc: Ipc,
  gainDbv: number,
  sessionKey: SessionKey = SLOT0
): Promise<void> {
  try {
    await ipc.call("set_input_gain", { gainDbv, ...sessionArgs(store.get(), sessionKey) });
    await refreshConfig(store, ipc, sessionKey);
  } catch (e) {
    toast(store, "error", `Input range: ${e}`);
  }
}

export async function setOutputRange(
  store: Store<AppState>,
  ipc: Ipc,
  gainDbv: number,
  sessionKey: SessionKey = SLOT0
): Promise<void> {
  try {
    await ipc.call("set_output_gain", { gainDbv, ...sessionArgs(store.get(), sessionKey) });
    await refreshConfig(store, ipc, sessionKey);
  } catch (e) {
    toast(store, "error", `Output range: ${e}`);
  }
}

export async function setSampleRate(
  store: Store<AppState>,
  ipc: Ipc,
  rateHz: number,
  sessionKey: SessionKey = SLOT0
): Promise<void> {
  try {
    await ipc.call("set_sample_rate", { rateHz, ...sessionArgs(store.get(), sessionKey) });
    await refreshConfig(store, ipc, sessionKey);
    // A running stream's ms→samples projections (scope windows, trigger
    // pre_samples — selectors/trigger.ts::tileWindowSamples) key on the
    // device sample rate: a step here must reach a live loop, same as every
    // other capture-affecting change (pre-existing gap, surfaced by Lot A).
    syncStream(store, ipc, sessionKey);
  } catch (e) {
    toast(store, "error", `Sample rate: ${e}`);
  }
}

export async function refreshTelemetry(
  store: Store<AppState>,
  ipc: Ipc,
  sessionKey: SessionKey = SLOT0
): Promise<void> {
  const s = store.get();
  const sess = session(s, sessionKey);
  if (sess?.device.status !== "connected") return;
  try {
    // Idle: fire the ~1 s keepalive — it pings the link register (keeps the
    // LINK LED lit, #31) AND reads fresh telemetry. During a run, never
    // touch the register bus: read the cache the stream's own keepalives
    // maintain — between frames and, since #54, at ~1 Hz inside each
    // capture (`last_telemetry`, no USB I/O). Keyed like refreshConfig
    // (E2 review #4): the answer lands on the session it was read from.
    const scope = sessionArgs(s, sessionKey);
    const telemetry = sess.run.streaming
      ? await ipc.call("last_telemetry", scope)
      : await ipc.call("keepalive", scope);
    if (telemetry) {
      store.update("device/telemetry", (st) =>
        updateDevice(st, sessionKey, (d) => ({ ...d, telemetry }))
      );
    }
  } catch {
    // Telemetry is best-effort; a failed poll must not toast-spam.
  }
}

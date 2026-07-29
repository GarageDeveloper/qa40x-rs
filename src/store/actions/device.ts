/**
 * Device actions: connection lifecycle + configuration. Each action is the
 * unidirectional path  IPC → store  (never DOM → store, never store → IPC
 * as a side effect of rendering).
 */
import type { Ipc } from "../../ipc/ipc";
import type { Store } from "../store";
import type { AppState, LevelOffsetsDb, RunState, SessionKey } from "../state";
import { SLOT0, hwTraceIds, sessionKeyForSlot, slotOfSessionKey } from "../state";
import { addableEntries, autoConnectDeviceId } from "../selectors/devices";
import {
  isRoutable,
  session,
  sessionArgs,
  updateDevice,
  updateRun,
} from "../selectors/session";
import { dropSession, mintSession, refreshDevices, setFocusedSession } from "./devices";
import { syncAllDacOwners } from "./outputonly";
import { dropSourceTargetsForSlot } from "./sources";
import { disposeSession, syncStream } from "./stream";
import {
  purgeSlotEndpointTraces,
  reconcileHwTraces,
  resetSlotEndpointTraces,
  stampSlotEndpointIdentity,
} from "./traces";
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
 * four-offsets record (the #48/#50/#51 class). The isRoutable gate (E4)
 * covers a session evicted mid-flow: reads for a dead slot ≥ 1 key must
 * not fall through to the default runtime. Exported for E4's add flow,
 * which passes an EXPLICIT `scope` (review #5): right after the connect
 * answer a stale enumeration can transiently clear the session's adopted
 * id — the add flow knows the id regardless, and skipping the read would
 * leave `config`/`offsets` null forever (playedFrequencyHz would then
 * snap the generator on a 48 kHz grid whatever the unit runs at — the
 * #14 coherence class). */
export async function refreshConfig(
  store: Store<AppState>,
  ipc: Ipc,
  key: SessionKey,
  scope?: { deviceId?: string }
): Promise<void> {
  if (scope === undefined && !isRoutable(store.get(), key)) return;
  scope ??= sessionArgs(store.get(), key);
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
    // Identity from the OPEN, slot-0 flavor (lot F, Raphaël's validation):
    // a connected-then-disconnected unit that never streamed must still
    // leave its name on its endpoint rows — the disconnected header/focus
    // option and the slot-0 header Connect read it. In-session only:
    // slot-0 captures are deliberately not persisted.
    if (info) stampSlotEndpointIdentity(store, 0, info);
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
 * Demo mode (reshaped in lot E4 — Raphaël 2026-07-29): the button ADDS a
 * built-in virtual unit through the SAME path as the Traces panel's
 * + device, then focuses it — never a slot-0 supersede. The old
 * `connect_virtual_device` flow parked the simulator on the DEFAULT slot,
 * so "disconnect the QA402 → Demo" left the hardware with no way back
 * short of a replug (demo had taken its slot). Now slot 0 stays the
 * hardware's: the auto-connect tick can (re)claim it while the demo
 * session keeps running alongside — the one-click no-hardware experience
 * is unchanged because the focus moves to the fresh session in the same
 * gesture (transport, sources and chrome all follow it).
 *
 * (`connect_virtual_device` itself remains backend-side: REST/scripting
 * and an explicit virtual pick through the toolbar still target slot 0.)
 */
export async function demoAddVirtual(
  store: Store<AppState>,
  ipc: Ipc
): Promise<void> {
  const virtual = addableEntries(store.get()).find((e) => e.is_virtual);
  if (!virtual) {
    // The built-in source always enumerates two virtual units, so this is
    // only the boot race (no scan landed yet) or every virtual already open.
    toast(store, "info", "No virtual device available — retry in a moment");
    return;
  }
  await addDevice(store, ipc, virtual.id);
  const added = Object.values(store.get().devices.sessions).find(
    (x) => x.deviceId === virtual.id
  );
  if (added) setFocusedSession(store, ipc, added.key);
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
  // Unroutable slot ≥ 1 (adopted id transiently cleared by a stale
  // enumeration): the arg-less call would close the DEFAULT runtime — the
  // OTHER device (E4 review #1). Refuse the whole gesture; the id is one
  // enumeration away.
  if (!isRoutable(store.get(), sessionKey)) return;
  // Program-lock guard (lot F2, the F1 bookkeeping item): the UI disables
  // its Disconnect affordances under the session's lock, but REST/debug
  // callers reach this action directly — an eviction mid-program releases
  // anyProgramLock early and strands the orphaned invoke (F1 review #5).
  if (session(store.get(), sessionKey)?.run.programLock) {
    toast(store, "info", "A measurement is running on this device — stop it first.");
    return;
  }
  try {
    // The backend stops the stream loop / generator BEFORE closing the
    // device (a clean Stopped reaches the channel — no capture error).
    // Arg-less for slot 0 by the sessionArgs contract (the top-bar
    // Disconnect); E4's group headers pass their own session key.
    await ipc.call("disconnect_device", sessionArgs(store.get(), sessionKey));
  } finally {
    if (sessionKey === SLOT0) {
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
    } else {
      // Evict-on-disconnect for slot ≥ 1 (lot F2): a disconnected added
      // device renders exactly like a disconnected slot-0 one — a dormant,
      // named group with its rows intact and a one-click revive — instead
      // of a live-but-dead session with different chrome. Traces stay
      // (D1), source targets stay (the revive reopens the same unit on the
      // same slot); the module maps and the session go.
      disposeSession(sessionKey);
      store.update("device/disconnect-evicted", (s) => dropSession(s, sessionKey));
      // A focus that sat on this key fell back — wire-visible for BOTH
      // DAC-owner kinds (the F2 focus-atomicity rule).
      syncAllDacOwners(store, ipc);
    }
  }
  void refreshDevices(store, ipc);
}

/** The model+serial a slot's endpoint rows persist (their capture
 * snapshot — stamped at add and at every ingest), or null when no row
 * carries one. The add flow compares it against the unit it just opened
 * (lot F2, decision D5). */
function slotEndpointIdentity(
  s: AppState,
  slot: number
): { model: string; serial: string } | null {
  for (const id of Object.values(hwTraceIds(slot))) {
    const d = s.traces.byId[id]?.capture?.device;
    if (d) return { model: d.model, serial: d.serial };
  }
  return null;
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
 * Open `deviceId` as an ADDITIONAL device (issue #25 lot E4 — the traces
 * panel's add-device gesture). The backend answer carries the opened id +
 * slot, and the session is minted WITH the id (bookkeeping item 1: no
 * unroutable window — `isRoutable` is true from the first store state that
 * holds the session). The new device comes up in monitor mode (mintSession
 * leaves the focus alone) with a fresh endpoint slate (decision B6: a
 * reused slot must not show the previous unit's frames).
 */
export async function addDevice(
  store: Store<AppState>,
  ipc: Ipc,
  deviceId: string,
  opts: {
    /** Preferred slot — the revive-a-dormant-group gesture asks for the
     * group's own slot so its rows come back to life. The ANSWER's slot
     * is the authority (an occupied hint falls back backend-side). */
    slot?: number;
  } = {}
): Promise<void> {
  const s0 = store.get();
  if (s0.devices.adding.includes(deviceId)) return;
  const held = Object.values(s0.devices.sessions).some((x) => x.deviceId === deviceId);
  if (held || s0.devices.byId[deviceId]?.open) {
    toast(store, "info", "This device is already connected");
    return;
  }
  store.update("devices/adding", (s) => ({
    ...s,
    devices: { ...s.devices, adding: [...s.devices.adding, deviceId] },
  }));
  try {
    const { device_id, slot } = await ipc.call("connect_additional_device", {
      deviceId,
      ...(opts.slot !== undefined ? { slot: opts.slot } : {}),
    });
    const key = sessionKeyForSlot(slot);
    // The slot's PERSISTED identity, read before the fresh slate zeroes it:
    // compared against the opened unit below (lot F2, decision D5) — a
    // doc-pinned stimulus must not re-bind onto a different converter.
    const prior = slotEndpointIdentity(store.get(), slot);
    store.update("devices/mint-session", (s) => mintSession(s, slot, device_id));
    store.update("traces/reconcile-hw", reconcileHwTraces);
    resetSlotEndpointTraces(store, slot);
    const info = await ipc.call("get_device_info", { deviceId: device_id });
    store.update("device/added", (s) =>
      updateDevice(s, key, (d) => ({ ...d, status: "connected", present: true, info }))
    );
    // Identity from the OPEN, not just from frames (lot F, Raphaël's
    // validation): an added device that never streams before the next
    // save/restart must still leave its model+serial on its endpoint rows,
    // or the dormant group's one-click revive has nothing to match.
    if (info) stampSlotEndpointIdentity(store, slot, info);
    // A DIFFERENT unit landed on a slot whose doc pinned a stimulus to the
    // previous tenant (lot F2, decision D5): drop that slot's source
    // targets — the evict→re-add path is reachable via a loaded doc even
    // before F3 ships a target-editing UI. Same model+serial (the revive
    // path) keeps them.
    if (
      info &&
      prior &&
      (prior.model !== info.model || prior.serial !== info.serial)
    ) {
      store.update("sources/drop-slot-targets", (s) =>
        dropSourceTargetsForSlot(s, slot)
      );
      syncAllDacOwners(store, ipc);
    }
    // EXPLICIT scope, not the session-keyed read (review #5): a stale
    // enumeration landing mid-add can transiently clear the adopted id,
    // and the gated read would then silently skip — leaving config and
    // offsets null forever on a session nothing re-reads.
    await refreshConfig(store, ipc, key, { deviceId: device_id });
    toast(store, "success", `Added ${info?.model ?? "device"}`);
  } catch (e) {
    toast(store, "error", `Add device failed: ${e}`);
  } finally {
    store.update("devices/adding-done", (s) => ({
      ...s,
      devices: { ...s.devices, adding: s.devices.adding.filter((x) => x !== deviceId) },
    }));
    void refreshDevices(store, ipc);
  }
}

/**
 * Remove `key`'s device from the bench (issue #25 lot E4 — the ✕ on a
 * group header): keyed disconnect (best-effort — the F8 rule: an already-
 * gone unit answers `Unknown device`, which reports nothing actionable),
 * session eviction, and the slot's endpoint purge (decision B5). Also the
 * purge path for a DORMANT group: no session, just dead traces. SLOT0 is
 * refused — the default device disconnects from the top bar and its
 * endpoints are permanent.
 */
export async function removeDevice(
  store: Store<AppState>,
  ipc: Ipc,
  key: SessionKey
): Promise<void> {
  if (key === SLOT0) return;
  // Program-lock guard (lot F2, the F1 bookkeeping item): the E4 group-✕
  // button is disabled under the session's lock, but REST/debug callers
  // reach the action directly — see disconnect() for the F1-review-#5
  // hazard this closes.
  if (session(store.get(), key)?.run.programLock) {
    toast(store, "info", "A measurement is running on this device — stop it first.");
    return;
  }
  const slot = slotOfSessionKey(key);
  const sess = session(store.get(), key);
  if (sess) {
    if (sess.deviceId !== null && sess.device.status !== "disconnected") {
      try {
        await ipc.call("disconnect_device", { deviceId: sess.deviceId });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.toLowerCase().includes("unknown device")) {
          toast(store, "error", `Disconnect: ${e}`);
        }
      }
    }
    disposeSession(key);
    store.update("devices/drop-session", (s) => dropSession(s, key));
  }
  purgeSlotEndpointTraces(store, ipc, slot);
  // The stimulus twin of the trace purge (lot F2, decision D5): targets
  // pinned to a REMOVED slot go with it — the slot's next tenant may be a
  // physically different converter/DUT. Applies to the dormant-group purge
  // too (no session, just dead rows and a doc-pinned route).
  store.update("sources/drop-slot-targets", (s) => dropSourceTargetsForSlot(s, slot));
  // A focus that sat on the dropped key fell back, and the target drop can
  // have emptied a running loop's slot set — wire-visible for BOTH DAC-owner
  // kinds (the F2 focus-atomicity rule), like setFocusedSession.
  syncAllDacOwners(store, ipc);
  void refreshDevices(store, ipc);
}

/**
 * Backend pushed a disconnect (USB monitoring event). Idempotent: the
 * monitor also fires after a MANUAL disconnect (it only sees "no longer
 * connected"), and any duplicate event must not re-toast or churn state.
 *
 * `deviceId` names the lost unit (issue #25 lot C); the loss is ROUTED to
 * the session holding that id (lot E2) so unit A's loss never tears down
 * unit B's session. Slot 0 keeps the historic mark-disconnected shape; a
 * matched slot ≥ 1 session is EVICTED instead (lot E4, decision B4): its
 * traces stay in the pool (the group goes dormant, D1) but a dead session
 * must not linger unroutable. Fallback to slot 0 covers the payload-less
 * event (older backend, the e2e fake) AND, while slot 0 is the LONE
 * session, an id that is either unadopted-yet (slot 0's own id is still
 * null — the pre-adoption window right after connect) or unknown to the
 * enumeration (the single-device contract smoke.pw.ts pins: any id ≡
 * payload-less there). An id the registry DOES know that matches no
 * session is a NO-OP even at one session (E4 review #3): a loss event for
 * an evicted slot ≥ 1 unit can be delivered after its removal already
 * shrank the bench to slot 0 alone, and tearing device A down for
 * device B's queued goodbye would kill the surviving capture. With
 * several sessions an unmatched id is always a NO-OP (E2 review #5).
 */
export function deviceLost(
  store: Store<AppState>,
  ipc: Ipc,
  deviceId: string | null = null
): void {
  const s0 = store.get();
  const matched =
    deviceId !== null
      ? Object.values(s0.devices.sessions).find((x) => x.deviceId === deviceId)?.key
      : undefined;
  const lone = Object.keys(s0.devices.sessions).length === 1;
  const key =
    matched ??
    (deviceId === null ||
    (lone &&
      (session(s0, SLOT0)?.deviceId === null ||
        s0.devices.byId[deviceId] === undefined))
      ? SLOT0
      : undefined);
  if (key === undefined) return;
  // Idempotence: already disconnected (or no such session at all) — a
  // duplicate monitor event must not re-toast or churn state. A session
  // still "connecting" DOES tear down (pre-E2 behavior kept: the monitor
  // can outrace a doomed connect's own failure path).
  const status = session(s0, key)?.device.status;
  if (status === undefined || status === "disconnected") return;
  if (key !== SLOT0) {
    // Eviction (E4): teardown of the module maps first (a late frame from
    // the dead channel must find its gen counter gone), then the store
    // drop. A focus on the lost key fell back — wire-visible for BOTH
    // DAC-owner kinds since lot F2 (a surviving session's generator can
    // inherit the default-target sources), so streams AND generators
    // re-sync in this same gesture. Traces and source targets stay (D1):
    // a replug revives the same unit on the same slot.
    disposeSession(key);
    store.update("device/lost-evicted", (s) => dropSession(s, key));
    syncAllDacOwners(store, ipc);
    toast(store, "info", "Device disconnected");
    return;
  }
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
 * session. The top bar passes the focus and the group controls their own
 * key (E4) — hence the isRoutable gates (E4 review #1): an unadopted
 * slot ≥ 1 key must never fall through to the default runtime; a range
 * register is calibration-bearing, and moving the OTHER device's register
 * mid-capture is the four-offsets bug class on the wire. */

export async function setInputRange(
  store: Store<AppState>,
  ipc: Ipc,
  gainDbv: number,
  sessionKey: SessionKey = SLOT0
): Promise<void> {
  if (!isRoutable(store.get(), sessionKey)) return;
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
  if (!isRoutable(store.get(), sessionKey)) return;
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
  if (!isRoutable(store.get(), sessionKey)) return;
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
  // The ~1 Hz poll hits EVERY session (C2): an unroutable slot ≥ 1 must
  // not fall through — an arg-less keepalive takes the DEFAULT runtime's
  // device mutex inside its live capture, once per second, and its answer
  // would land as ANOTHER unit's telemetry (E4 review #1).
  if (!isRoutable(s, sessionKey)) return;
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

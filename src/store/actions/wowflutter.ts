/**
 * Wow & flutter (issue #28) — a one-shot measurement, not a persisted
 * program: it drives the device directly and returns its result to the
 * dialog that asked for it, rather than landing on a workspace trace.
 *
 * It still takes the SAME exclusive device lock `runProgram` uses (stop
 * whichever loop owns the DAC, run, hand the session back exactly as
 * found) — duplicated here in miniature because this measurement has no
 * persisted `ProgramMeta`/trace to hang the handover off of. Every other
 * panel's "a measurement is running" greying (`programLockReason`,
 * `run.programLock`) keeps working unchanged: it falls back to a generic
 * label when the lock id doesn't match a program.
 *
 * Session/endpoint-scoped throughout (issue #25): the backend command takes
 * an explicit output/input `Channel` per call — no state keyed on "the
 * device".
 */
import type { Channel, WowFlutterResult } from "../../gen";
import type { Ipc } from "../../ipc/ipc";
import type { Store } from "../store";
import type { AppState } from "../state";
import { startRun, stopRun } from "./stream";
import { syncOutputOnly } from "./outputonly";

/** The `run.programLock` id this measurement holds while it runs — not a
 * real program id, so `programLockReason` special-cases it for a legible
 * message instead of falling back to the bare "program" placeholder. */
export const WOW_FLUTTER_LOCK_ID = "wow-flutter";

export interface WowFlutterParams {
  referenceFreq: number;
  durationSecs: number;
  outputChannel: Channel;
  inputChannel: Channel;
  /** Play the reference tone on `outputChannel` (loopback / driven DUT).
   * Off: silence is sent and `inputChannel` is just monitored — an
   * external transport (tape, turntable) is assumed to already be playing
   * the test tone. */
  generate: boolean;
}

/**
 * Run the wow & flutter measurement under the exclusive device lock. Throws
 * (never toasts itself — the caller/dialog owns its own error display) when
 * another measurement is already running or the device isn't connected.
 */
export async function runWowFlutter(
  store: Store<AppState>,
  ipc: Ipc,
  params: WowFlutterParams
): Promise<WowFlutterResult> {
  const s = store.get();
  if (s.run.programLock !== null) {
    throw new Error("Another measurement is running — try again once it finishes.");
  }
  if (s.device.status !== "connected") {
    throw new Error("Connect the device first — this measurement drives the hardware.");
  }

  const wasStreaming = s.run.streaming;
  const wasOutputOnly = s.run.outputOnly && s.run.generatorRunning;
  store.update("wow-flutter/lock", (st) => ({
    ...st,
    run: { ...st.run, programLock: WOW_FLUTTER_LOCK_ID },
  }));
  try {
    // Hand the device over deterministically: the generator loop first,
    // then the stream loop — same order/rationale as runProgram (single-
    // stream hard rule; `stream_stop` returns only once fully exited).
    if (wasOutputOnly) {
      await ipc.call("stop_generator", {});
      store.update("wow-flutter/generator-stopped", (st) => ({
        ...st,
        run: { ...st.run, generatorRunning: false },
      }));
    }
    if (wasStreaming || s.run.stopping) await stopRun(store, ipc);

    return await ipc.call("measure_wow_flutter", {
      referenceFreq: params.referenceFreq,
      durationSecs: params.durationSecs,
      outputChannel: params.outputChannel,
      inputChannel: params.inputChannel,
      generate: params.generate,
    });
  } finally {
    store.update("wow-flutter/unlock", (st) => ({
      ...st,
      run: { ...st.run, programLock: null },
    }));
    // Resume the session that ran before, exactly like runProgram.
    if (wasOutputOnly) syncOutputOnly(store, ipc);
    else if (wasStreaming) void startRun(store, ipc);
  }
}

/**
 * Cooperatively cancel an in-flight measurement — the SAME `sweep_stop`
 * command / `sweep_cancel` flag the batched THD sweep uses (`stopProgram`
 * in `./programs.ts`). Safe to share: only one exclusive measurement
 * program runs at a time. Fire-and-forget, like its sweep counterpart —
 * the caller doesn't wait on it, it just unblocks the in-flight capture.
 */
export function stopWowFlutter(ipc: Ipc): void {
  void ipc.call("sweep_stop", {}).catch(() => {});
}

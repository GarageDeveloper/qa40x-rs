/**
 * Workspace actions (M5): apply a document to the live session, named
 * saves, the debounced auto-save, and the boot restore.
 *
 * Loading replaces the BENCH (sources / traces / programs / layout /
 * acquisition), never the session: device state, the running stream and the
 * theme stay. Nothing plays after a load — a workspace restore must never
 * start driving the outputs by itself (the playing flags are normalized off
 * both at snapshot and here, defensively: blobs are user-editable files).
 */
import type { Ipc } from "../../ipc/ipc";
import { clearAllFrames, putFrames } from "../../data/frames";
import { clearAllMeasures } from "../../data/measures";
import { clearTriggerSnapshots } from "../../data/triggered";
import { resetAllChains, syncChains } from "../../data/chains";
import { sanitizeUserCurve } from "../../core/weightingcurve";
import type { Store } from "../store";
import type { AppState } from "../state";
import type { WorkspaceDoc } from "../persist";
import {
  docToFrames,
  isQuotaExceeded,
  loadLegacyCurrent,
  loadLegacyNamed,
  sanitizeSourceTargets,
  snapshotWorkspace,
} from "../persist";
import type { WorkspaceStore } from "../wsstore";
import { anyProgramLock } from "../selectors/session";
import { syncAllStreams } from "./stream";
import { reconcileHwTraces } from "./traces";
import { toast } from "./ui";

/** A quota-exceeded save is either a one-off (a huge document on THIS
 * save) or a standing condition (storage already full) — either way, warn
 * once per session rather than on every 500 ms auto-save tick. */
function quotaOrGenericMessage(action: string, e: unknown): string {
  return isQuotaExceeded(e)
    ? `${action} failed: storage is full — delete old saved workspaces or free up disk space.`
    : `${action} failed: ${e}`;
}

/**
 * Replace the bench with `doc`. Refuses while a measurement program owns
 * the device (its result trace would vanish under it mid-run).
 */
export function applyWorkspaceDoc(
  store: Store<AppState>,
  ipc: Ipc,
  doc: WorkspaceDoc
): boolean {
  const s = store.get();
  // Bench-global by intent: a program running on ANY session (not just the
  // focused one) owns a result trace the load would replace under it.
  if (anyProgramLock(s) !== null) {
    toast(store, "info", "A measurement is running — stop it before loading a workspace.");
    return false;
  }

  // The whole data plane restarts: cached frames, measures, transform
  // scheduling and held trigger snapshots all key on trace ids about to be
  // replaced — a stale snapshot left behind here would let a HELD
  // NORMAL/SINGLE scope picture from the OLD bench keep rendering under a
  // trace id the new bench just reused (issue #26 review #3).
  clearAllFrames();
  clearAllMeasures();
  clearTriggerSnapshots();
  resetAllChains();

  // Frozen ❄ data lands in the cache FIRST, then the store update reveals
  // the ids (the §3.1 ingest order, same as a live frame).
  for (const [id, frames] of Object.entries(doc.refFrames)) {
    putFrames(id, 1, docToFrames(frames));
  }

  store.update("workspace/load", (st) => ({
    ...st,
    acquisition: doc.acquisition,
    sources: {
      order: [...doc.sources.order],
      byId: Object.fromEntries(
        doc.sources.order
          .filter((id) => doc.sources.byId[id])
          // Targets sanitized again here (not just trusting `migrate()` ran)
          // for the same reason as the weighting curve below: templates and
          // debug callers hand this docs that never passed through migrate,
          // and the routing matrix drives a DAC (issue #25 lot F2).
          .map((id) => [
            id,
            {
              ...doc.sources.byId[id],
              playing: false,
              targets: sanitizeSourceTargets(doc.sources.byId[id].targets),
            },
          ])
      ),
    },
    traces: doc.traces,
    programs: {
      order: [...doc.programs.order],
      byId: Object.fromEntries(
        doc.programs.order
          .filter((id) => doc.programs.byId[id])
          .map((id) => [
            id,
            {
              ...doc.programs.byId[id],
              run: "idle" as const,
              progress: null,
              startedAtMs: null,
            },
          ])
      ),
    },
    layout: { ...doc.layout, focus: null },
    workspace: { name: doc.name, collapsed: [...doc.collapsed] },
    triggers: doc.triggers,
    // Sanitized again here (not just trusting `migrate()` ran) — a
    // template or any other caller can hand `applyWorkspaceDoc` a doc that
    // never passed through `migrate()` (issue #29 review finding #5).
    weighting: {
      userCurve: sanitizeUserCurve(doc.userWeightingCurve),
      userCurveName:
        typeof doc.userWeightingCurveName === "string" ? doc.userWeightingCurveName : null,
    },
  }));

  // F6 (issue #25 lot E3): the doc replaced the trace pool WHOLESALE — put
  // back the endpoint traces of every LIVE session the doc didn't know
  // about (their data re-lands with that session's next frame; the ids are
  // recomputed from the slot, so they match). Doc-provided traces for
  // absent slots stay, dormant (see reconcileHwTraces). At boot, and on
  // every existing single-device doc, this is a no-op by construction.
  store.update("workspace/reconcile-hw-traces", reconcileHwTraces);

  // A running stream keeps running and simply follows the new bench (its
  // slots empty out — nothing plays; its display budget follows the tiles).
  syncAllStreams(store, ipc);
  syncChains(store, ipc);
  return true;
}

export function setWorkspaceName(store: Store<AppState>, name: string): void {
  store.update("workspace/name", (s) =>
    s.workspace.name === name
      ? s
      : { ...s, workspace: { ...s.workspace, name } }
  );
}

/** Collapse/expand a sidebar panel ("sources" | "traces" | "programs"). */
export function togglePanelCollapsed(store: Store<AppState>, key: string): void {
  store.update("workspace/collapse", (s) => {
    const collapsed = s.workspace.collapsed.includes(key)
      ? s.workspace.collapsed.filter((k) => k !== key)
      : [...s.workspace.collapsed, key];
    return { ...s, workspace: { ...s.workspace, collapsed } };
  });
}

/** Save the current bench under a name (also becomes the workspace name). */
export async function saveWorkspaceAs(
  store: Store<AppState>,
  ws: WorkspaceStore,
  name: string
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  setWorkspaceName(store, trimmed);
  try {
    await ws.save(trimmed, snapshotWorkspace(store.get()));
    toast(store, "success", `Workspace "${trimmed}" saved.`);
  } catch (e) {
    toast(store, "error", quotaOrGenericMessage(`Saving workspace "${trimmed}"`, e));
  }
}

export async function loadWorkspaceNamed(
  store: Store<AppState>,
  ipc: Ipc,
  ws: WorkspaceStore,
  name: string,
  from: "saved" | "legacy" = "saved"
): Promise<void> {
  let doc: WorkspaceDoc | null = null;
  try {
    doc = from === "legacy" ? loadLegacyNamed(name) : await ws.load(name);
  } catch {
    doc = null;
  }
  if (!doc) {
    toast(store, "error", `Could not load workspace "${name}".`);
    return;
  }
  if (applyWorkspaceDoc(store, ipc, doc)) {
    toast(store, "success", `Workspace "${doc.name}" loaded.`);
  }
}

/**
 * Boot restore: the auto-saved current document (IndexedDB — which imported
 * any old v2 localStorage blobs at first open — else the legacy v4 current
 * through the importer). Without one, the initialState() bench stands — the
 * maintainer-validated first-run defaults, not a template.
 *
 * Returns whether the CURRENT-doc read provably succeeded (a doc, or a
 * definitive "none saved"). `false` means the record may exist but could
 * not be read — the caller must NOT enable the auto-save then: its first
 * tick would overwrite the very record we failed to read with the empty
 * initial bench (adversarial review #1 of this lot).
 */
export async function restoreWorkspaceAtBoot(
  store: Store<AppState>,
  ipc: Ipc,
  ws: WorkspaceStore
): Promise<boolean> {
  let doc: WorkspaceDoc | null = null;
  let readOk = true;
  try {
    doc = await ws.loadCurrent();
  } catch {
    doc = null; // an unusable DB must never block the boot
    readOk = false;
  }
  if (!doc) {
    try {
      doc = loadLegacyCurrent();
    } catch {
      // localStorage itself can throw (disabled/blocked storage — the same
      // reason main.ts's theme/REST-token reads and wsstore.ts's importer
      // guard every access) — the boot must degrade to initialState(),
      // never abort. `mountApp` awaits this call (issue #44 lot 1), so an
      // uncaught rejection here would leave the app unmounted, not just
      // the workspace unrestored.
      doc = null;
    }
  }
  if (doc) applyWorkspaceDoc(store, ipc, doc);
  return readOk;
}

const AUTO_SAVE_DEBOUNCE_MS = 500;

/**
 * Auto-save every edit (v1 parity): any store batch schedules a trailing
 * snapshot; identical documents are not rewritten (per-frame updates only
 * touch transients, which the snapshot strips — the compare keeps frame
 * traffic from thrashing the storage). Writes are chained so two ticks
 * never interleave inside the async store.
 */
export function initAutoSave(store: Store<AppState>, ws: WorkspaceStore): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  // The dedupe compares against the last ENQUEUED document, not the last
  // committed one — with a write slower than one debounce period, comparing
  // against the committed json would skip the corrective write of an
  // A → B → A edit sequence and leave B on disk while the live bench is A
  // (adversarial review #2 of this lot). On failure the queued json rolls
  // back to the committed one so the next tick retries.
  let lastWritten = "";
  let lastQueued = "";
  let chain: Promise<void> = Promise.resolve();
  // A full quota won't clear itself between ticks — warn once per session,
  // not every 500 ms (issue #29 review finding #2), but keep trying: the
  // user may have freed space (deleted a saved workspace) in the meantime.
  let warned = false;
  store.subscribe(() => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      const doc = snapshotWorkspace(store.get());
      const json = JSON.stringify(doc);
      if (json === lastQueued) return;
      lastQueued = json;
      chain = chain.then(async () => {
        try {
          await ws.saveCurrent(doc);
          lastWritten = json;
          warned = false;
        } catch (e) {
          // Only roll back if no NEWER write was enqueued meanwhile.
          if (lastQueued === json) lastQueued = lastWritten;
          if (!warned) {
            warned = true;
            toast(store, "error", quotaOrGenericMessage("Workspace auto-save", e));
          }
        }
      });
    }, AUTO_SAVE_DEBOUNCE_MS);
  });
}

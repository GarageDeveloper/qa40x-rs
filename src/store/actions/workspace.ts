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
  loadCurrent,
  loadLegacyNamed,
  loadNamed,
  saveCurrent,
  saveNamed,
  snapshotWorkspace,
} from "../persist";
import { syncStream } from "./stream";
import { toast } from "./ui";

/** A quota-exceeded save is either a one-off (a huge curve on THIS save) or
 * a standing condition (storage already full) — either way, warn once per
 * session rather than on every 500 ms auto-save tick. */
function quotaOrGenericMessage(action: string, e: unknown): string {
  return isQuotaExceeded(e)
    ? `${action} failed: local storage is full — free up space (a large imported ` +
        "weighting curve is the usual cause) or clear an old saved workspace."
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
  if (s.run.programLock !== null) {
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
          .map((id) => [id, { ...doc.sources.byId[id], playing: false }])
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

  // A running stream keeps running and simply follows the new bench (its
  // slots empty out — nothing plays; its display budget follows the tiles).
  syncStream(store, ipc);
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
export function saveWorkspaceAs(store: Store<AppState>, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  setWorkspaceName(store, trimmed);
  let error: unknown = null;
  const ok = saveNamed(trimmed, snapshotWorkspace(store.get()), (e) => (error = e));
  if (ok) {
    toast(store, "success", `Workspace "${trimmed}" saved.`);
  } else {
    toast(store, "error", quotaOrGenericMessage(`Saving workspace "${trimmed}"`, error));
  }
}

export function loadWorkspaceNamed(
  store: Store<AppState>,
  ipc: Ipc,
  name: string,
  from: "saved" | "legacy" = "saved"
): void {
  const doc = from === "legacy" ? loadLegacyNamed(name) : loadNamed(name);
  if (!doc) {
    toast(store, "error", `Could not load workspace "${name}".`);
    return;
  }
  if (applyWorkspaceDoc(store, ipc, doc)) {
    toast(store, "success", `Workspace "${doc.name}" loaded.`);
  }
}

/**
 * Boot restore: the auto-saved current document (v2 keys, else the legacy
 * v4 current through the importer). Without one, the initialState() bench
 * stands — the maintainer-validated first-run defaults, not a template.
 */
export function restoreWorkspaceAtBoot(store: Store<AppState>, ipc: Ipc): void {
  const doc = loadCurrent();
  if (doc) applyWorkspaceDoc(store, ipc, doc);
}

const AUTO_SAVE_DEBOUNCE_MS = 500;

/**
 * Auto-save every edit (v1 parity): any store batch schedules a trailing
 * snapshot; identical documents are not rewritten (per-frame updates only
 * touch transients, which the snapshot strips — the compare keeps frame
 * traffic from thrashing localStorage).
 */
export function initAutoSave(store: Store<AppState>): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastJson = "";
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
      if (json === lastJson) return;
      let error: unknown = null;
      const ok = saveCurrent(doc, (e) => (error = e));
      if (ok) {
        lastJson = json;
        warned = false;
      } else if (!warned) {
        warned = true;
        toast(store, "error", quotaOrGenericMessage("Workspace auto-save", error));
      }
    }, AUTO_SAVE_DEBOUNCE_MS);
  });
}

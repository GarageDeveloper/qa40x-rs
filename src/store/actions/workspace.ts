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
import { resetAllChains, syncChains } from "../../data/chains";
import type { Store } from "../store";
import type { AppState } from "../state";
import type { WorkspaceDoc } from "../persist";
import {
  docToFrames,
  loadCurrent,
  loadLegacyNamed,
  loadNamed,
  saveCurrent,
  saveNamed,
  snapshotWorkspace,
} from "../persist";
import { syncStream } from "./stream";
import { toast } from "./ui";

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

  // The whole data plane restarts: cached frames, measures and transform
  // scheduling all key on trace ids about to be replaced.
  clearAllFrames();
  clearAllMeasures();
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
  saveNamed(trimmed, snapshotWorkspace(store.get()));
  toast(store, "success", `Workspace "${trimmed}" saved.`);
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
  store.subscribe(() => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      const doc = snapshotWorkspace(store.get());
      const json = JSON.stringify(doc);
      if (json === lastJson) return;
      lastJson = json;
      saveCurrent(doc);
    }, AUTO_SAVE_DEBOUNCE_MS);
  });
}

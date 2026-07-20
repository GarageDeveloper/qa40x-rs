/**
 * REST automation-server actions (M5 design round): the status lives in
 * `ui.rest` so the status-bar indicator and the App drawer read the SAME
 * truth. On a failed rebind the truth is re-read — the checkbox must never
 * claim an exposure the server didn't achieve.
 */
import type { Ipc } from "../../ipc/ipc";
import type { RestStatus } from "../../gen";
import type { Store } from "../store";
import type { AppState } from "../state";
import { toast } from "./ui";

function put(store: Store<AppState>, rest: RestStatus): void {
  store.update("rest/status", (s) => ({ ...s, ui: { ...s.ui, rest } }));
}

export async function refreshRest(store: Store<AppState>, ipc: Ipc): Promise<void> {
  try {
    put(store, await ipc.call("rest_status", {}));
  } catch {
    /* backend without REST (e2e fake without handler) — indicator stays off */
  }
}

export async function setRestExposed(
  store: Store<AppState>,
  ipc: Ipc,
  exposed: boolean
): Promise<void> {
  try {
    put(store, await ipc.call("rest_set_exposed", { exposed }));
  } catch (e) {
    toast(store, "error", `REST rebind failed: ${e}`);
    await refreshRest(store, ipc);
  }
}

/** The localStorage key holding the user's fixed bearer token ("" = unset). */
export const REST_TOKEN_KEY = "qa40x-v2-rest-token";

/**
 * Set or clear (null/blank) the fixed bearer token, persist the choice, and
 * push it to the backend (hot rebind if currently exposed). `quiet` suppresses
 * the error toast — used for the startup push, where the e2e fake backend has
 * no REST handler.
 */
export async function setRestToken(
  store: Store<AppState>,
  ipc: Ipc,
  token: string | null,
  quiet = false
): Promise<void> {
  const trimmed = token?.trim() || null;
  try {
    localStorage.setItem(REST_TOKEN_KEY, trimmed ?? "");
  } catch {
    /* no storage — the backend still applies it for this session */
  }
  try {
    put(store, await ipc.call("rest_set_token", { token: trimmed }));
  } catch (e) {
    if (!quiet) {
      toast(store, "error", `REST token change failed: ${e}`);
      await refreshRest(store, ipc);
    }
  }
}

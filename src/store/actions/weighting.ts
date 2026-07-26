/**
 * User weighting curve actions (issue #29). The curve itself is pure display
 * configuration — persisted per WORKSPACE (store/persist.ts), never a
 * module-global (issue #25): the backend already takes it as a plain
 * parameter (`measurements::weighting::UserWeightingCurve`), and every
 * transform step that uses it embeds its OWN snapshot at Apply time
 * (core/transforms.ts) — this slice is just where the frontend keeps the
 * "currently loaded" curve for editing.
 *
 * `setUserWeightingCurve` is a pure COMMIT — it does no parsing and no CSV
 * I/O. The transform dialog (panels/traces/transformdialog.ts) stages a
 * freshly-picked file in its own local state and only calls this at Apply
 * (review finding #7 — importing a file must never write `s.weighting`,
 * hence the auto-save, before the user confirms; Cancel must roll back to
 * nothing having happened).
 */
import type { Store } from "../store";
import type { AppState } from "../state";
import type { UserWeightingCurve } from "../../gen";

/** Commit `curve` as the bench's loaded user weighting curve. */
export function setUserWeightingCurve(
  store: Store<AppState>,
  fileName: string,
  curve: UserWeightingCurve
): void {
  store.update("weighting/set-curve", (s) => ({
    ...s,
    weighting: { userCurve: curve, userCurveName: fileName },
  }));
}

export function clearUserWeightingCurve(store: Store<AppState>): void {
  store.update("weighting/clear-curve", (s) =>
    s.weighting.userCurve === null
      ? s
      : { ...s, weighting: { userCurve: null, userCurveName: null } }
  );
}

/**
 * Export orchestration (issue #30) — the impure counterpart to csv.ts /
 * png.ts: reads the store, stamps provenance (clock + app version), asks
 * for a destination through the dialog plugin, and hands the bytes to the
 * backend (`export_write_file` / `export_copy_image`). Plain file save
 * dialogs only — no network side effects.
 *
 * Everything funnels through the Ipc seam, so the e2e fake records the
 * writes; the save dialog itself is a plugin invoke the same mock catches.
 */
import { save } from "@tauri-apps/plugin-dialog";
import type { Store } from "../store/store";
import { isRatioTrace, type AppState } from "../store/state";
import type { Ipc } from "../ipc/ipc";
import type { Domain, TraceId } from "../core/model";
import {
  FD_UNIT_LABELS,
  scopeVM,
  spectrumVM,
  sweepVM,
  sweepUnitLabel,
  sweepXUnit,
} from "../store/selectors/chartvm";
import { getFrames } from "../data/frames";
import { toast } from "../store/actions/ui";
import {
  benchProvenance,
  clipScopeWindow,
  numCell,
  provenanceComments,
  tileScopeCsv,
  tileSpectrumCsv,
  tileSweepCsv,
  traceFdCsv,
  traceSourceLine,
  traceSweepCsv,
  traceTdCsv,
  type ProvenanceLine,
} from "./csv";
import { bytesToBase64, composeTileImage } from "./png";

/** Injected by Vite from package.json (both configs); "dev" outside a
 * bundler (vitest without the define, a bare tsc run). */
const APP_VERSION: string =
  typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";

const KIND_LABELS = { spectrum: "Spectrum", scope: "Scope", sweep: "Sweep" } as const;

/** `YYYYMMDD-HHMMSS` local-time filename stamp. */
function fileStamp(d = new Date()): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function slug(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "export"
  );
}

function comments(s: AppState, extra: ProvenanceLine[]): string[] {
  return provenanceComments([
    ...benchProvenance(s, APP_VERSION, new Date().toISOString()),
    ...extra,
  ]);
}

/** Save-dialog + backend write; false = user cancelled. */
async function writeVia(
  ipc: Ipc,
  suggestedName: string,
  extension: "csv" | "png",
  bytesBase64: string
): Promise<string | null> {
  const path = await save({
    defaultPath: suggestedName,
    filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
  });
  if (!path) return null;
  await ipc.call("export_write_file", { path, contentsBase64: bytesBase64 });
  return path;
}

function textToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

/** The tile's DOM root (PNG capture) — the same stable per-tile testid the
 * grid stamps; the drawer has no tile handle so it resolves through here. */
function tileRootEl(tileId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="tile-${tileId}"]`);
}

/* ------------------------------------------------------------------ */
/* CSV                                                                  */
/* ------------------------------------------------------------------ */

/** Export a tile's displayed curves — display units, the exact view-model
 * the renderer draws (dBr, converter offsets, trigger alignment included). */
export async function exportTileCsv(
  store: Store<AppState>,
  ipc: Ipc,
  tileId: string
): Promise<void> {
  const s = store.get();
  const tile = s.layout.tiles[tileId];
  if (!tile) return;
  let csv: string | null = null;
  const extra: ProvenanceLine[] = [{ key: "export", value: "tile" }, { key: "graph", value: tile.kind }];
  if (tile.kind === "spectrum") {
    const vm = spectrumVM(s, tile);
    if (vm.series.length > 0) {
      const lines = [...extra, { key: "unit", value: vm.unitLabel }];
      // A dBr file is meaningless without the subtracted reference (review
      // finding #4): with an AUTO reference it's a runtime peak recorded
      // nowhere else — write it in the tile's pre-dBr unit.
      if (vm.dbrRefDb !== null) {
        lines.push(
          { key: "dbr_ref", value: numCell(vm.dbrRefDb) },
          { key: "dbr_ref_unit", value: FD_UNIT_LABELS[tile.fdUnit] }
        );
      }
      csv = tileSpectrumCsv(vm, comments(s, lines));
    }
  } else if (tile.kind === "scope") {
    // Clip to the tile's displayed time window — the file must match the
    // drawn extent, whether or not a trigger is aligned (review finding #3).
    const vm = clipScopeWindow(scopeVM(s, tile), tile.timeWindowMs);
    if (vm.series.length > 0) {
      const lines = [
        ...extra,
        { key: "unit", value: vm.unitLabel },
        { key: "time_window_ms", value: tile.timeWindowMs === null ? "full" : String(tile.timeWindowMs) },
        // t=0 is the displayed window's start, not the trigger instant.
        { key: "time_origin", value: "window start" },
      ];
      if (vm.trigger) {
        lines.push(
          { key: "trigger_state", value: vm.trigger.state },
          { key: "trigger_position_pct", value: String(tile.triggerPositionPct) }
        );
      }
      csv = tileScopeCsv(vm, comments(s, lines));
    }
  } else {
    const vm = sweepVM(s, tile);
    if (vm.series.length > 0) {
      csv = tileSweepCsv(vm, comments(s, [...extra, { key: "unit", value: vm.unitLabel }]));
    }
  }
  if (csv === null) {
    toast(store, "info", "Nothing to export yet — the graph has no data.");
    return;
  }
  try {
    const path = await writeVia(
      ipc,
      `qa40x-${tile.kind}-${fileStamp()}.csv`,
      "csv",
      textToBase64(csv)
    );
    if (path) toast(store, "success", `Exported ${path}`);
  } catch (e) {
    toast(store, "error", `CSV export failed: ${String(e)}`);
  }
}

/** Export one trace's cached frames for `domain` — wire units plus the
 * derived absolute column when the converter offset is known. */
export async function exportTraceCsv(
  store: Store<AppState>,
  ipc: Ipc,
  traceId: TraceId,
  domain: Domain
): Promise<void> {
  const s = store.get();
  const meta = s.traces.byId[traceId];
  const frames = getFrames(traceId);
  if (!meta) return;
  const extra: ProvenanceLine[] = [
    { key: "export", value: "trace" },
    { key: "trace", value: meta.label },
    { key: "trace_source", value: traceSourceLine(s, meta) },
    { key: "trace_offset_dbv", value: meta.offsetDb === null ? "unknown" : String(meta.offsetDb) },
  ];
  let csv: string | null = null;
  if (domain === "td" && frames?.td) {
    csv = traceTdCsv(meta, frames.td, comments(s, extra));
  } else if (domain === "fd" && frames?.fd) {
    csv = traceFdCsv(meta, frames.fd, comments(s, extra), isRatioTrace(meta));
  } else if (domain === "sweep" && frames?.sweep) {
    // Units resolved with the tile's own frame-first-program-fallback rule
    // (chartvm), never a bare frame read (review finding #6).
    csv = traceSweepCsv(
      meta,
      frames.sweep,
      comments(s, extra),
      sweepXUnit(s, traceId, frames.sweep),
      sweepUnitLabel(s, traceId, frames.sweep)
    );
  }
  if (csv === null) {
    toast(store, "info", "Nothing to export yet — the trace has no such frame.");
    return;
  }
  try {
    const path = await writeVia(
      ipc,
      `qa40x-${slug(meta.label)}-${domain}-${fileStamp()}.csv`,
      "csv",
      textToBase64(csv)
    );
    if (path) toast(store, "success", `Exported ${path}`);
  } catch (e) {
    toast(store, "error", `CSV export failed: ${String(e)}`);
  }
}

/* ------------------------------------------------------------------ */
/* PNG                                                                  */
/* ------------------------------------------------------------------ */

/** Title + short provenance footer for the composed image. */
function tileImageText(s: AppState, tileId: string): { title: string; footer: string[] } {
  const tile = s.layout.tiles[tileId];
  const kind = tile ? KIND_LABELS[tile.kind] : "Graph";
  const labels = (tile?.traces ?? [])
    .filter((id) => !tile?.hidden.includes(id))
    .map((id) => s.traces.byId[id]?.label)
    .filter((l): l is string => !!l);
  const info = s.device.info;
  const device = info
    ? `${info.model} #${info.serial} fw${info.firmware_version}${info.is_virtual ? " (virtual)" : ""}`
    : "no device";
  const cfg = s.device.config;
  const acq = s.acquisition;
  const avg =
    acq.averaging.mode === "off" ? "avg off" : `avg ${acq.averaging.mode}×${acq.averaging.count}`;
  return {
    title: labels.length > 0 ? `${kind} — ${labels.join(", ")}` : kind,
    footer: [
      `qa40x-rs v${APP_VERSION} — ${device}` +
        (cfg ? ` — ${cfg.sample_rate} Hz` : "") +
        `, FFT ${acq.fftSize}, ${acq.window}, ${avg}`,
      `exported ${new Date().toISOString()}`,
    ],
  };
}

export async function exportTilePng(
  store: Store<AppState>,
  ipc: Ipc,
  tileId: string
): Promise<void> {
  const s = store.get();
  const root = tileRootEl(tileId);
  const { title, footer } = tileImageText(s, tileId);
  const image = root ? await composeTileImage(root, title, footer) : null;
  if (!image) {
    toast(store, "info", "Nothing to export yet — the graph has not rendered.");
    return;
  }
  try {
    const path = await writeVia(
      ipc,
      `qa40x-${slug(title)}-${fileStamp()}.png`,
      "png",
      image.pngBase64
    );
    if (path) toast(store, "success", `Exported ${path}`);
  } catch (e) {
    toast(store, "error", `PNG export failed: ${String(e)}`);
  }
}

export async function copyTilePng(
  store: Store<AppState>,
  ipc: Ipc,
  tileId: string
): Promise<void> {
  const s = store.get();
  const root = tileRootEl(tileId);
  const { title, footer } = tileImageText(s, tileId);
  const image = root ? await composeTileImage(root, title, footer) : null;
  if (!image) {
    toast(store, "info", "Nothing to copy yet — the graph has not rendered.");
    return;
  }
  try {
    // Same PNG bytes as the file lane — the backend decodes (a raw-RGBA
    // lane cost ~34 MB of IPC per Retina copy, review finding #8).
    await ipc.call("export_copy_image", { pngBase64: image.pngBase64 });
    toast(store, "success", "Graph image copied to the clipboard.");
  } catch (e) {
    toast(store, "error", `Copy failed: ${String(e)}`);
  }
}

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
import {
  captureBenchSignature,
  isRatioTrace,
  type AppState,
  type CaptureProvenance,
  type TileConfig,
} from "../store/state";
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
import { chipSourceTraceId, shownTraces } from "../store/selectors/layout";
import { getFrames } from "../data/frames";
import { toast } from "../store/actions/ui";
import {
  clipScopeWindow,
  numCell,
  provenanceComments,
  tileScopeCsv,
  tileSpectrumCsv,
  tileSweepCsv,
  traceFdCsv,
  traceProvenance,
  traceSourceLine,
  traceSweepCsv,
  traceTdCsv,
  type ProvenanceLine,
} from "./csv";
import { bytesToBase64, composeTileImage } from "./png";
import { fmtSeconds, renderTileSvg } from "./svg";

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

function comments(
  s: AppState,
  extra: ProvenanceLine[],
  capture: CaptureProvenance | null = null
): string[] {
  return provenanceComments([
    ...traceProvenance(s, capture, APP_VERSION, new Date().toISOString()),
    ...extra,
  ]);
}

/**
 * The capture snapshot a TILE export rides under (issue #40): the chip-
 * source trace's — the one the tile's readouts already follow — but only
 * while that trace is actually DRAWN (an explicit chip source the user
 * legend-hid contributes no columns; signing the file with its bench would
 * re-create the very bug #40 fixes — review finding #2). Falls back to the
 * first drawn member with a snapshot.
 *
 * Members with data captured under DIFFERENT bench states flag the snapshot
 * `mixed` (it then describes one member only; each member's own trace
 * export carries its full snapshot). A drawn member WITHOUT a snapshot (a
 * pre-#40 doc's ❄ trace) counts as its own unknown bench — silence there
 * would vouch for data nobody stamped (review finding #5). Members without
 * data contribute no columns and are ignored.
 */
export function tileCapture(s: AppState, tile: TileConfig): CaptureProvenance | null {
  const drawn = shownTraces(tile).filter((id) => {
    const t = s.traces.byId[id];
    return !!t && t.domains.length > 0;
  });
  const chipId = chipSourceTraceId(tile);
  let capture =
    (chipId && drawn.includes(chipId) ? s.traces.byId[chipId]?.capture : null) ?? null;
  if (!capture) {
    for (const id of drawn) {
      const c = s.traces.byId[id]?.capture;
      if (c) {
        capture = c;
        break;
      }
    }
  }
  const sigs = new Set<string>();
  for (const id of drawn) {
    const c = s.traces.byId[id]?.capture;
    sigs.add(c ? captureBenchSignature(c) : "unknown");
  }
  if (capture && sigs.size > 1) return { ...capture, mixed: true };
  return capture;
}

/**
 * The tile capture for the EXPORT lanes: a scope tile holding a trigger
 * snapshot draws THAT picture (chartvm slices the held arrays with the
 * snapshot's own rate/offsets, never the live frame) — its provenance is
 * the one latched with it, not whatever the endpoints refreshed to since
 * (review finding #3: a held NORMAL picture under a since-moved bench).
 */
function tileExportCapture(
  s: AppState,
  tile: TileConfig,
  heldCapture: CaptureProvenance | null | undefined
): CaptureProvenance | null {
  return heldCapture ?? tileCapture(s, tile);
}

/** Save-dialog + backend write; false = user cancelled. */
async function writeVia(
  ipc: Ipc,
  suggestedName: string,
  extension: "csv" | "png" | "svg",
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
/* Tile view-models + their provenance lines (shared by CSV and SVG)    */
/* ------------------------------------------------------------------ */

function tileExtraLines(kind: string): ProvenanceLine[] {
  return [
    { key: "export", value: "tile" },
    { key: "graph", value: kind },
  ];
}

function spectrumExport(s: AppState, tile: NonNullable<AppState["layout"]["tiles"][string]>) {
  const vm = spectrumVM(s, tile);
  const lines = [...tileExtraLines(tile.kind), { key: "unit", value: vm.unitLabel }];
  // A dBr file is meaningless without the subtracted reference (review
  // finding #4): with an AUTO reference it's a runtime peak recorded
  // nowhere else — write it in the tile's pre-dBr unit.
  if (vm.dbrRefDb !== null) {
    lines.push(
      { key: "dbr_ref", value: numCell(vm.dbrRefDb) },
      { key: "dbr_ref_unit", value: FD_UNIT_LABELS[tile.fdUnit] }
    );
  }
  return { vm, lines };
}

function scopeExport(s: AppState, tile: NonNullable<AppState["layout"]["tiles"][string]>) {
  // Clip to the tile's displayed time window — the exported data must match
  // the drawn extent, trigger aligned or not (review finding #3).
  const vm = clipScopeWindow(scopeVM(s, tile), tile.timeWindowMs);
  const lines = [
    ...tileExtraLines(tile.kind),
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
  return { vm, lines };
}

function sweepExport(s: AppState, tile: NonNullable<AppState["layout"]["tiles"][string]>) {
  const vm = sweepVM(s, tile);
  return { vm, lines: [...tileExtraLines(tile.kind), { key: "unit", value: vm.unitLabel }] };
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
  if (tile.kind === "spectrum") {
    const { vm, lines } = spectrumExport(s, tile);
    if (vm.series.length > 0) csv = tileSpectrumCsv(vm, comments(s, lines, tileCapture(s, tile)));
  } else if (tile.kind === "scope") {
    const { vm, lines } = scopeExport(s, tile);
    if (vm.series.length > 0) {
      csv = tileScopeCsv(vm, comments(s, lines, tileExportCapture(s, tile, vm.trigger?.capture)));
    }
  } else {
    const { vm, lines } = sweepExport(s, tile);
    if (vm.series.length > 0) csv = tileSweepCsv(vm, comments(s, lines, tileCapture(s, tile)));
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

/* ------------------------------------------------------------------ */
/* SVG                                                                  */
/* ------------------------------------------------------------------ */

/** Export a tile as a standalone VECTOR drawing (svg.ts) — the same
 * display-unit view-model as the CSV/PNG lanes, with the full provenance
 * block embedded in the file's <metadata>. */
export async function exportTileSvg(
  store: Store<AppState>,
  ipc: Ipc,
  tileId: string
): Promise<void> {
  const s = store.get();
  const tile = s.layout.tiles[tileId];
  if (!tile) return;
  const { title, footer } = tileImageText(s, tileId);
  let svg: string | null = null;
  if (tile.kind === "spectrum") {
    const { vm, lines } = spectrumExport(s, tile);
    svg = renderTileSvg({
      title,
      footer,
      provenance: comments(s, lines, tileCapture(s, tile)),
      unitLabel: vm.unitLabel,
      xUnitLabel: "Hz",
      xLog: tile.axis.xLog,
      yDomain: tile.axis.yAuto ? undefined : [tile.axis.yMin, tile.axis.yMax],
      series: vm.series.map((sv) => ({ label: sv.label, color: sv.color, x: sv.x, y: sv.y })),
    });
  } else if (tile.kind === "scope") {
    const { vm, lines } = scopeExport(s, tile);
    svg = renderTileSvg({
      title,
      footer,
      provenance: comments(s, lines, tileExportCapture(s, tile, vm.trigger?.capture)),
      unitLabel: vm.unitLabel,
      xUnitLabel: "s",
      xLog: false,
      ySymmetric: true,
      xFormat: fmtSeconds,
      series: vm.series.map((sv) => ({
        label: sv.label,
        color: sv.color,
        x: Float64Array.from({ length: sv.samples.length }, (_, i) => i / sv.sampleRate),
        y: sv.samples,
      })),
    });
  } else {
    const { vm, lines } = sweepExport(s, tile);
    svg = renderTileSvg({
      title,
      footer,
      provenance: comments(s, lines, tileCapture(s, tile)),
      unitLabel: vm.unitLabel,
      xUnitLabel: vm.xUnit === "rateHz" ? "Hz (rate)" : vm.xUnit,
      // Level sweeps are linear dB steps; Hz and rate-Hz axes are log —
      // the same scale rule the sweep renderer applies.
      xLog: vm.xUnit !== "dBFS",
      series: vm.series.map((sv) => ({
        // A member whose y unit differs from the axis label says so in the
        // legend (a dB and a % sweep can share a tile).
        label: sv.yUnitLabel !== vm.unitLabel ? `${sv.label} (${sv.yUnitLabel})` : sv.label,
        color: sv.color,
        x: sv.x,
        y: sv.y,
      })),
    });
  }
  if (svg === null) {
    toast(store, "info", "Nothing to export yet — the graph has no data.");
    return;
  }
  try {
    const path = await writeVia(
      ipc,
      `qa40x-${tile.kind}-${fileStamp()}.svg`,
      "svg",
      textToBase64(svg)
    );
    if (path) toast(store, "success", `Exported ${path}`);
  } catch (e) {
    toast(store, "error", `SVG export failed: ${String(e)}`);
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
    csv = traceTdCsv(meta, frames.td, comments(s, extra, meta.capture));
  } else if (domain === "fd" && frames?.fd) {
    csv = traceFdCsv(meta, frames.fd, comments(s, extra, meta.capture), isRatioTrace(meta));
  } else if (domain === "sweep" && frames?.sweep) {
    // Units resolved with the tile's own frame-first-program-fallback rule
    // (chartvm), never a bare frame read (review finding #6).
    csv = traceSweepCsv(
      meta,
      frames.sweep,
      comments(s, extra, meta.capture),
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

/** Title + short provenance footer for the composed image. The footer
 * prefers the tile's capture snapshot (issue #40 — the PNG lane had the
 * same export-time-bench bug as the CSV header): device/rate/fft/window/avg
 * describe the bench that PRODUCED the drawn data whenever it's known. */
function tileImageText(s: AppState, tileId: string): { title: string; footer: string[] } {
  const tile = s.layout.tiles[tileId];
  const kind = tile ? KIND_LABELS[tile.kind] : "Graph";
  const labels = (tile?.traces ?? [])
    .filter((id) => !tile?.hidden.includes(id))
    .map((id) => s.traces.byId[id]?.label)
    .filter((l): l is string => !!l);
  const cap = tile
    ? tile.kind === "scope"
      ? tileExportCapture(s, tile, scopeVM(s, tile).trigger?.capture)
      : tileCapture(s, tile)
    : null;
  const info = s.device.info;
  const device = cap?.device
    ? `${cap.device.model} #${cap.device.serial}` +
      (cap.device.firmware !== null ? ` fw${cap.device.firmware}` : "") +
      (cap.device.isVirtual ? " (virtual)" : "")
    : info
      ? `${info.model} #${info.serial} fw${info.firmware_version}${info.is_virtual ? " (virtual)" : ""}`
      : "no device";
  const acq = s.acquisition;
  const rateHz = cap?.sampleRateHz ?? s.device.config?.sample_rate ?? null;
  const fft = cap ? cap.fftSize : acq.fftSize;
  const window = cap ? cap.window : acq.window;
  const averaging = cap ? cap.averaging : acq.averaging;
  const avg =
    averaging === null
      ? null
      : averaging.mode === "off"
        ? "avg off"
        : `avg ${averaging.mode}×${averaging.count}`;
  const acqParts = [
    ...(fft !== null ? [`FFT ${fft}`] : []),
    ...(window !== null ? [window] : []),
    ...(avg !== null ? [avg] : []),
  ];
  return {
    title: labels.length > 0 ? `${kind} — ${labels.join(", ")}` : kind,
    footer: [
      `qa40x-rs v${APP_VERSION} — ${device}` +
        (rateHz !== null ? ` — ${rateHz} Hz` : "") +
        (acqParts.length > 0 ? `, ${acqParts.join(", ")}` : "") +
        (cap?.mixed ? " — mixed capture sources" : ""),
      (cap?.capturedAt ? `captured ${cap.capturedAt}, ` : "") +
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

/**
 * CSV export core (issue #30) — PURE text builders, no DOM, no IPC, no
 * clock: everything impure (timestamp, app version, save dialog, file
 * write) stays in export.ts, so these are unit-tested directly.
 *
 * Two export shapes, deliberately different in unit semantics:
 *  - a TILE export writes the tile's view-model verbatim — display units,
 *    exactly the curves the user is looking at (dBr subtraction, converter
 *    offsets, trigger-aligned slices included), via the same chartvm
 *    selectors the renderer eats;
 *  - a TRACE export writes the frames-cache arrays in their WIRE units
 *    (dBFS / full-scale samples), with a derived absolute column (dBV /
 *    volts) when the trace's converter offset is known — the re-analysable
 *    raw form.
 *
 * File shape (pattern borrowed from Phonalyser's `.fft`): `# key=value`
 * provenance comment lines, then one explicit-unit header row, then data
 * rows. `.` decimal separator always (JS number formatting), `,` field
 * separator, non-finite values (digital silence at -∞ dB) as empty cells.
 */
import type { AppState, TraceMeta } from "../store/state";
import type { ScopeVM, SpectrumVM, SweepVM } from "../store/selectors/chartvm";
import type { DecodedSweep } from "../data/frames";
import type { DecodedFd, DecodedTd } from "../ipc/stream";

/* ------------------------------------------------------------------ */
/* Cells and columns                                                    */
/* ------------------------------------------------------------------ */

/** A number as a CSV cell: shortest exact JS form (always `.` decimal,
 * exponent notation allowed); non-finite → empty cell. */
export function numCell(v: number): string {
  return Number.isFinite(v) ? String(v) : "";
}

/** Quote a text cell only when it needs it (comma, quote, newline). */
export function textCell(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface CsvColumn {
  header: string;
  values: ArrayLike<number>;
}

/** Assemble comment lines + header row + data rows; columns of unequal
 * length are padded with empty cells (side-by-side series export). */
export function columnsCsv(comments: string[], columns: CsvColumn[]): string {
  const rows = Math.max(0, ...columns.map((c) => c.values.length));
  const out: string[] = [...comments, columns.map((c) => textCell(c.header)).join(",")];
  for (let i = 0; i < rows; i++) {
    out.push(columns.map((c) => (i < c.values.length ? numCell(c.values[i]) : "")).join(","));
  }
  return out.join("\n") + "\n";
}

/* ------------------------------------------------------------------ */
/* Provenance                                                           */
/* ------------------------------------------------------------------ */

export interface ProvenanceLine {
  key: string;
  value: string;
}

export function provenanceComments(lines: ProvenanceLine[]): string[] {
  return ["# qa40x-rs data export", ...lines.map((l) => `# ${l.key}=${l.value}`)];
}

/**
 * The bench-state provenance block (issue #30): everything needed to
 * re-analyse or compare the file years later — app version, DEVICE IDENTITY
 * (the #25 standing constraint: model/serial/firmware/virtual from day one,
 * so the format doesn't break when several hardware sources exist),
 * acquisition parameters, converter ranges and calibration state.
 *
 * Honesty note: these lines describe the bench AT EXPORT TIME. A frozen ❄
 * trace or a reloaded document may have been captured under different
 * settings — the trailing `note` line says so, and the data columns stay
 * self-describing (explicit Hz / seconds axes) regardless.
 */
export function benchProvenance(
  s: AppState,
  appVersion: string,
  exportedAt: string
): ProvenanceLine[] {
  const lines: ProvenanceLine[] = [
    { key: "format_version", value: "1" },
    { key: "app", value: "qa40x-rs" },
    { key: "app_version", value: appVersion },
    { key: "exported_at", value: exportedAt },
  ];
  const info = s.device.info;
  if (info) {
    lines.push(
      { key: "device_model", value: info.model },
      { key: "device_serial", value: info.serial },
      { key: "device_firmware", value: String(info.firmware_version) },
      { key: "device_virtual", value: String(info.is_virtual) }
    );
  } else {
    lines.push({ key: "device_model", value: "none" });
  }
  const cfg = s.device.config;
  if (cfg) {
    lines.push(
      { key: "sample_rate_hz", value: String(cfg.sample_rate) },
      { key: "input_range_dbv", value: String(cfg.input_gain) },
      { key: "output_range_dbv", value: String(cfg.output_gain) }
    );
  }
  const acq = s.acquisition;
  lines.push(
    { key: "fft_size", value: String(acq.fftSize) },
    { key: "window", value: acq.window },
    { key: "averaging", value: acq.averaging.mode }
  );
  if (acq.averaging.mode !== "off") {
    lines.push({ key: "averaging_count", value: String(acq.averaging.count) });
  }
  lines.push({ key: "round_to_bin", value: String(acq.coherentGen) });
  const off = s.device.offsets;
  lines.push({ key: "calibrated", value: String(off?.calibrated === true) });
  if (off) {
    lines.push(
      { key: "offset_input_l_db", value: numCell(off.input_l) },
      { key: "offset_input_r_db", value: numCell(off.input_r) },
      { key: "offset_output_l_db", value: numCell(off.output_l) },
      { key: "offset_output_r_db", value: numCell(off.output_r) }
    );
  }
  lines.push({
    key: "note",
    value:
      "header reflects the bench at export time; a frozen or reloaded " +
      "trace may have been captured under different settings",
  });
  return lines;
}

/** One human line describing where a trace's frames come from — resolves
 * referenced trace ids to their labels while they still exist. */
export function traceSourceLine(s: AppState, meta: TraceMeta): string {
  const src = meta.source;
  switch (src.kind) {
    case "hw_input":
      return `hardware input ${src.channel === "left" ? "L" : "R"}`;
    case "hw_output":
      return `hardware output ${src.channel === "left" ? "L" : "R"}`;
    case "memory": {
      const from = s.traces.byId[src.frozenFrom]?.label ?? src.frozenFrom;
      return `frozen copy of ${from}${src.ratio ? " (ratio)" : ""}`;
    }
    case "transform": {
      const input = s.traces.byId[src.input]?.label ?? src.input;
      const steps = src.steps.map((st) => st.type).join(" → ");
      return `transform of ${input}${steps ? ` [${steps}]` : ""}`;
    }
    case "program": {
      const p = s.programs.byId[meta.id];
      return p?.kind === "sweep"
        ? `measurement program (${p.params.measurement})`
        : "measurement program";
    }
  }
}

/* ------------------------------------------------------------------ */
/* Tile exports — display units, straight from the view-models          */
/* ------------------------------------------------------------------ */

/** True when every series shares one x grid (bitwise-equal values). */
function sharedX(xs: ArrayLike<number>[]): boolean {
  if (xs.length < 2) return true;
  const first = xs[0];
  for (const x of xs) {
    if (x.length !== first.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== first[i]) return false;
  }
  return true;
}

export function tileSpectrumCsv(vm: SpectrumVM, comments: string[]): string {
  const columns: CsvColumn[] = [];
  if (sharedX(vm.series.map((sv) => sv.x))) {
    if (vm.series.length > 0) columns.push({ header: "frequency_hz", values: vm.series[0].x });
    for (const sv of vm.series) {
      columns.push({ header: `${sv.label} (${vm.unitLabel})`, values: sv.y });
    }
  } else {
    // Distinct grids (e.g. a frozen trace from another FFT size): each
    // series keeps its own labeled x column, rows padded to the longest.
    for (const sv of vm.series) {
      columns.push({ header: `frequency_hz (${sv.label})`, values: sv.x });
      columns.push({ header: `${sv.label} (${vm.unitLabel})`, values: sv.y });
    }
  }
  return columnsCsv(comments, columns);
}

/** Time axis of one scope series, derived from its own sample rate. */
function timeAxis(count: number, sampleRate: number): Float64Array {
  const t = new Float64Array(count);
  for (let i = 0; i < count; i++) t[i] = i / sampleRate;
  return t;
}

export function tileScopeCsv(vm: ScopeVM, comments: string[]): string {
  const columns: CsvColumn[] = [];
  const shared =
    vm.series.length > 0 &&
    vm.series.every(
      (sv) =>
        sv.sampleRate === vm.series[0].sampleRate &&
        sv.samples.length === vm.series[0].samples.length
    );
  if (shared) {
    columns.push({
      header: "time_s",
      values: timeAxis(vm.series[0].samples.length, vm.series[0].sampleRate),
    });
    for (const sv of vm.series) {
      columns.push({ header: `${sv.label} (${vm.unitLabel})`, values: sv.samples });
    }
  } else {
    for (const sv of vm.series) {
      columns.push({
        header: `time_s (${sv.label})`,
        values: timeAxis(sv.samples.length, sv.sampleRate),
      });
      columns.push({ header: `${sv.label} (${vm.unitLabel})`, values: sv.samples });
    }
  }
  return columnsCsv(comments, columns);
}

/** The sweep x-axis column header for a carried x unit. */
export function sweepXHeader(xUnit: "Hz" | "dBFS" | "rateHz"): string {
  return xUnit === "Hz" ? "frequency_hz" : xUnit === "dBFS" ? "level_dbfs" : "rate_hz";
}

export function tileSweepCsv(vm: SweepVM, comments: string[]): string {
  const columns: CsvColumn[] = [];
  const xHeader = sweepXHeader(vm.xUnit);
  if (sharedX(vm.series.map((sv) => sv.x))) {
    if (vm.series.length > 0) columns.push({ header: xHeader, values: vm.series[0].x });
    for (const sv of vm.series) {
      columns.push({ header: `${sv.label} (${vm.unitLabel})`, values: sv.y });
      if (sv.phaseDeg) columns.push({ header: `${sv.label} phase (deg)`, values: sv.phaseDeg });
    }
  } else {
    for (const sv of vm.series) {
      columns.push({ header: `${xHeader} (${sv.label})`, values: sv.x });
      columns.push({ header: `${sv.label} (${vm.unitLabel})`, values: sv.y });
      if (sv.phaseDeg) columns.push({ header: `${sv.label} phase (deg)`, values: sv.phaseDeg });
    }
  }
  return columnsCsv(comments, columns);
}

/* ------------------------------------------------------------------ */
/* Trace exports — wire units + derived absolute column                 */
/* ------------------------------------------------------------------ */

export function traceTdCsv(
  meta: TraceMeta,
  td: DecodedTd,
  comments: string[]
): string {
  const columns: CsvColumn[] = [
    { header: "time_s", values: timeAxis(td.samples.length, td.sampleRate) },
    { header: "amplitude_fs", values: td.samples },
  ];
  if (meta.offsetDb !== null) {
    const k = Math.pow(10, meta.offsetDb / 20);
    columns.push({
      header: "amplitude_v",
      values: Float64Array.from(td.samples, (v) => v * k),
    });
  }
  return columnsCsv(
    [...comments, `# trace_sample_rate_hz=${td.sampleRate}`],
    columns
  );
}

export function traceFdCsv(
  meta: TraceMeta,
  fd: DecodedFd,
  comments: string[],
  ratio: boolean
): string {
  const columns: CsvColumn[] = [{ header: "frequency_hz", values: fd.freqs }];
  if (ratio) {
    // A deconvolved spectrum is dB re its reference — absolute units and
    // converter offsets don't apply (chartvm's isRatioTrace guard).
    columns.push({ header: "magnitude_db_rel", values: fd.magDb });
  } else {
    columns.push({ header: "magnitude_dbfs", values: fd.magDb });
    if (meta.offsetDb !== null) {
      const off = meta.offsetDb;
      columns.push({
        header: "magnitude_dbv",
        values: Float64Array.from(fd.magDb, (v) => v + off),
      });
    }
  }
  return columnsCsv(comments, columns);
}

export function traceSweepCsv(
  meta: TraceMeta,
  sweep: DecodedSweep,
  comments: string[]
): string {
  // Same frame-carried unit rules as the sweep tile (issues #27/#28): the
  // x unit rides the frame; missing on pre-field frames → "Hz".
  const xUnit = sweep.xUnit ?? "Hz";
  const yUnit = sweep.yUnit ?? "dB";
  const columns: CsvColumn[] = [{ header: sweepXHeader(xUnit), values: sweep.freqs }];
  for (const c of sweep.curves) {
    const label = sweep.curves.length > 1 ? `${meta.label} ${c.label}` : meta.label;
    columns.push({ header: `${label} (${yUnit})`, values: c.values });
    if (c.phaseDeg) columns.push({ header: `${label} phase (deg)`, values: c.phaseDeg });
  }
  return columnsCsv(comments, columns);
}

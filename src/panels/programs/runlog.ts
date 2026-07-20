/**
 * The streaming script-output buffer (M4, port of v1 scriptdialog.ts):
 * actions/programs.ts feeds it from the backend's `script-log` events; the
 * script dialog renders it and live-appends while open. One script runs at
 * a time, so one app-wide log.
 */

export interface ScriptLogLine {
  line: string;
  error: boolean;
  /** Separator lines like "— run started —". */
  meta?: boolean;
}

export const MAX_LOG_LINES = 2000;

export class ScriptRunLog {
  private readonly buf: ScriptLogLine[] = [];
  private readonly listeners = new Set<(l: ScriptLogLine) => void>();

  append(line: string, error: boolean, meta = false): void {
    const entry: ScriptLogLine = { line, error, meta };
    this.buf.push(entry);
    if (this.buf.length > MAX_LOG_LINES) this.buf.splice(0, this.buf.length - MAX_LOG_LINES);
    for (const fn of this.listeners) fn(entry);
  }

  lines(): readonly ScriptLogLine[] {
    return this.buf;
  }

  clear(): void {
    this.buf.length = 0;
  }

  /** Subscribe to appended lines; returns an unsubscribe function. */
  subscribe(fn: (l: ScriptLogLine) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/** The app-wide script output log. */
export const scriptRunLog = new ScriptRunLog();

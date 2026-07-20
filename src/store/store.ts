/**
 * The central store — the ONLY holder of app state (plan §3.1).
 *
 * - `get()` returns the current immutable snapshot.
 * - `update(name, fn)` is the ONLY write path: `fn` returns a new root
 *   (spread-based immutable updates). Notifications are batched in a
 *   microtask, so one user action touching several slices fires one
 *   render pass.
 * - `select(sel, cb)` subscribes to a slice: `cb` fires only when the
 *   selected value changes (Object.is, or a supplied equality).
 *
 * No framework: panels build DOM once and update it from `select`
 * callbacks. State must stay serializable — no typed arrays, DOM nodes or
 * functions in it (frame data lives in `data/frames.ts`).
 */

export type Unsubscribe = () => void;

interface Selection<S> {
  sel: (s: S) => unknown;
  cb: (v: never) => void;
  eq: (a: unknown, b: unknown) => boolean;
  last: unknown;
}

/** Deep-freeze in dev so accidental in-place mutation throws loudly. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

export class Store<S> {
  private state: S;
  private readonly selections = new Set<Selection<S>>();
  private readonly coarse = new Set<() => void>();
  private notifyQueued = false;
  private readonly freeze: boolean;

  constructor(initial: S, opts: { freeze?: boolean } = {}) {
    this.freeze = opts.freeze ?? import.meta.env?.DEV ?? false;
    this.state = this.freeze ? deepFreeze(initial) : initial;
  }

  get(): S {
    return this.state;
  }

  /**
   * Apply a named, pure update. The name is for debugging/telemetry only
   * (it shows up in dev logging); it carries no behavior.
   */
  update(name: string, fn: (s: S) => S): void {
    const next = fn(this.state);
    if (Object.is(next, this.state)) return;
    this.state = this.freeze ? deepFreeze(next) : next;
    if (import.meta.env?.DEV) {
      // One line per action keeps the flow reconstructible from the console.
      console.debug(`[store] ${name}`);
    }
    this.queueNotify();
  }

  /**
   * Subscribe to a derived value. `cb` is called immediately with the
   * current value, then after any update that changes it.
   */
  select<T>(
    sel: (s: S) => T,
    cb: (value: T) => void,
    eq: (a: T, b: T) => boolean = Object.is
  ): Unsubscribe {
    const entry: Selection<S> = {
      sel,
      cb: cb as (v: never) => void,
      eq: eq as (a: unknown, b: unknown) => boolean,
      last: sel(this.state),
    };
    this.selections.add(entry);
    cb(entry.last as T);
    return () => this.selections.delete(entry);
  }

  /** Coarse subscription: fires after every batch (persist, devtools). */
  subscribe(cb: () => void): Unsubscribe {
    this.coarse.add(cb);
    return () => this.coarse.delete(cb);
  }

  private queueNotify(): void {
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      for (const entry of this.selections) {
        // One throwing subscriber must never silently starve the ones after
        // it — that failure mode reads as "the UI stopped reacting" with no
        // visible error. Contain, report, keep notifying.
        try {
          const value = entry.sel(this.state);
          if (!entry.eq(value, entry.last)) {
            entry.last = value;
            (entry.cb as (v: unknown) => void)(value);
          }
        } catch (err) {
          console.error("[store] subscriber failed:", err);
        }
      }
      for (const cb of this.coarse) {
        try {
          cb();
        } catch (err) {
          console.error("[store] coarse subscriber failed:", err);
        }
      }
    });
  }
}

/** Shallow equality for object slices (e.g. `s => s.device`). */
export function shallowEq<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  ) {
    return false;
  }
  const ka = Object.keys(a) as (keyof T)[];
  const kb = Object.keys(b) as (keyof T)[];
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.is(a[k], b[k]));
}

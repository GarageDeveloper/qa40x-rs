/**
 * Theme controller — Light / Dark for the QA40x controller.
 *
 * Dark is the default (the instrument look the app ships with). The choice is
 * stamped as `data-theme="dark" | "light"` on <html> and persisted to
 * localStorage. CSS custom properties (styles.css) carry the whole palette for
 * both themes; the canvas charts can't read CSS, so they mirror the tokens via
 * `readCssVars()` and repaint on `onThemeChange`.
 */

export type Theme = "dark" | "light";

const STORAGE_KEY = "qa402-theme";
const listeners = new Set<() => void>();

/** The theme currently stamped on the document (defaults to dark). */
export function currentTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

/**
 * Resolve and apply the startup theme: the stored choice if present, else the
 * OS preference on first run, else dark (the safe default the design targets).
 * Call once, as early as possible, before charts are constructed.
 */
export function initTheme(): void {
  let theme: Theme = "dark";
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    /* private mode / no storage — fall through to defaults */
  }
  if (stored === "light" || stored === "dark") {
    theme = stored;
  } else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
    theme = "light";
  }
  document.documentElement.setAttribute("data-theme", theme);
  // Refresh any palettes registered at import time so charts built after this
  // read the resolved startup theme (chart instances are constructed later).
  for (const fn of listeners) fn();
}

/** Apply a theme, persist it, and notify chart listeners to repaint. */
export function setTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* ignore persistence failures */
  }
  for (const fn of listeners) fn();
}

/** Flip between dark and light. Returns the new theme. */
export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === "dark" ? "light" : "dark";
  setTheme(next);
  return next;
}

/**
 * Register a callback fired after every theme change. Chart palettes register a
 * palette-refresh first (module load) and instances register their repaint
 * (construction); the Set preserves that order, so colours are refreshed before
 * anything redraws.
 */
export function onThemeChange(fn: () => void): void {
  listeners.add(fn);
}

/** Unregister a theme listener (charts call this on destroy). */
export function offThemeChange(fn: () => void): void {
  listeners.delete(fn);
}

/**
 * Snapshot the document's computed custom properties as a reader. Read once per
 * refresh (getComputedStyle is not free) and pull each token with a fallback so
 * a missing var never yields an empty string.
 */
export function readCssVars(): (name: string, fallback: string) => string {
  const cs = getComputedStyle(document.documentElement);
  return (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback;
}

/**
 * Convert a `#rgb` / `#rrggbb` hex to an `rgba()` string at the given alpha.
 * Used for canvas fills derived from a theme series colour, so a single token
 * drives both the stroke and its translucent fill in both themes. Falls back to
 * the input string when it isn't a parseable hex (already rgba/named).
 */
export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.trim();
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(h);
  if (!m) return h;
  let r: number;
  let g: number;
  let b: number;
  if (m[1].length === 3) {
    r = parseInt(m[1][0] + m[1][0], 16);
    g = parseInt(m[1][1] + m[1][1], 16);
    b = parseInt(m[1][2] + m[1][2], 16);
  } else {
    r = parseInt(m[1].slice(0, 2), 16);
    g = parseInt(m[1].slice(2, 4), 16);
    b = parseInt(m[1].slice(4, 6), 16);
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

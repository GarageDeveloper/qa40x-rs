/**
 * The ONE file that knows the browser-automation tool (RULE 1 of the harness,
 * see tests/e2e/README.md).
 *
 * Page objects and tests speak only to the `Driver` interface below, which
 * traffics in CSS selectors, page functions, and plain data. Migrating to
 * another tool (the logged option is WebdriverIO + @wdio/tauri-service, to
 * drive the REAL app instead of the mocked one) means implementing `Driver`
 * once over that tool's API — `browser.execute` for eval, `$$`/`getText` for
 * the text helpers — and swapping the fixtures file. The suite itself must
 * not change.
 *
 * Keep this interface boring: selectors + page functions + plain returns.
 * Anything clever (auto-waiting locator chains, :has-text engines) is
 * Playwright-only and would make the migration a rewrite.
 */

import type { Page } from "@playwright/test";

export interface Driver {
  /** Navigate to a path on the harness dev server and wait for load. */
  goto(path: string): Promise<void>;
  /** Click the first element matching `selector`. */
  click(selector: string): Promise<void>;
  /** Click the element matching `selector` whose trimmed text equals `text`. */
  clickByText(selector: string, text: string): Promise<void>;
  /** Check / uncheck a checkbox (firing real change events). */
  setChecked(selector: string, checked: boolean): Promise<void>;
  /** Trimmed textContent of the first match, or null when absent. */
  text(selector: string): Promise<string | null>;
  /**
   * Run a function in the page and return its JSON-serializable result.
   * The function must be self-contained (no closure over test scope) — both
   * Playwright and WebdriverIO serialize it by source.
   */
  eval<A, T>(fn: (arg: A) => T, arg: A): Promise<T>;
  /** Poll a page-side predicate until it returns true (or time out). */
  waitUntil<A>(fn: (arg: A) => boolean, arg: A, opts?: { timeoutMs?: number }): Promise<void>;
  /** Full-page screenshot written to `absPath`. */
  screenshot(absPath: string): Promise<void>;
}

export class PlaywrightDriver implements Driver {
  constructor(private readonly page: Page) {}

  async goto(path: string): Promise<void> {
    await this.page.goto(path);
  }

  async click(selector: string): Promise<void> {
    await this.page.locator(selector).first().click();
  }

  async clickByText(selector: string, text: string): Promise<void> {
    const matches = this.page.locator(selector);
    const n = await matches.count();
    for (let i = 0; i < n; i++) {
      const t = (await matches.nth(i).textContent())?.trim();
      if (t === text) {
        await matches.nth(i).click();
        return;
      }
    }
    throw new Error(`No element matching ${selector} with text "${text}"`);
  }

  async setChecked(selector: string, checked: boolean): Promise<void> {
    await this.page.locator(selector).first().setChecked(checked);
  }

  async text(selector: string): Promise<string | null> {
    const loc = this.page.locator(selector).first();
    if ((await loc.count()) === 0) return null;
    return ((await loc.textContent()) ?? "").trim();
  }

  async eval<A, T>(fn: (arg: A) => T, arg: A): Promise<T> {
    return this.page.evaluate(fn, arg);
  }

  async waitUntil<A>(
    fn: (arg: A) => boolean,
    arg: A,
    opts?: { timeoutMs?: number }
  ): Promise<void> {
    await this.page.waitForFunction(fn, arg, { timeout: opts?.timeoutMs ?? 10_000 });
  }

  async screenshot(absPath: string): Promise<void> {
    await this.page.screenshot({ path: absPath, fullPage: true });
  }
}

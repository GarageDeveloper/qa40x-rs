/**
 * v2 test fixtures — same pattern as the v1 suite: specs import
 * `test`/`expect` from here, receive a booted `AppV2`, and never see a
 * Page/Locator. Reuses the shared PlaywrightDriver.
 */
import { test as base, expect } from "@playwright/test";
import { PlaywrightDriver } from "./driver";
import { AppV2 } from "./app";

export const test = base.extend<{ app: AppV2 }>({
  app: async ({ page }, use) => {
    page.on("pageerror", (err) => console.error("[page error]", err.message));
    const app = new AppV2(new PlaywrightDriver(page));
    await app.boot();
    await use(app);
  },
});

export { expect };

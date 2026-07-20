import { defineConfig } from "@playwright/test";

/**
 * E2E harness config (tests/e2e/README.md).
 *
 * - Specs are `*.pw.ts` on purpose: vitest's default include is
 *   `*.{test,spec}.*`, so this suffix keeps `npm test` from ever picking the
 *   e2e specs up (and keeps its 193 unit tests exactly as fast as before).
 * - The web server is the real Vite dev server with the fake-backend
 *   bootstrap injected (vite.e2e.config.ts); `reuseExistingServer` means a
 *   `npm run dev:fake` you already have open is reused, headed runs included.
 */
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /.*\.pw\.ts$/,
  outputDir: "tests/e2e/.results",
  timeout: 30_000,
  // The fake device is one shared page-global; keep runs deterministic.
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://localhost:14200",
    viewport: { width: 1680, height: 1050 },
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npx vite --config vite.e2e.config.ts",
    url: "http://localhost:14200",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});

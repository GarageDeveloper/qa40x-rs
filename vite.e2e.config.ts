/**
 * Vite config for the e2e harness (tests/e2e): serves the REAL index.html and
 * the real app, with one change — the harness bootstrap (fake Tauri backend,
 * tests/e2e/harness/boot.ts) is injected as a module script BEFORE
 * /src/main.ts, so every invoke()/listen() lands on the fake device instead
 * of a Rust backend that isn't there.
 *
 * Used by `npm run test:e2e` (via playwright.config.ts webServer) and by
 * `npm run dev:fake` to click around the UI by hand without hardware.
 */
import { defineConfig, type Plugin } from "vite";

const MAIN_TAGS = [
  '<script type="module" src="/src/main.ts" defer></script>',
];
const BOOT_TAG = '<script type="module" src="/tests/e2e/harness/boot.ts" defer></script>';

function injectHarness(): Plugin {
  return {
    name: "qa40x-e2e-inject-harness",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        const mainTag = MAIN_TAGS.find((tag) => html.includes(tag));
        if (!mainTag) {
          // Fail loudly: silently serving the page WITHOUT the fake backend
          // would hang every test at "Disconnected" with no explanation.
          throw new Error(
            "e2e harness: no known main.ts script tag found in the page — " +
              "update MAIN_TAGS in vite.e2e.config.ts"
          );
        }
        return html.replace(mainTag, `${BOOT_TAG}\n    ${mainTag}`);
      },
    },
  };
}

/**
 * The production CSP from tauri.conf.json, so every e2e run also proves the
 * app works under the policy the shipped webview enforces. Two dev-only
 * relaxations: vite serves styles as inline <style> tags ('unsafe-inline' —
 * the production bundle links real CSS files and keeps style-src 'self'),
 * and HMR needs its own websocket.
 */
const E2E_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self'; " +
  "connect-src 'self' ws://localhost:14200; " +
  "object-src 'none'; base-uri 'self'; form-action 'self'";

export default defineConfig({
  plugins: [injectHarness()],
  clearScreen: false,
  server: {
    port: 14200,
    strictPort: true,
    headers: {
      "Content-Security-Policy": E2E_CSP,
    },
  },
});

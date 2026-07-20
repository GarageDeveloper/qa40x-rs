/**
 * E2E harness bootstrap. Injected by vite.e2e.config.ts as a module script
 * BEFORE /src/main.ts in index.html — module scripts execute in document
 * order, so by the time the app module evaluates, `window.__TAURI_INTERNALS__`
 * is already the mock and every `invoke`/`listen` lands on the fake device.
 *
 * Events: `mockIPC(..., { shouldMockEvents: true })` implements the
 * `plugin:event|listen/emit/unlisten` commands in the mock itself, storing
 * the app's `transformCallback` handler ids. Driving a backend event is then
 * just invoking `plugin:event|emit` — the exact path a real emission takes
 * through the mock — which we expose as `window.__qa40xE2E.emit`, used both
 * by tests (via the adapter) and by the fake device itself (script-state…).
 */

import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { FakeDevice } from "./fake-device";
import { fixtureProvider, type RecordedFixture } from "./frames";

export interface QA40xE2EHooks {
  /** Emit a backend event into the app's listen() callbacks. */
  emit(event: string, payload?: unknown): void;
  /** The fake backend, for state pokes (setPresent, holdPrograms…). */
  device: FakeDevice;
  /** Swap the capture seam to replay recorded hardware frames (task #54). */
  useFixtures(fixtures: RecordedFixture[]): void;
}

declare global {
  interface Window {
    __qa40xE2E: QA40xE2EHooks;
    __TAURI_INTERNALS__: { invoke(cmd: string, args?: unknown): Promise<unknown> };
  }
}

const device = new FakeDevice();

mockWindows("main");
mockIPC(async (cmd, args) => device.handle(cmd, (args ?? {}) as Record<string, unknown>), {
  shouldMockEvents: true,
});

function emit(event: string, payload?: unknown): void {
  void window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event, payload });
}
device.emitter = emit;

window.__qa40xE2E = {
  emit,
  device,
  useFixtures: (fixtures) => device.setProvider(fixtureProvider(fixtures)),
};

console.info("[qa40x e2e] fake backend installed — this page is NOT talking to hardware");

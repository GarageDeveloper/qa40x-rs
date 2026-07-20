// @vitest-environment jsdom
//
// M0 spike: prove that a Tauri v2 `Channel` passed as an invoke() argument
// under mockIPC (the e2e fake-device seam) reaches the mock handler intact,
// and that the handler can deliver messages into it.
//
// Two delivery paths are proven:
//  1. `channel.onmessage(msg)` — direct call through the public accessor
//     (simplest for the fake device);
//  2. `window.__TAURI_INTERNALS__.runCallback(channel.id, { index, message })`
//     — the production delivery path, exercising the Channel's own ordering
//     machinery (including out-of-order arrival).
//
// If this test ever breaks on a @tauri-apps/api upgrade, the streaming design
// (plan §3.2) needs its fallback: the fake emits via `plugin:event|emit`.
import { afterEach, expect, test } from "vitest";
import { Channel, invoke } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

afterEach(() => {
  clearMocks();
});

test("a Channel invoke arg reaches the mock handler intact (direct onmessage)", async () => {
  const received: unknown[] = [];

  mockIPC((cmd, args) => {
    if (cmd !== "stream_start") throw new Error(`unexpected cmd ${cmd}`);
    // Under mockIPC, args are NOT serialized: the live Channel object arrives.
    const ch = (args as { onFrame: Channel<{ seq: number }> }).onFrame;
    expect(ch).toBeInstanceOf(Channel);
    ch.onmessage({ seq: 1 });
    ch.onmessage({ seq: 2 });
    return null;
  });

  const onFrame = new Channel<{ seq: number }>((msg) => received.push(msg));
  await invoke("stream_start", { onFrame });

  expect(received).toEqual([{ seq: 1 }, { seq: 2 }]);
});

test("runCallback delivery preserves message order (production path)", async () => {
  const received: number[] = [];

  mockIPC((cmd, args) => {
    if (cmd !== "stream_start") return null;
    const ch = (args as { onFrame: Channel<{ seq: number }> }).onFrame;
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          runCallback: (id: number, arg: unknown) => void;
        };
      }
    ).__TAURI_INTERNALS__;
    // Deliver out of order: the Channel must queue index 1 until 0 arrives.
    internals.runCallback(ch.id, { index: 1, message: { seq: 11 } });
    internals.runCallback(ch.id, { index: 0, message: { seq: 10 } });
    return null;
  });

  const onFrame = new Channel<{ seq: number }>((msg) => received.push(msg.seq));
  await invoke("stream_start", { onFrame });

  expect(received).toEqual([10, 11]);
});

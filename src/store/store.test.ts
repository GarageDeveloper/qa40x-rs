import { describe, expect, test, vi } from "vitest";
import { shallowEq, Store } from "./store";

interface S {
  a: { n: number };
  b: { m: number };
}

const init = (): S => ({ a: { n: 1 }, b: { m: 1 } });

/** Flush the microtask queue so batched notifications fire. */
const flush = () => Promise.resolve();

describe("Store", () => {
  test("update replaces the snapshot; get() reflects it synchronously", () => {
    const store = new Store<S>(init());
    store.update("test", (s) => ({ ...s, a: { n: 2 } }));
    expect(store.get().a.n).toBe(2);
  });

  test("select fires immediately with the current value", () => {
    const store = new Store<S>(init());
    const cb = vi.fn();
    store.select((s) => s.a.n, cb);
    expect(cb).toHaveBeenCalledExactlyOnceWith(1);
  });

  test("select fires only when its slice changes", async () => {
    const store = new Store<S>(init());
    const onA = vi.fn();
    const onB = vi.fn();
    store.select((s) => s.a, onA);
    store.select((s) => s.b, onB);
    onA.mockClear();
    onB.mockClear();

    store.update("touch-a", (s) => ({ ...s, a: { n: 2 } }));
    await flush();

    expect(onA).toHaveBeenCalledExactlyOnceWith({ n: 2 });
    expect(onB).not.toHaveBeenCalled();
  });

  test("several updates in one turn notify once (microtask batch)", async () => {
    const store = new Store<S>(init());
    const cb = vi.fn();
    store.select((s) => s.a.n, cb);
    cb.mockClear();

    store.update("one", (s) => ({ ...s, a: { n: 2 } }));
    store.update("two", (s) => ({ ...s, a: { n: 3 } }));
    await flush();

    expect(cb).toHaveBeenCalledExactlyOnceWith(3);
  });

  test("unsubscribe stops notifications", async () => {
    const store = new Store<S>(init());
    const cb = vi.fn();
    const off = store.select((s) => s.a.n, cb);
    cb.mockClear();
    off();

    store.update("after-off", (s) => ({ ...s, a: { n: 9 } }));
    await flush();

    expect(cb).not.toHaveBeenCalled();
  });

  test("identity-preserving update is a no-op", async () => {
    const store = new Store<S>(init());
    const coarse = vi.fn();
    store.subscribe(coarse);

    store.update("noop", (s) => s);
    await flush();

    expect(coarse).not.toHaveBeenCalled();
  });

  test("frozen state throws on in-place mutation (dev guard)", () => {
    const store = new Store<S>(init(), { freeze: true });
    expect(() => {
      (store.get().a as { n: number }).n = 42;
    }).toThrow();
  });

  test("shallowEq compares one level deep", () => {
    const a = { x: 1, y: 2 };
    expect(shallowEq(a, { x: 1, y: 2 })).toBe(true);
    expect(shallowEq(a, { x: 1, y: 3 })).toBe(false);
    expect(shallowEq<unknown>({ x: {} }, { x: {} })).toBe(false);
  });
});

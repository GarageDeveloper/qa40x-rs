// @vitest-environment jsdom
/**
 * Traces panel (DOM) — device-group rendering pins (issue #25 lot E4): the
 * boot single-device shape must carry the SAME testids/classes as pre-E4
 * (row.ts's extraction moved code, not behavior), and the no-layout-shift
 * controls (alias input, per-group Run, add-device select) must render
 * DISABLED in their "nothing yet" states rather than being absent —
 * gui-no-layout-shift.md's rule, load-bearing here because a toggled
 * control appearing/disappearing is a worse UX regression than a greyed
 * one (see devicegroup.ts's own header comment).
 */
import { describe, expect, it } from "vitest";
import type { Commands, Ipc } from "../../ipc/ipc";
import { Store } from "../../store/store";
import { initialState, type AppState } from "../../store/state";
import { mountTracesPanel } from "./panel";

const noopIpc: Ipc = {
  async call<K extends keyof Commands>(): Promise<Commands[K]["result"]> {
    return null as Commands[K]["result"];
  },
};

/** Store notifications are batched in a microtask (store.ts's
 * `queueMicrotask`) — one tick flushes them since it queues strictly after. */
const flush = (): Promise<void> => Promise.resolve();

function mount(state: AppState = initialState()): { host: HTMLElement; store: Store<AppState> } {
  const store = new Store(state);
  const host = document.createElement("div");
  mountTracesPanel(host, store, noopIpc);
  return { host, store };
}

describe("Traces panel (DOM) — boot state renders one device group, byte-identical row shape", () => {
  it("one group at data-slot=0, carrying testid traces-group-0", async () => {
    const { host } = mount();
    await flush();
    const group = host.querySelector('[data-testid="traces-group-0"]');
    expect(group).not.toBeNull();
    expect(group!.getAttribute("data-slot")).toBe("0");
    // Exactly one group at boot — no phantom slot-1 dormant group.
    expect(host.querySelectorAll("[data-testid^='traces-group-']").length).toBe(1);
  });

  it("its 4 rows carry the pre-E4 testids AND the traces__row class", async () => {
    const { host } = mount();
    await flush();
    for (const id of ["hw-in-left", "hw-in-right", "hw-out-left", "hw-out-right"]) {
      const dot = host.querySelector(`[data-testid="trace-color-${id}"]`);
      expect(dot, id).not.toBeNull();
      const row = dot!.closest(".traces__row");
      expect(row, id).not.toBeNull();
    }
  });
});

describe("Traces panel (DOM) — no-layout-shift controls render DISABLED, never absent", () => {
  it("group-alias-0 is present but DISABLED while the slot-0 session's deviceId is null (boot)", async () => {
    const { host } = mount();
    await flush();
    const alias = host.querySelector('[data-testid="group-alias-0"]') as HTMLInputElement | null;
    expect(alias).not.toBeNull();
    expect(alias!.disabled).toBe(true);
  });

  it("group-run-0 is present but DISABLED while the session is not connected (boot status is 'disconnected')", async () => {
    const { host } = mount();
    await flush();
    const run = host.querySelector('[data-testid="group-run-0"]') as HTMLButtonElement | null;
    expect(run).not.toBeNull();
    expect(run!.disabled).toBe(true);
    expect(run!.textContent).toBe("Run");
  });

  it("group-remove-0 is present but DISABLED — the default device's endpoints are permanent", async () => {
    const { host } = mount();
    await flush();
    const remove = host.querySelector('[data-testid="group-remove-0"]') as HTMLButtonElement | null;
    expect(remove).not.toBeNull();
    expect(remove!.disabled).toBe(true);
  });

  it("traces-add-device is present but DISABLED while nothing is enumerated/addable (boot: no devices scanned yet)", async () => {
    const { host } = mount();
    await flush();
    const addDev = host.querySelector(
      '[data-testid="traces-add-device"]'
    ) as HTMLSelectElement | null;
    expect(addDev).not.toBeNull();
    expect(addDev!.disabled).toBe(true);
  });
});

describe("Traces panel (DOM) — per-group collapse (Raphaël 2026-07-28)", () => {
  it("the chevron folds the group to its header (rows/ctls hidden by class, header controls still present) and persists via workspace.collapsed", async () => {
    const { host, store } = mount();
    await flush();
    const group = host.querySelector('[data-testid="traces-group-0"]')!;
    const btn = host.querySelector(
      '[data-testid="group-collapse-0"]'
    ) as HTMLButtonElement;
    expect(group.classList.contains("traces__group--collapsed")).toBe(false);
    expect(btn.textContent).toBe("▾");

    btn.click();
    await flush();
    expect(store.get().workspace.collapsed).toContain("traces-group-0");
    expect(group.classList.contains("traces__group--collapsed")).toBe(true);
    expect(btn.textContent).toBe("▸");
    // The header stays whole — Run/Remove/alias remain reachable folded.
    expect(host.querySelector('[data-testid="group-run-0"]')).not.toBeNull();

    btn.click();
    await flush();
    expect(store.get().workspace.collapsed).not.toContain("traces-group-0");
    expect(group.classList.contains("traces__group--collapsed")).toBe(false);
  });
});

/**
 * Slot-0 header Connect (issue #25 lot F, Raphaël 2026-07-29): a
 * disconnected DEFAULT device next to live devices used to leave only the
 * anonymous top-bar Connect ("on ne sait pas ce qu'on connecte"). With an
 * identity on its rows (the in-session connect stamp) and the unit
 * enumerable, the slot-0 group header now offers the same named revive as
 * slot ≥ 1 — routed through the slot-0 connect flow (`connect_device`,
 * explicit id: a P3 pick). At boot (no identity) the button stays the
 * familiar disabled "Run" — pinned above.
 */
describe("Traces panel (DOM) — slot-0 named reconnect from the group header (issue #25 lot F)", () => {
  function slot0DisconnectedWithIdentity(): AppState {
    const s = initialState();
    const withEntry: AppState = {
      ...s,
      devices: {
        ...s.devices,
        available: ["usb/A"],
        byId: {
          "usb/A": {
            id: "usb/A",
            source_id: "usb",
            source_kind: "Usb",
            source_label: "USB",
            model: "QA402",
            serial: "A",
            serial_synthetic: false,
            product: "QA402 Audio Analyzer",
            firmware_version: null,
            sample_rates: [48000, 96000, 192000],
            capabilities: null,
            open: false,
            slot: null,
          } as never,
        },
      },
    };
    return {
      ...withEntry,
      traces: {
        ...withEntry.traces,
        byId: {
          ...withEntry.traces.byId,
          "hw-in-left": {
            ...withEntry.traces.byId["hw-in-left"],
            capture: {
              device: { model: "QA402", serial: "A", firmware: 60, isVirtual: false },
              sampleRateHz: null,
              inputRangeDbv: null,
              outputRangeDbv: null,
              offsets: null,
              fftSize: null,
              window: null,
              averaging: null,
              capturedAt: null,
            },
          },
        },
      },
    };
  }

  it("the slot-0 button reads 'Connect', ENABLED, and the header names the unit", async () => {
    const store = new Store(slot0DisconnectedWithIdentity());
    const host = document.createElement("div");
    mountTracesPanel(host, store, noopIpc);
    await flush();
    const run = host.querySelector('[data-testid="group-run-0"]') as HTMLButtonElement;
    expect(run.textContent).toBe("Connect");
    expect(run.disabled).toBe(false);
    const title = host.querySelector('[data-testid="group-title-0"]');
    expect(title?.textContent ?? "").toContain("QA402 · A");
  });

  it("clicking it calls connect_device with the EXPLICIT id — the slot-0 flow, never connect_additional_device", async () => {
    const calls: [string, unknown][] = [];
    const recordingIpc: Ipc = {
      async call<K extends keyof Commands>(
        cmd: K,
        args?: Commands[K]["args"]
      ): Promise<Commands[K]["result"]> {
        calls.push([cmd, args]);
        return null as Commands[K]["result"];
      },
    };
    const store = new Store(slot0DisconnectedWithIdentity());
    const host = document.createElement("div");
    mountTracesPanel(host, store, recordingIpc);
    await flush();
    (host.querySelector('[data-testid="group-run-0"]') as HTMLButtonElement).click();
    await flush();
    const connectCall = calls.find(([m]) => m === "connect_device");
    expect(connectCall).toBeDefined();
    expect(connectCall![1]).toEqual({ deviceId: "usb/A" });
    expect(calls.some(([m]) => m === "connect_additional_device")).toBe(false);
  });
});

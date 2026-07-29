/**
 * v2 application page object. Speaks only to the shared Driver interface
 * (RULE 1) and the v2 app's data-testid selectors. The harness (fake
 * device, boot injection) is the same one the v1 suite uses.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Driver } from "./driver";

const SCREENSHOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "screenshots"
);

export class AppV2 {
  constructor(readonly drv: Driver) {}

  /** Capture a full-page screenshot into tests/e2e/screenshots/. */
  async screenshot(name: string): Promise<void> {
    await this.drv.screenshot(path.join(SCREENSHOT_DIR, `${name}.png`));
  }

  /** Load the v2 page. Unlike v1, the v2 app does not auto-connect. */
  async boot(): Promise<void> {
    await this.drv.goto("/index.html");
    await this.drv.waitUntil(
      () => document.querySelector('[data-testid="btn-connect"]') !== null,
      undefined as void
    );
  }

  async clickConnect(): Promise<void> {
    await this.drv.click('[data-testid="btn-connect"]');
  }

  async connectLabel(): Promise<string | null> {
    return this.drv.text('[data-testid="btn-connect"]');
  }

  async waitConnected(timeoutMs = 15_000): Promise<void> {
    await this.drv.waitUntil(
      () =>
        document
          .querySelector('[data-testid="device-led"]')
          ?.classList.contains("led--on") === true,
      undefined as void,
      { timeoutMs }
    );
  }

  async waitDisconnected(timeoutMs = 15_000): Promise<void> {
    await this.drv.waitUntil(
      () =>
        document
          .querySelector('[data-testid="device-led"]')
          ?.classList.contains("led--on") === false,
      undefined as void,
      { timeoutMs }
    );
  }

  /** Unplug/replug the fake bus device (same seam as the v1 suite). */
  async setPresent(present: boolean): Promise<void> {
    await this.drv.eval(
      (p: boolean) => window.__qa40xE2E.device.setPresent(p),
      present
    );
  }

  /** Demo mode: the Demo button (visible only while disconnected). */
  async clickDemo(): Promise<void> {
    await this.drv.click('[data-testid="btn-demo"]');
  }

  async demoButtonVisible(): Promise<boolean> {
    return this.drv.eval(
      () =>
        document
          .querySelector('[data-testid="btn-demo"]')
          ?.classList.contains("u-hidden") === false,
      undefined as void
    );
  }

  /** The DEMO chip badging a virtual-device session. */
  async demoChipVisible(): Promise<boolean> {
    return this.drv.eval(
      () =>
        document
          .querySelector('[data-testid="demo-chip"]')
          ?.classList.contains("u-hidden") === false,
      undefined as void
    );
  }

  /* -- unit picker (issue #25 lot D) ----------------------------------- */

  /** How many physical units the fake bus offers. */
  async setUnits(n: number): Promise<void> {
    await this.drv.eval((v: number) => window.__qa40xE2E.device.setUnits(v), n);
  }

  async devicePickerVisible(): Promise<boolean> {
    return this.drv.eval(
      () =>
        document
          .querySelector('[data-testid="device-select"]')
          ?.classList.contains("u-hidden") === false,
      undefined as void
    );
  }

  async devicePickerDisabled(): Promise<boolean> {
    return this.drv.eval(
      () =>
        (
          document.querySelector(
            '[data-testid="device-select"]'
          ) as HTMLSelectElement | null
        )?.disabled === true,
      undefined as void
    );
  }

  /** The picker's option values (unit ids), in listed order. */
  async deviceOptions(): Promise<string[]> {
    return this.drv.eval(
      () =>
        Array.from(
          document.querySelectorAll('[data-testid="device-select"] option')
        ).map((o) => (o as HTMLOptionElement).value),
      undefined as void
    );
  }

  async pickDevice(id: string): Promise<void> {
    await this.setSelect("device-select", id);
  }

  /** Every deviceId `connect_device` was invoked with (null = arg-less). */
  async connectDeviceIds(): Promise<(string | null)[]> {
    return this.drv.eval(
      () => window.__qa40xE2E.device.connectDeviceIds,
      undefined as void
    );
  }

  async identity(): Promise<string | null> {
    return this.drv.text('[data-testid="device-identity"]');
  }

  /* -- multi-device (issue #25 lot E4) --------------------------------- */

  /** How many built-in virtual units the fake enumerates (default 1). */
  async setVirtualUnits(n: number): Promise<void> {
    await this.drv.eval(
      (v: number) => window.__qa40xE2E.device.setVirtualUnits(v),
      n
    );
  }

  /** Unplug ONE physical unit — per-unit loss, id in the event payload. */
  async unplugUnit(id: string): Promise<void> {
    await this.drv.eval(
      (v: string) => window.__qa40xE2E.device.unplugUnit(v),
      id
    );
  }

  /** Fake-side truth: slots with an open unit, ascending. */
  async openSlots(): Promise<number[]> {
    return this.drv.eval(() => window.__qa40xE2E.device.openSlots(), undefined as void);
  }

  /** Fake-side truth: the stream config `slot`'s unit last adopted. */
  async unitStreamSlotCount(slot: number): Promise<number | null> {
    return this.drv.eval(
      (v: number) => {
        const cfg = window.__qa40xE2E.device.streamConfigOf(v);
        return cfg === null ? null : cfg.slots.length;
      },
      slot
    );
  }

  /** Fake-side truth: frames `slot`'s unit pushed on its current stream. */
  async unitFrameCount(slot: number): Promise<number> {
    return this.drv.eval(
      (v: number) => window.__qa40xE2E.device.frameCountOf(v),
      slot
    );
  }

  /** Every session's transport scalars + the focus (debug-hook probe). */
  async sessions(): Promise<{
    focused: string;
    byKey: Record<
      string,
      {
        slot: number;
        deviceId: string | null;
        status: string;
        streaming: boolean;
        frames: number;
        outputOnly: boolean;
        generatorRunning: boolean;
      }
    >;
  }> {
    return this.drv.eval(() => {
      const dbg = (
        window as unknown as {
          qa40xV2Debug: { sessions(): never };
        }
      ).qa40xV2Debug;
      return dbg.sessions();
    }, undefined as void);
  }

  /** Add an enumerated unit from the Traces-panel "+ device" select. */
  async addDeviceFromPanel(id: string): Promise<void> {
    await this.setSelect("traces-add-device", id);
  }

  /** The "+ device" select's option values (excluding the placeholder). */
  async addableOptions(): Promise<string[]> {
    return this.drv.eval(
      () =>
        Array.from(
          document.querySelectorAll('[data-testid="traces-add-device"] option')
        )
          .map((o) => (o as HTMLOptionElement).value)
          .filter((v) => v !== ""),
      undefined as void
    );
  }

  /** Group titles by slot, as rendered ("<label>" or "<label> — not connected"). */
  async groupTitle(slot: number): Promise<string | null> {
    return this.drv.text(`[data-testid="group-title-${slot}"]`);
  }

  /** Number of device groups the panel renders. */
  async groupCount(): Promise<number> {
    return this.drv.eval(
      () => document.querySelectorAll(".traces__group").length,
      undefined as void
    );
  }

  /** Click a group header's Run/Stop. */
  async groupRun(slot: number): Promise<void> {
    await this.drv.click(`[data-testid="group-run-${slot}"]`);
  }

  async groupRunLabel(slot: number): Promise<string | null> {
    return this.drv.text(`[data-testid="group-run-${slot}"]`);
  }

  async groupRunDisabled(slot: number): Promise<boolean> {
    return this.drv.eval(
      (v: number) =>
        (
          document.querySelector(
            `[data-testid="group-run-${v}"]`
          ) as HTMLButtonElement | null
        )?.disabled === true,
      slot
    );
  }

  /** Click a group header's Remove ✕. */
  async groupRemove(slot: number): Promise<void> {
    await this.drv.click(`[data-testid="group-remove-${slot}"]`);
  }

  /** Type an alias into a group header's editor (commits via change). */
  async setGroupAlias(slot: number, alias: string): Promise<void> {
    await this.drv.eval(
      (a: { slot: number; alias: string }) => {
        const input = document.querySelector(
          `[data-testid="group-alias-${a.slot}"]`
        ) as HTMLInputElement;
        input.value = a.alias;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      },
      { slot, alias }
    );
  }

  /** The toolbar device-select's mode: "pick" (lot D — no data-mode
   * attribute, the pre-E4 attribute set) or "focus" (E4). */
  async focusMode(): Promise<string> {
    return this.drv.eval(
      () =>
        (
          document.querySelector(
            '[data-testid="device-select"]'
          ) as HTMLElement | null
        )?.dataset.mode ?? "pick",
      undefined as void
    );
  }

  /** Focus a session from the toolbar selector (focus mode only). */
  async pickFocus(key: string): Promise<void> {
    await this.setSelect("device-select", key);
  }

  /** The device-select's option LABELS (alias-aware in focus mode). */
  async deviceOptionLabels(): Promise<string[]> {
    return this.drv.eval(
      () =>
        Array.from(
          document.querySelectorAll('[data-testid="device-select"] option')
        ).map((o) => o.textContent ?? ""),
      undefined as void
    );
  }

  async telemetry(): Promise<string | null> {
    return this.drv.text('[data-testid="device-telemetry"]');
  }

  /** Change a range/rate select by test id (fires a real change event). */
  async setSelect(testid: string, value: string): Promise<void> {
    await this.drv.eval(
      (a: { testid: string; value: string }) => {
        const sel = document.querySelector(
          `[data-testid="${a.testid}"]`
        ) as HTMLSelectElement;
        sel.value = a.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      },
      { testid, value }
    );
  }

  async selectValue(testid: string): Promise<string> {
    return this.drv.eval(
      (a: { testid: string }) =>
        (
          document.querySelector(
            `[data-testid="${a.testid}"]`
          ) as HTMLSelectElement
        ).value,
      { testid }
    );
  }

  /** True when all four device controls (in/out/rate/fft) are disabled. */
  async controlsDisabled(): Promise<boolean> {
    return this.drv.eval(
      () =>
        ["input-range", "output-range", "sample-rate", "fft-size"].every(
          (id) =>
            (
              document.querySelector(
                `[data-testid="${id}"]`
              ) as HTMLSelectElement | null
            )?.disabled === true
        ),
      undefined as void
    );
  }

  /** Drive a backend event into the app's listen() callbacks. */
  async emit(event: string, payload?: unknown): Promise<void> {
    await this.drv.eval(
      (a: { event: string; payload: unknown }) =>
        window.__qa40xE2E.emit(a.event, a.payload),
      { event, payload: payload ?? null }
    );
  }

  /** Number of visible toasts whose message contains `text`. */
  async toastCount(text: string): Promise<number> {
    return this.drv.eval(
      (a: { text: string }) =>
        Array.from(document.querySelectorAll(".toast__msg")).filter((n) =>
          (n.textContent ?? "").includes(a.text)
        ).length,
      { text }
    );
  }

  /** Whether an annunciator badge is lit. */
  async annunciatorLit(key: string): Promise<boolean> {
    return this.drv.eval(
      (a: { key: string }) =>
        document
          .querySelector(`[data-testid="ann-${a.key}"]`)
          ?.classList.contains("annunciator--lit") === true,
      { key }
    );
  }

  /* ---- M1: stream / sources / traces / spectrum ---------------------- */

  /** Replay recorded hardware fixtures instead of the synthetic loopback
   * (same harness seam as v1 — window.__qa40xE2E.useFixtures takes the
   * RecordedFixture OBJECTS, loaded from JSON in the spec's Node context). */
  async useFixtures(fixtures: unknown[]): Promise<void> {
    await this.drv.eval(
      (fx: unknown[]) =>
        window.__qa40xE2E.useFixtures(
          fx as Parameters<typeof window.__qa40xE2E.useFixtures>[0]
        ),
      fixtures
    );
  }

  /** Add a source of any kind via the "+" menu; returns its id (the newest
   * sources row). */
  async addSource(
    kind:
      | "sine"
      | "square"
      | "triangle"
      | "sawtooth"
      | "multitone"
      | "noise"
      | "chirp"
      | "script"
  ): Promise<string> {
    await this.drv.click('[data-testid="btn-add-source"]');
    await this.drv.click(`[data-testid="add-kind-${kind}"]`);
    return this.drv.eval(() => {
      const dbg = (
        window as unknown as {
          qa40xV2Debug: { state(): { sources: { order: string[] } } };
        }
      ).qa40xV2Debug;
      const order = dbg.state().sources.order;
      return order[order.length - 1];
    }, undefined as void);
  }

  /** Add a sine source and return its id. */
  async addSine(): Promise<string> {
    return this.addSource("sine");
  }

  async setSineFrequency(id: string, hz: number): Promise<void> {
    await this.setNumberField(`src-freq-${id}`, hz);
  }

  async setSineLevel(id: string, dbv: number): Promise<void> {
    await this.setNumberField(`src-level-${id}`, dbv);
  }

  /** Route via the L/R checkbox pair (nothing checked = Off). */
  async setSineRoute(id: string, route: "left" | "right" | "both" | "off"): Promise<void> {
    const wantL = route === "left" || route === "both";
    const wantR = route === "right" || route === "both";
    for (const [side, want] of [["l", wantL], ["r", wantR]] as const) {
      await this.drv.eval(
        (a: { testid: string; want: boolean }) => {
          const box = document.querySelector(
            `[data-testid="${a.testid}"]`
          ) as HTMLInputElement;
          if (box.checked !== a.want) box.click();
        },
        { testid: `src-route-${side}-${id}`, want }
      );
    }
  }

  async playSine(id: string): Promise<void> {
    await this.drv.click(`[data-testid="src-play-${id}"]`);
  }

  /** The Σ-peak / clip / fitted-range footer, as the user sees it. */
  async mixReadout(): Promise<{
    peakDbv: number | null;
    clipLit: boolean;
    rangeDbv: number | null;
  }> {
    return this.drv.eval(() => {
      const sigma =
        document.querySelector('[data-testid="sigma-peak"]')?.textContent ?? "";
      const m = sigma.match(/([+-]?\d+(?:\.\d+)?) dBV/);
      const range =
        document.querySelector('[data-testid="out-range-readout"]')?.textContent ?? "";
      const rm = range.match(/([+-]?\d+) dBV/);
      return {
        peakDbv: m ? Number(m[1]) : null,
        clipLit:
          document
            .querySelector('[data-testid="out-clip-dot"]')
            ?.classList.contains("sources__clip--lit") === true,
        rangeDbv: rm ? Number(rm[1]) : null,
      };
    }, undefined as void);
  }

  /** A source row's level field value, as displayed (the asked dBV). */
  async sourceLevelValue(id: string): Promise<number> {
    return this.drv.eval(
      (a: { testid: string }) =>
        Number(
          (
            document.querySelector(
              `[data-testid="${a.testid}"]`
            ) as HTMLInputElement
          ).value
        ),
      { testid: `src-level-${id}` }
    );
  }

  /** The fitted output range the run state carries (backend truth). */
  async fittedOutputRange(): Promise<number | null> {
    return this.drv.eval(() => {
      const dbg = (
        window as unknown as {
          qa40xV2Debug: { state(): { run: { fittedOutputRangeDbv: number | null } } };
        }
      ).qa40xV2Debug;
      return dbg.state().run.fittedOutputRangeDbv;
    }, undefined as void);
  }

  /** Highest stream frame seq seen by the run stats (frame counter). */
  async frameCount(): Promise<number> {
    return this.drv.eval(() => {
      const dbg = (
        window as unknown as {
          qa40xV2Debug: { state(): { run: { stats: { frames: number } } } };
        }
      ).qa40xV2Debug;
      return dbg.state().run.stats.frames;
    }, undefined as void);
  }

  /** The named backend error shown on a source row ("" when none). */
  async sourceError(id: string): Promise<string> {
    return this.drv.eval(
      (a: { testid: string }) =>
        document.querySelector(`[data-testid="${a.testid}"]`)?.textContent ?? "",
      { testid: `src-error-${id}` }
    );
  }

  /** Toggle the output-only session mode checkbox. */
  async setOutputOnly(on: boolean): Promise<void> {
    await this.drv.eval(
      (a: { on: boolean }) => {
        const box = document.querySelector(
          '[data-testid="output-only"]'
        ) as HTMLInputElement;
        if (box.checked !== a.on) box.click();
      },
      { on }
    );
  }

  /** Whether the fake's gap-free generator loop is running (backend truth). */
  async generatorRunning(): Promise<boolean> {
    return this.drv.eval(() => {
      const dbg = (
        window as unknown as {
          qa40xV2Debug: { state(): { run: { generatorRunning: boolean } } };
        }
      ).qa40xV2Debug;
      return dbg.state().run.generatorRunning;
    }, undefined as void);
  }

  /** Whether the stream reports itself running. */
  async streaming(): Promise<boolean> {
    return this.drv.eval(() => {
      const dbg = (
        window as unknown as {
          qa40xV2Debug: { state(): { run: { streaming: boolean } } };
        }
      ).qa40xV2Debug;
      return dbg.state().run.streaming;
    }, undefined as void);
  }

  /** Set any numeric field by test id (fires a real change event). */
  async setNumber(testid: string, value: number): Promise<void> {
    await this.setNumberField(testid, value);
  }

  private async setNumberField(testid: string, value: number): Promise<void> {
    await this.drv.eval(
      (a: { testid: string; value: number }) => {
        const input = document.querySelector(
          `[data-testid="${a.testid}"]`
        ) as HTMLInputElement;
        input.value = String(a.value);
        input.dispatchEvent(new Event("change", { bubbles: true }));
      },
      { testid, value }
    );
  }

  /**
   * Show/hide a trace on a grid tile (default: the first tile). Since M3
   * "visibility" is tile membership: shown = member of the tile (the add
   * ＋trace select), hidden = removed via the legend ✕.
   */
  async setTraceVisible(
    traceId: string,
    visible: boolean,
    tileId = "tile-1"
  ): Promise<void> {
    await this.drv.eval(
      (a: { traceId: string; visible: boolean; tileId: string }) => {
        const member =
          document.querySelector(
            `[data-testid="tile-trace-${a.tileId}-${a.traceId}"]`
          ) !== null;
        if (a.visible && !member) {
          const sel = document.querySelector(
            `[data-testid="tile-add-trace-${a.tileId}"]`
          ) as HTMLSelectElement;
          sel.value = a.traceId;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (!a.visible && member) {
          (
            document.querySelector(
              `[data-testid="tile-trace-x-${a.tileId}-${a.traceId}"]`
            ) as HTMLButtonElement
          ).click();
        }
      },
      { traceId, visible, tileId }
    );
  }

  /** A tile's "+" add-trace picker: the trace ids currently OFFERED (the
   * blank "＋" placeholder option excluded) — issue #28 second-pass review
   * finding #9's domain filter (spectrum → fd, scope → td, sweep → sweep,
   * a domain-less trace listed everywhere). */
  async addTraceOptions(tileId = "tile-1"): Promise<string[]> {
    return this.drv.eval(
      (a: { tileId: string }) => {
        const sel = document.querySelector(
          `[data-testid="tile-add-trace-${a.tileId}"]`
        ) as HTMLSelectElement | null;
        if (!sel) return [];
        return Array.from(sel.options)
          .map((o) => o.value)
          .filter((v) => v !== "");
      },
      { tileId }
    );
  }

  /** Set a tile's display unit (fd or td — the same per-tile selector). */
  async setTileUnit(unit: string, tileId = "tile-1"): Promise<void> {
    await this.setSelect(`tile-unit-${tileId}`, unit);
  }

  /** Set the grid layout preset (1, 1x2, 2x1, 1x3, 2x2, 2x3). */
  async setLayoutPattern(pattern: string): Promise<void> {
    await this.setSelect("layout-pattern", pattern);
  }

  /** Switch a tile's graph kind (spectrum ⇄ scope ⇄ sweep). */
  async setTileKind(
    kind: "spectrum" | "scope" | "sweep",
    tileId = "tile-1"
  ): Promise<void> {
    await this.setSelect(`tile-kind-${tileId}`, kind);
  }

  /** The visible tile ids, in grid order (top-left first). */
  async tileOrder(): Promise<string[]> {
    return this.drv.eval(
      () =>
        Array.from(
          document.querySelectorAll('[data-testid="graph-grid"] > .tile')
        ).map((n) =>
          ((n as HTMLElement).getAttribute("data-testid") ?? "").replace(/^tile-/, "")
        ),
      undefined as void
    );
  }

  /** A tile's measure-chip readouts, as {key: text}. */
  async tileChips(tileId = "tile-1"): Promise<Record<string, string>> {
    return this.drv.eval(
      (a: { tileId: string }) => {
        const out: Record<string, string> = {};
        for (const chip of Array.from(
          document.querySelectorAll(
            `[data-testid="tile-chips-${a.tileId}"] .tile__chip`
          )
        )) {
          const key = (chip as HTMLElement).dataset.key ?? "";
          out[key] =
            chip.querySelector(".tile__chip-value")?.textContent ?? "";
        }
        return out;
      },
      { tileId }
    );
  }

  /** A tile chip's tooltip (title attribute) — carries the sliding-window
   * stats line for the scope measurement suite (issue #26 lot B). */
  async tileChipTitle(tileId: string, key: string): Promise<string> {
    return this.drv.eval(
      (a: { tileId: string; key: string }) =>
        (
          document.querySelector(
            `[data-testid="tile-chip-${a.tileId}-${a.key}"]`
          ) as HTMLElement | null
        )?.title ?? "",
      { tileId, key }
    );
  }

  /** Drag one tile onto another by the handle (pointer-event sequence —
   * the app reorders on pointerdown → move → up, not HTML5 DnD, which the
   * Tauri macOS webview swallows). */
  async dragTile(fromTileId: string, toTileId: string): Promise<void> {
    await this.drv.eval(
      (a: { from: string; to: string }) => {
        const handle = document.querySelector(
          `[data-testid="tile-handle-${a.from}"]`
        ) as HTMLElement;
        const target = document.querySelector(
          `[data-testid="tile-${a.to}"]`
        ) as HTMLElement;
        const hr = handle.getBoundingClientRect();
        const tr = target.getBoundingClientRect();
        const at = (x: number, y: number): PointerEventInit => ({
          bubbles: true,
          pointerId: 1,
          button: 0,
          clientX: x,
          clientY: y,
        });
        handle.dispatchEvent(
          new PointerEvent("pointerdown", at(hr.x + 2, hr.y + 2))
        );
        handle.dispatchEvent(
          new PointerEvent(
            "pointermove",
            at(tr.x + tr.width / 2, tr.y + tr.height / 2)
          )
        );
        handle.dispatchEvent(
          new PointerEvent(
            "pointerup",
            at(tr.x + tr.width / 2, tr.y + tr.height / 2)
          )
        );
      },
      { from: fromTileId, to: toTileId }
    );
  }

  /** Click a tile's legend chip (toggles whether that curve is drawn). */
  async toggleLegend(traceId: string, tileId = "tile-1"): Promise<void> {
    await this.drv.click(`[data-testid="tile-trace-${tileId}-${traceId}"]`);
  }

  /** Whether a legend chip is in its hidden (struck-through) state. */
  async legendOff(traceId: string, tileId = "tile-1"): Promise<boolean> {
    return this.drv.eval(
      (a: { sel: string }) =>
        document
          .querySelector(a.sel)
          ?.classList.contains("tile__trace--off") === true,
      { sel: `[data-testid="tile-trace-${tileId}-${traceId}"]` }
    );
  }

  /** The scope view-model of a tile (display-unit samples), summarized. */
  async scopeSeries(
    tileId?: string
  ): Promise<{ label: string; unit: string; peak: number }[]> {
    return this.drv.eval(
      (a: { tileId?: string }) => {
        const dbg = (
          window as unknown as {
            qa40xV2Debug: {
              scopeVM(id?: string): {
                unitLabel: string;
                series: { label: string; samples: Float64Array }[];
              };
            };
          }
        ).qa40xV2Debug;
        const vm = dbg.scopeVM(a.tileId);
        return vm.series.map((s) => {
          let peak = 0;
          for (const v of s.samples) peak = Math.max(peak, Math.abs(v));
          return { label: s.label, unit: vm.unitLabel, peak };
        });
      },
      { tileId }
    );
  }

  /** Raw display-unit samples of a tile's first scope series (the trigger
   * source's own picture) — for edge-alignment and held-frame assertions. */
  async scopeSamples(tileId?: string): Promise<number[]> {
    return this.drv.eval(
      (a: { tileId?: string }) => {
        const dbg = (
          window as unknown as {
            qa40xV2Debug: {
              scopeVM(id?: string): {
                series: { samples: Float64Array }[];
              };
            };
          }
        ).qa40xV2Debug;
        const s = dbg.scopeVM(a.tileId).series[0];
        return s ? Array.from(s.samples) : [];
      },
      { tileId }
    );
  }

  /** The scope trigger overlay of a tile's view-model (Lot A, issue #26) —
   * `null` when the tile's resolved trigger is off or nothing has latched
   * yet, the same shape `scopeVM().trigger` returns. */
  async scopeTrigger(tileId?: string): Promise<{
    sourceId: string;
    state: string;
    frac: number;
    levelDisplay: number;
    position: number;
    held: boolean;
  } | null> {
    return this.drv.eval(
      (a: { tileId?: string }) => {
        const dbg = (
          window as unknown as {
            qa40xV2Debug: {
              scopeVM(id?: string): {
                trigger: {
                  sourceId: string;
                  state: string;
                  frac: number;
                  levelDisplay: number;
                  position: number;
                  held: boolean;
                } | null;
              };
            };
          }
        ).qa40xV2Debug;
        return dbg.scopeVM(a.tileId).trigger;
      },
      { tileId }
    );
  }

  /** Set a scope tile's trigger controls via the ⚙ Trigger tab (same
   * gesture the Axis-tab tests use elsewhere in this adapter) — pass only
   * the fields to change, the rest are left as-is. Mode/edge/level/hyst
   * land on the tile's CURRENTLY resolved endpoint (per-endpoint, plan
   * §3.2); source/position/markers land on the tile itself. */
  async setTileTrigger(
    tileId: string,
    opts: {
      source?: "auto" | string;
      mode?: "off" | "auto" | "normal" | "single";
      edge?: "rising" | "falling";
      levelV?: number;
      hystV?: number | null;
      positionPct?: number;
      markers?: boolean;
    }
  ): Promise<void> {
    await this.drv.click(`[data-testid="tile-gear-${tileId}"]`);
    await this.drv.click('[data-testid="gear-tab-trigger"]');
    if (opts.source !== undefined) await this.setSelect("gear-trigger-source", opts.source);
    if (opts.mode !== undefined) await this.setSelect("gear-trigger-mode", opts.mode);
    if (opts.edge !== undefined) await this.setSelect("gear-trigger-edge", opts.edge);
    if (opts.levelV !== undefined) await this.setNumber("gear-trigger-level", opts.levelV);
    if (opts.hystV !== undefined) {
      await this.drv.eval(
        (a: { value: number | null }) => {
          const input = document.querySelector(
            '[data-testid="gear-trigger-hyst"]'
          ) as HTMLInputElement;
          input.value = a.value === null ? "" : String(a.value);
          input.dispatchEvent(new Event("change", { bubbles: true }));
        },
        { value: opts.hystV }
      );
    }
    if (opts.positionPct !== undefined) await this.setNumber("gear-trigger-position", opts.positionPct);
    if (opts.markers !== undefined) {
      await this.drv.eval(
        (a: { want: boolean }) => {
          const box = document.querySelector(
            '[data-testid="gear-trigger-markers"]'
          ) as HTMLInputElement;
          if (box.checked !== a.want) box.click();
        },
        { want: opts.markers }
      );
    }
    await this.closeDialog();
  }

  /** The tile-header trigger chip's text (`T off` / `T ▲ AUTO` / ...). */
  async triggerChip(tileId: string): Promise<string | null> {
    return this.drv.text(`[data-testid="tile-trigger-${tileId}"]`);
  }

  /** Left-click the trigger chip (toggles its quick menu). */
  async clickTriggerChip(tileId: string): Promise<void> {
    await this.drv.click(`[data-testid="tile-trigger-${tileId}"]`);
  }

  /** Whether the chip's quick trigger menu is open. */
  async triggerMenuOpen(tileId: string): Promise<boolean> {
    return this.drv.eval(
      (a: { sel: string }) => {
        const menu = document.querySelector(a.sel) as HTMLElement | null;
        return menu !== null && !menu.hidden;
      },
      { sel: `[data-testid="tile-trigmenu-${tileId}"]` }
    );
  }

  /** Click a quick-menu item: `mode-auto`, `edge-falling`, `settings`, ... */
  async clickTriggerMenuItem(tileId: string, item: string): Promise<void> {
    await this.drv.click(`[data-testid="tile-trigmenu-${tileId}-${item}"]`);
  }

  /** Right-click the trigger chip — jumps straight to the ⚙ Trigger tab. */
  async contextClickTriggerChip(tileId: string): Promise<void> {
    await this.drv.eval(
      (a: { sel: string }) => {
        document
          .querySelector(a.sel)!
          .dispatchEvent(
            new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
          );
      },
      { sel: `[data-testid="tile-trigger-${tileId}"]` }
    );
  }

  /** Click a tile's Arm button (re-)arms a SINGLE shot. */
  async armTrigger(tileId: string): Promise<void> {
    await this.drv.click(`[data-testid="tile-trigger-arm-${tileId}"]`);
  }

  /** Whether the Arm button carries the armed highlight (SINGLE waiting). */
  async armHighlighted(tileId: string): Promise<boolean> {
    return this.drv.eval(
      (a: { sel: string }) =>
        document.querySelector(a.sel)?.classList.contains("btn--primary") ===
        true,
      { sel: `[data-testid="tile-trigger-arm-${tileId}"]` }
    );
  }

  /** Client-px bounding box of a scope tile's chart canvas — the coordinate
   * space `dragOnScopeCanvas` and the trigger/marker hit zones live in. */
  async chartCanvasRect(
    tileId: string
  ): Promise<{ x: number; y: number; width: number; height: number }> {
    return this.drv.eval(
      (a: { tileId: string }) => {
        const el = document.querySelector(
          `[data-testid="tile-chart-${a.tileId}"] canvas`
        ) as HTMLCanvasElement;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      },
      { tileId }
    );
  }

  /**
   * Drive a real pointer-gesture (down at the first point, move through the
   * rest, up at the last) directly on a scope tile's chart canvas — the same
   * synthetic-PointerEvent approach `dragTile` uses (the ScopeChart's own
   * `pointerdown`/`pointermove`/`pointerup` listeners, `setPointerCapture`
   * wrapped in a try/catch for exactly this reason, see tile.ts's drag
   * handle). Exercises the SAME onPointerDown hit-test → onPointerMove →
   * onPointerUp(done=true) path a mouse drag takes — trigger level/position
   * handles and A/B time markers all live on this one canvas and share this
   * gesture shape.
   */
  async dragOnScopeCanvas(
    tileId: string,
    points: { x: number; y: number }[]
  ): Promise<void> {
    await this.drv.eval(
      (a: { tileId: string; points: { x: number; y: number }[] }) => {
        const el = document.querySelector(
          `[data-testid="tile-chart-${a.tileId}"] canvas`
        ) as HTMLElement;
        const at = (x: number, y: number): PointerEventInit => ({
          bubbles: true,
          pointerId: 1,
          button: 0,
          clientX: x,
          clientY: y,
        });
        const [first, ...rest] = a.points;
        el.dispatchEvent(new PointerEvent("pointerdown", at(first.x, first.y)));
        for (const p of rest) {
          el.dispatchEvent(new PointerEvent("pointermove", at(p.x, p.y)));
        }
        const last = a.points[a.points.length - 1];
        el.dispatchEvent(new PointerEvent("pointerup", at(last.x, last.y)));
      },
      { tileId, points }
    );
  }

  /** A scope tile's A/B marker readout row ("A" or "B"), or null when that
   * marker doesn't exist — `.mk-freq` is the Δt-from-start readout, the
   * cheapest DOM-observable proof a marker moved. */
  async scopeMarkerRow(
    tileId: string,
    label: "A" | "B"
  ): Promise<{ freq: string; val: string } | null> {
    return this.drv.eval(
      (a: { tileId: string; label: string }) => {
        const rows = Array.from(
          document.querySelectorAll(`[data-testid="tile-chart-${a.tileId}"] .mk-row`)
        );
        const row = rows.find(
          (r) => r.querySelector(".mk-name")?.textContent === a.label
        );
        if (!row) return null;
        return {
          freq: row.querySelector(".mk-freq")?.textContent ?? "",
          val: row.querySelector(".mk-val")?.textContent ?? "",
        };
      },
      { tileId, label }
    );
  }

  /** The pool rows as {id, label, badges: [{tag, dim, tip}]}. */
  async poolRows(): Promise<
    { id: string; label: string; badges: { tag: string; dim: boolean; tip: string }[] }[]
  > {
    return this.drv.eval(
      // `.traces__row`, not direct children (lot E4): the rows nest under
      // per-device group wrappers; row identity is the row class itself.
      () =>
        Array.from(
          document.querySelectorAll('[data-testid="traces-list"] .traces__row')
        ).map((row) => ({
          id: (row as HTMLElement).dataset.key ?? "",
          label: row.querySelector(".traces__label")?.textContent ?? "",
          badges: Array.from(row.querySelectorAll(".traces__badge")).map((b) => ({
            tag: b.textContent ?? "",
            dim: b.classList.contains("traces__badge--dim"),
            tip: b.getAttribute("title") ?? "",
          })),
        })),
      undefined as void
    );
  }

  async clickRun(): Promise<void> {
    await this.drv.click('[data-testid="btn-run"]');
  }

  /** Wait until the spectrum view-model carries a series for `label` with
   * seq ≥ `minSeq` (i.e. a fresh frame reached the renderer feed). */
  async waitForSeries(label: string, minSeq = 1, timeoutMs = 15_000): Promise<void> {
    await this.drv.waitUntil(
      (a: { label: string; minSeq: number }) => {
        const dbg = (
          window as unknown as {
            qa40xV2Debug?: {
              spectrumVM(): { series: { label: string; seq: number }[] };
            };
          }
        ).qa40xV2Debug;
        const s = dbg?.spectrumVM().series.find((x) => x.label === a.label);
        return (s?.seq ?? 0) >= a.minSeq;
      },
      { label, minSeq },
      { timeoutMs }
    );
  }

  /** Highest seq currently in the VM (to wait for strictly-newer frames). */
  async maxSeriesSeq(): Promise<number> {
    return this.drv.eval(() => {
      const dbg = (
        window as unknown as {
          qa40xV2Debug: { spectrumVM(): { series: { seq: number }[] } };
        }
      ).qa40xV2Debug;
      return Math.max(0, ...dbg.spectrumVM().series.map((s) => s.seq));
    }, undefined as void);
  }

  /* ---- Data export seam (issue #30) ----------------------------------- */

  /** Every file the app asked the fake backend to write, decoded to text
   * (CSV assertions; a PNG decodes to gibberish but its path still tells). */
  async exportedFiles(): Promise<{ path: string; text: string }[]> {
    return this.drv.eval(
      () =>
        window.__qa40xE2E.device.exports.map((e) => ({
          path: e.path,
          text: atob(e.contentsBase64),
        })),
      undefined as void
    );
  }

  /** Every clipboard image the fake received (dimensions + payload size). */
  async copiedImages(): Promise<{ width: number; height: number; byteLength: number }[]> {
    return this.drv.eval(() => window.__qa40xE2E.device.copiedImages, undefined as void);
  }

  /** Arm the fake save dialog to answer "cancelled" (null path). */
  async cancelNextSaveDialog(on = true): Promise<void> {
    await this.drv.eval(
      (v: boolean) => {
        window.__qa40xE2E.device.cancelSaveDialog = v;
      },
      on
    );
  }

  /* ---- M4: programs / transform locks -------------------------------- */

  /** Arm the fake's program gate: the next measurement program stays in
   * flight until releasePrograms(), so the locked UI can be observed. */
  async holdPrograms(): Promise<void> {
    await this.drv.eval(() => window.__qa40xE2E.device.holdPrograms(), undefined as void);
  }

  async releasePrograms(): Promise<void> {
    await this.drv.eval(() => window.__qa40xE2E.device.releasePrograms(), undefined as void);
  }

  /** Add a program via the panel's "+" menu; closes the auto-opened config
   * dialog and returns the new program id. */
  async addProgram(kind: "thd" | "fr" | "wowflutter" | "script"): Promise<string> {
    await this.drv.click('[data-testid="btn-add-program"]');
    await this.drv.click(`[data-testid="add-prog-${kind}"]`);
    await this.closeDialog();
    return this.drv.eval(() => {
      const dbg = (
        window as unknown as {
          qa40xV2Debug: { state(): { programs: { order: string[] } } };
        }
      ).qa40xV2Debug;
      const order = dbg.state().programs.order;
      return order[order.length - 1];
    }, undefined as void);
  }

  /** Whether the dialog row containing a field (by its data-testid) is
   * hidden — the sweep dialog toggles rows with `.u-hidden` depending on
   * measurement/axis (issue #27's frequency-axis vs level-axis fields). */
  async dialogRowHidden(fieldTestid: string): Promise<boolean> {
    return this.drv.eval(
      (a: { fieldTestid: string }) => {
        const field = document.querySelector(`[data-testid="${a.fieldTestid}"]`);
        return field?.closest(".dialog__row")?.classList.contains("u-hidden") ?? true;
      },
      { fieldTestid }
    );
  }

  /** Close any open dialog (Escape — the dialogs all listen for it). */
  async closeDialog(): Promise<void> {
    await this.drv.eval(
      () =>
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
        ),
      undefined as void
    );
  }

  async playProgram(id: string): Promise<void> {
    await this.drv.click(`[data-testid="prog-play-${id}"]`);
  }

  /** A program's run state from the store ("idle" | "running"). */
  async programRun(id: string): Promise<string> {
    return this.drv.eval(
      (a: { id: string }) => {
        const dbg = (
          window as unknown as {
            qa40xV2Debug: {
              state(): { programs: { byId: Record<string, { run: string }> } };
            };
          }
        ).qa40xV2Debug;
        return dbg.state().programs.byId[a.id]?.run ?? "gone";
      },
      { id }
    );
  }

  /** The sources panel's program-lock note text, or null when hidden. */
  async sourcesLockNote(): Promise<string | null> {
    return this.drv.eval(() => {
      const n = document.querySelector<HTMLElement>('[data-testid="sources-lock"]');
      return n && !n.hidden ? n.textContent : null;
    }, undefined as void);
  }

  /** A source-row play button's disabled state + tooltip. */
  async playButtonState(id: string): Promise<{ disabled: boolean; title: string }> {
    return this.drv.eval(
      (a: { id: string }) => {
        const b = document.querySelector<HTMLButtonElement>(
          `[data-testid="src-play-${a.id}"]`
        );
        return { disabled: b?.disabled === true, title: b?.title ?? "" };
      },
      { id }
    );
  }

  /** The global Run button's disabled state + tooltip. */
  async runButtonState(): Promise<{ disabled: boolean; title: string }> {
    return this.drv.eval(() => {
      const b = document.querySelector<HTMLButtonElement>('[data-testid="btn-run"]');
      return { disabled: b?.disabled === true, title: b?.title ?? "" };
    }, undefined as void);
  }

  /** Whether a source's playing intent is set (survives a program run). */
  async sourcePlaying(id: string): Promise<boolean> {
    return this.drv.eval(
      (a: { id: string }) => {
        const dbg = (
          window as unknown as {
            qa40xV2Debug: {
              state(): { sources: { byId: Record<string, { playing: boolean }> } };
            };
          }
        ).qa40xV2Debug;
        return dbg.state().sources.byId[a.id]?.playing === true;
      },
      { id }
    );
  }

  /** A trace's current display label (e.g. the sweep program's auto-label). */
  async traceLabel(id: string): Promise<string | null> {
    return this.drv.eval(
      (a: { id: string }) => {
        const dbg = (
          window as unknown as {
            qa40xV2Debug: {
              state(): { traces: { byId: Record<string, { label: string }> } };
            };
          }
        ).qa40xV2Debug;
        return dbg.state().traces.byId[a.id]?.label ?? null;
      },
      { id }
    );
  }

  /** The domains a pool trace currently carries (td/fd/sweep). */
  async traceDomains(id: string): Promise<string[]> {
    return this.drv.eval(
      (a: { id: string }) => {
        const dbg = (
          window as unknown as {
            qa40xV2Debug: {
              state(): { traces: { byId: Record<string, { domains: string[] }> } };
            };
          }
        ).qa40xV2Debug;
        return dbg.state().traces.byId[a.id]?.domains ?? [];
      },
      { id }
    );
  }

  /** The sweep view-model of a tile, summarized (label + point count + the
   * x-axis unit — "Hz" for a frequency sweep, "dBFS" for a THD-vs-level
   * sweep, issue #27 — and its first/last x values). */
  async sweepSeries(
    tileId?: string
  ): Promise<
    { label: string; points: number; unit: string; xUnit: string; xFirst: number; xLast: number }[]
  > {
    return this.drv.eval(
      (a: { tileId?: string }) => {
        const dbg = (
          window as unknown as {
            qa40xV2Debug: {
              sweepVM(id?: string): {
                unitLabel: string;
                xUnit: string;
                series: { label: string; x: Float64Array }[];
              };
            };
          }
        ).qa40xV2Debug;
        const vm = dbg.sweepVM(a.tileId);
        return vm.series.map((s) => ({
          label: s.label,
          points: s.x.length,
          unit: vm.unitLabel,
          xUnit: vm.xUnit,
          xFirst: s.x[0],
          xLast: s.x[s.x.length - 1],
        }));
      },
      { tileId }
    );
  }

  /**
   * The peak (max) displayed level of a series within ±spanHz of centerHz —
   * read from the VM the renderer is fed, so values are in the tile's
   * CURRENT display unit. Band peak, not point sample: the app bin-snaps
   * tones, so the nominal frequency lands on the line's skirt.
   */
  async curvePeakDb(
    label: string,
    centerHz: number,
    spanHz = 50
  ): Promise<number | null> {
    return this.drv.eval(
      (a: { label: string; lo: number; hi: number }) => {
        const dbg = (
          window as unknown as {
            qa40xV2Debug: {
              spectrumVM(): {
                series: { label: string; x: Float64Array; y: Float64Array }[];
              };
            };
          }
        ).qa40xV2Debug;
        const s = dbg.spectrumVM().series.find((x) => x.label === a.label);
        if (!s) return null;
        let best: number | null = null;
        for (let i = 0; i < s.x.length; i++) {
          const f = s.x[i];
          if (f < a.lo || f > a.hi) continue;
          const v = s.y[i];
          if (best === null || v > best) best = v;
        }
        return best;
      },
      { label, lo: centerHz - spanHz, hi: centerHz + spanHz }
    );
  }

  /* ---- M5: workspace persistence -------------------------------------- */

  /**
   * Reboot into a localStorage-era state: the workspace IndexedDB is
   * deleted and `seeds` land in localStorage BEFORE any app script runs —
   * so the first-boot import (issue #44 lot 1) sees exactly these blobs,
   * deterministically (the fixture's initial boot may already have
   * auto-saved a current doc to IndexedDB; a seed-after-boot approach
   * would race that).
   */
  async bootLocalStorageEra(seeds: Record<string, string>): Promise<void> {
    await this.drv.addInitScript(
      (s: Record<string, string>) => {
        try {
          indexedDB.deleteDatabase("qa40x-v2");
        } catch {
          /* no IDB — nothing to clear */
        }
        for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
      },
      seeds
    );
    await this.boot();
  }

  /** Seed a raw localStorage blob (e.g. a legacy v4 save). */
  async putLocalStorage(key: string, value: string): Promise<void> {
    await this.drv.eval(
      (a: { key: string; value: string }) => localStorage.setItem(a.key, a.value),
      { key, value }
    );
  }

  async getLocalStorage(key: string): Promise<string | null> {
    return this.drv.eval(
      (a: { key: string }) => localStorage.getItem(a.key),
      { key }
    );
  }

  /** Name the workspace and Save it (the bar's explicit named save), then
   * wait for the outcome toast — the write is async (issue #44 lot 1). */
  async saveWorkspaceAs(name: string): Promise<void> {
    await this.drv.eval(
      (a: { name: string }) => {
        const input = document.querySelector<HTMLInputElement>(
          '[data-testid="ws-name"]'
        )!;
        input.value = a.name;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      },
      { name }
    );
    const maxToastId = await this.drv.eval(() => {
      const dbg = (
        window as unknown as {
          qa40xV2Debug: { state(): { ui: { toasts: { id: number }[] } } };
        }
      ).qa40xV2Debug;
      return Math.max(0, ...dbg.state().ui.toasts.map((t) => t.id));
    }, undefined as void);
    await this.drv.click('[data-testid="ws-save"]');
    await this.drv.waitUntil(
      (a: { maxToastId: number }) => {
        const dbg = (
          window as unknown as {
            qa40xV2Debug: {
              state(): { ui: { toasts: { id: number; message: string }[] } };
            };
          }
        ).qa40xV2Debug;
        return dbg
          .state()
          .ui.toasts.some((t) => t.id > a.maxToastId && / saved\.|failed/.test(t.message));
      },
      { maxToastId }
    );
  }

  /** Load from the ▾ menu: a template, a v2 save, or a legacy (v1) save.
   * Waits for the outcome toast — loading goes through the async storage
   * seam (issue #44 lot 1), so the click alone doesn't mean applied. */
  async loadWorkspace(
    name: string,
    from: "template" | "saved" | "legacy"
  ): Promise<void> {
    const maxToastId = await this.drv.eval(() => {
      const dbg = (
        window as unknown as {
          qa40xV2Debug: { state(): { ui: { toasts: { id: number }[] } } };
        }
      ).qa40xV2Debug;
      return Math.max(0, ...dbg.state().ui.toasts.map((t) => t.id));
    }, undefined as void);
    await this.drv.click('[data-testid="ws-load"]');
    const prefix = from === "template" ? "ws-tpl" : from === "saved" ? "ws-saved" : "ws-legacy";
    await this.drv.click(`[data-testid="${prefix}-${name}"]`);
    await this.drv.waitUntil(
      (a: { maxToastId: number }) => {
        const dbg = (
          window as unknown as {
            qa40xV2Debug: {
              state(): { ui: { toasts: { id: number; message: string }[] } };
            };
          }
        ).qa40xV2Debug;
        return dbg
          .state()
          .ui.toasts.some(
            (t) => t.id > a.maxToastId && /loaded\.|Could not load/.test(t.message)
          );
      },
      { maxToastId }
    );
  }

  /** The Load ▾ menu's item labels per section, then close the menu. The
   * menu populates asynchronously (saved names list from IndexedDB) and is
   * revealed once complete — wait for that before reading. */
  async workspaceMenu(): Promise<{ templates: string[]; saved: string[]; legacy: string[] }> {
    await this.drv.click('[data-testid="ws-load"]');
    await this.drv.waitUntil(
      () =>
        document.querySelector<HTMLElement>('[data-testid="ws-menu"]')?.hidden === false,
      undefined as void
    );
    const out = await this.drv.eval(() => {
      const items = (sel: string): string[] =>
        Array.from(
          document.querySelectorAll<HTMLElement>(`[data-testid^="${sel}"]`)
        ).map((b) => b.textContent ?? "");
      return {
        templates: items("ws-tpl-"),
        saved: items("ws-saved-"),
        legacy: items("ws-legacy-"),
      };
    }, undefined as void);
    await this.closeMenus();
    return out;
  }

  /** Click anywhere neutral to dismiss open dropdown menus. */
  async closeMenus(): Promise<void> {
    await this.drv.eval(() => document.body.click(), undefined as void);
  }

  /**
   * Everything the user can SEE of the bench, as one comparable digest —
   * read from the store the panels render from (name, layout + per-tile
   * config, sources with params, programs, pool trace ids/labels).
   */
  async workspaceDigest(): Promise<unknown> {
    return this.drv.eval(() => {
      const dbg = (
        window as unknown as {
          qa40xV2Debug: {
            state(): {
              workspace: unknown;
              layout: { pattern: string; order: string[]; tiles: Record<string, unknown> };
              sources: { order: string[]; byId: Record<string, unknown> };
              programs: { order: string[]; byId: Record<string, unknown> };
              traces: {
                order: string[];
                byId: Record<string, { label: string; source: unknown }>;
              };
            };
          };
        }
      ).qa40xV2Debug;
      const s = dbg.state();
      return {
        workspace: s.workspace,
        layout: {
          pattern: s.layout.pattern,
          order: s.layout.order,
          tiles: s.layout.tiles,
        },
        sources: s.sources,
        programs: s.programs,
        traces: s.traces.order.map((id) => ({
          id,
          label: s.traces.byId[id]?.label,
          source: s.traces.byId[id]?.source,
        })),
      };
    }, undefined as void);
  }

  /** Wait until the debounced auto-save wrote a current-workspace record
   * whose name matches (so a reload will restore it). Reads through the
   * app's own storage seam (IndexedDB since issue #44 lot 1) via the
   * debug hook — an async probe, so this polls rather than waitUntil. */
  async waitForAutoSave(name: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = await this.drv.eval(
        () =>
          (
            window as unknown as {
              qa40xV2Debug: { wsCurrentName(): Promise<string | null> };
            }
          ).qa40xV2Debug.wsCurrentName(),
        undefined as void
      );
      if (current === name) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `auto-save of "${name}" did not land within ${timeoutMs} ms (current: ${current})`
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Toggle a sidebar section's collapse chevron. */
  async toggleCollapse(key: "sources" | "traces" | "programs"): Promise<void> {
    await this.drv.click(`[data-testid="collapse-${key}"]`);
  }

  async panelCollapsed(key: "sources" | "traces" | "programs"): Promise<boolean> {
    return this.drv.eval(
      (a: { key: string }) =>
        document
          .querySelector(`[data-testid="${a.key}-panel"]`)
          ?.classList.contains("is-collapsed") === true,
      { key }
    );
  }

  /** Press the global Space transport (on the page body, no control focused). */
  async pressSpace(): Promise<void> {
    await this.drv.eval(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { code: "Space", bubbles: true, cancelable: true })
      );
    }, undefined as void);
  }
}

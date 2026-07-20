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

  async identity(): Promise<string | null> {
    return this.drv.text('[data-testid="device-identity"]');
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

  /** The pool rows as {id, label, badges: [{tag, dim, tip}]}. */
  async poolRows(): Promise<
    { id: string; label: string; badges: { tag: string; dim: boolean; tip: string }[] }[]
  > {
    return this.drv.eval(
      () =>
        Array.from(
          document.querySelectorAll('[data-testid="traces-list"] > *')
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
  async addProgram(kind: "thd" | "fr" | "script"): Promise<string> {
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

  /** The sweep view-model of a tile, summarized (label + point count). */
  async sweepSeries(
    tileId?: string
  ): Promise<{ label: string; points: number; unit: string }[]> {
    return this.drv.eval(
      (a: { tileId?: string }) => {
        const dbg = (
          window as unknown as {
            qa40xV2Debug: {
              sweepVM(id?: string): {
                unitLabel: string;
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

  /** Name the workspace and Save it (the bar's explicit named save). */
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
    await this.drv.click('[data-testid="ws-save"]');
  }

  /** Load from the ▾ menu: a template, a v2 save, or a legacy (v1) save. */
  async loadWorkspace(
    name: string,
    from: "template" | "saved" | "legacy"
  ): Promise<void> {
    await this.drv.click('[data-testid="ws-load"]');
    const prefix = from === "template" ? "ws-tpl" : from === "saved" ? "ws-saved" : "ws-legacy";
    await this.drv.click(`[data-testid="${prefix}-${name}"]`);
  }

  /** The Load ▾ menu's item labels per section, then close the menu. */
  async workspaceMenu(): Promise<{ templates: string[]; saved: string[]; legacy: string[] }> {
    await this.drv.click('[data-testid="ws-load"]');
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

  /** Wait until the debounced auto-save wrote a current-workspace blob
   * whose name matches (so a reload will restore it). */
  async waitForAutoSave(name: string, timeoutMs = 5_000): Promise<void> {
    await this.drv.waitUntil(
      (a: { name: string }) => {
        const raw = localStorage.getItem("qa40x-v2-ws-current");
        if (!raw) return false;
        try {
          return (JSON.parse(raw) as { name?: string }).name === a.name;
        } catch {
          return false;
        }
      },
      { name },
      { timeoutMs }
    );
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

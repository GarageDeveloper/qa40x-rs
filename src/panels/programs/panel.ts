/**
 * Measurement Programs panel (M4, v1 Phase H parity). Programs — sweeps and
 * scripts that DRIVE the instrument — live apart from the signal sources
 * because they obey the one REAL hardware constraint: an exclusive device
 * session, one at a time. Starting one suspends the stream (sources keep
 * their playing intent, data stays on screen) and finishing auto-resumes
 * it; while one runs, every other transport is disabled with the reason.
 */
import "./panel.css";
import type { Store } from "../../store/store";
import type { AppState, ProgramMeta } from "../../store/state";
import type { Ipc } from "../../ipc/ipc";
import {
  addProgram,
  programLockReason,
  programProgressText,
  removeProgram,
  runProgram,
  stopProgram,
} from "../../store/actions/programs";
import { freezeTrace, setTraceColor } from "../../store/actions/traces";
import { el, keyedList } from "../../ui/dom";
import { collapsiblePanel } from "../../ui/collapse";
import { openSweepDialog } from "./sweepdialog";
import { openProgramScriptDialog } from "./scriptdialog";

interface RowVM {
  prog: ProgramMeta;
  label: string;
  color: string;
  hasData: boolean;
  /** Why this row's Play is locked (another program runs), or null. */
  lock: string | null;
}

const ADD_PROGRAMS: { kind: "thd" | "fr" | "wowflutter" | "script"; label: string }[] = [
  { kind: "thd", label: "Sweep (THD vs freq/level)" },
  { kind: "fr", label: "Frequency Response" },
  { kind: "wowflutter", label: "Wow & Flutter" },
  { kind: "script", label: "Script (measure / plot)" },
];

function typeLabel(p: ProgramMeta): string {
  if (p.kind === "script") {
    return p.role === "measurement" ? "Script · measure" : "Script · plot";
  }
  if (p.params.measurement === "fr") return "Freq response";
  if (p.params.measurement === "wowflutter") return "Wow & flutter";
  return p.params.axis === "level" ? "THD vs level" : "THD vs freq";
}

/** Cents of a Hz offset around a reference tone (100 ¢ = one semitone) — a
 * musician-legible complement to the raw Hz static-offset reading. `null`
 * when the ratio isn't meaningful (never `-Infinity`). */
function centsOffset(offsetHz: number, referenceHz: number): number | null {
  if (referenceHz <= 0) return null;
  const ratio = 1 + offsetHz / referenceHz;
  if (!(ratio > 0)) return null;
  return 1200 * Math.log2(ratio);
}

function fmtSigned(v: number, digits: number, unit: string): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)} ${unit}`;
}

/**
 * A program's scalar-readout line: "—" for anything that isn't a wow &
 * flutter program (thd/fr/script), else "not run yet" before its first
 * successful run, then weighted/unweighted %, peak %, and the static
 * frequency offset (Hz + cents, against the backend's ACTUALLY-used
 * reference frequency, surfaced with an "@ N Hz" note when the backend's
 * Nyquist clamp moved it away from what was asked — issue #28 second pass,
 * review points 4/9).
 *
 * ALWAYS called for every program row (see `build()`/`update()`) — the
 * line itself is unconditionally present on every card, never created or
 * destroyed based on `measurement`. Two real bugs came from the earlier
 * "only build this DOM node for a wowflutter program" approach (issue #28
 * second-pass review finding #1): (A) `configureSweepProgram` can convert a
 * program's `measurement` from "thd" to "wowflutter" via the gear dialog
 * AFTER the row already exists — `keyedList` (keyed on the program id)
 * only calls `create()` once per id, so a converted program's scalars had
 * no DOM slot to land in, ever; (B) two workspaces loaded back to back can
 * reuse the same `prog-N` id across a kind change, leaving a stale
 * conditionally-built node (or a missing one) behind. A row's `measurement`
 * is READ FRESH from `prog` on every call here — there is nothing left to
 * go stale.
 */
export function wowSummary(prog: ProgramMeta): string {
  if (prog.kind !== "sweep" || prog.params.measurement !== "wowflutter") return "—";
  const r = prog.wowResult;
  if (!r) return "not run yet";
  const cents = centsOffset(r.staticOffsetHz, r.referenceFreqUsed);
  const offset =
    cents === null
      ? fmtSigned(r.staticOffsetHz, 2, "Hz")
      : `${fmtSigned(r.staticOffsetHz, 2, "Hz")} (${fmtSigned(cents, 1, "¢")})`;
  // The backend clamps reference_freq to [20, 0.9·Nyquist] — surface it
  // when it actually moved (review finding #4), rather than silently
  // reporting scalars measured at a DIFFERENT tone than the one asked for.
  const usedNote =
    Math.abs(r.referenceFreqUsed - prog.params.wowReferenceHz) > 0.5
      ? ` @ ${r.referenceFreqUsed.toFixed(0)} Hz`
      : "";
  return (
    `weighted ${r.weightedPercent.toFixed(3)}% (DIN approx.) · ` +
    `unweighted ${r.unweightedPercent.toFixed(3)}% · ` +
    `peak ${r.peakPercent.toFixed(3)}%${usedNote} · offset ${offset}`
  );
}

function openDialogFor(
  store: Store<AppState>,
  ipc: Ipc,
  prog: ProgramMeta
): void {
  if (prog.kind === "script") openProgramScriptDialog(store, ipc, prog.id);
  else openSweepDialog(store, ipc, prog.id);
}

export function mountProgramsPanel(
  host: HTMLElement,
  store: Store<AppState>,
  ipc: Ipc
): void {
  const list = el("div.programs__list", { "data-testid": "programs-list" });

  const menu = el("div.programs__menu", { "data-testid": "add-program-menu" });
  menu.hidden = true;
  for (const item of ADD_PROGRAMS) {
    menu.append(
      el(
        "button.programs__menu-item",
        {
          type: "button",
          "data-testid": `add-prog-${item.kind}`,
          onclick: () => {
            const id = addProgram(store, item.kind);
            menu.hidden = true;
            const prog = store.get().programs.byId[id];
            if (prog) openDialogFor(store, ipc, prog);
          },
        },
        item.label
      )
    );
  }
  const addBtn = el(
    "button.btn.btn--small",
    {
      type: "button",
      "data-testid": "btn-add-program",
      title: "Add a measurement program (sweep or script)",
      onclick: (e: Event) => {
        e.stopPropagation();
        const willOpen = menu.hidden;
        menu.hidden = !willOpen;
        if (willOpen) {
          document.addEventListener("click", () => (menu.hidden = true), {
            once: true,
            capture: true,
          });
        }
      },
    },
    "+"
  );

  const head = el(
    "div.programs__head",
    {},
    el("h2.sidebar__title", {}, "Programs"),
    el(
      "span.programs__note",
      {
        title:
          "A program owns the device for its run; the stream pauses and auto-resumes after",
      },
      "exclusive · one at a time"
    ),
    el("div.programs__addwrap", {}, addBtn, menu)
  );
  const section = el(
    "section.programs",
    { "data-testid": "programs-panel" },
    head,
    list
  );
  host.append(section);
  collapsiblePanel(store, section, head, "programs");

  const build = (vm: RowVM): HTMLElement => {
    const id = vm.prog.id;
    const play = el("button.btn.btn--small", {
      "data-testid": `prog-play-${id}`,
      onclick: () => {
        const p = store.get().programs.byId[id];
        if (!p) return;
        if (p.run === "running") stopProgram(store, ipc, id);
        else void runProgram(store, ipc, id);
      },
    });
    const gear = el(
      "button.btn.btn--small",
      {
        "data-testid": `prog-gear-${id}`,
        onclick: () => {
          const p = store.get().programs.byId[id];
          if (p) openDialogFor(store, ipc, p);
        },
      },
      "⚙"
    );
    const freeze = el(
      "button.btn.btn--small",
      {
        "data-testid": `prog-freeze-${id}`,
        title: "Freeze a named reference from this result",
        onclick: () => freezeTrace(store, id),
      },
      "❄"
    );
    const remove = el(
      "button.btn.btn--small",
      {
        "data-testid": `prog-remove-${id}`,
        title: "Remove this program",
        onclick: () => removeProgram(store, ipc, id),
      },
      "✕"
    );
    // Same color-picker dot as the Traces pool (10a): the program's trace
    // shares its id, so setTraceColor recolors the plotted curve directly.
    const dot = el("input.programs__dot", {
      type: "color",
      "data-testid": `prog-color-${id}`,
      title: "Trace color — click to change",
    }) as HTMLInputElement;
    dot.addEventListener("input", () => setTraceColor(store, id, dot.value));
    // The scalar-readout line is UNCONDITIONAL — every program row gets one
    // (see `wowSummary`'s doc comment for why the old "only for a
    // wowflutter program" approach was a real bug, issue #28 second-pass
    // review finding #1). No-layout-shift too: the slot's PRESENCE never
    // changes across any state, only its text.
    return el(
      "div.programs__row",
      {},
      el(
        "div.programs__rowline",
        {},
        dot,
        el("span.programs__name"),
        el("span.programs__spacer"),
        play,
        gear,
        freeze,
        remove
      ),
      el("div.programs__type", { "data-testid": `prog-type-${id}` }),
      el("div.programs__wow", { "data-testid": `prog-wow-${id}` })
    );
  };

  const update = (node: HTMLElement, vm: RowVM): void => {
    const id = vm.prog.id;
    const running = vm.prog.run === "running";
    const dotInput = node.querySelector(".programs__dot") as HTMLInputElement;
    if (dotInput.value !== vm.color) dotInput.value = vm.color;
    node.querySelector(".programs__name")!.textContent = vm.label;

    const type = node.querySelector<HTMLElement>(`[data-testid="prog-type-${id}"]`)!;
    const sr = store.get().device.config?.sample_rate ?? 48000;
    type.textContent = running
      ? `${typeLabel(vm.prog)} · ${programProgressText(vm.prog, sr, performance.now())}`
      : typeLabel(vm.prog);

    // nowrap + ellipsis (.programs__wow, panel.css) clips the ~100-char
    // readout instead of wrapping the card to 3 lines and growing it on
    // the first ▶ (issue #28 second-pass review finding #6) — the full
    // text still reaches the user via the native title tooltip, same
    // pattern as `.programs__name`.
    const wow = node.querySelector<HTMLElement>(`[data-testid="prog-wow-${id}"]`)!;
    const summary = wowSummary(vm.prog);
    wow.textContent = summary;
    wow.title = summary;

    const play = node.querySelector<HTMLButtonElement>(`[data-testid="prog-play-${id}"]`)!;
    play.textContent = running ? "⏹" : "▶";
    play.classList.toggle("btn--primary", running);
    play.disabled = !running && vm.lock !== null;
    play.title = running
      ? "Stop this program"
      : (vm.lock ?? "Run this program (takes the device exclusively)");

    const freeze = node.querySelector<HTMLButtonElement>(`[data-testid="prog-freeze-${id}"]`)!;
    freeze.disabled = !vm.hasData;
    freeze.title = vm.hasData
      ? "Freeze a named reference from this result"
      : "No data yet — run first";

    const remove = node.querySelector<HTMLButtonElement>(`[data-testid="prog-remove-${id}"]`)!;
    remove.disabled = running;
    remove.title = running ? "Stop the program before removing it" : "Remove this program";
  };

  let lastRows: RowVM[] = [];
  const render = (): void => {
    keyedList(list, lastRows, (vm) => vm.prog.id, { create: build, update });
    list.classList.toggle("programs__list--empty", lastRows.length === 0);
  };

  store.select(
    (s) => {
      const lock = programLockReason(s);
      return s.programs.order
        .map((pid) => s.programs.byId[pid])
        .filter((p): p is ProgramMeta => !!p)
        .map((prog): RowVM => {
          const t = s.traces.byId[prog.id];
          return {
            prog,
            label: t?.label ?? prog.id,
            color: t?.color ?? "#888888",
            hasData: (t?.domains.length ?? 0) > 0,
            lock: s.run.programLock === prog.id ? null : lock,
          };
        });
    },
    (rows) => {
      lastRows = rows;
      render();
    },
    (a, b) => JSON.stringify(a) === JSON.stringify(b)
  );

  // Tick the acquisition estimate while a program runs (the backend is
  // silent during the one-stream capture — see sweepEstimateSeconds).
  setInterval(() => {
    if (lastRows.some((vm) => vm.prog.run === "running")) render();
  }, 500);
}

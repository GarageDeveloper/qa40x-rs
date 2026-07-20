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

const ADD_PROGRAMS: { kind: "thd" | "fr" | "script"; label: string }[] = [
  { kind: "thd", label: "Sweep (THD vs freq)" },
  { kind: "fr", label: "Frequency Response" },
  { kind: "script", label: "Script (measure / plot)" },
];

function typeLabel(p: ProgramMeta): string {
  if (p.kind === "script") {
    return p.role === "measurement" ? "Script · measure" : "Script · plot";
  }
  return p.params.measurement === "fr" ? "Freq response" : "THD vs freq";
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
      el("div.programs__type", { "data-testid": `prog-type-${id}` })
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

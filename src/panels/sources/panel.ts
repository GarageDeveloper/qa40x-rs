/**
 * Signal Sources panel (M2: the full family).
 *
 * Every brick has the SAME silhouette (maintainer feedback, 2026-07-17):
 * name + routing matrix + transport on the top line, the kind-specific
 * parameters below — so a sine, a noise and a script all read the same way.
 *
 * - sources are added from a v1-style "+" menu (one click, pick a kind);
 * - routing matrix: Out L / Out R checkboxes (nothing checked = Off —
 *   maintainer-preferred over a dropdown, never regress to a select);
 * - per-source play/pause (play auto-starts the stream);
 * - the sine tone editor shows the phased sum's Σpeak / crest headroom;
 * - scripts are edited in a modal dialog with presets (inline editing in a
 *   narrow sidebar row was unusable);
 * - per-slot backend errors (bad script, unknown waveform…) land on their
 *   own row — named, never wholesale;
 * - footer: Σ-peak of the mix, the latched OUT CLIP dot and the fitted
 *   output range (all from StreamMsg.mix / OutputOnlyStatus — backend
 *   truth), plus the output-only session toggle.
 */
import "./panel.css";
import type { Store } from "../../store/store";
import { shallowEq } from "../../store/store";
import type { AppState, SourceKind, SourceMeta } from "../../store/state";
import type { Ipc } from "../../ipc/ipc";
import type { Tone } from "../../gen";
import {
  addExtraTone,
  addSource,
  KIND_LABELS,
  patchExtraTone,
  removeExtraTone,
  removeSource,
  setSourceFrequency,
  setSourceKind,
  setSourceLevel,
  setSourcePlaying,
  setSourceRoute,
  SOURCE_KINDS,
} from "../../store/actions/sources";
import { setOutputOnly } from "../../store/actions/outputonly";
import { setCoherentGen } from "../../store/actions/acquisition";
import { playedFrequencyHz } from "../../store/actions/stream";
import { programLockReason } from "../../store/actions/programs";
import { routeChecks, routeFromChecks } from "../../core/routing";
import { toneListStats } from "../../core/tonestats";
import { el, keyedList } from "../../ui/dom";
import { collapsiblePanel } from "../../ui/collapse";
import { openScriptDialog } from "./scriptdialog";

/** One row's view: the source plus its backend slot error, if any, and the
 * program-lock reason greying its transport (M4 — named, never silent). */
interface RowVM {
  src: SourceMeta;
  error: string | null;
  lock: string | null;
  /** The frequency the mixer actually plays (bin-snapped when the coherent
   * toggle is on), or null for kinds without a frequency. Computed in the
   * selector so a change of FFT size, sample rate or the toggle re-renders
   * the rows (issue #14). */
  played: number | null;
}

/** The phased tone list a sine source plays (primary tone at phase 0 + the
 * enabled extras) — the input of the headroom readout. */
function sineTones(src: SourceMeta): Tone[] {
  if (src.kind !== "sine") return [];
  const level = (dbv: number): number => Math.pow(10, dbv / 20);
  return [
    {
      enabled: true,
      frequency_hz: src.frequencyHz,
      amplitude_vrms: level(src.levelDbv),
      phase_degrees: 0,
    },
    ...src.extraTones.map((t) => ({
      enabled: t.enabled,
      frequency_hz: t.frequencyHz,
      amplitude_vrms: level(t.levelDbv),
      phase_degrees: t.phaseDeg,
    })),
  ];
}

function numberField(
  testid: string,
  unit: string,
  onChange: (value: number) => void,
  attrs: Record<string, string> = {}
): { wrap: HTMLElement; input: HTMLInputElement } {
  const input = el("input.field.sources__num", {
    type: "number",
    step: "any",
    "data-testid": testid,
    ...attrs,
    onchange: (e: Event) => onChange(Number((e.target as HTMLInputElement).value)),
  });
  const wrap = el("label.sources__f", {}, el("span.sources__u", {}, unit), input);
  return { wrap, input };
}

/** Sync an input's value unless the user is typing in it. */
function syncField(node: HTMLElement, testid: string, value: string): void {
  const input = node.querySelector<HTMLInputElement>(`[data-testid="${testid}"]`);
  if (input && document.activeElement !== input) input.value = value;
}

/** The v1-style "+" add menu: one small button, a dropdown of source kinds,
 * closed by any outside click. */
function addMenu(store: Store<AppState>, ipc: Ipc): HTMLElement {
  const menu = el("div.sources__menu", { "data-testid": "add-menu" });
  menu.hidden = true;
  for (const kind of SOURCE_KINDS) {
    menu.append(
      el(
        "button.sources__menu-item",
        {
          type: "button",
          "data-testid": `add-kind-${kind}`,
          onclick: () => {
            addSource(store, ipc, kind);
            menu.hidden = true;
          },
        },
        KIND_LABELS[kind]
      )
    );
  }
  const btn = el(
    "button.btn.btn--small",
    {
      type: "button",
      "data-testid": "btn-add-source",
      title: "Add a signal source",
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
  return el("div.sources__addwrap", {}, btn, menu);
}

export function mountSourcesPanel(
  host: HTMLElement,
  store: Store<AppState>,
  ipc: Ipc
): void {
  const list = el("div.sources__list", { "data-testid": "sources-list" });
  const lockNote = el("div.sources__lock", { "data-testid": "sources-lock" });
  lockNote.hidden = true;
  const sigma = el("span.sources__sigma", { "data-testid": "sigma-peak" }, "Σ —");
  const clipDot = el("span.sources__clip", { "data-testid": "out-clip-dot" });
  const rangeReadout = el("span.sources__range", { "data-testid": "out-range-readout" });
  const outOnly = el("input", { type: "checkbox", "data-testid": "output-only" });
  outOnly.addEventListener("change", () => setOutputOnly(store, ipc, outOnly.checked));
  const coherent = el("input", { type: "checkbox", "data-testid": "coherent-gen" });
  coherent.addEventListener("change", () => setCoherentGen(store, ipc, coherent.checked));

  const head = el(
    "div.sources__head",
    {},
    el("h2.sidebar__title", {}, "Signal Sources"),
    addMenu(store, ipc)
  );
  const section = el(
    "section.sources",
    { "data-testid": "sources-panel" },
    head,
    lockNote,
    list,
      el(
        "div.sources__footer",
        {},
        sigma,
        clipDot,
        rangeReadout,
        el("span.sources__spacer"),
        el(
          "label.sources__outonly",
          {
            title:
              "Round every periodic tone onto the FFT bin grid (the official " +
              "app's default): a coherent tone has no window-skirt leakage, " +
              "so THD+N/SNR read the true residual. Off plays the asked " +
              "frequency verbatim (~12 dB pessimistic tiles at 1 kHz/32768).",
          },
          coherent,
          "Round to bin"
        ),
        el(
          "label.sources__outonly",
          {
            title:
              "Drive the DAC gap-free from the playing sources, with no " +
              "capture (for feeding an external DUT). Analysis resumes when " +
              "unchecked.",
          },
          outOnly,
          "Output only"
        )
      )
  );
  host.append(section);
  collapsiblePanel(store, section, head, "sources");

  // Per-row expandable tone editors — persisted, so a tone list left open
  // (or closed) comes back the same way after a relaunch.
  const EXPANDED_KEY = "qa40x-v2-tones-expanded";
  const expanded = new Set<string>();
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    if (raw) for (const id of JSON.parse(raw) as string[]) expanded.add(id);
  } catch {
    /* no storage */
  }
  const saveExpanded = (): void => {
    try {
      // Only ids that still name a source: a stale entry must not pop open
      // a FUTURE source that happens to reuse the id.
      const live = [...expanded].filter((id) => store.get().sources.byId[id]);
      localStorage.setItem(EXPANDED_KEY, JSON.stringify(live));
    } catch {
      /* no storage */
    }
  };

  const buildRow = (vm: RowVM): HTMLElement => {
    const src = vm.src;
    const id = src.id;

    // ---- top line: identical silhouette for every kind -----------------
    const routeL = el("input", { type: "checkbox", "data-testid": `src-route-l-${id}` });
    const routeR = el("input", { type: "checkbox", "data-testid": `src-route-r-${id}` });
    const onRouteChange = (): void =>
      setSourceRoute(store, ipc, id, routeFromChecks(routeL.checked, routeR.checked));
    routeL.addEventListener("change", onRouteChange);
    routeR.addEventListener("change", onRouteChange);

    const play = el("button.btn.btn--small", {
      "data-testid": `src-play-${id}`,
      onclick: () =>
        setSourcePlaying(store, ipc, id, !store.get().sources.byId[id]?.playing),
    });
    const remove = el(
      "button.btn.btn--small",
      {
        "data-testid": `src-remove-${id}`,
        onclick: () => removeSource(store, ipc, id),
        "aria-label": "Remove source",
      },
      "✕"
    );

    // Waveform re-select in place (M6 gap 10d): the row title reads
    // "[Sine ▾] 1000 Hz" — the select is the kind, the span the rest of the
    // label. Script sources keep a plain title (different beast).
    let kindSel: HTMLSelectElement | null = null;
    if (src.kind !== "script") {
      kindSel = el("select.sources__kind", {
        "data-testid": `src-kind-${id}`,
        title:
          "Waveform — switch in place; level, frequency, routing and play " +
          "state are kept",
      }) as HTMLSelectElement;
      for (const k of SOURCE_KINDS) {
        if (k !== "script") kindSel.append(el("option", { value: k }, KIND_LABELS[k]));
      }
      kindSel.value = src.kind;
      kindSel.onchange = () =>
        setSourceKind(store, ipc, id, kindSel!.value as Exclude<SourceKind, "script">);
    }

    const head = el(
      "div.sources__rowline",
      {},
      ...(kindSel ? [kindSel] : []),
      el("span.sources__name"),
      el("span.sources__spacer"),
      play,
      el(
        "span.sources__route",
        { title: "Route to Out L / Out R (nothing checked = Off)" },
        el("label.sources__route-ch", {}, routeL, "L"),
        el("label.sources__route-ch", {}, routeR, "R")
      ),
      remove
    );

    // ---- params line: the kind-specific fields -------------------------
    const params: (HTMLElement | string)[] = [];
    if (src.kind !== "script" && "frequencyHz" in src) {
      params.push(
        numberField(`src-freq-${id}`, "Hz", (v) => setSourceFrequency(store, ipc, id, v), {
          min: "1",
        }).wrap,
        // The actually-played frequency (issue #14) — the ask stays the
        // user's, only the mix snaps. Always rendered so toggling the
        // rounding never shifts the layout.
        el("span.sources__snapped", { "data-testid": `src-snapped-${id}` })
      );
    }
    if (src.kind !== "script") {
      params.push(
        numberField(`src-level-${id}`, "dBV", (v) => setSourceLevel(store, ipc, id, v)).wrap
      );
    }
    if (src.kind === "sine") {
      params.push(
        el(
          "button.btn.btn--small",
          {
            "data-testid": `src-more-${id}`,
            onclick: () => {
              if (expanded.has(id)) expanded.delete(id);
              else expanded.add(id);
              saveExpanded();
              render();
            },
          },
          "Tones"
        )
      );
    }
    if (src.kind === "script") {
      params.push(
        el(
          "button.btn.btn--small",
          {
            "data-testid": `src-edit-${id}`,
            onclick: () => openScriptDialog(store, ipc, id),
          },
          "Edit…"
        )
      );
    }

    const errBadge = el("span.sources__err", { "data-testid": `src-error-${id}` });
    const row = el(
      "div.sources__row",
      {},
      head,
      el("div.sources__params", {}, ...params),
      errBadge
    );

    // ---- the sine tone editor ------------------------------------------
    if (src.kind === "sine") {
      const toneRows = el("div.sources__tones", { "data-testid": `src-tones-${id}` });
      const stats = el("span.sources__tonestats", {
        "data-testid": `src-tonestats-${id}`,
      });
      row.append(
        el(
          "div.sources__detail",
          {},
          toneRows,
          el(
            "div.sources__tones-foot",
            {},
            el(
              "button.btn.btn--small",
              {
                "data-testid": `src-tone-add-${id}`,
                onclick: () => addExtraTone(store, ipc, id),
              },
              "+ Tone"
            ),
            stats
          )
        )
      );
    }
    return row;
  };

  const updateRow = (node: HTMLElement, vm: RowVM): void => {
    const src = vm.src;
    const id = src.id;
    // With the kind select as the title's first word, the span shows the
    // label MINUS its leading kind ("Sine 1000 Hz" → "1000 Hz"); a custom
    // label that doesn't lead with the kind shows in full.
    const kindPrefix = src.kind === "script" ? "" : KIND_LABELS[src.kind];
    node.querySelector<HTMLElement>(".sources__name")!.textContent =
      kindPrefix && src.label.startsWith(kindPrefix)
        ? src.label.slice(kindPrefix.length).trim()
        : src.label;
    if ("frequencyHz" in src) syncField(node, `src-freq-${id}`, String(src.frequencyHz));
    if (src.kind !== "script") syncField(node, `src-level-${id}`, String(src.levelDbv));

    const snapped = node.querySelector<HTMLElement>(`[data-testid="src-snapped-${id}"]`);
    if (snapped && vm.played !== null && "frequencyHz" in src) {
      // Always shown, both toggle states: an appearing/disappearing hint
      // would shift the whole params line on every toggle flip.
      const moved = Math.abs(vm.played - src.frequencyHz) > 1e-9;
      snapped.textContent = `→ ${vm.played.toFixed(4)} Hz`;
      snapped.title = moved
        ? "Actually-played frequency: the tone is rounded onto the FFT bin " +
          "grid (Round to eliminate leakage)"
        : "Actually-played frequency (the ask, played verbatim)";
    }

    const checks = routeChecks(src.route);
    node.querySelector<HTMLInputElement>(`[data-testid="src-route-l-${id}"]`)!.checked =
      checks.left;
    node.querySelector<HTMLInputElement>(`[data-testid="src-route-r-${id}"]`)!.checked =
      checks.right;

    const play = node.querySelector<HTMLButtonElement>(`[data-testid="src-play-${id}"]`)!;
    // While a program holds the device, the playing intent shows as PAUSED
    // (data kept, resumes on completion) and the transport is locked with
    // the program's name — legible, never silently inert (v1 invariant C).
    play.textContent = src.playing ? "⏸" : "▶";
    play.classList.toggle("btn--primary", src.playing && vm.lock === null);
    play.classList.toggle("sources__play--held", src.playing && vm.lock !== null);
    play.disabled = vm.lock !== null;
    play.title = vm.lock ?? (src.playing ? "Pause this source" : "Play this source");

    const err = node.querySelector<HTMLElement>(`[data-testid="src-error-${id}"]`)!;
    err.textContent = vm.error ?? "";
    err.classList.toggle("sources__err--on", vm.error !== null);

    const detail = node.querySelector<HTMLElement>(".sources__detail");
    if (detail) detail.classList.toggle("sources__detail--open", expanded.has(id));

    if (src.kind === "sine") {
      // The collapsed row must betray a hidden multi-tone: the Tones button
      // carries the enabled extra-tone count and lights up, so a restored
      // tone list is never silently active behind a plain "Sine 1000 Hz".
      const more = node.querySelector<HTMLButtonElement>(
        `[data-testid="src-more-${id}"]`
      )!;
      const enabledExtras = src.extraTones.filter((t) => t.enabled).length;
      more.textContent = enabledExtras > 0 ? `Tones ×${enabledExtras}` : "Tones";
      more.classList.toggle("btn--primary", enabledExtras > 0);
      more.title =
        enabledExtras > 0
          ? `${enabledExtras} extra tone${enabledExtras > 1 ? "s" : ""} enabled — the output is a multi-tone`
          : "Edit the tone list";

      const toneRows = node.querySelector<HTMLElement>(`[data-testid="src-tones-${id}"]`)!;
      keyedList(
        toneRows,
        src.extraTones.map((t, i) => ({ t, i })),
        ({ i }) => String(i),
        {
          create: ({ i }) => {
            const en = el("input", {
              type: "checkbox",
              "data-testid": `src-tone-en-${id}-${i}`,
              onchange: (e: Event) =>
                patchExtraTone(store, ipc, id, i, {
                  enabled: (e.target as HTMLInputElement).checked,
                }),
            });
            const freq = numberField(
              `src-tone-freq-${id}-${i}`,
              "Hz",
              (v) => v > 0 && patchExtraTone(store, ipc, id, i, { frequencyHz: v }),
              { min: "1" }
            );
            const level = numberField(`src-tone-level-${id}-${i}`, "dBV", (v) =>
              patchExtraTone(store, ipc, id, i, { levelDbv: v })
            );
            const phase = numberField(`src-tone-phase-${id}-${i}`, "°", (v) =>
              patchExtraTone(store, ipc, id, i, { phaseDeg: v })
            );
            const del = el(
              "button.btn.btn--small",
              {
                "data-testid": `src-tone-del-${id}-${i}`,
                onclick: () => removeExtraTone(store, ipc, id, i),
                "aria-label": "Remove tone",
              },
              "✕"
            );
            return el("div.sources__tone", {}, en, freq.wrap, level.wrap, phase.wrap, del);
          },
          update: (row, { t, i }) => {
            row.querySelector<HTMLInputElement>(
              `[data-testid="src-tone-en-${id}-${i}"]`
            )!.checked = t.enabled;
            syncField(row, `src-tone-freq-${id}-${i}`, String(t.frequencyHz));
            syncField(row, `src-tone-level-${id}-${i}`, String(t.levelDbv));
            syncField(row, `src-tone-phase-${id}-${i}`, String(t.phaseDeg));
          },
        }
      );
      const stats = toneListStats(sineTones(src));
      node.querySelector<HTMLElement>(`[data-testid="src-tonestats-${id}"]`)!.textContent =
        stats.peak > 0
          ? `Σpeak ${(20 * Math.log10(stats.peak)).toFixed(1)} dBV · crest ${stats.crestDb.toFixed(1)} dB`
          : "silent";
    }
  };

  let lastRows: RowVM[] = [];
  const render = (): void => {
    // The kind joins the key: a waveform switch REBUILDS the row (its params
    // line is kind-specific — freq/tones for periodic, level-only broadband).
    keyedList(list, lastRows, (vm) => `${vm.src.id}:${vm.src.kind}`, {
      create: buildRow,
      update: updateRow,
    });
  };

  store.select(
    (s) => {
      const errors = new Map(s.run.slotErrors.map((e) => [e.id, e.error]));
      const lock = programLockReason(s);
      return s.sources.order
        .map((id) => s.sources.byId[id])
        .filter((src): src is SourceMeta => !!src)
        .map((src) => ({
          src,
          error: errors.get(src.id) ?? null,
          lock,
          played:
            src.kind !== "script" && "frequencyHz" in src
              ? playedFrequencyHz(s, src.frequencyHz)
              : null,
        }));
    },
    (rows) => {
      lastRows = rows;
      render();
    },
    (a, b) => JSON.stringify(a) === JSON.stringify(b)
  );

  // The lock note: while a program owns the device, say so in words.
  store.select(
    (s) => programLockReason(s),
    (lock) => {
      lockNote.hidden = lock === null;
      lockNote.textContent = lock ? `Sources paused — ${lock}` : "";
    }
  );

  store.select(
    (s) => ({
      peak: s.run.sigmaPeakDbv,
      clip: s.run.clip.output,
      range: s.run.fittedOutputRangeDbv,
      driving: s.run.streaming || s.run.generatorRunning,
      outputOnly: s.run.outputOnly,
      connected: s.device.status === "connected",
    }),
    ({ peak, clip, range, driving, outputOnly, connected }) => {
      sigma.textContent =
        peak === null ? "Σ —" : `Σ ${peak >= 0 ? "+" : ""}${peak.toFixed(1)} dBV`;
      clipDot.classList.toggle("sources__clip--lit", clip);
      clipDot.title = clip ? "Output clipping" : "";
      rangeReadout.textContent =
        driving && range !== null ? `@ ${range >= 0 ? "+" : ""}${range} dBV` : "";
      outOnly.checked = outputOnly;
      outOnly.disabled = !connected;
    },
    shallowEq
  );

  store.select(
    (s) => s.acquisition.coherentGen,
    (on) => {
      coherent.checked = on;
    }
  );
}

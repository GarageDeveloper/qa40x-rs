/**
 * Signal-source actions (M2: the full family — waveforms, tone lists,
 * broadband sources, render scripts). Every mutation ends with a sync of
 * whichever loop currently owns the DAC: the stream (capture + analysis) or
 * the gap-free output-only generator.
 *
 * Run-vs-play (the M1 review item): playing a source AUTO-STARTS the stream
 * when it isn't running — a source declared "playing" must be audible without
 * a second gesture. The Run button remains the monitor-mode transport (and
 * stops the lot).
 */
import type { Ipc } from "../../ipc/ipc";
import type { Store } from "../store";
import type {
  AppState,
  ExtraTone,
  PeriodicSource,
  ScriptSource,
  SourceKind,
  SourceMeta,
  SourceRoute,
} from "../state";
import { startRun, syncStream } from "./stream";
import { syncOutputOnly } from "./outputonly";

// Starts at 2: the boot workspace ships "Sine 1" (state.ts initialSources).
let nextId = 2;

export const SOURCE_KINDS: SourceKind[] = [
  "sine",
  "square",
  "triangle",
  "sawtooth",
  "multitone",
  "noise",
  "chirp",
  "script",
];

export const KIND_LABELS: Record<SourceKind, string> = {
  sine: "Sine",
  square: "Square",
  triangle: "Triangle",
  sawtooth: "Sawtooth",
  multitone: "Multitone",
  noise: "Noise",
  chirp: "Chirp",
  script: "Script",
};

/** The default render script (the pinned square-wave example — the same text
 * `mixer::tests::the_square_source_example_renders` pins backend-side). */
export const DEFAULT_RENDER_SCRIPT = `// A SIGNAL SOURCE script: define fn render(ctx). Samples are level-volts
// (1.0 = 0 dBV), so AMP 0.1 plays at -20 dBV. Sources sum; the summed peak
// picks the output range and a clipping sum lights OUT CLIP.
fn render(ctx) {
    let FREQ = 440.0;                     // Hz — change me
    let AMP = 0.1;                        // level-volts (0.1 = -20 dBV)
    let period = ctx.sample_rate / FREQ;  // samples per cycle
    let out = [];
    for i in 0..ctx.buffer_size {
        let phase = (i.to_float() / period) % 1.0;
        out.push(if phase < 0.5 { AMP } else { -AMP });
    }
    out
}
`;

function defaultSource(kind: SourceKind, id: string, label: string): SourceMeta {
  const base = { id, label, route: "left" as SourceRoute, playing: false };
  switch (kind) {
    case "sine":
    case "square":
    case "triangle":
    case "sawtooth":
      return { ...base, kind, frequencyHz: 1000, levelDbv: -12, extraTones: [] };
    case "multitone":
    case "noise":
    case "chirp":
      return { ...base, kind, levelDbv: -12 };
    case "script":
      return { ...base, kind, source: DEFAULT_RENDER_SCRIPT };
  }
}

/** Sync whichever loop owns the DAC after a source mutation. */
function syncActive(store: Store<AppState>, ipc: Ipc): void {
  if (store.get().run.outputOnly) syncOutputOnly(store, ipc);
  else syncStream(store, ipc);
}

export function addSource(store: Store<AppState>, ipc: Ipc, kind: SourceKind): string {
  // The counter is module state but ids may come back from a LOADED
  // workspace (M5) — skip past any id already in the pool.
  let n = nextId++;
  while (store.get().sources.byId[`src-${kind}-${n}`]) n = nextId++;
  const id = `src-${kind}-${n}`;
  const source = defaultSource(kind, id, `${KIND_LABELS[kind]} ${n}`);
  store.update("sources/add", (s) => ({
    ...s,
    sources: {
      order: [...s.sources.order, id],
      byId: { ...s.sources.byId, [id]: source },
    },
  }));
  syncActive(store, ipc);
  return id;
}

export function removeSource(store: Store<AppState>, ipc: Ipc, id: string): void {
  store.update("sources/remove", (s) => {
    const byId = { ...s.sources.byId };
    delete byId[id];
    return {
      ...s,
      sources: { order: s.sources.order.filter((x) => x !== id), byId },
    };
  });
  syncActive(store, ipc);
}

function patch(
  store: Store<AppState>,
  action: string,
  id: string,
  update: (src: SourceMeta) => SourceMeta
): void {
  store.update(action, (s) => {
    const src = s.sources.byId[id];
    if (!src) return s;
    return {
      ...s,
      sources: { ...s.sources, byId: { ...s.sources.byId, [id]: update(src) } },
    };
  });
}

/**
 * Change a source's waveform IN PLACE (M6 gap 10d): what the target kind
 * understands is kept — level always, frequency + extra tones across the
 * periodic family — and routing/play state never move. Values a kind hides
 * come back when switching back (frequency survives a sine→noise→sine round
 * trip via the defaults only; the periodic family round-trips exactly).
 * Script sources are a different beast: never offered from or towards.
 */
export function setSourceKind(
  store: Store<AppState>,
  ipc: Ipc,
  id: string,
  kind: Exclude<SourceKind, "script">
): void {
  patch(store, "sources/kind", id, (src) => {
    if (src.kind === "script" || src.kind === kind) return src;
    // Auto labels lead with the kind ("Sine 1", "Sine 1000 Hz") — follow the
    // switch; a label that doesn't is user text, leave it alone.
    const old = KIND_LABELS[src.kind];
    const label = src.label.startsWith(old)
      ? KIND_LABELS[kind] + src.label.slice(old.length)
      : src.label;
    const base = { id: src.id, label, route: src.route, playing: src.playing };
    if (kind === "sine" || kind === "square" || kind === "triangle" || kind === "sawtooth") {
      return {
        ...base,
        kind,
        frequencyHz: "frequencyHz" in src ? src.frequencyHz : 1000,
        levelDbv: src.levelDbv,
        extraTones: "extraTones" in src ? src.extraTones : [],
      };
    }
    return { ...base, kind, levelDbv: src.levelDbv };
  });
  syncActive(store, ipc);
}

export function setSourceFrequency(
  store: Store<AppState>,
  ipc: Ipc,
  id: string,
  frequencyHz: number
): void {
  if (!(frequencyHz > 0)) return;
  patch(store, "sources/frequency", id, (src) =>
    "frequencyHz" in src ? { ...src, frequencyHz } : src
  );
  syncActive(store, ipc);
}

export function setSourceLevel(
  store: Store<AppState>,
  ipc: Ipc,
  id: string,
  levelDbv: number
): void {
  if (!Number.isFinite(levelDbv)) return;
  patch(store, "sources/level", id, (src) =>
    src.kind === "script" ? src : { ...src, levelDbv }
  );
  syncActive(store, ipc);
}

export function setSourceRoute(
  store: Store<AppState>,
  ipc: Ipc,
  id: string,
  route: SourceRoute
): void {
  patch(store, "sources/route", id, (src) => ({ ...src, route }));
  syncActive(store, ipc);
}

export function setSourcePlaying(
  store: Store<AppState>,
  ipc: Ipc,
  id: string,
  playing: boolean
): void {
  // A running measurement program owns the device: the UI greys the
  // transports with the reason, and the action refuses as backstop.
  if (store.get().run.programLock !== null) return;
  patch(store, playing ? "sources/play" : "sources/pause", id, (src) => ({
    ...src,
    playing,
  }));
  const s = store.get();
  if (s.run.outputOnly) {
    syncOutputOnly(store, ipc);
    return;
  }
  // Play auto-starts the stream (see module docs); otherwise the running
  // loop just follows the new membership.
  if (playing && !s.run.streaming && s.device.status === "connected") {
    void startRun(store, ipc);
  } else {
    syncStream(store, ipc);
  }
}

/** Replace a script source's text (recompiled backend-side on the next
 * sync; failures come back as a named per-slot error). */
export function setScriptSource(
  store: Store<AppState>,
  ipc: Ipc,
  id: string,
  source: string
): void {
  patch(store, "sources/script", id, (src) =>
    src.kind === "script" ? ({ ...src, source } satisfies ScriptSource) : src
  );
  syncActive(store, ipc);
}

/* ---- extra tones (sine → phased tone list) --------------------------- */

function patchTones(
  store: Store<AppState>,
  action: string,
  id: string,
  update: (tones: ExtraTone[]) => ExtraTone[]
): void {
  patch(store, action, id, (src) =>
    src.kind === "sine"
      ? ({ ...src, extraTones: update(src.extraTones) } satisfies PeriodicSource)
      : src
  );
}

export function addExtraTone(store: Store<AppState>, ipc: Ipc, id: string): void {
  patchTones(store, "sources/tone-add", id, (tones) => [
    ...tones,
    { enabled: true, frequencyHz: 2000, levelDbv: -24, phaseDeg: 0 },
  ]);
  syncActive(store, ipc);
}

export function removeExtraTone(
  store: Store<AppState>,
  ipc: Ipc,
  id: string,
  index: number
): void {
  patchTones(store, "sources/tone-remove", id, (tones) =>
    tones.filter((_, i) => i !== index)
  );
  syncActive(store, ipc);
}

export function patchExtraTone(
  store: Store<AppState>,
  ipc: Ipc,
  id: string,
  index: number,
  changes: Partial<ExtraTone>
): void {
  patchTones(store, "sources/tone-edit", id, (tones) =>
    tones.map((t, i) => (i === index ? { ...t, ...changes } : t))
  );
  syncActive(store, ipc);
}

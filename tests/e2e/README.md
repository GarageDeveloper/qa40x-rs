# E2E harness

Drive the real frontend in a real browser, against a **fake backend**, and
**look at it**. This exists because 183 green unit tests and 0 warnings once
missed four bugs that were obvious the moment a human saw the screen (a
missing FD badge, an L/R asymmetry, a 40 dB spectrum-floor error, a
per-source setting that was silently global). Each piece was locally
coherent; only the assembled UI showed the problem. The harness makes the
assembled UI something an agent — or you — can open, click, screenshot, and
read back.

## Running it

```sh
npm run test:e2e            # headless, all specs (tests/e2e/*.pw.ts)
npm run test:e2e:headed     # same, with a visible browser window
npx playwright test --ui    # Playwright's interactive UI mode
npx playwright test smoke.pw.ts -g "ATTEN"  # one test by name
```

Screenshots land in `tests/e2e/screenshots/` (gitignored) — the
`screenshot.pw.ts` tour always drops a set of connected views, so even a
headless run leaves something to look at. Playwright artifacts (traces, failure screenshots) go
to `tests/e2e/.results/`.

To just **click around the app by hand** without hardware:

```sh
npm run dev:fake            # Vite dev server on http://localhost:14200
```

then open that URL in any browser. Same app, same fake device; the console
logs `[qa40x e2e] fake backend installed` so you can't mistake it for a real
session. A `test:e2e` run reuses this server if it is already up.

First-time setup: `npm ci && npx playwright install chromium`.

## How it works

- `vite.e2e.config.ts` serves the **real** `index.html` and injects one extra
  module script, `tests/e2e/harness/boot.ts`, *before* `/src/main.ts`
  (module scripts execute in document order, so the mock is in place before
  the app evaluates).
- `boot.ts` calls `mockIPC(handler, { shouldMockEvents: true })` from
  `@tauri-apps/api/mocks`: every `invoke()` lands on the fake device
  (`harness/fake-device.ts`), and the mock itself implements
  `plugin:event|listen/emit`, keeping the app's `listen()` callbacks in a
  registry.
- **Driving events**: emitting `plugin:event|emit` through the mock runs the
  registered callbacks — the exact path a real backend emission takes. The
  harness exposes it as `window.__qa40xE2E.emit(event, payload)`; tests call
  it via `app.emit(...)` (e.g. `script-frame`, `script-acquire`,
  `device-disconnected`). The fake device uses the same hook for events it
  emits itself (`script-state`, unplug).
- The fake's **capture** (`generate_and_capture`) is behind the
  `FrameProvider` seam (`harness/frames.ts`). The default is a synthetic
  perfect loopback; `app.useFixtures([...])` swaps in `fixtureProvider`, which
  replays **recorded hardware frames** (`tests/e2e/fixtures/*.json`, from
  `src-tauri/examples/record_fixtures.rs`, #54) — selecting a fixture by the
  driven-channel signature of the buffer the app plays and refusing loudly on
  any range / sample-rate mismatch. A requested length longer than the fixture
  (the live loop's capture-guard padding) is filled by wrapping the block
  **aligned to the analysis window**, so the wrap seams fall in the discarded
  guards and the app analyses the recording verbatim (a mid-window seam would
  fake a ~60 dB-too-high noise floor).

### What the fake device does — and does NOT — simulate

Does: connect/presence/config registers, the two dBFS→dBV converter offsets,
mixer slot rendering (sine/square/triangle/sawtooth/tones/noise/chirp/
multitone at correct RMS levels, routed and summed), a range-correct
loopback capture with a small noise floor, real windowed FFTs and crude
derived metrics, telemetry, in-memory storage stubs. ONE measurement program:
the THD-vs-frequency sweep (`measure_thd_vs_frequency`) — a stub RESULT (used
only by the device-lock family, which asserts the lock semantics around it,
never its numbers), gateable with `app.holdPrograms()` /
`releasePrograms()` so the locked UI can be observed instead of raced.

Does NOT: Rhai script execution (refused with a named error), other
measurement programs / sweeps (unimplemented commands throw), converter
distortion or frequency response, round-trip latency, relay settling,
averaging, FFT windows other than Hann, calibration pages. **Unknown commands
throw loudly** — if the app grows a new startup invoke, a test will name it
instead of hanging.

### The invariant suite (#55), organised by INVARIANT VIOLATED

Not by screen — because the same bug class ("one value where there must be N")
recurred five times. Each spec file is one family; every assertion is
relational (before/after, L vs R, ask vs read), never a golden value.

- `level-references.pw.ts` — **B**: an input-range step re-references dBFS but
  moves no absolute-dBV reading (the #51 pin); Output vs Input agreement.
- `one-value-where-n.pw.ts` — **A**: two sources both run; a tile plays both;
  one source's edit moves only it; Output L/R and Input L/R each own their
  spectrum (#49/#50/#58); Off-route removal.
- `domain-badges.pw.ts` — **E**: FD badges follow the display rule,
  symmetrically, with truthful tooltips (#52).
- `device-lock.pw.ts` — **C**: a running program locks sources by name and
  resumes exactly what played.
- `mixer-clip.pw.ts` — **D**: same-channel sum +6 dB vs split; a clipping sum
  lights and HOLDS the clip dot, never a silent rescale.
- `persistence.pw.ts` — **F**: save/load round-trip; legacy-v4→v5 migration
  (against a real captured v4 blob, `fixtures/workspace-v4.json`).
- `recorded-levels.pw.ts` — **B (absolute)**: the same invariants against REAL
  recorded frames. Live once `tests/e2e/fixtures/` is populated; each test
  `.skip`s with "awaiting recorded fixtures (#54)" otherwise.

Level model (why the numbers read back true): mixer slots render in
level-volts (sine peak 1.0 ≙ 0 dBV RMS, mirroring the backend mixer,
`src-tauri/src/mixer.rs`); the capture maps
DAC digital → volts → ADC digital through the *current* output and input
ranges; the offsets mirror the backend (input `range − 6` **plus the factory ADC
trim** — the #51 hardware probe measured the total input offset at range
18 dBV as +20.81 dB, and `harness/frames.ts inputDbvOffsetDb` models that
trim for both the offset command and the synthetic capture; output
`range + 3.01`; digital-RMS-referenced spectra). So a −12 dBV source reads
−12 dBV on both Output and Input traces, *keeps* reading −12 dBV when a
range register moves — which rule 2 below depends on — and a replayed
recorded fixture displays the absolute dBV that was really driven.

## RULE 1 — tests never touch the automation tool

Specs import `test`/`expect` from `adapter/fixtures.ts` and speak to page
objects (`App`, `SourcesPanelPO`, …) that return **plain data**:

```ts
const rows = await app.sources.rows();
expect(rows).toEqual([
  { label: "Sine 1000 Hz",   running: true, routeL: true,  routeR: false, ... },
]);
```

Everything tool-specific lives in exactly two files: `adapter/driver.ts`
(the `Driver` interface + its Playwright implementation) and
`adapter/fixtures.ts`. Migrating to WebdriverIO (the logged path for driving
the REAL Tauri app — macOS has no WKWebView driver, so `tauri-driver` can't,
but `@wdio/tauri-service` can) means reimplementing `Driver` over
`browser.execute`/`$$` and swapping the fixtures file. The cost of this
discipline is zero now; retrofitting it onto a grown suite is prohibitive.

**Known limit**: the abstraction covers UI *driving* only. `mockIPC` does
not exist in the WebdriverIO-against-the-real-app world — a deterministic
suite there needs a backend replay mode (in the backlog). Don't design tests
that only make sense with a mock in reach.

## RULE 2 — assert invariants, not golden values

The fake device encodes *our* understanding of the backend — the same
understanding the frontend was written against. A golden-value assertion can
therefore pass **on the bug**. Real case: with one shared dBFS→dBV offset,
the fake, the frontend and the assertion would all have agreed on a wrong
Output-trace level; the bug (#51, two converters ⇒ two offsets) was only
visible because the *shape* of the check was physical:

```ts
// BAD — encodes what the author believed
expect(await app.curveDbAt("Output L", 1000)).toBeCloseTo(-12.0);

// GOOD — encodes physics; catches the bug even with a naive fake
const before = await app.curveDbAt("Output L", 1000);
await setInputRange(42);                                  // ADC-side change
expect(await app.curveDbAt("Output L", 1000)).toBeCloseTo(before); // cannot move the DAC
```

Prefer assertions of the form *"this action cannot change that reading"*,
*"these two readings must agree"*, *"this level moves by exactly the amount
I changed it"*. Reserve golden values for things the UI itself states
(labels, defaults like "-12 dBV" — which ARE the contract).

## Adding a page object

1. Find the panel's DOM contract in its renderer (`src/panels/**/*.ts` —
   they build plain class-named elements; prefer existing classes,
   `aria-label`s and titles over adding test ids).
2. Write a `*PO` class in `adapter/` that takes a `Driver` and returns plain
   data from `drv.eval(pageFn, arg)` — the page function must be
   self-contained (it is serialized by source; no closures).
3. Expose it on `App`, use it from a spec. If you need something from the
   app's state that the DOM doesn't show (curve data, workspace), extend the
   `qa40xV2Debug` handle in `src/main.ts` — that is the one sanctioned
   production hook.

Reading a curve: charts are canvas, so `app.curveDbAt(label, hz)` reads the
trace's frame from the pool via `qa40xV2Debug` — the exact array the canvas
was drawn from, one step upstream of rasterization. Pixel-scraping would
test the plotting library; this tests the app's data.

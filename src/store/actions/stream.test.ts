/**
 * buildStreamConfig — the state → StreamConfig projection the backend loop
 * follows (sources → slots, averaging mapping, visibility → spectra budget) —
 * and the slot-building invariants ported from mixer.test.ts (M2: the
 * mixer.ts slot-building half must not drift in the port).
 */
import { describe, expect, it } from "vitest";
import type { PeriodicSource, ScriptSource, SourceMeta } from "../state";
import { initialState } from "../state";
import { HW_TRACE_IDS } from "../state";
import {
  buildStreamConfig,
  levelToAmplitude,
  slotFromSource,
  snapToBin,
} from "./stream";

const noSnap = (hz: number): number => hz;

function sineSource(id: string, over: Partial<PeriodicSource> = {}): SourceMeta {
  return {
    id,
    label: id,
    kind: "sine",
    frequencyHz: 1000,
    levelDbv: -12,
    extraTones: [],
    route: "left",
    playing: true,
    ...over,
  } as SourceMeta;
}

describe("snapToBin", () => {
  it("snaps to the nearest FFT bin at the device sample rate", () => {
    // 1 kHz at 48 kHz / 32768 → bin 683 → 1000.34 Hz (v1 behavior).
    const snapped = snapToBin(1000, 32768, 48000);
    expect(snapped).toBeCloseTo((683 * 48000) / 32768, 9);
  });

  it("never snaps below bin 1 (DC is not a tone)", () => {
    expect(snapToBin(0.01, 4096, 48000)).toBeCloseTo(48000 / 4096, 9);
  });
});

describe("buildStreamConfig", () => {
  it("maps averaging: off → count 1; power/coherent keep the count", () => {
    const s = initialState();
    s.acquisition.averaging = { mode: "off", count: 8 };
    expect(buildStreamConfig(s).averaging).toEqual({ coherent: false, count: 1 });
    s.acquisition.averaging = { mode: "power", count: 8 };
    expect(buildStreamConfig(s).averaging).toEqual({ coherent: false, count: 8 });
    s.acquisition.averaging = { mode: "coherent", count: 16 };
    expect(buildStreamConfig(s).averaging).toEqual({ coherent: true, count: 16 });
  });

  it("requests exactly the spectra some spectrum tile shows (display budget)", () => {
    const s = initialState();
    // One displayed tile: the boot 2×2 also shows Input R (row 2 default)
    // and would rightly widen the budget.
    s.layout.pattern = "1";
    s.layout.tiles["tile-1"].traces = [HW_TRACE_IDS.inputL, HW_TRACE_IDS.outputL];
    expect(buildStreamConfig(s).spectra).toEqual({
      input_l: true,
      input_r: false,
      output_l: true,
      output_r: false,
    });
  });

  it("a legend-hidden trace leaves the fd budget", () => {
    const s = initialState();
    s.layout.pattern = "1"; // keep the boot row-2 (Input R) tiles out
    s.layout.tiles["tile-1"].traces = [HW_TRACE_IDS.inputL, HW_TRACE_IDS.inputR];
    s.layout.tiles["tile-1"].hidden = [HW_TRACE_IDS.inputR];
    expect(buildStreamConfig(s).spectra.input_l).toBe(true);
    expect(buildStreamConfig(s).spectra.input_r).toBe(false);
  });

  it("a scope tile requests NO spectra — td is always carried (#52)", () => {
    const s = initialState();
    s.layout.pattern = "1"; // isolate tile-1 (the boot layout is 2×2)
    s.layout.tiles["tile-1"].kind = "scope";
    s.layout.tiles["tile-1"].traces = [HW_TRACE_IDS.inputL, HW_TRACE_IDS.inputR];
    expect(buildStreamConfig(s).spectra).toEqual({
      input_l: false,
      input_r: false,
      output_l: false,
      output_r: false,
    });
  });

  it("a hidden tile (beyond the pattern) does not inflate the budget", () => {
    const s = initialState();
    // The "1" pattern shows only tile-1; tile-3 (a spectrum) is hidden —
    // its Output R must not be computed.
    s.layout.pattern = "1";
    s.layout.tiles["tile-3"].traces = [HW_TRACE_IDS.outputR];
    expect(buildStreamConfig(s).spectra.output_r).toBe(false);
  });

  it("declares one slot per PLAYING source, bin-snapped, dBV → linear", () => {
    const s = initialState();
    s.device.config = { input_gain: 18, output_gain: 8, sample_rate: 48000 };
    s.sources = {
      order: ["a", "b"],
      byId: {
        a: sineSource("a", { label: "Sine 1" }),
        b: sineSource("b", {
          label: "Sine 2",
          frequencyHz: 2000,
          levelDbv: 0,
          route: "right",
          playing: false,
        }),
      },
    };
    const slots = buildStreamConfig(s).slots;
    expect(slots).toHaveLength(1);
    expect(slots[0].id).toBe("a");
    expect(slots[0].route).toBe("left");
    const src = slots[0].source;
    if (src.kind !== "waveform") throw new Error("expected a waveform slot");
    expect(src.frequency_hz).toBeCloseTo((683 * 48000) / 32768, 6);
    expect(src.amplitude).toBeCloseTo(Math.pow(10, -12 / 20), 9);
  });
});

/* Ports of the mixer.test.ts slot-building invariants (M2). The v1 trace
 * classification half (definesRender/isMixSource) has no v2 counterpart by
 * design: sources are explicitly typed here, and a script without
 * `fn render(ctx)` comes back as a named backend SlotError (pinned by
 * mixer::tests::a_bad_slot_is_dropped_and_named_the_rest_play). */
describe("slotFromSource (the mixer.ts slot-building port)", () => {
  it("levels map dBV → linear level-volts (0 dBV ≙ 1.0)", () => {
    expect(levelToAmplitude(0)).toBeCloseTo(1.0, 12);
    expect(levelToAmplitude(-6)).toBeCloseTo(0.5011872, 6);
    expect(levelToAmplitude(8)).toBeCloseTo(2.5118864, 6);
  });

  it("a plain sine keeps the classic waveform slot, bin-snapped", () => {
    const snap = (hz: number): number => Math.round(hz / 100) * 100;
    const slot = slotFromSource(sineSource("s", { frequencyHz: 997 }), snap);
    expect(slot).toEqual({
      id: "s",
      source: {
        kind: "waveform",
        waveform: "sine",
        frequency_hz: 1000,
        amplitude: levelToAmplitude(-12),
      },
      route: "left",
      enabled: true,
    });
  });

  it("routes follow the source's declared route — including off (muted)", () => {
    for (const route of ["left", "right", "both", "off"] as const) {
      const slot = slotFromSource(sineSource("s", { route }), noSnap);
      expect(slot.route).toBe(route);
      expect(slot.enabled).toBe(true);
    }
  });

  it("a sine with extra tones becomes a phased tone list", () => {
    const snap = (hz: number): number => Math.round(hz / 100) * 100;
    const slot = slotFromSource(
      sineSource("g", {
        frequencyHz: 997,
        extraTones: [
          { enabled: true, frequencyHz: 2503, levelDbv: -18, phaseDeg: 90 },
          { enabled: false, frequencyHz: 5000, levelDbv: -6, phaseDeg: 0 }, // skipped
        ],
      }),
      snap
    );
    // The primary {frequency, level} tone rides at phase 0; each enabled
    // extra is bin-snapped and converted dBV → Vrms at this boundary.
    expect(slot.source).toEqual({
      kind: "tones",
      tones: [
        {
          enabled: true,
          frequency_hz: 1000,
          amplitude_vrms: levelToAmplitude(-12),
          phase_degrees: 0,
        },
        {
          enabled: true,
          frequency_hz: 2500,
          amplitude_vrms: levelToAmplitude(-18),
          phase_degrees: 90,
        },
      ],
    });
  });

  it("a sine with no (or only disabled) extra tones keeps the classic slot", () => {
    // The plain-sine path is the bit-identical one the hardware level
    // measurement was pinned on — it must not silently reroute.
    const disabled = [{ enabled: false, frequencyHz: 2000, levelDbv: -6, phaseDeg: 0 }];
    for (const extraTones of [[], disabled]) {
      const slot = slotFromSource(sineSource("g", { extraTones }), noSnap);
      expect(slot.source.kind).toBe("waveform");
    }
  });

  it("square / triangle / sawtooth become waveform slots", () => {
    for (const kind of ["square", "triangle", "sawtooth"] as const) {
      const slot = slotFromSource(
        sineSource("g", { kind, frequencyHz: 440, levelDbv: -20 }),
        noSnap
      );
      expect(slot.source).toEqual({
        kind: "waveform",
        waveform: kind,
        frequency_hz: 440,
        amplitude: levelToAmplitude(-20),
      });
    }
  });

  it("extra tones apply to sine only — a square with tones stays a square", () => {
    const extraTones = [{ enabled: true, frequencyHz: 2000, levelDbv: -6, phaseDeg: 0 }];
    const slot = slotFromSource(sineSource("g", { kind: "square", extraTones }), noSnap);
    expect(slot.source.kind).toBe("waveform");
  });

  it("multitone / noise / chirp carry only their level", () => {
    for (const kind of ["multitone", "noise", "chirp"] as const) {
      const slot = slotFromSource(
        { id: "b", label: kind, kind, levelDbv: -12, route: "both", playing: true },
        noSnap
      );
      expect(slot.source).toEqual({ kind, amplitude: levelToAmplitude(-12) });
    }
  });

  it("a script slot carries its source text and declared route", () => {
    const script: ScriptSource = {
      id: "sq",
      label: "Script",
      kind: "script",
      source: "fn render(ctx) { [] }",
      route: "both",
      playing: true,
    };
    const slot = slotFromSource(script, noSnap);
    expect(slot.source).toEqual({ kind: "script", source: "fn render(ctx) { [] }" });
    expect(slot.route).toBe("both");
  });
});

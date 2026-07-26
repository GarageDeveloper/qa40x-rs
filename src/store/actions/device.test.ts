/**
 * Device config-refresh actions: `refreshConfig` (the common choke point
 * behind connect/setInputRange/setOutputRange/setSampleRate) must
 * invalidate any held Levels reading (issue #29 review finding #8) — its
 * Vrms/dBV/dBu were computed from the calibration factor AT MEASUREMENT
 * TIME, and a range/rate change moves that factor.
 */
import { describe, expect, it } from "vitest";
import type { Commands, Ipc } from "../../ipc/ipc";
import { Store } from "../store";
import { initialState, type AppState } from "../state";
import { connect, setInputRange, setOutputRange, setSampleRate } from "./device";

function stubIpc(): Ipc {
  return {
    async call<K extends keyof Commands>(cmd: K): Promise<Commands[K]["result"]> {
      switch (cmd) {
        case "connect_device":
          return "ok" as Commands[K]["result"];
        case "get_device_info":
          return null as Commands[K]["result"];
        case "get_device_config":
          return { input_gain: 0, output_gain: -12, sample_rate: 48000 } as Commands[K]["result"];
        case "get_input_dbv_offset":
        case "get_output_dbv_offset":
          return { offset_db: 6, calibrated: true } as Commands[K]["result"];
        case "set_input_gain":
        case "set_output_gain":
        case "set_sample_rate":
          return "ok" as Commands[K]["result"];
        default:
          return null as Commands[K]["result"];
      }
    },
  };
}

function stateWithLevelsResult(): AppState {
  const s = initialState();
  return {
    ...s,
    device: { ...s.device, status: "connected" },
    levels: {
      ...s.levels,
      result: {
        rms_dbfs: -20,
        peak_dbfs: -15,
        rms_a_dbfs: -22,
        rms_c_dbfs: -20.5,
        rms_vrms: 0.1,
        rms_dbv: -20,
        rms_dbu: -17.8,
        rms_a_dbv: -22,
        calibrated: true,
        clipped: false,
        stimulus_freq_hz: 1000,
      },
      error: "some stale error",
    },
  };
}

describe("actions/device — Levels invalidation on config refresh (issue #29 finding #8)", () => {
  it("setInputRange clears a held levels result", async () => {
    const store = new Store(stateWithLevelsResult());
    await setInputRange(store, stubIpc(), 6);
    expect(store.get().levels.result).toBeNull();
    expect(store.get().levels.error).toBeNull();
  });

  it("setOutputRange clears a held levels result", async () => {
    const store = new Store(stateWithLevelsResult());
    await setOutputRange(store, stubIpc(), -2);
    expect(store.get().levels.result).toBeNull();
  });

  it("setSampleRate clears a held levels result", async () => {
    const store = new Store(stateWithLevelsResult());
    await setSampleRate(store, stubIpc(), 96000);
    expect(store.get().levels.result).toBeNull();
  });

  it("connect() also clears any levels result left from a prior session", async () => {
    const store = new Store(stateWithLevelsResult());
    await connect(store, stubIpc());
    expect(store.get().levels.result).toBeNull();
  });

  it("other levels params (channel/duration/…) are untouched by a range change", async () => {
    const seed: AppState = {
      ...stateWithLevelsResult(),
      levels: { ...stateWithLevelsResult().levels, inputChannel: "right", durationSecs: 3 },
    };
    const store = new Store(seed);
    await setInputRange(store, stubIpc(), 6);
    expect(store.get().levels.inputChannel).toBe("right");
    expect(store.get().levels.durationSecs).toBe(3);
  });
});

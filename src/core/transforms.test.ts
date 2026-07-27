import { describe, expect, it } from "vitest";
import {
  dialogModelToSteps,
  stepsToDialogModel,
  transformLabel,
  type TransformDialogModel,
} from "./transforms";

const baseModel: TransformDialogModel = {
  input: "hw-in-left",
  weighting: "none",
  userCurve: null,
  notch: false,
  notchFreq: 60,
  deconvolve: "none",
  script: "",
};

describe("dialogModelToSteps / stepsToDialogModel — user weighting curve", () => {
  it("embeds a snapshot of the loaded curve in the weighting step", () => {
    const curve = { freqs: [100, 1000], gains: [0, 12] };
    const steps = dialogModelToSteps({ ...baseModel, weighting: "user", userCurve: curve });
    expect(steps).toEqual([{ type: "weighting", mode: "user", curve }]);
  });

  it("falls back to no weighting step when 'user' is chosen with nothing loaded", () => {
    const steps = dialogModelToSteps({ ...baseModel, weighting: "user", userCurve: null });
    expect(steps).toEqual([]);
  });

  it("round-trips through stepsToDialogModel, recovering the embedded curve", () => {
    const curve = { freqs: [20, 200, 2000], gains: [-6, 0, 6] };
    const steps = dialogModelToSteps({ ...baseModel, weighting: "user", userCurve: curve });
    const model = stepsToDialogModel("hw-in-left", steps);
    expect(model.weighting).toBe("user");
    expect(model.userCurve).toEqual(curve);
  });

  it("a fixed A/C/RIAA weighting step carries no curve field", () => {
    const steps = dialogModelToSteps({ ...baseModel, weighting: "a" });
    expect(steps).toEqual([{ type: "weighting", mode: "a" }]);
  });

  it("re-editing an A-weighted step never surfaces a stale curve", () => {
    const model = stepsToDialogModel("hw-in-left", [{ type: "weighting", mode: "a" }]);
    expect(model.weighting).toBe("a");
    expect(model.userCurve).toBeNull();
  });

  it("transformLabel names a user curve distinctly from A/C/RIAA", () => {
    const curve = { freqs: [100], gains: [3] };
    expect(
      transformLabel([{ type: "weighting", mode: "user", curve }])
    ).toBe("User-weighted");
    expect(transformLabel([{ type: "weighting", mode: "a" }])).toBe("A-weighted");
    expect(transformLabel([{ type: "weighting", mode: "riaa" }])).toBe("RIAA");
  });
});

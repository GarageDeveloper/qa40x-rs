/**
 * Role classification × the read-only `device()` verb (issue #25 lot F6):
 * reading the bound device's identity must never re-classify a plot script
 * as a device-driving one — `device` is cached-status family, deliberately
 * NOT in MEASUREMENT_VERBS.
 */
import { describe, expect, it } from "vitest";
import { classifyScriptRole } from "./scriptrole";

describe("classifyScriptRole and device()", () => {
  it("a device()-only script classifies as a SOURCE script", () => {
    expect(classifyScriptRole('print("on " + device().model + " " + device().serial);')).toBe(
      "source"
    );
  });

  it("device() beside a measurement verb stays a measurement script", () => {
    expect(classifyScriptRole("print(device().id);\nacquire();")).toBe("measurement");
  });

  it("use_device (the R4 refusal stub) is not a measurement verb either", () => {
    // It errors at RUN time with the R4 rule — classification must not
    // claim the device for a script that can only ever refuse.
    expect(classifyScriptRole('use_device("usb/AB12");')).toBe("source");
  });
});

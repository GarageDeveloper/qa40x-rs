/**
 * The tile "+" add-trace picker's domain filter (issue #28 second-pass
 * review finding #9): a PROGRAM/MEMORY trace with KNOWN domains must carry
 * the one the tile kind actually draws, or it never appears there — but a
 * trace with NO domains yet (nothing streamed) stays listable everywhere,
 * and a hardware endpoint ALWAYS stays listable everywhere regardless of
 * its current domains (its fd/td set is display-derived — a spectrum is
 * computed only for a trace some fd tile actually shows, domain-badges.pw.ts
 * — so a td-only playing endpoint must still be offered on a spectrum
 * tile: THAT addition is what makes its fd start flowing).
 */
import { describe, expect, it } from "vitest";
import type { TraceMeta } from "../../store/state";
import { addTraceCandidates } from "./addtrace";

function trace(
  id: string,
  domains: TraceMeta["domains"],
  sourceKind: TraceMeta["source"]["kind"] = "hw_input"
): TraceMeta {
  const source =
    sourceKind === "hw_input" || sourceKind === "hw_output"
      ? { kind: sourceKind, channel: "left" as const }
      : sourceKind === "program"
        ? { kind: "program" as const }
        : sourceKind === "memory"
          ? { kind: "memory" as const, frozenFrom: "src" }
          : { kind: "transform" as const, input: "src", steps: [] };
  return {
    id,
    label: id,
    color: "#888",
    source,
    domains,
    seq: domains.length ? 1 : 0,
    offsetDb: null,
    capture: null,
  };
}

describe("addTraceCandidates", () => {
  const byId: Record<string, TraceMeta> = {
    "hw-in-l": trace("hw-in-l", ["td", "fd"], "hw_input"), // streaming, shown on an fd tile too
    "hw-in-r": trace("hw-in-r", ["td"], "hw_input"), // streaming, td only — NOT yet on an fd tile
    "prog-wf": trace("prog-wf", ["sweep"], "program"), // wow & flutter: sweep-only
    "prog-thd": trace("prog-thd", ["sweep"], "program"), // THD sweep: sweep-only
    "frozen-wf": trace("frozen-wf", ["sweep"], "memory"), // a frozen ❄ W&F snapshot
    "fresh-xform": trace("fresh-xform", [], "transform"), // just created, nothing landed yet
  };
  const order = ["hw-in-l", "hw-in-r", "prog-wf", "prog-thd", "frozen-wf", "fresh-xform"];

  it("a spectrum tile offers fd-carrying, domain-less, AND td-only hardware traces, never a sweep-only program/memory trace", () => {
    const cands = addTraceCandidates(order, byId, [], "spectrum");
    expect(cands).toContain("hw-in-l");
    expect(cands).toContain("hw-in-r"); // hw endpoint: always listable (display-derived fd)
    expect(cands).toContain("fresh-xform");
    expect(cands).not.toContain("prog-wf");
    expect(cands).not.toContain("prog-thd");
    expect(cands).not.toContain("frozen-wf");
  });

  it("a scope tile offers td-carrying, domain-less, and hardware traces, never a sweep-only program/memory trace", () => {
    const cands = addTraceCandidates(order, byId, [], "scope");
    expect(cands).toContain("hw-in-l");
    expect(cands).toContain("hw-in-r");
    expect(cands).toContain("fresh-xform");
    expect(cands).not.toContain("prog-wf");
    expect(cands).not.toContain("prog-thd");
    expect(cands).not.toContain("frozen-wf");
  });

  it("a sweep tile offers sweep-carrying, domain-less, AND hardware traces, never a fd/td-only program/memory trace", () => {
    // Hardware endpoints stay listable on a sweep tile too (the same
    // display-derived-domain exemption) even though none of this fixture's
    // hw traces currently carry "sweep" — a real hw endpoint never does.
    const cands = addTraceCandidates(order, byId, [], "sweep");
    expect(cands).toContain("prog-wf");
    expect(cands).toContain("prog-thd");
    expect(cands).toContain("frozen-wf");
    expect(cands).toContain("fresh-xform");
    expect(cands).toContain("hw-in-l");
    expect(cands).toContain("hw-in-r");
  });

  it("excludes traces already on the tile regardless of domain", () => {
    const cands = addTraceCandidates(order, byId, ["prog-wf"], "sweep");
    expect(cands).not.toContain("prog-wf");
    expect(cands).toContain("prog-thd");
  });

  it("a trace absent from the pool (stale id) is simply not offered", () => {
    const cands = addTraceCandidates(["ghost", ...order], byId, [], "spectrum");
    expect(cands).not.toContain("ghost");
  });
});

import { describe, expect, it } from "vitest";
import { type RunPhase, setRunPhase } from "../src/core/run-state.ts";
import { baseline, changedFingerprint, cite, execution, initial } from "./fixtures.ts";

describe("workflow gates", () => {
  it("requires an executed positive reproduction before test", () => {
    let state = setRunPhase(initial(), "reproduce");
    expect(() => setRunPhase(state, "test")).toThrow();
    state = cite(execution(state, "node repro.js"), {
      kind: "command",
      purpose: "reproduction",
      summary: "Bug absent",
      reproduction: { bugObserved: false, actual: "0", expected: "0" },
    });
    expect(() => setRunPhase(state, "test")).toThrow();
  });
  it("requires a failing regression on the current baseline before fix or verification", () => {
    const state = baseline();
    expect(setRunPhase(state, "verify").phase).toBe("verify");
    expect(() =>
      setRunPhase({ ...state, workspaceFingerprint: changedFingerprint }, "verify"),
    ).toThrow();
    expect(() =>
      setRunPhase(execution(state, "node --test regression.test.js", 0), "verify"),
    ).toThrow();
  });
  it("enforces fix authorization and a real change before verification", () => {
    expect(() => setRunPhase(baseline(), "fix")).toThrow();
    expect(() => setRunPhase(baseline(true), "verify")).toThrow();
    let state = setRunPhase(baseline(true), "fix");
    expect(() => setRunPhase(state, "verify")).toThrow();
    state = cite(state, {
      kind: "observation",
      purpose: "fix",
      result: "observed",
      summary: "Claimed edit",
    });
    expect(() => setRunPhase(state, "verify")).toThrow();
    expect(
      setRunPhase({ ...state, workspaceFingerprint: changedFingerprint }, "verify").phase,
    ).toBe("verify");
  });
  it.each<[RunPhase, RunPhase]>([
    ["triage", "test"],
    ["reproduce", "triage"],
    ["report", "triage"],
  ])("rejects %s -> %s", (from, to) => {
    expect(() => setRunPhase({ ...initial(), phase: from }, to)).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { finishRun, renderReport } from "../src/core/report.ts";
import { setRunPhase } from "../src/core/run-state.ts";
import {
  baseline,
  cite,
  execution,
  initial,
  regressionPath,
  reportPath,
  verification,
  verified,
} from "./fixtures.ts";

function fixed() {
  return verified(verified(verification(true), "regression"), "existing");
}

describe("completion", () => {
  it("requires a current blocker instead of reusing a blocker from an earlier phase or file version", () => {
    let state = cite(initial(), {
      kind: "observation",
      purpose: "diagnostic",
      result: "blocked",
      summary: "Missing compiler",
    });
    expect(() =>
      finishRun(setRunPhase(state, "reproduce"), "blocked", "Stopped", reportPath),
    ).toThrow();
    state = { ...state, workspaceFingerprint: "d".repeat(64) };
    expect(() => finishRun(state, "blocked", "Stopped", reportPath)).toThrow();
  });
  it.each(["changed files", "later failure"])(
    "rejects a stale negative reproduction after %s",
    (reason) => {
      let state = cite(execution(setRunPhase(initial(), "reproduce"), "node repro.js", 0), {
        kind: "command",
        purpose: "reproduction",
        summary: "No bug",
        reproduction: { bugObserved: false, actual: "0", expected: "0" },
      });
      state =
        reason === "changed files"
          ? { ...state, workspaceFingerprint: "d".repeat(64) }
          : execution(state, "node repro.js", 1, "MODULE_NOT_FOUND");
      expect(() => finishRun(state, "not_reproduced", "No bug", reportPath)).toThrow();
    },
  );
  it("finishes a fix with current regression and existing tests passing", () => {
    expect(finishRun(fixed(), "fixed", "Fixed", reportPath).outcome).toBe("fixed");
  });
  it.each(["regression", "existing"] as const)(
    "rejects an older pass when the latest %s result fails",
    (scope) => {
      expect(() => finishRun(verified(fixed(), scope, 1), "fixed", "Fixed", reportPath)).toThrow();
    },
  );
  it("rejects a later failed execution even if the model does not record it", () => {
    const state = execution(fixed(), "node --test regression.test.js", 1);
    expect(() => finishRun(state, "fixed", "Fixed", reportPath)).toThrow();
  });
  it("requires re-verification after further code changes", () => {
    const state = { ...fixed(), workspaceFingerprint: "d".repeat(64) };
    expect(() => finishRun(state, "fixed", "Fixed", reportPath)).toThrow();
    expect(
      finishRun(verified(verified(state, "regression"), "existing"), "fixed", "Fixed", reportPath)
        .outcome,
    ).toBe("fixed");
  });
  it("does not accept a different test as the post-fix regression", () => {
    let state = verified(verification(true), "existing");
    state = cite(execution(state, "node --test unrelated.test.js"), {
      kind: "test",
      purpose: "verification",
      verificationScope: "regression",
      path: regressionPath,
      summary: "Different test",
    });
    expect(() => finishRun(state, "fixed", "Fixed", reportPath)).toThrow();
  });
  it("requires both scopes and refuses evidence-free success", () => {
    expect(() =>
      finishRun(verified(verification(true), "regression"), "fixed", "Fixed", reportPath),
    ).toThrow();
    expect(() => finishRun(initial(), "fixed", "Fixed", reportPath)).toThrow();
  });
  it("labels reproduction-only runs only when the regression still fails and existing tests pass", () => {
    const state = verified(verified(verification(), "regression", 1), "existing");
    expect(finishRun(state, "reproduced", "Reproduced", reportPath).outcome).toBe("reproduced");
    expect(() =>
      finishRun(verified(state, "regression"), "reproduced", "Reproduced", reportPath),
    ).toThrow();
    expect(() => finishRun(fixed(), "reproduced", "Reproduced", reportPath)).toThrow();
  });
  it("distinguishes a completed no-bug attempt from missing dependencies", () => {
    let state = setRunPhase(initial(), "reproduce");
    state = cite(execution(state, "node repro.js", 0, "actual=0 expected=0"), {
      kind: "command",
      purpose: "reproduction",
      summary: "No bug",
      reproduction: { bugObserved: false, actual: "0", expected: "0" },
    });
    expect(finishRun(state, "not_reproduced", "No bug observed", reportPath).outcome).toBe(
      "not_reproduced",
    );
    expect(() => setRunPhase(state, "test")).toThrow();
    expect(() =>
      cite(execution(setRunPhase(initial(), "reproduce"), "node missing.js", 1), {
        kind: "command",
        purpose: "reproduction",
        summary: "Missing dependency",
        reproduction: { bugObserved: false, actual: "Module not found", expected: "0" },
      }),
    ).toThrow();
    expect(() => finishRun(baseline(), "not_reproduced", "No bug", reportPath)).toThrow();
  });
  it("requires explicit blockers and preserves their explanation", () => {
    expect(() => finishRun(initial(), "blocked", "Stopped", reportPath)).toThrow();
    const state = cite(initial(), {
      kind: "observation",
      purpose: "diagnostic",
      result: "blocked",
      summary: "Missing compiler",
    });
    const finished = finishRun(state, "blocked", "Compiler unavailable", reportPath);
    expect(renderReport(finished)).toContain("Missing compiler");
    expect(() => finishRun(finished, "blocked", "Again", reportPath)).toThrow();
  });
  it("validates summaries and report locations", () => {
    expect(() => finishRun(fixed(), "fixed", " ", reportPath)).toThrow();
    expect(() => finishRun(fixed(), "fixed", "Fixed", "../report.md")).toThrow();
  });
  it("renders deterministic execution links, comparison and baseline metadata", () => {
    const state = finishRun(fixed(), "fixed", "Fixed empty input", reportPath);
    const report = renderReport(state);
    expect(report).toBe(renderReport(state));
    expect(report).toContain("**Outcome:** fixed");
    expect(report).toContain("Execution: call-1");
    expect(report).toContain("Actual: NaN");
    expect(report).toContain("Expected: 0");
    expect(report).toContain("**Baseline commit:**");
    expect(() => renderReport(initial())).toThrow();
  });
});

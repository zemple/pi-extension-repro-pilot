import { describe, expect, it } from "vitest";
import { getRegressionStatus, recordEvidence, recordExecution } from "../src/core/evidence.ts";
import { finishRun } from "../src/core/report.ts";
import { setRunPhase } from "../src/core/run-state.ts";
import {
  changedFingerprint,
  cite,
  execution,
  initial,
  reportPath,
  timestamp,
  verification,
  verified,
} from "./fixtures.ts";

describe("evidence", () => {
  it("copies the observed command, exit code and output instead of model claims", () => {
    const state = cite(execution(initial(), "node --version", 0, "v22.19.0"), {
      kind: "command",
      purpose: "environment",
      summary: "Node version",
    });
    expect(state.evidence[0]).toMatchObject({
      id: "E1",
      executionId: "call-1",
      command: "node --version",
      exitCode: 0,
      output: "v22.19.0",
      result: "passed",
      phase: "triage",
    });
  });
  it("freezes both evidence and executions after completion", () => {
    const state = finishRun(
      verified(verified(verification(true), "regression"), "existing"),
      "fixed",
      "Fixed",
      reportPath,
    );
    expect(() =>
      cite(state, {
        kind: "observation",
        purpose: "diagnostic",
        result: "observed",
        summary: "Too late",
      }),
    ).toThrow();
    expect(() => execution(state)).toThrow();
  });
  it("rejects empty summaries and invalid timestamps", () => {
    expect(() =>
      cite(initial(), {
        kind: "observation",
        purpose: "diagnostic",
        result: "observed",
        summary: " ",
      }),
    ).toThrow();
    expect(() =>
      recordEvidence(
        initial(),
        { kind: "observation", purpose: "diagnostic", result: "observed", summary: "Note" },
        "invalid",
      ),
    ).toThrow();
  });
  it("does not accept an observation in place of an executed test", () => {
    expect(() =>
      cite(verification(), {
        kind: "observation",
        purpose: "verification",
        verificationScope: "existing",
        result: "observed",
        summary: "I think tests pass",
      }),
    ).toThrow();
  });
  it("rejects evidence in the wrong phase and missing regression paths", () => {
    expect(() =>
      cite(execution(initial()), {
        kind: "test",
        purpose: "regression",
        summary: "Fails",
        path: "test.js",
      }),
    ).toThrow();
    const state = setRunPhase(initial(), "reproduce");
    expect(() =>
      cite(execution(state), {
        kind: "command",
        purpose: "reproduction",
        summary: "Bug",
        reproduction: { bugObserved: true, actual: "0", expected: "0" },
      }),
    ).toThrow();
  });
  it.each([null, 1.5, -1, 256])(
    "does not turn an unknown or invalid exit code %s into a passing test",
    (exitCode) => {
      if (exitCode === null) {
        expect(() =>
          cite(execution(initial(), "node test.js", null), {
            kind: "test",
            purpose: "diagnostic",
            summary: "Test",
          }),
        ).toThrow();
      } else {
        expect(() => execution(initial(), "node test.js", exitCode)).toThrow();
      }
    },
  );
  it("rejects duplicate execution IDs, reuse and results from an older execution", () => {
    let state = execution(initial());
    const first = state.executions[0];
    if (!first) throw new Error("Missing execution fixture");
    expect(() => recordExecution(state, first)).toThrow();
    state = cite(state, { kind: "test", purpose: "diagnostic", summary: "Test" });
    expect(() =>
      recordEvidence(
        state,
        { kind: "test", purpose: "diagnostic", summary: "Again", executionId: "call-1" },
        timestamp,
      ),
    ).toThrow();
    state = execution(state);
    expect(() =>
      recordEvidence(
        state,
        { kind: "test", purpose: "diagnostic", summary: "Old", executionId: "call-1" },
        timestamp,
      ),
    ).toThrow();
  });
  it("rejects evidence after workspace changes, including changes caused by the command", () => {
    let state = execution(initial());
    state = { ...state, workspaceFingerprint: changedFingerprint };
    expect(() =>
      cite(state, { kind: "command", purpose: "diagnostic", summary: "Stale" }),
    ).toThrow();
    const first = state.executions[0];
    if (!first) throw new Error("Missing execution fixture");
    const executionRecord = {
      ...first,
      id: "changed",
      workspaceAfter: changedFingerprint,
    };
    state = recordExecution(state, executionRecord);
    expect(() =>
      cite(state, { kind: "command", purpose: "diagnostic", summary: "Changed files" }),
    ).toThrow();
  });
  it("redacts and bounds observed output without truncating the recorded command", () => {
    const command = `node test.js ${"x".repeat(1500)}`;
    const state = cite(
      execution(initial(), command, 0, `ghp_syntheticSecret123 ${"z".repeat(5000)}`),
      { kind: "command", purpose: "diagnostic", summary: "Synthetic token ghp_syntheticSecret123" },
    );
    expect(state.evidence[0]?.command).toBe(command);
    expect(JSON.stringify(state.evidence)).not.toContain("ghp_syntheticSecret123");
    expect(state.evidence[0]?.output?.length).toBeLessThanOrEqual(4000);
  });
  it("shows later failed and stale verification instead of an older passing status", () => {
    const passed = verified(verification(true), "regression");
    expect(getRegressionStatus(passed)).toBe("passing");
    expect(getRegressionStatus(verified(passed, "regression", 1))).toBe("failing");
    expect(getRegressionStatus({ ...passed, workspaceFingerprint: "d".repeat(64) })).toBe(
      "blocked",
    );
  });
});

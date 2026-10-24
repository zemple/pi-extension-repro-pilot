import { type EvidenceInput, recordEvidence, recordExecution } from "../src/core/evidence.ts";
import { createRunState, type RunState, setRunPhase } from "../src/core/run-state.ts";
export const issue = {
  url: "https://github.com/acme/demo/issues/1",
  repository: "acme/demo",
  number: 1,
  title: "Wrong empty total",
  body: "Expected 0, actual NaN",
};
export const workspace = {
  root: "/tmp/repro-target",
  head: "a".repeat(40),
  fingerprint: "b".repeat(64),
};
export const changedFingerprint = "c".repeat(64);
export const timestamp = "2026-10-23T12:00:00.000Z";
export const regressionCommand = "node --test regression.test.js";
export const regressionPath = "regression.test.js";
export function initial(fixRequested = false): RunState {
  return createRunState("run-1", issue, { workspace, fixRequested });
}
export function execution(
  state: RunState,
  command = regressionCommand,
  exitCode: number | null = 0,
  output = "actual=NaN expected=0",
): RunState {
  return recordExecution(state, {
    id: `call-${state.executions.length + 1}`,
    phase: state.phase,
    command,
    exitCode,
    output,
    recordedAt: timestamp,
    workspaceBefore: state.workspaceFingerprint,
    workspaceAfter: state.workspaceFingerprint,
  });
}
export function cite(state: RunState, input: EvidenceInput): RunState {
  const executionId = state.executions.at(-1)?.id;
  return recordEvidence(
    state,
    { ...input, ...(input.kind !== "observation" && executionId ? { executionId } : {}) },
    timestamp,
  );
}
export function baseline(fixRequested = false): RunState {
  let state = setRunPhase(initial(fixRequested), "reproduce");
  state = cite(execution(state, "node repro.js"), {
    kind: "command",
    purpose: "reproduction",
    summary: "Empty total is NaN",
    reproduction: { bugObserved: true, actual: "NaN", expected: "0" },
  });
  state = setRunPhase(state, "test");
  return cite(execution(state, regressionCommand, 1), {
    kind: "test",
    purpose: "regression",
    summary: "Regression fails",
    path: regressionPath,
  });
}
export function verification(fixRequested = false): RunState {
  let state = baseline(fixRequested);
  if (fixRequested) {
    state = setRunPhase(state, "fix");
    state = { ...state, workspaceFingerprint: changedFingerprint };
    state = cite(state, {
      kind: "observation",
      purpose: "fix",
      result: "observed",
      summary: "Changed the empty-input handling",
      path: "source.js",
    });
  }
  return setRunPhase(state, "verify");
}
export function verified(
  state: RunState,
  scope: "regression" | "existing",
  exitCode = 0,
): RunState {
  return cite(
    execution(
      state,
      scope === "regression" ? regressionCommand : "node --test existing.test.js",
      exitCode,
      "test result",
    ),
    {
      kind: "test",
      purpose: "verification",
      verificationScope: scope,
      summary: "Verification result",
      ...(scope === "regression" ? { path: regressionPath } : {}),
    },
  );
}
export const reportPath = ".repro-pilot/runs/run-1/report.md";

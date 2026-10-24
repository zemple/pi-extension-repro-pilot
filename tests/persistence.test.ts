import { describe, expect, it } from "vitest";
import { parseRunState, restoreRunState, runStateEntryType } from "../src/core/persistence.ts";
import { finishRun } from "../src/core/report.ts";
import { setRunPhase } from "../src/core/run-state.ts";
import {
  baseline,
  cite,
  execution,
  initial,
  reportPath,
  verification,
  verified,
} from "./fixtures.ts";

const entry = (data: unknown) => ({ type: "custom", customType: runStateEntryType, data });
function fixed() {
  return finishRun(
    verified(verified(verification(true), "regression"), "existing"),
    "fixed",
    "Fixed",
    reportPath,
  );
}

describe("state restoration", () => {
  it.each([initial(), baseline(), baseline(true), verification(), verification(true), fixed()])(
    "restores a valid $phase/$outcome checkpoint",
    (state) => {
      expect(parseRunState(JSON.parse(JSON.stringify(state)))).toEqual(state);
    },
  );
  it("restores blocked and no-bug outcomes at their actual stopping phase", () => {
    const blocked = finishRun(
      cite(initial(), {
        kind: "observation",
        purpose: "diagnostic",
        result: "blocked",
        summary: "No compiler",
      }),
      "blocked",
      "Blocked",
      reportPath,
    );
    expect(parseRunState(blocked)).toEqual(blocked);
    const state = cite(execution(setRunPhase(initial(), "reproduce")), {
      kind: "command",
      purpose: "reproduction",
      summary: "No bug",
      reproduction: { bugObserved: false, actual: "0", expected: "0" },
    });
    const negative = finishRun(state, "not_reproduced", "No bug", reportPath);
    expect(parseRunState(negative)).toEqual(negative);
  });
  it("rejects evidence-free fixed and illegally advanced checkpoints", () => {
    expect(
      parseRunState({
        ...initial(),
        phase: "report",
        outcome: "fixed",
        finalSummary: "Fixed",
        reportPath,
      }),
    ).toBeUndefined();
    expect(parseRunState({ ...initial(), phase: "verify" })).toBeUndefined();
    expect(parseRunState({ ...initial(), phase: "fix" })).toBeUndefined();
  });
  it("rejects invented execution links and modified command output or exit codes", () => {
    const state = baseline();
    for (const patch of [
      { executionId: "invented" },
      { exitCode: 0 },
      { command: "invented" },
      { output: "invented" },
    ]) {
      expect(
        parseRunState({
          ...state,
          evidence: state.evidence.map((item, i) => (i === 1 ? { ...item, ...patch } : item)),
        }),
      ).toBeUndefined();
    }
  });
  it("rejects duplicate IDs, phase disorder and contradictory final success", () => {
    const state = fixed();
    expect(
      parseRunState({ ...state, executions: [...state.executions, state.executions[0]] }),
    ).toBeUndefined();
    expect(parseRunState({ ...state, evidence: [...state.evidence].reverse() })).toBeUndefined();
    expect(
      parseRunState({
        ...state,
        evidence: state.evidence.map((item, i) => ({ ...item, id: i === 1 ? "E1" : item.id })),
      }),
    ).toBeUndefined();
    expect(parseRunState({ ...state, fixRequested: false })).toBeUndefined();
    expect(parseRunState({ ...state, workspaceFingerprint: "d".repeat(64) })).toBeUndefined();
  });
  it.each([
    null,
    { schemaVersion: 1 },
    { ...initial(), runId: "../escape" },
    { ...initial(), phase: "unknown" },
    { ...initial(), issue: { ...initial().issue, url: "https://example.com" } },
    { ...initial(), issue: { ...initial().issue, title: "x".repeat(501) } },
    { ...initial(), finalSummary: "Too early" },
  ])("rejects malformed, legacy or inconsistent state", (value) => {
    expect(parseRunState(value)).toBeUndefined();
  });
  it("restores only the latest valid checkpoint on the supplied branch", () => {
    const latest = baseline();
    expect(
      restoreRunState([
        entry(initial()),
        entry(latest),
        entry({ ...initial(), phase: "verify" }),
        { type: "custom", customType: "another-extension", data: fixed() },
      ]),
    ).toEqual(latest);
    expect(restoreRunState([])).toBeUndefined();
  });
  it("does not let a later checkpoint grant fix permission or erase earlier evidence", () => {
    const first = baseline();
    const unauthorized = { ...first, fixRequested: true };
    expect(restoreRunState([entry(first), entry(unauthorized)])?.fixRequested).toBe(false);
    const erased = { ...initial(), phase: "reproduce" as const };
    expect(restoreRunState([entry(first), entry(erased)])?.evidence).toHaveLength(2);
  });
});

import { describe, expect, it } from "vitest";
import { recordEvidence } from "../src/core/evidence.ts";
import {
  createRunState,
  type IssueSummary,
  type RunPhase,
  setRunPhase,
} from "../src/core/run-state.ts";

const issue: IssueSummary = {
  url: "https://github.com/acme/calculator/issues/1",
  repository: "acme/calculator",
  number: 1,
  title: "Calculator returns the wrong total for an empty list",
  body: "Calling total([]) should return 0, but it currently returns NaN.",
};

describe("createRunState", () => {
  it("starts a versioned run in triage with no evidence", () => {
    expect(createRunState("run-1", issue)).toEqual({
      schemaVersion: 1,
      runId: "run-1",
      phase: "triage",
      issue,
      evidence: [],
      outcome: "in_progress",
      fixRequested: false,
    });
  });
});

describe("setRunPhase", () => {
  it("requires reproduction evidence before entering test", () => {
    let state = setRunPhase(createRunState("run-1", issue), "reproduce");

    expect(() => setRunPhase(state, "test")).toThrow(
      "Successful executable reproduction evidence is required before entering test",
    );

    state = recordEvidence(
      state,
      {
        kind: "command",
        purpose: "reproduction",
        result: "observed",
        summary: "Empty input returns NaN",
        command: "node reproduce.mjs",
        exitCode: 0,
        output: "NaN",
      },
      "2026-08-25T12:00:00.000Z",
    );

    expect(setRunPhase(state, "test").phase).toBe("test");
  });

  it("does not treat an unsuccessful reproduction attempt as reproduction", () => {
    let state = setRunPhase(createRunState("run-1", issue), "reproduce");
    state = recordEvidence(
      state,
      {
        kind: "command",
        purpose: "reproduction",
        result: "failed",
        summary: "The reproduction command could not run",
        command: "node reproduce.mjs",
        exitCode: 1,
      },
      "2026-08-25T12:00:00.000Z",
    );

    expect(() => setRunPhase(state, "test")).toThrow(
      "Successful executable reproduction evidence is required before entering test",
    );
  });

  it("requires a failing regression test before entering verification", () => {
    let state = createRunState("run-1", issue);
    state = setRunPhase(state, "reproduce");
    state = recordEvidence(
      state,
      {
        kind: "command",
        purpose: "reproduction",
        result: "observed",
        summary: "Bug reproduced",
        command: "node reproduce.mjs",
        exitCode: 0,
      },
      "2026-08-25T12:00:00.000Z",
    );
    state = setRunPhase(state, "test");

    expect(() => setRunPhase(state, "verify")).toThrow(
      "A failing baseline regression test is required",
    );

    state = recordEvidence(
      state,
      {
        kind: "test",
        purpose: "regression",
        result: "failed",
        summary: "Empty-list regression fails against baseline",
        command: "npm test",
        exitCode: 1,
        path: "tests/calculator.test.ts",
      },
      "2026-08-25T12:01:00.000Z",
    );

    expect(setRunPhase(state, "verify").phase).toBe("verify");
  });

  it("requires requested fixes to pass through fix with fix evidence", () => {
    let state = createRunState("run-1", issue, { fixRequested: true });
    state = setRunPhase(state, "reproduce");
    state = recordEvidence(
      state,
      {
        kind: "command",
        purpose: "reproduction",
        result: "observed",
        summary: "Bug reproduced",
        command: "node reproduce.mjs",
        exitCode: 0,
      },
      "2026-08-25T12:00:00.000Z",
    );
    state = setRunPhase(state, "test");
    state = recordEvidence(
      state,
      {
        kind: "test",
        purpose: "regression",
        result: "failed",
        summary: "Regression test fails",
        command: "npm test",
        exitCode: 1,
      },
      "2026-08-25T12:01:00.000Z",
    );

    expect(() => setRunPhase(state, "verify")).toThrow(
      "A requested fix must enter fix before verification",
    );

    state = setRunPhase(state, "fix");
    expect(() => setRunPhase(state, "verify")).toThrow(
      "Positive fix evidence is required before verification",
    );

    state = recordEvidence(
      state,
      {
        kind: "observation",
        purpose: "fix",
        result: "observed",
        summary: "Handled empty input explicitly",
        path: "src/calculator.ts",
      },
      "2026-08-25T12:02:00.000Z",
    );

    expect(setRunPhase(state, "verify").phase).toBe("verify");
  });

  it("does not let observations or blocked attempts replace required workflow evidence", () => {
    let state = createRunState("run-1", issue, { fixRequested: true });
    state = setRunPhase(state, "reproduce");
    state = recordEvidence(
      state,
      {
        kind: "command",
        purpose: "reproduction",
        result: "observed",
        summary: "Bug reproduced",
        command: "node reproduce.mjs",
        exitCode: 0,
      },
      "2026-08-25T12:00:00.000Z",
    );
    state = setRunPhase(state, "test");
    state = recordEvidence(
      state,
      {
        kind: "observation",
        purpose: "regression",
        result: "failed",
        summary: "The model says a regression failed",
      },
      "2026-08-25T12:01:00.000Z",
    );

    expect(() => setRunPhase(state, "fix")).toThrow(
      "A failing baseline regression test is required",
    );

    state = {
      ...state,
      evidence: state.evidence.map((item) =>
        item.purpose === "regression" ? { ...item, result: "blocked" as const } : item,
      ),
    };
    expect(() => setRunPhase(state, "fix")).toThrow(
      "A failing baseline regression test is required",
    );
  });

  it("requires positive fix evidence before verification", () => {
    let state = createRunState("run-1", issue, { fixRequested: true });
    state = setRunPhase(state, "reproduce");
    state = recordEvidence(
      state,
      {
        kind: "command",
        purpose: "reproduction",
        result: "observed",
        summary: "Bug reproduced",
        command: "node reproduce.mjs",
        exitCode: 0,
      },
      "2026-08-25T12:00:00.000Z",
    );
    state = setRunPhase(state, "test");
    state = recordEvidence(
      state,
      {
        kind: "test",
        purpose: "regression",
        result: "failed",
        summary: "Regression fails",
        command: "npm test",
        exitCode: 1,
      },
      "2026-08-25T12:01:00.000Z",
    );
    state = setRunPhase(state, "fix");
    state = recordEvidence(
      state,
      {
        kind: "observation",
        purpose: "fix",
        result: "blocked",
        summary: "Could not apply the fix",
      },
      "2026-08-25T12:02:00.000Z",
    );

    expect(() => setRunPhase(state, "verify")).toThrow(
      "Positive fix evidence is required before verification",
    );
  });

  it.each<[RunPhase, RunPhase]>([
    ["triage", "test"],
    ["reproduce", "triage"],
    ["report", "triage"],
  ])("rejects an invalid %s -> %s transition", (from, to) => {
    const state = { ...createRunState("run-1", issue), phase: from };

    expect(() => setRunPhase(state, to)).toThrow(`Invalid phase transition: ${from} -> ${to}`);
  });
});

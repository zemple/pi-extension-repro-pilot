import { describe, expect, it } from "vitest";

import { parseRunState, restoreRunState, runStateEntryType } from "../src/core/persistence.ts";
import { createRunState, type IssueSummary } from "../src/core/run-state.ts";

const issue: IssueSummary = {
  url: "https://github.com/acme/calculator/issues/1",
  repository: "acme/calculator",
  number: 1,
  title: "Calculator returns the wrong total for an empty list",
  body: "Calling total([]) should return 0, but it currently returns NaN.",
};

describe("parseRunState", () => {
  it("accepts a current state", () => {
    const state = createRunState("run-1", issue, { fixRequested: true });

    expect(parseRunState(state)).toEqual(state);
  });

  it("adds defaults when restoring an early schema-v1 checkpoint", () => {
    const state = {
      schemaVersion: 1,
      runId: "run-1",
      phase: "triage",
      issue,
      evidence: [],
    };

    expect(parseRunState(state)).toEqual({
      ...state,
      outcome: "in_progress",
      fixRequested: false,
    });
  });

  it.each([
    null,
    { schemaVersion: 2 },
    { ...createRunState("run-1", issue), runId: "../escape" },
    { ...createRunState("run-1", issue), phase: "unknown" },
    { ...createRunState("run-1", issue), evidence: [{ kind: "command" }] },
  ])("rejects malformed or unsupported persisted data", (value) => {
    expect(parseRunState(value)).toBeUndefined();
  });

  it("rejects contradictory executable evidence from restored state", () => {
    const state = {
      ...createRunState("run-1", issue),
      evidence: [
        {
          id: "E1",
          phase: "triage",
          recordedAt: "2026-08-25T12:00:00.000Z",
          kind: "test",
          purpose: "diagnostic",
          result: "passed",
          summary: "Contradictory test",
          command: "npm test",
          exitCode: 1,
        },
      ],
    };

    expect(parseRunState(state)).toBeUndefined();
  });

  it.each([
    { field: "title", issue: { ...issue, title: "x".repeat(501) } },
    { field: "body", issue: { ...issue, body: "x".repeat(65_537) } },
  ])("rejects an unbounded issue $field from restored state", ({ issue: restoredIssue }) => {
    const state = createRunState("run-1", restoredIssue);

    expect(parseRunState(state)).toBeUndefined();
  });

  it("requires final metadata only on finished report states", () => {
    const active = createRunState("run-1", issue);
    expect(parseRunState({ ...active, finalSummary: "Too early", reportPath: "report.md" })).toBe(
      undefined,
    );
    expect(parseRunState({ ...active, phase: "report", outcome: "blocked" })).toBeUndefined();
  });
});

describe("restoreRunState", () => {
  it("restores the latest valid state entry on the supplied branch", () => {
    const initial = createRunState("run-1", issue);
    const later = { ...initial, phase: "reproduce" as const };
    const entries = [
      { type: "custom", customType: runStateEntryType, data: initial },
      { type: "message", message: { role: "user", content: "ignored" } },
      { type: "custom", customType: runStateEntryType, data: later },
      { type: "custom", customType: runStateEntryType, data: { invalid: true } },
    ];

    expect(restoreRunState(entries)).toEqual(later);
  });

  it("does not restore entries belonging to another extension", () => {
    const entries = [
      { type: "custom", customType: "other-extension", data: createRunState("run-1", issue) },
    ];

    expect(restoreRunState(entries)).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";

import { type EvidenceInput, recordEvidence } from "../src/core/evidence.ts";
import { createRunState, type IssueSummary, setRunPhase } from "../src/core/run-state.ts";

const issue: IssueSummary = {
  url: "https://github.com/acme/calculator/issues/1",
  repository: "acme/calculator",
  number: 1,
  title: "Calculator returns the wrong total for an empty list",
  body: "Calling total([]) should return 0, but it currently returns NaN.",
};

describe("recordEvidence", () => {
  it("records a typed command result in the current phase", () => {
    const state = createRunState("run-1", issue);

    const updated = recordEvidence(
      state,
      {
        kind: "command",
        purpose: "environment",
        result: "passed",
        summary: "Node version is supported",
        command: "node --version",
        exitCode: 0,
        output: "v20.19.5",
      },
      "2026-08-25T12:00:00.000Z",
    );

    expect(updated.evidence).toEqual([
      {
        id: "E1",
        phase: "triage",
        recordedAt: "2026-08-25T12:00:00.000Z",
        kind: "command",
        purpose: "environment",
        result: "passed",
        summary: "Node version is supported",
        command: "node --version",
        exitCode: 0,
        output: "v20.19.5",
      },
    ]);
  });

  it.each<EvidenceInput>([
    {
      kind: "command",
      purpose: "regression",
      result: "failed",
      summary: "Regression test fails",
      exitCode: 0,
    },
    {
      kind: "test",
      purpose: "regression",
      result: "failed",
      summary: "Regression test fails",
      command: "npm test",
    },
    {
      kind: "test",
      purpose: "regression",
      result: "failed",
      summary: "Regression test fails",
      command: "npm test",
      exitCode: 1.5,
    },
  ])("rejects incomplete executable evidence", (input) => {
    const state = createRunState("run-1", issue);

    expect(() => recordEvidence(state, input, "2026-08-25T12:00:00.000Z")).toThrow(
      "Command and test evidence require a command and integer exit code",
    );
  });

  it("rejects an empty summary", () => {
    const state = createRunState("run-1", issue);

    expect(() =>
      recordEvidence(
        state,
        { kind: "observation", purpose: "diagnostic", result: "observed", summary: "  " },
        "2026-08-25T12:00:00.000Z",
      ),
    ).toThrow("Evidence summary is required");
  });

  it.each([
    { result: "passed" as const, exitCode: 1 },
    { result: "failed" as const, exitCode: 0 },
  ])("rejects $result executable evidence with exit code $exitCode", ({ result, exitCode }) => {
    const state = createRunState("run-1", issue);

    expect(() =>
      recordEvidence(
        state,
        {
          kind: "test",
          purpose: "diagnostic",
          result,
          summary: "Contradictory test result",
          command: "npm test",
          exitCode,
        },
        "2026-08-25T12:00:00.000Z",
      ),
    ).toThrow("Executable evidence result must agree with its exit code");
  });

  it("records workflow evidence only in its matching phase", () => {
    const state = createRunState("run-1", issue);

    expect(() =>
      recordEvidence(
        state,
        {
          kind: "test",
          purpose: "reproduction",
          result: "observed",
          summary: "Empty input returns NaN",
          command: "npm test",
          exitCode: 1,
        },
        "2026-08-25T12:00:00.000Z",
      ),
    ).toThrow("Reproduction evidence must be recorded during reproduce");

    const reproduceState = setRunPhase(state, "reproduce");
    expect(
      recordEvidence(
        reproduceState,
        {
          kind: "test",
          purpose: "reproduction",
          result: "observed",
          summary: "Empty input returns NaN",
          command: "npm test",
          exitCode: 1,
        },
        "2026-08-25T12:00:00.000Z",
      ).evidence[0]?.phase,
    ).toBe("reproduce");
  });

  it("bounds long output and redacts common credentials", () => {
    const state = createRunState("run-1", issue);
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";
    const output = `${"a".repeat(3000)}\nAuthorization: Bearer ${secret}\n${"z".repeat(3000)}`;

    const updated = recordEvidence(
      state,
      {
        kind: "command",
        purpose: "diagnostic",
        result: "passed",
        summary: `Checked token ${secret}`,
        command: `TOKEN=${secret} npm test`,
        exitCode: 0,
        output,
      },
      "2026-08-25T12:00:00.000Z",
    );

    const evidence = updated.evidence[0];
    expect(evidence?.summary).not.toContain(secret);
    expect(evidence?.command).not.toContain(secret);
    expect(evidence?.output).not.toContain(secret);
    expect(evidence?.output).toContain("[truncated");
    expect(evidence?.output?.length).toBeLessThanOrEqual(4000);
  });
});

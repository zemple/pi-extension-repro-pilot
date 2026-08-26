import { describe, expect, it } from "vitest";

import { recordEvidence } from "../src/core/evidence.ts";
import { finishRun, renderReport } from "../src/core/report.ts";
import { createRunState, type IssueSummary, setRunPhase } from "../src/core/run-state.ts";

const issue: IssueSummary = {
  url: "https://github.com/acme/calculator/issues/1",
  repository: "acme/calculator",
  number: 1,
  title: "Calculator returns the wrong total for an empty list",
  body: "Calling total([]) should return 0, but it currently returns NaN.",
};

function reachVerification(fixRequested: boolean) {
  let state = createRunState("run-1", issue, { fixRequested });
  state = setRunPhase(state, "reproduce");
  state = recordEvidence(
    state,
    {
      kind: "command",
      purpose: "reproduction",
      result: "observed",
      summary: "Empty input returns NaN instead of 0",
      command: "node reproduce.mjs",
      exitCode: 0,
      output: "actual=NaN expected=0",
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
      summary: "Empty-list regression fails against baseline",
      command: "npm test",
      exitCode: 1,
      path: "tests/calculator.test.ts",
    },
    "2026-08-25T12:01:00.000Z",
  );

  if (fixRequested) {
    state = setRunPhase(state, "fix");
    state = recordEvidence(
      state,
      {
        kind: "observation",
        purpose: "fix",
        result: "observed",
        summary: "Return zero for an empty input",
        path: "src/calculator.ts",
      },
      "2026-08-25T12:02:00.000Z",
    );
  }

  return setRunPhase(state, "verify");
}

function addPassingVerification(
  state: ReturnType<typeof reachVerification>,
  scope: "regression" | "existing",
) {
  return recordEvidence(
    state,
    {
      kind: "test",
      purpose: "verification",
      verificationScope: scope,
      result: "passed",
      summary: scope === "regression" ? "Regression test passes" : "Existing tests pass",
      command: scope === "regression" ? "npm test -- -t empty" : "npm test",
      exitCode: 0,
    },
    scope === "regression" ? "2026-08-25T12:03:00.000Z" : "2026-08-25T12:04:00.000Z",
  );
}

describe("finishRun", () => {
  it("finishes a reproduction-only run after existing tests are verified", () => {
    let state = reachVerification(false);
    state = addPassingVerification(state, "existing");

    const finished = finishRun(
      state,
      "reproduced",
      "The empty-list bug is reproducible.",
      ".repro-pilot/runs/run-1/report.md",
    );

    expect(finished).toMatchObject({
      phase: "report",
      outcome: "reproduced",
      finalSummary: "The empty-list bug is reproducible.",
      reportPath: ".repro-pilot/runs/run-1/report.md",
    });
  });

  it("requires regression and existing tests to pass before declaring a fix", () => {
    let state = reachVerification(true);
    state = addPassingVerification(state, "regression");

    expect(() => finishRun(state, "fixed", "Fixed.", ".repro-pilot/runs/run-1/report.md")).toThrow(
      "Fixed runs require passing regression and existing-test verification evidence",
    );

    state = addPassingVerification(state, "existing");
    expect(finishRun(state, "fixed", "Fixed.", ".repro-pilot/runs/run-1/report.md").outcome).toBe(
      "fixed",
    );
  });

  it("does not accept observations as passing verification tests", () => {
    let state = reachVerification(true);
    for (const verificationScope of ["regression", "existing"] as const) {
      state = recordEvidence(
        state,
        {
          kind: "observation",
          purpose: "verification",
          verificationScope,
          result: "passed",
          summary: `${verificationScope} supposedly passes`,
        },
        "2026-08-25T12:03:00.000Z",
      );
    }

    expect(() => finishRun(state, "fixed", "Fixed.", "report.md")).toThrow(
      "Fixed runs require passing regression and existing-test verification evidence",
    );
  });

  it("requires positive executable reproduction evidence for successful outcomes", () => {
    let state = reachVerification(false);
    state = addPassingVerification(state, "existing");
    state = {
      ...state,
      evidence: state.evidence.map((item) =>
        item.purpose === "reproduction"
          ? { ...item, result: "failed" as const, exitCode: 1 }
          : item,
      ),
    };

    expect(() => finishRun(state, "reproduced", "Done.", "report.md")).toThrow(
      "Successful runs require positive executable reproduction evidence",
    );
  });

  it("cannot change the outcome of an already finished run", () => {
    let state = reachVerification(false);
    state = addPassingVerification(state, "existing");
    state = finishRun(state, "reproduced", "Reproduced.", "report.md");

    expect(() => finishRun(state, "blocked", "Changed.", "report.md")).toThrow(
      "Run is already finished",
    );
  });

  it("allows an honestly blocked run to report early", () => {
    let state = createRunState("run-1", issue);
    state = recordEvidence(
      state,
      {
        kind: "observation",
        purpose: "diagnostic",
        result: "blocked",
        summary: "Target repository is not the current checkout",
      },
      "2026-08-25T12:00:00.000Z",
    );

    expect(
      finishRun(state, "blocked", "The target source is unavailable.", "report.md"),
    ).toMatchObject({ phase: "report", outcome: "blocked" });
  });

  it("rejects a success outcome without evidence", () => {
    const state = createRunState("run-1", issue);

    expect(() => finishRun(state, "reproduced", "Done.", "report.md")).toThrow(
      "Reproduced runs must finish verification",
    );
  });

  it("rejects a not-reproduced outcome without a failed reproduction attempt", () => {
    const state = createRunState("run-1", issue);

    expect(() => finishRun(state, "not_reproduced", "Not reproduced.", "report.md")).toThrow(
      "Not-reproduced runs require a failed or blocked reproduction attempt",
    );
  });
});

describe("renderReport", () => {
  it("renders a deterministic report from structured fixed state", () => {
    let state = reachVerification(true);
    state = addPassingVerification(state, "regression");
    state = addPassingVerification(state, "existing");
    state = finishRun(state, "fixed", "Empty lists now return zero.", "report.md");

    const report = renderReport(state);

    expect(report).toContain("# ReproPilot Report");
    expect(report).toContain("**Outcome:** fixed");
    expect(report).toContain("## Reproduction");
    expect(report).toContain("## Regression Test");
    expect(report).toContain("## Fix");
    expect(report).toContain("## Verification");
    expect(report).toContain("### E1 — reproduction / observed");
    expect(report).toContain("`node reproduce.mjs`");
    expect(report).toContain("actual=NaN expected=0");
  });

  it("refuses to render an unfinished state", () => {
    expect(() => renderReport(createRunState("run-1", issue))).toThrow(
      "Only a finished run can be rendered",
    );
  });
});

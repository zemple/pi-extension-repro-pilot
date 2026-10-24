import {
  type Evidence,
  isFailedRegressionEvidence,
  isPassingVerificationEvidence,
  isPositiveFixEvidence,
  isPositiveReproductionEvidence,
  latestVerification,
  sanitizeText,
} from "./evidence.ts";
import type { RunOutcome, RunState } from "./run-state.ts";

export type FinalOutcome = Exclude<RunOutcome, "in_progress">;

function hasEvidence(state: RunState, predicate: (evidence: Evidence) => boolean): boolean {
  return state.evidence.some(predicate);
}

export function finishRun(
  state: RunState,
  outcome: FinalOutcome,
  summary: string,
  reportPath: string,
): RunState {
  if (state.phase === "report" || state.outcome !== "in_progress") {
    throw new Error("Run is already finished");
  }

  const finalSummary = sanitizeText(summary.trim(), 1000);
  if (!finalSummary) throw new Error("Final summary is required");
  if (!reportPath.trim()) throw new Error("Report path is required");

  const hasReproduction = state.evidence.some(isPositiveReproductionEvidence);
  const hasRegressionFailure = state.evidence.some(isFailedRegressionEvidence);
  const regression = latestVerification(state, "regression");
  const existing = latestVerification(state, "existing");
  const baseline = [...state.evidence].reverse().find(isFailedRegressionEvidence);
  const sameRegression =
    regression &&
    baseline &&
    regression.path === baseline.path &&
    regression.command === baseline.command;
  const existingPassed = existing && isPassingVerificationEvidence(existing, "existing");
  if (reportPath !== `.repro-pilot/runs/${state.runId}/report.md`)
    throw new Error("Invalid report path for this run");

  if (outcome === "blocked") {
    if (
      !hasEvidence(
        state,
        (item) =>
          item.result === "blocked" &&
          item.phase === state.phase &&
          item.workspaceFingerprint === state.workspaceFingerprint,
      )
    )
      throw new Error("Blocked runs require a current blocker on the current workspace");
  } else if (outcome === "not_reproduced") {
    const negative = state.evidence.some((item) => {
      const latest = [...state.executions]
        .reverse()
        .find((execution) => execution.command === item.command);
      return (
        item.purpose === "reproduction" &&
        item.reproduction?.bugObserved === false &&
        item.exitCode === 0 &&
        item.workspaceFingerprint === state.workspaceFingerprint &&
        latest?.id === item.executionId
      );
    });
    if (state.phase !== "reproduce" || !negative || hasReproduction)
      throw new Error(
        "Not-reproduced runs require a completed no-bug reproduction, without positive reproduction evidence",
      );
  } else {
    if (state.phase !== "verify") throw new Error("Successful runs must finish verification");
    if (!hasReproduction || !hasRegressionFailure)
      throw new Error(
        "Successful runs require reproduction and a failing baseline regression test",
      );
    if (!existingPassed || !sameRegression)
      throw new Error(
        "Successful runs require current regression and existing-test verification evidence",
      );
    if (outcome === "reproduced") {
      if (state.fixRequested || state.evidence.some(isPositiveFixEvidence))
        throw new Error("A fix-enabled run cannot finish as reproduction only");
      if (
        regression.result !== "failed" ||
        baseline.workspaceFingerprint !== state.workspaceFingerprint
      )
        throw new Error("Reproduction-only verification must still fail on the unchanged baseline");
    } else {
      if (!isPassingVerificationEvidence(regression, "regression"))
        throw new Error(
          "Fixed runs require passing regression and existing-test verification evidence",
        );
      if (
        !state.fixRequested ||
        !state.evidence.some(isPositiveFixEvidence) ||
        !state.fixBaselineFingerprint ||
        state.fixBaselineFingerprint === state.workspaceFingerprint
      )
        throw new Error(
          "Fixed runs require a requested fix, fix evidence, and an actual workspace change",
        );
    }
  }

  return {
    ...state,
    phase: "report",
    outcome,
    finalSummary,
    reportPath: reportPath.trim(),
  };
}

function renderEvidenceList(items: readonly Evidence[]): string {
  if (items.length === 0) return "_No structured evidence recorded._";
  return items.map((item) => `- **${item.id}** [${item.result}] ${item.summary}`).join("\n");
}

function renderEvidenceDetails(evidence: Evidence): string {
  const lines = [
    `### ${evidence.id} — ${evidence.purpose} / ${evidence.result}`,
    "",
    `- Phase: ${evidence.phase}`,
    `- Kind: ${evidence.kind}`,
    `- Recorded: ${evidence.recordedAt}`,
    `- Summary: ${evidence.summary}`,
  ];
  if (evidence.executionId) lines.push(`- Execution: ${evidence.executionId}`);
  if (evidence.reproduction)
    lines.push(
      `- Bug observed: ${evidence.reproduction.bugObserved ? "yes" : "no"}`,
      `- Actual: ${evidence.reproduction.actual}`,
      `- Expected: ${evidence.reproduction.expected}`,
    );
  if (evidence.path) lines.push(`- Path: \`${evidence.path}\``);
  if (evidence.command) lines.push(`- Command: \`${evidence.command.replaceAll("`", "\\`")}\``);
  if (evidence.exitCode !== undefined) lines.push(`- Exit code: ${evidence.exitCode}`);
  if (evidence.output) lines.push("", "```text", evidence.output, "```");
  return lines.join("\n");
}

export function renderReport(state: RunState): string {
  if (state.phase !== "report" || state.outcome === "in_progress") {
    throw new Error("Only a finished run can be rendered");
  }

  const byPurpose = (purpose: Evidence["purpose"]) =>
    state.evidence.filter((item) => item.purpose === purpose);
  const report = [
    "# ReproPilot Report",
    "",
    `**Run:** ${state.runId}`,
    `**Issue:** ${state.issue.repository}#${state.issue.number} — ${state.issue.title}`,
    `**Source:** ${state.issue.url}`,
    `**Outcome:** ${state.outcome}`,
    `**Baseline commit:** ${state.workspace.head}`,
    `**Workspace fingerprint:** ${state.workspaceFingerprint}`,
    `**Fix requested:** ${state.fixRequested ? "yes" : "no"}`,
    "",
    "## Summary",
    "",
    state.finalSummary ?? "",
    "",
    "## Reproduction",
    "",
    renderEvidenceList([
      ...byPurpose("environment"),
      ...byPurpose("reproduction"),
      ...byPurpose("diagnostic"),
    ]),
    "",
    "## Regression Test",
    "",
    renderEvidenceList(byPurpose("regression")),
    "",
    "## Fix",
    "",
    renderEvidenceList(byPurpose("fix")),
    "",
    "## Verification",
    "",
    renderEvidenceList(byPurpose("verification")),
    "",
    "## Evidence Details",
    "",
    ...state.evidence.flatMap((item) => [renderEvidenceDetails(item), ""]),
  ];
  return `${report.join("\n").trimEnd()}\n`;
}

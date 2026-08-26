import {
  type Evidence,
  isFailedRegressionEvidence,
  isPassingVerificationEvidence,
  isPositiveFixEvidence,
  isPositiveReproductionEvidence,
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
  const regressionPassed = state.evidence.some((item) =>
    isPassingVerificationEvidence(item, "regression"),
  );
  const existingPassed = state.evidence.some((item) =>
    isPassingVerificationEvidence(item, "existing"),
  );

  if (outcome === "blocked") {
    if (!hasEvidence(state, (item) => item.result === "blocked")) {
      throw new Error("Blocked runs require blocked evidence");
    }
  } else if (outcome === "not_reproduced") {
    if (
      !hasEvidence(
        state,
        (item) =>
          item.purpose === "reproduction" &&
          (item.kind === "command" || item.kind === "test") &&
          (item.result === "failed" || item.result === "blocked"),
      )
    ) {
      throw new Error("Not-reproduced runs require a failed or blocked reproduction attempt");
    }
  } else if (outcome === "reproduced") {
    if (state.phase !== "verify") {
      throw new Error("Reproduced runs must finish verification");
    }
    if (!hasReproduction) {
      throw new Error("Successful runs require positive executable reproduction evidence");
    }
    if (!hasRegressionFailure) {
      throw new Error("Successful runs require a failing baseline regression test");
    }
    if (!existingPassed) {
      throw new Error("Successful runs require passing existing-test verification evidence");
    }
  } else {
    if (state.phase !== "verify") throw new Error("Fixed runs must finish verification");
    if (!hasReproduction || !hasRegressionFailure) {
      throw new Error("Fixed runs require reproduction and a failing baseline regression test");
    }
    if (!regressionPassed || !existingPassed) {
      throw new Error(
        "Fixed runs require passing regression and existing-test verification evidence",
      );
    }
    if (!state.fixRequested || !state.evidence.some(isPositiveFixEvidence)) {
      throw new Error("Fixed runs require a requested fix and fix evidence");
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

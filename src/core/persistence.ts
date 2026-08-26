import { isEvidence } from "./evidence.ts";
import type { IssueSummary, RunOutcome, RunPhase, RunState } from "./run-state.ts";

export const runStateEntryType = "repro-pilot-state";

const phases: readonly RunPhase[] = ["triage", "reproduce", "test", "fix", "verify", "report"];
const outcomes: readonly RunOutcome[] = [
  "in_progress",
  "reproduced",
  "not_reproduced",
  "blocked",
  "fixed",
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseIssue(value: unknown): IssueSummary | undefined {
  if (!isObject(value)) return undefined;
  if (
    typeof value.url !== "string" ||
    !value.url ||
    typeof value.repository !== "string" ||
    !value.repository ||
    !Number.isInteger(value.number) ||
    (value.number as number) <= 0 ||
    typeof value.title !== "string" ||
    !value.title ||
    value.title.length > 500 ||
    typeof value.body !== "string" ||
    value.body.length > 65_536
  ) {
    return undefined;
  }

  return {
    url: value.url,
    repository: value.repository,
    number: value.number as number,
    title: value.title,
    body: value.body,
  };
}

export function parseRunState(value: unknown): RunState | undefined {
  if (!isObject(value) || value.schemaVersion !== 1) return undefined;
  if (typeof value.runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(value.runId)) {
    return undefined;
  }
  if (typeof value.phase !== "string" || !phases.includes(value.phase as RunPhase)) {
    return undefined;
  }
  const issue = parseIssue(value.issue);
  if (!issue || !Array.isArray(value.evidence) || !value.evidence.every(isEvidence)) {
    return undefined;
  }

  const outcome = value.outcome ?? "in_progress";
  const fixRequested = value.fixRequested ?? false;
  if (
    typeof outcome !== "string" ||
    !outcomes.includes(outcome as RunOutcome) ||
    typeof fixRequested !== "boolean" ||
    (value.finalSummary !== undefined && typeof value.finalSummary !== "string") ||
    (value.reportPath !== undefined && typeof value.reportPath !== "string")
  ) {
    return undefined;
  }
  if ((value.phase === "report") !== (outcome !== "in_progress")) return undefined;
  if (value.phase === "report") {
    if (
      typeof value.finalSummary !== "string" ||
      !value.finalSummary.trim() ||
      value.finalSummary.length > 1000 ||
      typeof value.reportPath !== "string" ||
      !value.reportPath.trim() ||
      value.reportPath.length > 1000
    ) {
      return undefined;
    }
  } else if (value.finalSummary !== undefined || value.reportPath !== undefined) {
    return undefined;
  }

  const state: RunState = {
    schemaVersion: 1,
    runId: value.runId,
    phase: value.phase as RunPhase,
    issue,
    evidence: value.evidence,
    outcome: outcome as RunOutcome,
    fixRequested,
  };
  if (typeof value.finalSummary === "string") state.finalSummary = value.finalSummary;
  if (typeof value.reportPath === "string") state.reportPath = value.reportPath;
  return state;
}

export function restoreRunState(entries: readonly unknown[]): RunState | undefined {
  let restored: RunState | undefined;
  for (const entry of entries) {
    if (!isObject(entry) || entry.type !== "custom" || entry.customType !== runStateEntryType) {
      continue;
    }
    const parsed = parseRunState(entry.data);
    if (parsed) restored = parsed;
  }
  return restored;
}

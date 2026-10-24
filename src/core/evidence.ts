import type { RunPhase, RunState } from "./run-state.ts";

export type EvidenceKind = "command" | "test" | "observation";
export type EvidencePurpose =
  | "environment"
  | "reproduction"
  | "regression"
  | "fix"
  | "verification"
  | "diagnostic";
export type EvidenceResult = "passed" | "failed" | "observed" | "blocked";
export type VerificationScope = "regression" | "existing";

export interface ReproductionComparison {
  bugObserved: boolean;
  actual: string;
  expected: string;
}

// Only the adapter creates executions, from Pi tool events. The model references their IDs.
export interface Execution {
  id: string;
  phase: RunPhase;
  command: string;
  exitCode: number | null;
  output: string;
  recordedAt: string;
  workspaceBefore: string;
  workspaceAfter: string;
}

export interface EvidenceInput {
  kind: EvidenceKind;
  purpose: EvidencePurpose;
  summary: string;
  result?: EvidenceResult;
  executionId?: string;
  reproduction?: ReproductionComparison;
  path?: string;
  verificationScope?: VerificationScope;
}

export interface Evidence extends EvidenceInput {
  id: string;
  phase: RunPhase;
  recordedAt: string;
  result: EvidenceResult;
  workspaceFingerprint: string;
  command?: string;
  exitCode?: number;
  output?: string;
}

export const phases = ["triage", "reproduce", "test", "fix", "verify", "report"] as const;
export const evidenceKinds = ["command", "test", "observation"] as const;
export const evidencePurposes = [
  "environment",
  "reproduction",
  "regression",
  "fix",
  "verification",
  "diagnostic",
] as const;
export const evidenceResults = ["passed", "failed", "observed", "blocked"] as const;
export const verificationScopes = ["regression", "existing"] as const;
export const maximumCommandLength = 16_000;
const requiredPhaseByPurpose: Partial<Record<EvidencePurpose, RunPhase>> = {
  reproduction: "reproduce",
  regression: "test",
  fix: "fix",
  verification: "verify",
};

export function sanitizeText(value: string, maximum: number): string {
  const redacted = value
    .replace(/\b(?:ghp_|github_pat_)[A-Za-z0-9_]+\b/gu, "[REDACTED]")
    .replace(/(Authorization:\s*Bearer\s+)\S+/giu, "$1[REDACTED]")
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)[A-Z0-9_]*)=([^\s]+)/gu,
      "$1=[REDACTED]",
    );
  if (redacted.length <= maximum) return redacted;
  const marker = "\n...[truncated]...\n";
  const available = maximum - marker.length;
  return `${redacted.slice(0, Math.ceil(available / 2))}${marker}${redacted.slice(-Math.floor(available / 2))}`;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function comparisonValid(value: unknown): value is ReproductionComparison {
  return (
    isObject(value) &&
    typeof value.bugObserved === "boolean" &&
    text(value.actual, 1000) &&
    text(value.expected, 1000) &&
    (!value.bugObserved || value.actual.trim() !== value.expected.trim())
  );
}

export function isExecution(value: unknown): value is Execution {
  return (
    isObject(value) &&
    text(value.id, 200) &&
    Object.keys(value).every((key) =>
      [
        "id",
        "phase",
        "command",
        "exitCode",
        "output",
        "recordedAt",
        "workspaceBefore",
        "workspaceAfter",
      ].includes(key),
    ) &&
    phases.some((phase) => phase === value.phase && phase !== "report") &&
    text(value.command, maximumCommandLength) &&
    (value.exitCode === null ||
      (Number.isInteger(value.exitCode) &&
        Number(value.exitCode) >= 0 &&
        Number(value.exitCode) <= 255)) &&
    typeof value.output === "string" &&
    value.output.length <= 4000 &&
    text(value.recordedAt, 40) &&
    !Number.isNaN(Date.parse(value.recordedAt)) &&
    text(value.workspaceBefore, 200) &&
    /^[a-f0-9]{64}$/u.test(value.workspaceBefore) &&
    text(value.workspaceAfter, 200) &&
    /^[a-f0-9]{64}$/u.test(value.workspaceAfter) &&
    sanitizeText(value.command, maximumCommandLength) === value.command &&
    sanitizeText(value.output, 4000) === value.output
  );
}

export function assertActive(state: RunState): void {
  if (state.phase === "report" || state.outcome !== "in_progress")
    throw new Error("Run is already finished");
}

export function recordExecution(state: RunState, execution: Execution): RunState {
  assertActive(state);
  if (execution.command.length > maximumCommandLength)
    throw new Error("Command is too long to record exactly");
  execution = {
    ...execution,
    command: sanitizeText(execution.command, maximumCommandLength),
    output: sanitizeText(execution.output, 4000),
  };
  if (!isExecution(execution) || execution.phase !== state.phase)
    throw new Error("Invalid execution record");
  if (state.executions.some((item) => item.id === execution.id))
    throw new Error("Duplicate execution ID");
  return {
    ...state,
    workspaceFingerprint: execution.workspaceAfter,
    executions: [...state.executions, execution],
  };
}

export function recordEvidence(
  state: RunState,
  input: EvidenceInput,
  recordedAt: string,
): RunState {
  assertActive(state);
  if (!evidenceKinds.includes(input.kind) || !evidencePurposes.includes(input.purpose))
    throw new Error("Invalid evidence kind or purpose");
  if (!input.summary?.trim()) throw new Error("Evidence summary is required");
  if (Number.isNaN(Date.parse(recordedAt))) throw new Error("Invalid evidence timestamp");
  const requiredPhase = requiredPhaseByPurpose[input.purpose];
  if (requiredPhase && state.phase !== requiredPhase)
    throw new Error(`${input.purpose} evidence must be recorded during ${requiredPhase}`);
  if (
    input.verificationScope !== undefined &&
    !verificationScopes.includes(input.verificationScope)
  )
    throw new Error("Invalid verification scope");
  if (input.purpose === "verification" && (input.kind !== "test" || !input.verificationScope))
    throw new Error("Verification requires a test and scope");
  if (input.purpose === "regression" && input.kind !== "test")
    throw new Error("Regression evidence requires a test");
  if (
    (input.purpose === "regression" || input.verificationScope === "regression") &&
    !input.path?.trim()
  )
    throw new Error("Regression test path is required");
  if (
    input.reproduction !== undefined &&
    (input.purpose !== "reproduction" || !comparisonValid(input.reproduction))
  )
    throw new Error("Invalid actual/expected comparison");
  let execution: Execution | undefined;
  let result = input.result;
  if (input.kind === "observation") {
    if (input.executionId || input.purpose === "reproduction")
      throw new Error("Reproduction requires executable evidence");
    if (result !== "observed" && result !== "blocked")
      throw new Error("Observations must be observed or blocked");
  } else {
    execution = state.executions.find((item) => item.id === input.executionId);
    if (!execution || execution.exitCode === null)
      throw new Error("Reference an observed execution with a known exit code");
    if (
      execution.phase !== state.phase ||
      execution.workspaceBefore !== execution.workspaceAfter ||
      execution.workspaceAfter !== state.workspaceFingerprint
    )
      throw new Error(
        "Execution is stale, changed the workspace, or belongs to another phase; run the command again",
      );
    const latest = [...state.executions]
      .reverse()
      .find((item) => item.command === execution?.command);
    if (latest?.id !== execution.id) throw new Error("A newer execution exists; use its result");
    if (state.evidence.some((item) => item.executionId === execution?.id))
      throw new Error("Execution has already been recorded as evidence");
    result = execution.exitCode === 0 ? "passed" : "failed";
    if (input.result !== undefined && input.result !== result)
      throw new Error("Execution result is determined by Pi, not the model");
    if (input.purpose === "reproduction" && !comparisonValid(input.reproduction))
      throw new Error("Reproduction requires actual, expected, and bugObserved");
    if (input.reproduction?.bugObserved === false && execution.exitCode !== 0)
      throw new Error(
        "A failed command cannot establish that the bug is absent; record a blocker instead",
      );
  }
  if (!result) throw new Error("Evidence result is required");
  const evidence: Evidence = {
    id: `E${state.evidence.length + 1}`,
    phase: state.phase,
    recordedAt,
    kind: input.kind,
    purpose: input.purpose,
    result,
    summary: sanitizeText(input.summary.trim(), 500),
    workspaceFingerprint: state.workspaceFingerprint,
  };
  if (execution) {
    evidence.executionId = execution.id;
    evidence.command = execution.command;
    evidence.exitCode = execution.exitCode as number;
    evidence.output = execution.output;
  }
  if (input.path !== undefined) evidence.path = sanitizeText(input.path.trim(), 1000);
  if (input.verificationScope !== undefined) evidence.verificationScope = input.verificationScope;
  if (input.reproduction)
    evidence.reproduction = {
      bugObserved: input.reproduction.bugObserved,
      actual: sanitizeText(input.reproduction.actual.trim(), 1000),
      expected: sanitizeText(input.reproduction.expected.trim(), 1000),
    };
  return { ...state, evidence: [...state.evidence, evidence] };
}

export function isPositiveReproductionEvidence(evidence: Evidence): boolean {
  return (
    evidence.purpose === "reproduction" &&
    evidence.kind !== "observation" &&
    evidence.reproduction?.bugObserved === true
  );
}

export function isFailedRegressionEvidence(evidence: Evidence): boolean {
  return (
    evidence.purpose === "regression" &&
    evidence.kind === "test" &&
    evidence.result === "failed" &&
    evidence.exitCode !== 0
  );
}

export function isPositiveFixEvidence(evidence: Evidence): boolean {
  return (
    evidence.purpose === "fix" && (evidence.result === "observed" || evidence.result === "passed")
  );
}

export function isPassingVerificationEvidence(
  evidence: Evidence,
  scope: VerificationScope,
): boolean {
  return (
    evidence.purpose === "verification" &&
    evidence.kind === "test" &&
    evidence.verificationScope === scope &&
    evidence.result === "passed" &&
    evidence.exitCode === 0
  );
}

export function latestVerification(
  state: RunState,
  scope: VerificationScope,
): Evidence | undefined {
  const candidates = state.evidence.filter(
    (item) => item.purpose === "verification" && item.verificationScope === scope,
  );
  // Execution order, not the order in which the model chooses to cite results.
  const latest = candidates.sort(
    (a, b) =>
      state.executions.findIndex((item) => item.id === b.executionId) -
      state.executions.findIndex((item) => item.id === a.executionId),
  )[0];
  if (!latest || latest.workspaceFingerprint !== state.workspaceFingerprint) return undefined;
  const latestExecution = [...state.executions]
    .reverse()
    .find((item) => item.command === latest.command);
  return latestExecution &&
    latestExecution.exitCode === latest.exitCode &&
    latestExecution.workspaceBefore === latestExecution.workspaceAfter &&
    latestExecution.workspaceAfter === state.workspaceFingerprint
    ? latest
    : undefined;
}

export function getRegressionStatus(
  state: RunState,
): "not_started" | "failing" | "passing" | "blocked" {
  const verification = latestVerification(state, "regression");
  if (verification)
    return isPassingVerificationEvidence(verification, "regression") ? "passing" : "failing";
  if (
    state.evidence.some(
      (item) => item.purpose === "verification" && item.verificationScope === "regression",
    )
  )
    return "blocked";
  return state.evidence.some(isFailedRegressionEvidence) ? "failing" : "not_started";
}

export function getFixStatus(state: RunState): "not_started" | "applied" {
  return state.evidence.some(isPositiveFixEvidence) ? "applied" : "not_started";
}

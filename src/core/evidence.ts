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

export interface EvidenceInput {
  kind: EvidenceKind;
  purpose: EvidencePurpose;
  result: EvidenceResult;
  summary: string;
  command?: string;
  exitCode?: number;
  output?: string;
  path?: string;
  verificationScope?: VerificationScope;
}

export interface Evidence extends EvidenceInput {
  id: string;
  phase: RunPhase;
  recordedAt: string;
}

const maxSummaryLength = 500;
const maxCommandLength = 1000;
const maxPathLength = 1000;
const maxOutputLength = 4000;

const evidenceKinds: readonly EvidenceKind[] = ["command", "test", "observation"];
const evidencePurposes: readonly EvidencePurpose[] = [
  "environment",
  "reproduction",
  "regression",
  "fix",
  "verification",
  "diagnostic",
];
const evidenceResults: readonly EvidenceResult[] = ["passed", "failed", "observed", "blocked"];
const verificationScopes: readonly VerificationScope[] = ["regression", "existing"];
const requiredPhaseByPurpose: Partial<Record<EvidencePurpose, RunPhase>> = {
  reproduction: "reproduce",
  regression: "test",
  fix: "fix",
  verification: "verify",
};

function redact(value: string): string {
  return value
    .replace(/\b(?:ghp_|github_pat_)[A-Za-z0-9_]+\b/gu, "[REDACTED]")
    .replace(/(Authorization:\s*Bearer\s+)\S+/giu, "$1[REDACTED]")
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)[A-Z0-9_]*)=([^\s]+)/gu,
      "$1=[REDACTED]",
    );
}

function bound(value: string, maximum: number): string {
  const redacted = redact(value);
  if (redacted.length <= maximum) {
    return redacted;
  }

  const omitted = redacted.length - maximum;
  const marker = `\n...[truncated ${omitted} characters]...\n`;
  const available = maximum - marker.length;
  const headLength = Math.ceil(available / 2);
  const tailLength = Math.floor(available / 2);
  return `${redacted.slice(0, headLength)}${marker}${redacted.slice(-tailLength)}`;
}

function optionalBounded(value: string | undefined, maximum: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return bound(value, maximum);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function executableResultAgrees(
  kind: EvidenceKind,
  result: EvidenceResult,
  exitCode: number | undefined,
): boolean {
  if (kind === "observation") return true;
  if (result === "passed") return exitCode === 0;
  if (result === "failed") return exitCode !== 0;
  return true;
}

export function sanitizeText(value: string, maximum: number): string {
  return bound(value, maximum);
}

export function isEvidence(value: unknown): value is Evidence {
  if (!isObject(value)) return false;
  if (typeof value.id !== "string" || !/^E[1-9]\d*$/u.test(value.id)) return false;
  if (
    typeof value.phase !== "string" ||
    !["triage", "reproduce", "test", "fix", "verify", "report"].includes(value.phase)
  ) {
    return false;
  }
  if (typeof value.recordedAt !== "string" || Number.isNaN(Date.parse(value.recordedAt))) {
    return false;
  }
  if (
    typeof value.kind !== "string" ||
    !evidenceKinds.includes(value.kind as EvidenceKind) ||
    typeof value.purpose !== "string" ||
    !evidencePurposes.includes(value.purpose as EvidencePurpose) ||
    typeof value.result !== "string" ||
    !evidenceResults.includes(value.result as EvidenceResult) ||
    typeof value.summary !== "string" ||
    value.summary.length === 0 ||
    value.summary.length > maxSummaryLength
  ) {
    return false;
  }
  if (
    (value.kind === "command" || value.kind === "test") &&
    (typeof value.command !== "string" || !value.command || !Number.isInteger(value.exitCode))
  ) {
    return false;
  }
  if (
    value.command !== undefined &&
    (typeof value.command !== "string" || value.command.length > maxCommandLength)
  ) {
    return false;
  }
  if (
    value.output !== undefined &&
    (typeof value.output !== "string" || value.output.length > maxOutputLength)
  ) {
    return false;
  }
  if (
    value.path !== undefined &&
    (typeof value.path !== "string" || value.path.length > maxPathLength)
  ) {
    return false;
  }
  if (value.exitCode !== undefined && !Number.isInteger(value.exitCode)) return false;
  if (
    !executableResultAgrees(
      value.kind as EvidenceKind,
      value.result as EvidenceResult,
      value.exitCode as number | undefined,
    )
  ) {
    return false;
  }
  if (
    value.verificationScope !== undefined &&
    (typeof value.verificationScope !== "string" ||
      !verificationScopes.includes(value.verificationScope as VerificationScope))
  ) {
    return false;
  }
  const requiredPhase = requiredPhaseByPurpose[value.purpose as EvidencePurpose];
  if (requiredPhase !== undefined && value.phase !== requiredPhase) return false;
  return true;
}

export function recordEvidence(
  state: RunState,
  input: EvidenceInput,
  recordedAt: string,
): RunState {
  const summary = input.summary.trim();
  if (!summary) {
    throw new Error("Evidence summary is required");
  }

  if (
    (input.kind === "command" || input.kind === "test") &&
    (!input.command?.trim() || !Number.isInteger(input.exitCode))
  ) {
    throw new Error("Command and test evidence require a command and integer exit code");
  }

  if (!executableResultAgrees(input.kind, input.result, input.exitCode)) {
    throw new Error("Executable evidence result must agree with its exit code");
  }

  if (Number.isNaN(Date.parse(recordedAt))) {
    throw new Error("Evidence timestamp must be an ISO date string");
  }

  const requiredPhase = requiredPhaseByPurpose[input.purpose];
  if (requiredPhase !== undefined && state.phase !== requiredPhase) {
    const label = input.purpose[0]?.toUpperCase() + input.purpose.slice(1);
    throw new Error(`${label} evidence must be recorded during ${requiredPhase}`);
  }

  const evidence: Evidence = {
    id: `E${state.evidence.length + 1}`,
    phase: state.phase,
    recordedAt,
    kind: input.kind,
    purpose: input.purpose,
    result: input.result,
    summary: bound(summary, maxSummaryLength),
  };

  const command = optionalBounded(input.command?.trim(), maxCommandLength);
  const output = optionalBounded(input.output, maxOutputLength);
  const path = optionalBounded(input.path?.trim(), maxPathLength);
  if (command !== undefined) evidence.command = command;
  if (input.exitCode !== undefined) evidence.exitCode = input.exitCode;
  if (output !== undefined) evidence.output = output;
  if (path !== undefined) evidence.path = path;
  if (input.verificationScope !== undefined) {
    evidence.verificationScope = input.verificationScope;
  }

  return { ...state, evidence: [...state.evidence, evidence] };
}

export function isPositiveReproductionEvidence(evidence: Evidence): boolean {
  return (
    evidence.purpose === "reproduction" &&
    (evidence.kind === "command" || evidence.kind === "test") &&
    (evidence.result === "observed" || evidence.result === "passed")
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

export function getRegressionStatus(
  state: RunState,
): "not_started" | "failing" | "passing" | "blocked" {
  const findLastMatching = (predicate: (item: Evidence) => boolean): Evidence | undefined => {
    for (let index = state.evidence.length - 1; index >= 0; index -= 1) {
      const item = state.evidence[index];
      if (item && predicate(item)) return item;
    }
    return undefined;
  };
  const regressionVerification = findLastMatching(
    (item) => item.purpose === "verification" && item.verificationScope === "regression",
  );
  if (
    regressionVerification &&
    isPassingVerificationEvidence(regressionVerification, "regression")
  ) {
    return "passing";
  }
  if (regressionVerification?.result === "blocked") return "blocked";

  const baseline = findLastMatching((item) => item.purpose === "regression");
  if (baseline && isFailedRegressionEvidence(baseline)) return "failing";
  if (baseline?.result === "blocked") return "blocked";
  return "not_started";
}

export function getFixStatus(state: RunState): "not_started" | "applied" {
  return state.evidence.some(isPositiveFixEvidence) ? "applied" : "not_started";
}

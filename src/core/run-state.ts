import {
  assertActive,
  type Evidence,
  type Execution,
  isFailedRegressionEvidence,
  isPositiveFixEvidence,
  isPositiveReproductionEvidence,
} from "./evidence.ts";

export type RunPhase = "triage" | "reproduce" | "test" | "fix" | "verify" | "report";
export type RunOutcome = "in_progress" | "reproduced" | "not_reproduced" | "blocked" | "fixed";
export interface IssueSummary {
  url: string;
  repository: string;
  number: number;
  title: string;
  body: string;
}
export interface WorkspaceSnapshot {
  root: string;
  head: string;
  fingerprint: string;
}
export interface RunState {
  schemaVersion: 2;
  runId: string;
  phase: RunPhase;
  issue: IssueSummary;
  workspace: WorkspaceSnapshot;
  workspaceFingerprint: string;
  executions: Execution[];
  evidence: Evidence[];
  outcome: RunOutcome;
  fixRequested: boolean;
  fixBaselineFingerprint?: string;
  finalSummary?: string;
  reportPath?: string;
}
const nextPhases: Record<RunPhase, readonly RunPhase[]> = {
  triage: ["reproduce"],
  reproduce: ["test"],
  test: ["fix", "verify"],
  fix: ["verify"],
  verify: [],
  report: [],
};
export function createRunState(
  runId: string,
  issue: IssueSummary,
  options: { workspace: WorkspaceSnapshot; fixRequested?: boolean },
): RunState {
  return {
    schemaVersion: 2,
    runId,
    phase: "triage",
    issue,
    workspace: options.workspace,
    workspaceFingerprint: options.workspace.fingerprint,
    executions: [],
    evidence: [],
    outcome: "in_progress",
    fixRequested: options.fixRequested ?? false,
  };
}
export function setRunPhase(state: RunState, phase: RunPhase): RunState {
  assertActive(state);
  if (!nextPhases[state.phase].includes(phase))
    throw new Error(`Invalid phase transition: ${state.phase} -> ${phase}`);
  if (state.phase === "reproduce" && !state.evidence.some(isPositiveReproductionEvidence))
    throw new Error("Successful executable reproduction evidence is required before entering test");
  if (state.phase === "test") {
    const baseline = [...state.evidence].reverse().find(isFailedRegressionEvidence);
    if (!baseline || baseline.workspaceFingerprint !== state.workspaceFingerprint)
      throw new Error("A failing baseline regression test on the current workspace is required");
    const latest = [...state.executions]
      .reverse()
      .find((item) => item.command === baseline.command);
    if (latest?.id !== baseline.executionId)
      throw new Error("Run and record the latest failing baseline regression test");
    if (state.fixRequested && phase !== "fix")
      throw new Error("A requested fix must enter fix before verification");
    if (!state.fixRequested && phase === "fix")
      throw new Error("Start the run with --fix before entering fix");
  }
  if (
    state.phase === "fix" &&
    (!state.evidence.some(isPositiveFixEvidence) ||
      state.workspaceFingerprint === state.fixBaselineFingerprint)
  )
    throw new Error(
      "Positive fix evidence and an actual workspace change are required before verification",
    );
  return {
    ...state,
    phase,
    ...(phase === "fix" ? { fixBaselineFingerprint: state.workspaceFingerprint } : {}),
  };
}

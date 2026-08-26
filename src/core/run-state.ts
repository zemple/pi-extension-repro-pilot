import {
  type Evidence,
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

export interface RunState {
  schemaVersion: 1;
  runId: string;
  phase: RunPhase;
  issue: IssueSummary;
  evidence: Evidence[];
  outcome: RunOutcome;
  fixRequested: boolean;
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
  options: { fixRequested?: boolean } = {},
): RunState {
  return {
    schemaVersion: 1,
    runId,
    phase: "triage",
    issue,
    evidence: [],
    outcome: "in_progress",
    fixRequested: options.fixRequested ?? false,
  };
}

export function setRunPhase(state: RunState, phase: RunPhase): RunState {
  if (!nextPhases[state.phase].includes(phase)) {
    throw new Error(`Invalid phase transition: ${state.phase} -> ${phase}`);
  }

  if (
    state.phase === "reproduce" &&
    phase === "test" &&
    !state.evidence.some(isPositiveReproductionEvidence)
  ) {
    throw new Error("Successful executable reproduction evidence is required before entering test");
  }

  if (state.phase === "test" && (phase === "fix" || phase === "verify")) {
    if (!state.evidence.some(isFailedRegressionEvidence)) {
      throw new Error("A failing baseline regression test is required");
    }
    if (state.fixRequested && phase === "verify") {
      throw new Error("A requested fix must enter fix before verification");
    }
    if (!state.fixRequested && phase === "fix") {
      throw new Error("Start the run with --fix before entering fix");
    }
  }

  if (state.phase === "fix" && phase === "verify" && !state.evidence.some(isPositiveFixEvidence)) {
    throw new Error("Positive fix evidence is required before verification");
  }

  return { ...state, phase };
}

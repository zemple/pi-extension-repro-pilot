import {
  type EvidenceInput,
  type Execution,
  evidenceKinds,
  evidencePurposes,
  evidenceResults,
  isExecution,
  isObject,
  phases,
  recordEvidence,
} from "./evidence.ts";
import { finishRun } from "./report.ts";
import {
  createRunState,
  type IssueSummary,
  type RunPhase,
  type RunState,
  setRunPhase,
  type WorkspaceSnapshot,
} from "./run-state.ts";
export const runStateEntryType = "repro-pilot-state";

function issueValid(value: unknown): value is IssueSummary {
  if (
    !isObject(value) ||
    typeof value.repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value.repository) ||
    !Number.isSafeInteger(value.number) ||
    Number(value.number) <= 0
  )
    return false;
  return (
    value.url === `https://github.com/${value.repository}/issues/${value.number}` &&
    typeof value.title === "string" &&
    value.title.trim().length > 0 &&
    value.title.length <= 500 &&
    typeof value.body === "string" &&
    value.body.length <= 65_536
  );
}
function workspaceValid(value: unknown): value is WorkspaceSnapshot {
  return (
    isObject(value) &&
    typeof value.root === "string" &&
    value.root.length > 0 &&
    value.root.length <= 4000 &&
    typeof value.head === "string" &&
    /^[a-f0-9]{40,64}$/u.test(value.head) &&
    typeof value.fingerprint === "string" &&
    /^[a-f0-9]{64}$/u.test(value.fingerprint)
  );
}
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((item, index) => same(item, b[index]));
  if (!isObject(a) || !isObject(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => same(a[key], b[key]));
}

export function parseRunState(value: unknown): RunState | undefined {
  if (
    !isObject(value) ||
    value.schemaVersion !== 2 ||
    typeof value.runId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(value.runId)
  )
    return undefined;
  if (
    !issueValid(value.issue) ||
    !workspaceValid(value.workspace) ||
    typeof value.fixRequested !== "boolean" ||
    typeof value.workspaceFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.workspaceFingerprint) ||
    !phases.some((phase) => phase === value.phase) ||
    !Array.isArray(value.executions) ||
    !value.executions.every(isExecution) ||
    !Array.isArray(value.evidence)
  )
    return undefined;
  const executions: Execution[] = value.executions;
  if (
    new Set(executions.map((item) => item.id)).size !== executions.length ||
    (!value.fixRequested && executions.some((item) => item.phase === "fix"))
  )
    return undefined;
  if (
    executions.some(
      (item, index) =>
        index > 0 &&
        phases.indexOf(item.phase) < phases.indexOf(executions[index - 1]?.phase as RunPhase),
    )
  )
    return undefined;
  const targetPhase = value.phase === "report" ? undefined : (value.phase as RunPhase);
  if (
    targetPhase &&
    executions.some((item) => phases.indexOf(item.phase) > phases.indexOf(targetPhase))
  )
    return undefined;
  try {
    let state = createRunState(value.runId, value.issue, {
      workspace: value.workspace,
      fixRequested: value.fixRequested,
    });
    // Rebuild each phase using the same evidence and transition gates as a live run.
    const route: RunPhase[] = value.fixRequested
      ? ["triage", "reproduce", "test", "fix", "verify"]
      : ["triage", "reproduce", "test", "verify"];
    let evidenceIndex = 0;
    const seenExecutions = new Set<string>();
    for (const phase of route) {
      if (state.phase !== phase) state = setRunPhase(state, phase);
      for (const raw of value.evidence) {
        if (!isObject(raw)) return undefined;
        if (raw.phase !== phase) continue;
        if (
          raw !== value.evidence[evidenceIndex] ||
          raw.id !== `E${evidenceIndex + 1}` ||
          typeof raw.recordedAt !== "string" ||
          !evidenceKinds.some((kind) => kind === raw.kind) ||
          !evidencePurposes.some((purpose) => purpose === raw.purpose) ||
          !evidenceResults.some((result) => result === raw.result) ||
          typeof raw.workspaceFingerprint !== "string"
        )
          return undefined;
        if (raw.executionId !== undefined) {
          const index = executions.findIndex((item) => item.id === raw.executionId);
          if (index < 0) return undefined;
          // A checkpoint may contain later executions, so replay only the prefix available at this evidence.
          state = { ...state, executions: executions.slice(0, index + 1) };
          if (seenExecutions.has(String(raw.executionId))) return undefined;
          seenExecutions.add(String(raw.executionId));
        }
        state = { ...state, workspaceFingerprint: raw.workspaceFingerprint };
        const input: EvidenceInput = {
          kind: raw.kind as EvidenceInput["kind"],
          purpose: raw.purpose as EvidenceInput["purpose"],
          summary: typeof raw.summary === "string" ? raw.summary : "",
        };
        for (const key of [
          "executionId",
          "result",
          "path",
          "verificationScope",
          "reproduction",
        ] as const) {
          if (raw[key] !== undefined) Object.assign(input, { [key]: raw[key] });
        }
        state = recordEvidence(state, input, raw.recordedAt);
        if (!same(state.evidence.at(-1), raw)) return undefined;
        evidenceIndex += 1;
      }
      state = {
        ...state,
        executions: executions.filter(
          (item) => phases.indexOf(item.phase) <= phases.indexOf(phase),
        ),
      };
      if (
        targetPhase === phase ||
        (value.phase === "report" &&
          evidenceIndex === value.evidence.length &&
          (value.outcome === "blocked" || value.outcome === "not_reproduced"))
      )
        break;
      // At test -> fix the recorded fingerprint is the exact failing baseline, not the later fixed tree.
      if (phase === "test") {
        const baseline = state.evidence.filter((item) => item.purpose === "regression").at(-1);
        if (baseline) state = { ...state, workspaceFingerprint: baseline.workspaceFingerprint };
      }
      if (phase === "fix") state = { ...state, workspaceFingerprint: value.workspaceFingerprint };
    }
    if (
      evidenceIndex !== value.evidence.length ||
      executions.some((item) => phases.indexOf(item.phase) > phases.indexOf(state.phase))
    )
      return undefined;
    state = { ...state, workspaceFingerprint: value.workspaceFingerprint, executions };
    if (state.fixBaselineFingerprint !== value.fixBaselineFingerprint) return undefined;
    if (value.phase === "report") {
      if (
        typeof value.finalSummary !== "string" ||
        typeof value.reportPath !== "string" ||
        !["fixed", "reproduced", "not_reproduced", "blocked"].includes(String(value.outcome))
      )
        return undefined;
      state = finishRun(
        state,
        value.outcome as "fixed" | "reproduced" | "not_reproduced" | "blocked",
        value.finalSummary,
        value.reportPath,
      );
    } else if (
      value.outcome !== "in_progress" ||
      value.finalSummary !== undefined ||
      value.reportPath !== undefined
    )
      return undefined;
    return state;
  } catch {
    return undefined;
  }
}

export function restoreRunState(entries: readonly unknown[]): RunState | undefined {
  let restored: RunState | undefined;
  for (const entry of entries) {
    if (!isObject(entry) || entry.type !== "custom" || entry.customType !== runStateEntryType)
      continue;
    const parsed = parseRunState(entry.data);
    if (!parsed) continue;
    if (restored) {
      if (parsed.runId !== restored.runId) {
        if (restored.outcome === "in_progress") continue;
      } else {
        if (
          !same(parsed.issue, restored.issue) ||
          !same(parsed.workspace, restored.workspace) ||
          parsed.fixRequested !== restored.fixRequested
        )
          continue;
        if (restored.outcome !== "in_progress" && !same(parsed, restored)) continue;
        if (phases.indexOf(parsed.phase) < phases.indexOf(restored.phase)) continue;
        if (
          restored.fixBaselineFingerprint !== undefined &&
          parsed.fixBaselineFingerprint !== restored.fixBaselineFingerprint
        )
          continue;
        if (
          parsed.evidence.length < restored.evidence.length ||
          !restored.evidence.every((item, index) => same(item, parsed.evidence[index]))
        )
          continue;
        if (
          parsed.executions.length < restored.executions.length ||
          !restored.executions.every((item, index) => same(item, parsed.executions[index]))
        )
          continue;
      }
    }
    restored = parsed;
  }
  return restored;
}

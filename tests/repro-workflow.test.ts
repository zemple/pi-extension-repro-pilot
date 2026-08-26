import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import registerReproWorkflow from "../extensions/repro-workflow/index.ts";
import { recordEvidence } from "../src/core/evidence.ts";
import { runStateEntryType } from "../src/core/persistence.ts";
import {
  createRunState,
  type IssueSummary,
  type RunState,
  setRunPhase,
} from "../src/core/run-state.ts";

type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
type SentMessage = Parameters<ExtensionAPI["sendUserMessage"]>[0];
type EventHandler = (event: unknown, context: ExtensionContext) => unknown;
const issueReference = "https://github.com/unjs/ufo/issues/148";
const issue: IssueSummary = {
  url: issueReference,
  repository: "unjs/ufo",
  number: 148,
  title: "Empty array parameters generate an invalid URL",
  body: "The query string contains a double ampersand.",
};

function setupExtension(
  options: {
    cwd?: string;
    branch?: unknown[];
    loadIssue?: (reference: string) => Promise<IssueSummary>;
    getCurrentRepository?: (cwd: string) => Promise<string>;
  } = {},
) {
  const commands = new Map<string, CommandOptions>();
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, EventHandler[]>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  const messages: SentMessage[] = [];
  const statuses: Array<[string, string | undefined]> = [];
  const widgets: Array<[string, unknown]> = [];
  const notifications: Array<[string, string | undefined]> = [];
  const branch = options.branch ?? [];

  const pi = {
    on(event: string, handler: EventHandler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(name: string, commandOptions: CommandOptions) {
      commands.set(name, commandOptions);
    },
    registerTool(definition: ToolDefinition) {
      tools.set(definition.name, definition);
    },
    appendEntry(customType: string, data?: unknown) {
      entries.push({ customType, data });
    },
    sendUserMessage(message: SentMessage) {
      messages.push(message);
    },
    setSessionName() {},
  } as unknown as ExtensionAPI;

  const context = {
    cwd: options.cwd ?? "/tmp/repro-target",
    sessionManager: {
      getBranch() {
        return branch;
      },
    },
    ui: {
      setStatus(key: string, text: string | undefined) {
        statuses.push([key, text]);
      },
      setWidget(key: string, value: unknown) {
        widgets.push([key, value]);
      },
      notify(message: string, level?: string) {
        notifications.push([message, level]);
      },
    },
  } as unknown as ExtensionCommandContext & ExtensionContext;

  registerReproWorkflow(pi, {
    loadIssue: options.loadIssue ?? (async () => issue),
    getCurrentRepository: options.getCurrentRepository ?? (async () => "unjs/ufo"),
  });

  const command = commands.get("repro");
  if (!command) throw new Error("ReproPilot did not register /repro");

  async function executeTool(name: string, params: unknown) {
    const tool = tools.get(name);
    if (!tool) throw new Error(`Missing tool: ${name}`);
    return tool.execute("tool-call-1", params as never, undefined, undefined, context);
  }

  async function emit(event: string, value: unknown) {
    const results = [];
    for (const handler of handlers.get(event) ?? []) {
      results.push(await handler(value, context));
    }
    return results;
  }

  return {
    command,
    commands,
    tools,
    entries,
    messages,
    statuses,
    widgets,
    notifications,
    context,
    executeTool,
    emit,
  };
}

async function recordFixedRun(runtime: ReturnType<typeof setupExtension>) {
  await runtime.command.handler(`${issueReference} --fix`, runtime.context);
  await runtime.executeTool("repro_set_phase", { phase: "reproduce" });
  await runtime.executeTool("repro_record_evidence", {
    kind: "command",
    purpose: "reproduction",
    result: "observed",
    summary: "Empty input returns NaN",
    command: "node reproduce.mjs",
    exitCode: 0,
    output: "actual=NaN expected=0",
  });
  await runtime.executeTool("repro_set_phase", { phase: "test" });
  await runtime.executeTool("repro_record_evidence", {
    kind: "test",
    purpose: "regression",
    result: "failed",
    summary: "Regression fails against the baseline",
    command: "npm test",
    exitCode: 1,
    path: "tests/calculator.test.ts",
  });
  await runtime.executeTool("repro_set_phase", { phase: "fix" });
  await runtime.executeTool("repro_record_evidence", {
    kind: "observation",
    purpose: "fix",
    result: "observed",
    summary: "Return zero for empty input",
    path: "src/calculator.ts",
  });
  await runtime.executeTool("repro_set_phase", { phase: "verify" });
  for (const verificationScope of ["regression", "existing"] as const) {
    await runtime.executeTool("repro_record_evidence", {
      kind: "test",
      purpose: "verification",
      verificationScope,
      result: "passed",
      summary: `${verificationScope} tests pass`,
      command: "npm test",
      exitCode: 0,
    });
  }
}

describe("repro-workflow extension", () => {
  it("registers the complete toolset and starts a fix-enabled GitHub issue run", async () => {
    const runtime = setupExtension();

    await runtime.command.handler(`${issueReference} --fix`, runtime.context);

    expect([...runtime.tools.keys()].sort()).toEqual([
      "repro_finish",
      "repro_load_issue",
      "repro_record_evidence",
      "repro_set_phase",
    ]);
    expect(runtime.entries).toHaveLength(1);
    expect(runtime.entries[0]).toMatchObject({
      customType: runStateEntryType,
      data: {
        schemaVersion: 1,
        phase: "triage",
        issue,
        evidence: [],
        outcome: "in_progress",
        fixRequested: true,
      },
    });
    expect(runtime.statuses.at(-1)).toEqual([
      "repro-pilot",
      "repro:triage evidence:0 test:not_started fix:not_started",
    ]);
    expect(runtime.widgets.at(-1)?.[1]).toEqual([
      "ReproPilot  TRIAGE",
      "Issue: unjs/ufo#148",
      "Evidence: 0",
      "Regression: not_started",
      "Fix: not_started (requested)",
    ]);
    expect(runtime.messages[0]).toContain("Work through the complete ReproPilot workflow");
  });

  it("loads a GitHub issue through repro_load_issue", async () => {
    const runtime = setupExtension();

    const result = await runtime.executeTool("repro_load_issue", { reference: issueReference });

    expect(result.details).toMatchObject({
      issue: { repository: "unjs/ufo", number: 148 },
      reference: issueReference,
    });
  });

  it("rejects malformed command arguments and issue loading failures", async () => {
    const loadIssue = async (): Promise<IssueSummary> => {
      throw new Error("Use a valid GitHub issue URL");
    };
    const runtime = setupExtension({ loadIssue });

    await runtime.command.handler(`${issueReference} --unknown`, runtime.context);
    await runtime.command.handler("not-an-issue", runtime.context);

    expect(runtime.entries).toHaveLength(0);
    expect(runtime.messages).toHaveLength(0);
    expect(runtime.notifications.map(([message]) => message)).toEqual([
      "Usage: /repro <github-issue-url> [--fix]",
      "Use a valid GitHub issue URL",
    ]);
  });

  it("rejects an issue that does not belong to the current repository", async () => {
    const mismatched = setupExtension({
      cwd: "/tmp/other-repository",
      getCurrentRepository: async () => "other/project",
    });

    await mismatched.command.handler(issueReference, mismatched.context);

    expect(mismatched.entries).toHaveLength(0);
    expect(mismatched.messages).toHaveLength(0);
    expect(mismatched.notifications.at(-1)?.[0]).toBe(
      "Issue repository unjs/ufo does not match current repository other/project",
    );
  });

  it("records evidence, persists it, and updates TUI state", async () => {
    const runtime = setupExtension();
    await runtime.command.handler(issueReference, runtime.context);
    await runtime.executeTool("repro_set_phase", { phase: "reproduce" });

    const result = await runtime.executeTool("repro_record_evidence", {
      kind: "command",
      purpose: "reproduction",
      result: "observed",
      summary: "Empty input returns NaN",
      command: "node reproduce.mjs",
      exitCode: 0,
      output: "NaN",
    });

    expect(result.content).toEqual([{ type: "text", text: "Recorded evidence E1." }]);
    expect(result.details).toMatchObject({ state: { evidence: [{ id: "E1" }] } });
    expect(runtime.entries).toHaveLength(3);
    expect(runtime.statuses.at(-1)?.[1]).toContain("evidence:1");
  });

  it("enforces core transition gates for model-requested phases", async () => {
    const runtime = setupExtension();
    await runtime.command.handler(issueReference, runtime.context);
    await runtime.executeTool("repro_set_phase", { phase: "reproduce" });

    await expect(runtime.executeTool("repro_set_phase", { phase: "test" })).rejects.toThrow(
      "Successful executable reproduction evidence is required before entering test",
    );
    expect(runtime.entries).toHaveLength(2);
  });

  it("writes a deterministic report only after completion gates pass", async () => {
    const target = await mkdtemp(join(tmpdir(), "repro-pilot-extension-"));
    try {
      const runtime = setupExtension({ cwd: target });
      await recordFixedRun(runtime);

      const result = await runtime.executeTool("repro_finish", {
        outcome: "fixed",
        summary: "Empty lists now return zero.",
      });

      const state = (result.details as { state: RunState }).state;
      expect(state).toMatchObject({ phase: "report", outcome: "fixed" });
      expect(state.reportPath).toMatch(/^\.repro-pilot\/runs\/.+\/report\.md$/u);
      const report = await readFile(join(target, state.reportPath ?? ""), "utf8");
      expect(report).toContain("**Outcome:** fixed");
      expect(report).toContain("### E1 — reproduction / observed");
      expect(runtime.entries.at(-1)?.data).toEqual(state);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("restores the latest valid branch state on session start", async () => {
    let state = createRunState("run-1", issue);
    state = setRunPhase(state, "reproduce");
    state = recordEvidence(
      state,
      {
        kind: "observation",
        purpose: "diagnostic",
        result: "observed",
        summary: "Repository inspected",
      },
      "2026-08-25T12:00:00.000Z",
    );
    const runtime = setupExtension({
      branch: [{ type: "custom", customType: runStateEntryType, data: state }],
    });

    await runtime.emit("session_start", { type: "session_start", reason: "resume" });

    expect(runtime.statuses.at(-1)?.[1]).toBe(
      "repro:reproduce evidence:1 test:not_started fix:not_started",
    );
    expect(runtime.notifications.at(-1)?.[0]).toBe("Restored ReproPilot run for unjs/ufo#148");
  });

  it("injects a compact active-state snapshot before each model run", async () => {
    const runtime = setupExtension();
    await runtime.command.handler(`${issueReference} --fix`, runtime.context);

    const [result] = await runtime.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "continue",
      systemPrompt: "base prompt",
      systemPromptOptions: {},
    });

    expect(result).toMatchObject({
      systemPrompt: expect.stringContaining("Active ReproPilot state"),
    });
    expect((result as { systemPrompt: string }).systemPrompt).toContain("Fix requested: yes");
    expect((result as { systemPrompt: string }).systemPrompt).toContain(
      "Record every important command or test with repro_record_evidence",
    );
  });
});

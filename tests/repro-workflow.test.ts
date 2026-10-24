import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolDefinition,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import register from "../extensions/repro-workflow/index.ts";
import { parseRunState, runStateEntryType } from "../src/core/persistence.ts";
import type { RunState } from "../src/core/run-state.ts";
import { getCurrentGitHubRepository } from "../src/github.ts";
import { getWorkspaceSnapshot } from "../src/workspace.ts";
import { issue, workspace } from "./fixtures.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
const directories: string[] = [];
const exec = promisify(execFile);
afterEach(async () => {
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function setup(
  options: {
    branch?: unknown[];
    realWorkspace?: boolean;
    commandPrefix?: string;
    writeReport?: (path: string, report: string) => Promise<void>;
  } = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), "repro-extension-"));
  directories.push(cwd);
  const commands = new Map<string, Command>();
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, Handler[]>();
  const entries: RunState[] = [];
  const branch = options.branch ?? [];
  const messages: unknown[] = [];
  const notifications: string[] = [];
  const statuses: string[] = [];
  let fingerprint = workspace.fingerprint;
  let repository = issue.repository;
  let appendFailure = false;
  const ctx = {
    cwd,
    sessionManager: {
      getBranch: () => branch,
      getSessionId: () => "test-session",
      getSessionFile: () => undefined,
    },
    ui: {
      notify: (s: string) => notifications.push(s),
      setStatus: (_k: string, s: string) => statuses.push(s),
      setWidget() {},
    },
  } as unknown as ExtensionCommandContext;
  register(
    {
      on: (e: string, h: Handler) => handlers.set(e, [...(handlers.get(e) ?? []), h]),
      registerTool: (t: ToolDefinition) => tools.set(t.name, t),
      registerCommand: (n: string, c: Command) => commands.set(n, c),
      appendEntry: (customType: string, data: RunState) => {
        if (appendFailure) throw new Error("disk full");
        entries.push(data);
        branch.push({ type: "custom", customType, data });
      },
      setSessionName() {},
      sendUserMessage: (s: unknown) => messages.push(s),
    } as unknown as ExtensionAPI,
    {
      loadIssue: async () => issue,
      getCurrentRepository: options.realWorkspace
        ? getCurrentGitHubRepository
        : async () => repository,
      getWorkspace: options.realWorkspace
        ? getWorkspaceSnapshot
        : async () => ({ ...workspace, root: cwd, fingerprint }),
      ...(options.writeReport ? { writeReport: options.writeReport } : {}),
    },
  );
  const emit = async (name: string, value: unknown) => {
    const results = [];
    for (const h of handlers.get(name) ?? []) results.push(await h(value, ctx));
    return results;
  };
  const tool = (name: string, params: unknown) => {
    const t = tools.get(name);
    if (!t) throw new Error("Missing tool");
    return t.execute("domain-call", params as never, undefined, undefined, ctx);
  };
  let call = 0;
  const shell = async (command: string) => {
    const id = `bash-${++call}`;
    const input = { command };
    const responses = await emit("tool_call", {
      type: "tool_call",
      toolName: "bash",
      toolCallId: id,
      input,
    });
    const blocked = responses.find((v) => v && typeof v === "object" && "block" in v);
    if (blocked) throw new Error("Tool blocked");
    let content: ToolResultEvent["content"];
    let isError = false;
    try {
      content = (
        await createBashToolDefinition(
          cwd,
          options.commandPrefix ? { commandPrefix: options.commandPrefix } : {},
        ).execute(id, input, undefined, undefined, ctx)
      ).content;
    } catch (error) {
      isError = true;
      content = [
        { type: "text" as const, text: String(error instanceof Error ? error.message : error) },
      ];
    }
    await emit("tool_result", {
      type: "tool_result",
      toolName: "bash",
      toolCallId: id,
      input,
      content,
      details: undefined,
      isError,
    });
    return id;
  };
  const command = commands.get("repro");
  if (!command) throw new Error("Missing /repro command");
  const start = (fix = false) => command.handler(`${issue.url}${fix ? " --fix" : ""}`, ctx);
  return {
    cwd,
    ctx,
    entries,
    tools,
    messages,
    notifications,
    statuses,
    emit,
    tool,
    shell,
    start,
    change: () => {
      fingerprint = "c".repeat(64);
    },
    wrongRepo: () => {
      repository = "other/repo";
    },
    failAppend: () => {
      appendFailure = true;
    },
  };
}
async function reproduce(runtime: Awaited<ReturnType<typeof setup>>, fix = false) {
  await runtime.start(fix);
  await runtime.tool("repro_set_phase", { phase: "reproduce" });
  const executionId = await runtime.shell("printf 'actual=1 expected=0'");
  await runtime.tool("repro_record_evidence", {
    kind: "command",
    purpose: "reproduction",
    summary: "Observed bug",
    executionId,
    reproduction: { bugObserved: true, actual: "1", expected: "0" },
  });
}

describe("Pi adapter", () => {
  it("rolls back a report writer that publishes and then fails", async () => {
    const r = await setup({
      writeReport: async (path, report) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, report);
        throw new Error("failed after publishing");
      },
    });
    await r.start();
    await r.tool("repro_record_evidence", {
      kind: "observation",
      purpose: "diagnostic",
      result: "blocked",
      summary: "Stop",
    });
    const runId = r.entries.at(-1)?.runId;
    if (!runId) throw new Error("Missing run");
    await expect(
      r.tool("repro_finish", { outcome: "blocked", summary: "Stopped" }),
    ).rejects.toThrow();
    await expect(
      readFile(join(r.cwd, ".repro-pilot", "runs", runId, "report.md")),
    ).rejects.toThrow();
    expect(r.entries.at(-1)?.outcome).toBe("in_progress");
  });

  it("preserves a previous report when completion persistence fails", async () => {
    const r = await setup();
    await r.start();
    await r.tool("repro_record_evidence", {
      kind: "observation",
      purpose: "diagnostic",
      result: "blocked",
      summary: "Stop",
    });
    const runId = r.entries.at(-1)?.runId;
    if (!runId) throw new Error("Missing run");
    const path = join(r.cwd, ".repro-pilot", "runs", runId, "report.md");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "previous report");
    r.failAppend();
    await expect(
      r.tool("repro_finish", { outcome: "blocked", summary: "Stopped" }),
    ).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("previous report");
  });

  it("preserves errexit behavior while still capturing a failing command's exit code", async () => {
    const r = await setup({ commandPrefix: "set -e" });
    await r.start();
    const id = await r.shell("false; printf 'should not run'");
    const observed = r.entries.at(-1)?.executions.at(-1);
    expect(observed).toMatchObject({ id, exitCode: 1 });
    expect(observed?.output).not.toContain("should not run");
  });

  it("releases a prepared command aborted before execution so an honest blocked run can finish", async () => {
    const r = await setup();
    await r.start();
    await r.emit("tool_call", {
      type: "tool_call",
      toolName: "bash",
      toolCallId: "aborted",
      input: { command: "node test.js" },
    });
    await r.emit("tool_execution_end", {
      type: "tool_execution_end",
      toolName: "bash",
      toolCallId: "aborted",
      result: { content: [{ type: "text", text: "Operation aborted" }] },
      isError: true,
    });
    await r.tool("repro_record_evidence", {
      kind: "observation",
      purpose: "diagnostic",
      result: "blocked",
      summary: "Command aborted before execution",
    });
    await r.tool("repro_finish", { outcome: "blocked", summary: "Interrupted" });
    expect(r.entries.at(-1)?.outcome).toBe("blocked");
    expect(r.entries.at(-1)?.executions.at(-1)).toMatchObject({ id: "aborted", exitCode: null });
  });

  it("keeps file writes reserved through their result, blocking completion and session navigation", async () => {
    const r = await setup();
    await r.start();
    await r.tool("repro_record_evidence", {
      kind: "observation",
      purpose: "diagnostic",
      result: "blocked",
      summary: "Stop",
    });
    await r.emit("tool_call", {
      type: "tool_call",
      toolName: "write",
      toolCallId: "write-1",
      input: { path: "source.js", content: "new source" },
    });
    await expect(
      r.tool("repro_finish", { outcome: "blocked", summary: "Stopped" }),
    ).rejects.toThrow(/busy/iu);
    expect(await r.emit("session_before_tree", { type: "session_before_tree" })).toContainEqual({
      cancel: true,
    });
    r.change();
    await r.emit("tool_result", {
      type: "tool_result",
      toolName: "write",
      toolCallId: "write-1",
      input: { path: "source.js", content: "new source" },
      content: [],
      isError: false,
    });
    expect(r.entries.at(-1)?.workspaceFingerprint).toBe("c".repeat(64));
    await r.tool("repro_record_evidence", {
      kind: "observation",
      purpose: "diagnostic",
      result: "blocked",
      summary: "Still blocked after the file change",
    });
    await r.tool("repro_finish", { outcome: "blocked", summary: "Stopped" });
    expect(r.entries.at(-1)?.outcome).toBe("blocked");
  });

  it("does not commit completion if files change while the report is being written", async () => {
    let mutate = () => {};
    const r = await setup({
      writeReport: async () => {
        mutate();
      },
    });
    mutate = r.change;
    await r.start();
    await r.tool("repro_record_evidence", {
      kind: "observation",
      purpose: "diagnostic",
      result: "blocked",
      summary: "Stop",
    });
    await expect(
      r.tool("repro_finish", { outcome: "blocked", summary: "Stopped" }),
    ).rejects.toThrow();
    expect(r.entries.at(-1)?.outcome).toBe("in_progress");
  });

  it("executes a real failing baseline, source fix and passing tests in a disposable Git checkout", async () => {
    const r = await setup({ realWorkspace: true });
    await exec("git", ["init", r.cwd]);
    await exec("git", ["-C", r.cwd, "remote", "add", "origin", "https://github.com/acme/demo.git"]);
    await writeFile(
      join(r.cwd, "source.mjs"),
      "export const total = values => values.length ? values.reduce((a,b)=>a+b,0) : NaN;\n",
    );
    await writeFile(
      join(r.cwd, "existing.test.mjs"),
      "import {total} from './source.mjs'; import assert from 'node:assert/strict'; assert.equal(total([1,2]),3);\n",
    );
    await exec("git", ["-C", r.cwd, "add", "."]);
    await exec("git", [
      "-C",
      r.cwd,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "baseline",
    ]);
    await r.start(true);
    await r.tool("repro_set_phase", { phase: "reproduce" });
    let executionId = await r.shell(
      "node --input-type=module -e \"import {total} from './source.mjs'; console.log('actual='+total([])+' expected=0')\"",
    );
    await r.tool("repro_record_evidence", {
      kind: "command",
      purpose: "reproduction",
      summary: "Empty input is wrong",
      executionId,
      reproduction: { bugObserved: true, actual: "NaN", expected: "0" },
    });
    await r.tool("repro_set_phase", { phase: "test" });
    await writeFile(
      join(r.cwd, "regression.test.mjs"),
      "import {total} from './source.mjs'; import assert from 'node:assert/strict'; assert.equal(total([]),0);\n",
    );
    executionId = await r.shell("node --test regression.test.mjs");
    expect(r.entries.at(-1)?.executions.at(-1)?.exitCode).toBe(1);
    await r.tool("repro_record_evidence", {
      kind: "test",
      purpose: "regression",
      path: "regression.test.mjs",
      summary: "Fails on baseline",
      executionId,
    });
    await r.tool("repro_set_phase", { phase: "fix" });
    await writeFile(
      join(r.cwd, "source.mjs"),
      "export const total = values => values.reduce((a,b)=>a+b,0);\n",
    );
    await r.tool("repro_record_evidence", {
      kind: "observation",
      purpose: "fix",
      result: "observed",
      path: "source.mjs",
      summary: "Return zero for empty input",
    });
    await r.tool("repro_set_phase", { phase: "verify" });
    executionId = await r.shell("node --test regression.test.mjs");
    await r.tool("repro_record_evidence", {
      kind: "test",
      purpose: "verification",
      verificationScope: "regression",
      path: "regression.test.mjs",
      summary: "Regression passes",
      executionId,
    });
    executionId = await r.shell("node --test existing.test.mjs");
    await r.tool("repro_record_evidence", {
      kind: "test",
      purpose: "verification",
      verificationScope: "existing",
      summary: "Existing tests pass",
      executionId,
    });
    await r.tool("repro_finish", { outcome: "fixed", summary: "Empty input now returns zero" });
    const finished = r.entries.at(-1);
    if (!finished?.reportPath) throw new Error("Missing finished report");
    expect(finished.outcome).toBe("fixed");
    for (const checkpoint of r.entries)
      expect(
        parseRunState(checkpoint),
        `${checkpoint.phase}/${checkpoint.evidence.length}`,
      ).toEqual(checkpoint);
    expect(await readFile(join(r.cwd, finished.reportPath), "utf8")).toContain(
      "**Outcome:** fixed",
    );
  });

  it("does not infer a zero exit code for a shell terminated without a receipt", async () => {
    const r = await setup();
    await r.start();
    const executionId = await r.shell("kill -TERM $$");
    expect(r.entries.at(-1)?.executions.at(-1)?.exitCode).toBeNull();
    await expect(
      r.tool("repro_record_evidence", {
        kind: "command",
        purpose: "diagnostic",
        summary: "Interrupted",
        executionId,
      }),
    ).rejects.toThrow();
  });

  it("removes a newly written report when saving the completed state fails", async () => {
    const r = await setup();
    await r.start();
    await r.tool("repro_record_evidence", {
      kind: "observation",
      purpose: "diagnostic",
      result: "blocked",
      summary: "Stop",
    });
    const runId = r.entries.at(-1)?.runId;
    if (!runId) throw new Error("Missing active run");
    const path = join(r.cwd, ".repro-pilot", "runs", runId, "report.md");
    r.failAppend();
    await expect(
      r.tool("repro_finish", { outcome: "blocked", summary: "Stopped" }),
    ).rejects.toThrow();
    await expect(readFile(path)).rejects.toThrow();
    expect(r.entries.at(-1)?.outcome).toBe("in_progress");
  });
  it("captures actual bash exit status and output and records evidence by execution ID", async () => {
    const r = await setup();
    await reproduce(r);
    expect(r.entries.at(-1)?.evidence[0]).toMatchObject({
      command: "printf 'actual=1 expected=0'",
      exitCode: 0,
      output: "actual=1 expected=0",
      executionId: "bash-1",
    });
    const failed = await r.shell("printf 'actual assertion failure'; exit 7");
    expect(r.entries.at(-1)?.executions.at(-1)).toMatchObject({ id: failed, exitCode: 7 });
    expect([...r.tools.keys()].sort()).toEqual([
      "repro_finish",
      "repro_load_issue",
      "repro_record_evidence",
      "repro_set_phase",
    ]);
  });
  it("does not silently replace an unfinished run or let an old finish overwrite a new one", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const r = await setup({ writeReport: async () => barrier });
    await r.start();
    const runId = r.entries[0]?.runId;
    await r.start();
    expect(r.entries.at(-1)?.runId).toBe(runId);
    expect(r.messages).toHaveLength(1);
    await r.tool("repro_record_evidence", {
      kind: "observation",
      purpose: "diagnostic",
      result: "blocked",
      summary: "Stop",
    });
    const finishing = r.tool("repro_finish", { outcome: "blocked", summary: "Stopped" });
    await r.start();
    release();
    await finishing;
    expect(r.entries.at(-1)?.runId).toBe(runId);
    expect(r.entries.at(-1)?.outcome).toBe("blocked");
  });
  it("halts further progress when persistence fails", async () => {
    const r = await setup();
    await r.start();
    r.failAppend();
    await expect(r.tool("repro_set_phase", { phase: "reproduce" })).rejects.toThrow();
    expect(r.entries.at(-1)?.phase).toBe("triage");
    await expect(r.tool("repro_set_phase", { phase: "reproduce" })).rejects.toThrow(
      /persist|restart/iu,
    );
  });
  it("preserves the active run and permits retry after report writing fails", async () => {
    let fail = true;
    const r = await setup({
      writeReport: async () => {
        if (fail) throw new Error("read-only filesystem");
      },
    });
    await r.start();
    await r.tool("repro_record_evidence", {
      kind: "observation",
      purpose: "diagnostic",
      result: "blocked",
      summary: "Stop",
    });
    await expect(
      r.tool("repro_finish", { outcome: "blocked", summary: "Stopped" }),
    ).rejects.toThrow();
    expect(r.entries.at(-1)?.outcome).toBe("in_progress");
    fail = false;
    await r.tool("repro_finish", { outcome: "blocked", summary: "Stopped" });
    expect(r.entries.at(-1)?.outcome).toBe("blocked");
  });
  it("writes a report and stops injecting an active workflow after completion", async () => {
    const r = await setup();
    await r.start();
    await r.tool("repro_record_evidence", {
      kind: "observation",
      purpose: "diagnostic",
      result: "blocked",
      summary: "Compiler unavailable",
    });
    await r.tool("repro_finish", { outcome: "blocked", summary: "Stopped" });
    const path = r.entries.at(-1)?.reportPath;
    if (!path) throw new Error("Missing finished report");
    expect(await readFile(join(r.cwd, path), "utf8")).toContain("Compiler unavailable");
    const responses = await r.emit("before_agent_start", { systemPrompt: "base" });
    expect(responses.filter(Boolean)).toHaveLength(0);
    await expect(
      r.tool("repro_record_evidence", {
        kind: "observation",
        purpose: "diagnostic",
        result: "observed",
        summary: "Late",
      }),
    ).rejects.toThrow();
  });
  it("refuses to resume work in a different repository", async () => {
    const r = await setup();
    await r.start();
    r.wrongRepo();
    await expect(r.tool("repro_set_phase", { phase: "reproduce" })).rejects.toThrow(/repository/iu);
    const restored = await setup({
      branch: [{ type: "custom", customType: runStateEntryType, data: r.entries[0] }],
    });
    restored.wrongRepo();
    await restored.emit("session_start", { type: "session_start", reason: "resume" });
    await expect(restored.tool("repro_set_phase", { phase: "reproduce" })).rejects.toThrow();
  });
  it("does not accept invented executions and detects file changes after execution", async () => {
    const r = await setup();
    await r.start();
    await expect(
      r.tool("repro_record_evidence", {
        kind: "command",
        purpose: "environment",
        summary: "Invented",
        executionId: "fake",
      }),
    ).rejects.toThrow();
    const id = await r.shell("printf 'real'");
    r.change();
    await expect(
      r.tool("repro_record_evidence", {
        kind: "command",
        purpose: "environment",
        summary: "Stale",
        executionId: id,
      }),
    ).rejects.toThrow();
  });
});

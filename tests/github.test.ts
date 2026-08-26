import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { getCurrentGitHubRepository, loadGitHubIssue, parseGitHubIssueUrl } from "../src/github.ts";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("parseGitHubIssueUrl", () => {
  it("parses one canonical GitHub issue URL", () => {
    expect(parseGitHubIssueUrl("https://github.com/unjs/ufo/issues/148")).toEqual({
      owner: "unjs",
      repository: "unjs/ufo",
      repositoryName: "ufo",
      issueNumber: 148,
      url: "https://github.com/unjs/ufo/issues/148",
    });
  });

  it.each([
    "fixture:ufo-148",
    "https://example.com/unjs/ufo/issues/148",
    "https://github.com/unjs/ufo/pull/148",
    "https://github.com/unjs/ufo/issues/not-a-number",
    "https://github.com/unjs/ufo/issues/0",
  ])("rejects unsupported issue reference %s", (reference) => {
    expect(() => parseGitHubIssueUrl(reference)).toThrow(
      "Use a GitHub issue URL like https://github.com/owner/repository/issues/123",
    );
  });
});

describe("loadGitHubIssue", () => {
  it("loads and validates a public issue through the GitHub REST API", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          number: 148,
          title: "Empty array parameters generate an invalid URL",
          body: "The query string contains a double ampersand.",
        }),
        { status: 200 },
      ),
    );

    await expect(
      loadGitHubIssue("https://github.com/unjs/ufo/issues/148", { fetcher }),
    ).resolves.toEqual({
      url: "https://github.com/unjs/ufo/issues/148",
      repository: "unjs/ufo",
      number: 148,
      title: "Empty array parameters generate an invalid URL",
      body: "The query string contains a double ampersand.",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.github.com/repos/unjs/ufo/issues/148",
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "application/vnd.github+json",
          "User-Agent": "repro-pilot",
        }),
      }),
    );
  });

  it("uses an explicit token without leaking it into errors", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message: "Bad credentials" }), {
        status: 401,
        statusText: "Unauthorized",
      }),
    );

    await expect(
      loadGitHubIssue("https://github.com/unjs/ufo/issues/148", {
        fetcher,
        token: "secret-token",
      }),
    ).rejects.toThrow("GitHub issue request failed: 401 Unauthorized");
    expect(fetcher).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer secret-token" }),
      }),
    );
  });

  it("rejects malformed issue data", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ number: 148, title: null, body: [] })));

    await expect(
      loadGitHubIssue("https://github.com/unjs/ufo/issues/148", { fetcher }),
    ).rejects.toThrow("GitHub returned invalid issue data");
  });
});

describe("getCurrentGitHubRepository", () => {
  it("reads an HTTPS GitHub origin from the current repository", async () => {
    const directory = await mkdtemp(join(tmpdir(), "repro-pilot-git-"));
    temporaryDirectories.push(directory);
    await execFileAsync("git", ["init", directory]);
    await execFileAsync("git", [
      "-C",
      directory,
      "remote",
      "add",
      "origin",
      "https://github.com/unjs/ufo.git",
    ]);

    await expect(getCurrentGitHubRepository(directory)).resolves.toBe("unjs/ufo");
  });

  it("reads an SSH GitHub origin from the current repository", async () => {
    const directory = await mkdtemp(join(tmpdir(), "repro-pilot-git-"));
    temporaryDirectories.push(directory);
    await execFileAsync("git", ["init", directory]);
    await execFileAsync("git", [
      "-C",
      directory,
      "remote",
      "add",
      "origin",
      "git@github.com:unjs/ufo.git",
    ]);

    await expect(getCurrentGitHubRepository(directory)).resolves.toBe("unjs/ufo");
  });

  it("rejects a directory without a GitHub origin", async () => {
    const directory = await mkdtemp(join(tmpdir(), "repro-pilot-not-git-"));
    temporaryDirectories.push(directory);

    await expect(getCurrentGitHubRepository(directory)).rejects.toThrow(
      "Current directory must be a GitHub repository with an origin remote",
    );
  });
});

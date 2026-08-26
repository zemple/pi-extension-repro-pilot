import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { IssueSummary } from "./core/run-state.ts";

const execFileAsync = promisify(execFile);
const githubApiVersion = "2026-03-10";
const invalidIssueUrlMessage =
  "Use a GitHub issue URL like https://github.com/owner/repository/issues/123";

export interface GitHubIssueReference {
  owner: string;
  repository: string;
  repositoryName: string;
  issueNumber: number;
  url: string;
}

export function parseGitHubIssueUrl(reference: string): GitHubIssueReference {
  let url: URL;
  try {
    url = new URL(reference);
  } catch {
    throw new Error(invalidIssueUrlMessage);
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const issueNumber = Number(parts[3]);
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    parts.length !== 4 ||
    parts[2] !== "issues" ||
    !parts[0] ||
    !parts[1] ||
    !Number.isSafeInteger(issueNumber) ||
    issueNumber <= 0
  ) {
    throw new Error(invalidIssueUrlMessage);
  }

  const owner = parts[0];
  const repositoryName = parts[1];
  return {
    owner,
    repository: `${owner}/${repositoryName}`,
    repositoryName,
    issueNumber,
    url: `https://github.com/${owner}/${repositoryName}/issues/${issueNumber}`,
  };
}

export async function loadGitHubIssue(
  reference: string,
  options: { fetcher?: typeof fetch; token?: string } = {},
): Promise<IssueSummary> {
  const parsed = parseGitHubIssueUrl(reference);
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "repro-pilot",
    "X-GitHub-Api-Version": githubApiVersion,
  };
  const token = options.token ?? process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(
    `https://api.github.com/repos/${parsed.owner}/${parsed.repositoryName}/issues/${parsed.issueNumber}`,
    { headers, redirect: "follow", signal: AbortSignal.timeout(15_000) },
  );
  if (!response.ok) {
    const status = response.statusText
      ? `${response.status} ${response.statusText}`
      : String(response.status);
    throw new Error(`GitHub issue request failed: ${status}`);
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error("GitHub returned invalid issue data");
  }
  if (
    typeof data !== "object" ||
    data === null ||
    !("number" in data) ||
    data.number !== parsed.issueNumber ||
    !("title" in data) ||
    typeof data.title !== "string" ||
    !data.title.trim() ||
    data.title.length > 500 ||
    !("body" in data) ||
    (typeof data.body !== "string" && data.body !== null) ||
    (typeof data.body === "string" && data.body.length > 65_536) ||
    "pull_request" in data
  ) {
    throw new Error("GitHub returned invalid issue data");
  }

  return {
    url: parsed.url,
    repository: parsed.repository,
    number: parsed.issueNumber,
    title: data.title.trim(),
    body: data.body ?? "",
  };
}

function parseGitHubRemote(remote: string): string | undefined {
  const scpMatch = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/u.exec(remote);
  if (scpMatch?.[1] && scpMatch[2]) return `${scpMatch[1]}/${scpMatch[2]}`;

  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    return undefined;
  }
  if (url.hostname.toLowerCase() !== "github.com") return undefined;
  const parts = url.pathname
    .replace(/\.git$/u, "")
    .split("/")
    .filter(Boolean);
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  return `${parts[0]}/${parts[1]}`;
}

export async function getCurrentGitHubRepository(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "remote", "get-url", "origin"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    const repository = parseGitHubRemote(stdout.trim());
    if (repository) return repository;
  } catch {
    // The caller receives one stable preflight error for missing git, repo, or origin.
  }
  throw new Error("Current directory must be a GitHub repository with an origin remote");
}

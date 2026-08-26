# ReproPilot

**English** | [简体中文](README.zh-CN.md)

ReproPilot is an issue reproduction agent built on [Pi Coding Agent](https://pi.dev).

Give it a GitHub issue URL. It investigates the matching local repository, reproduces the reported behavior, creates a regression test, and reports evidence from commands it actually ran. Add `--fix` to also request a fix and verification.

## Who it is for

- Developers learning how an evidence-driven coding agent works.
- Maintainers who want an issue turned into a reproducible test case.
- Developers who want to confirm a bug before attempting a fix.

ReproPilot runs locally. It does not automatically commit, push, or create a pull request.

## What it does

```text
Load issue → Triage → Reproduce → Add a failing regression test
                                      ↓
                    No --fix: verify and report
                    With --fix: repair → verify → report
```

Reading code is not proof of reproduction. ReproPilot requires evidence from executed commands or tests.

## Architecture

ReproPilot is a Pi package with four small layers:

| Path | Responsibility |
| --- | --- |
| `extensions/repro-workflow/` | Connects ReproPilot to Pi: `/repro`, custom tools, session events, and TUI status |
| `skills/repro-workflow/` | Gives the model the step-by-step reproduction procedure |
| `src/core/` | Enforces workflow state, evidence rules, persistence validation, and report generation without depending on Pi |
| `src/github.ts` | Loads and validates the GitHub issue and verifies the current repository |

Pi provides the model loop and built-in repository tools. ReproPilot adds only the issue-reproduction workflow and its deterministic evidence gates.

## Requirements

- Node.js 20.19 or later.
- Pi Coding Agent with a model configured.
- A local checkout of the repository that owns the issue, with the correct GitHub `origin`.
- The dependencies and toolchain needed to run that repository locally.

The target repository is not restricted to a programming language or test framework.

ReproPilot runs commands and may create or edit files in the current repository. Check your working tree first or use a separate branch.

## Quick start

Install Pi with npm:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

`--ignore-scripts` disables dependency lifecycle scripts during installation. Pi does not require install scripts for normal npm installs.

Installer alternative:

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

Authenticate with an API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pi
```

Or use an existing subscription:

```text
pi
/login  # Then select provider
```

Install ReproPilot once:

```bash
pi install https://github.com/zemple/repro-pilot
```

Public issues require no GitHub token. For issues you can access only after authentication, set `GITHUB_TOKEN` before starting Pi.

## Run

Clone or open the repository that owns the issue:

```bash
git clone https://github.com/OWNER/REPOSITORY.git
cd REPOSITORY
git status
git switch -c test-repro-pilot
pi
```

`git status` lets you check for existing uncommitted changes. `git switch -c test-repro-pilot` creates a new branch from your current commit and immediately switches to it, keeping ReproPilot's tests and possible source changes separate from your main branch. The branch name is arbitrary. This command is the clearer, branch-specific equivalent of the older `git checkout -b test-repro-pilot`.

Creating a branch does not clean or discard uncommitted changes. If `git status` shows work you want to preserve, commit or stash it before running ReproPilot.

Start Pi normally. Do not add `--no-skills`: it disables ReproPilot's workflow skill. ReproPilot does not include any unrelated skills.

Replace the uppercase placeholders, then run this inside Pi:

```text
/repro https://github.com/OWNER/REPOSITORY/issues/ISSUE_NUMBER
```

This reproduces the issue and creates a regression test, but does not repair the source code.

To also request a fix:

```text
/repro https://github.com/OWNER/REPOSITORY/issues/ISSUE_NUMBER --fix
```

The issue repository must match the current repository's GitHub `origin`. ReproPilot stops on a mismatch to avoid changing the wrong codebase.

## Read the live status

Pi shows a status such as:

```text
repro:triage evidence:0 test:not_started fix:not_started
```

- `repro`: current workflow phase.
- `evidence`: number of recorded evidence items.
- `test`: regression test status.
- `fix`: fix status.

| Phase | Meaning |
| --- | --- |
| `triage` | Understand the issue and find relevant code and tests |
| `reproduce` | Run the code and compare actual with expected behavior |
| `test` | Add a regression test and observe it failing on the baseline |
| `fix` | Change source code; entered only when `--fix` was used |
| `verify` | Run the regression test and relevant existing tests |
| `report` | Write the final report |

`test` is `not_started`, `failing`, `passing`, or `blocked`. `fix` is `not_started` or `applied`.

## Read the final result

| Outcome | Meaning |
| --- | --- |
| `reproduced` | The bug was reproduced and the regression test fails on the baseline; no source fix was applied |
| `fixed` | The bug was reproduced and fixed; the regression and relevant existing tests pass |
| `not_reproduced` | Reproduction was attempted, but the reported behavior was not observed |
| `blocked` | The run could not continue because of missing information, dependencies, or environment |

The final report is written inside the target repository:

```text
.repro-pilot/runs/<run-id>/report.md
```

Read `Outcome` and `Verification` first. Use `Evidence Details` when you need the exact command, exit code, and relevant output behind a conclusion. Evidence items are numbered `E1`, `E2`, and so on.

## Current limits

- Accepts issue URLs from `github.com` only.
- Requires the user to open the matching local repository first.
- Requires the target project's dependencies and tests to run locally.
- Provides no cloud sandbox and does not automatically commit, push, or open a pull request.

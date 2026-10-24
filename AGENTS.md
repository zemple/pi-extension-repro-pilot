# ReproPilot Development Guide

## Project Goal

ReproPilot is an evidence-driven bug reproduction agent built on Pi Coding Agent. It turns an issue into executed reproduction evidence, a failing regression test, an optional fix, verification results, and a structured report.

This is a learning project. Work in small vertical slices and explain non-obvious Pi APIs or TypeScript decisions before implementing them.

## Sources of Truth

- `AGENTS.md` is the single project-level instruction and architecture document.
- TypeScript types, tests, and executable configuration define implemented behavior.
- Update this file whenever an architectural boundary, workflow invariant, or MVP limit changes.
- Do not add separate planning, handoff, architecture, or code-style documents unless the project outgrows this file.
- Write `README.md` for users after the public workflow stabilizes.

## Product Contract

- The product is a Pi package installed by the user and run from a local checkout of the repository being investigated.
- `/repro <github-issue-url> [--fix]` loads one GitHub issue and starts a run in Pi's current working directory.
- The current checkout must have a GitHub `origin` matching the issue repository. ReproPilot does not clone repositories.
- The phase order is `triage -> reproduce -> test -> optional fix -> verify -> report`.
- Final outcomes are `reproduced`, `not_reproduced`, `blocked`, or `fixed`; phase and outcome are separate concepts.
- `--fix` explicitly authorizes source repair. Without it, the run must not enter `fix`.
- ReproPilot owns exactly four domain tools: `repro_load_issue`, `repro_set_phase`, `repro_record_evidence`, and `repro_finish`.
- The final report is generated at `.repro-pilot/runs/<run-id>/report.md` inside the target repository.

## Architecture Boundaries

- `src/core/` owns framework-independent state, evidence, persistence, completion, and reporting logic. It must not import Pi packages.
- `src/github.ts` owns GitHub issue URL parsing, REST loading, response validation, and current-repository preflight.
- `src/workspace.ts` owns Git root/HEAD discovery and content fingerprints of tracked and non-ignored untracked files, excluding generated `.repro-pilot` artifacts. Fingerprints include file content, deletion, permissions, and symlink targets; they do not rely on Git's dirty flag.
- `extensions/` adapts the core to public `@earendil-works/pi-coding-agent` APIs.
- Do not import `@earendil-works/pi-agent-core` directly unless a requirement recorded in this file cannot be met by Pi Coding Agent.
- Reuse Pi's built-in repository tools. Do not wrap or replace `read`, `bash`, `edit`, or `write`.
- Use public `tool_call`/`tool_result` hooks to observe bash executions. The adapter adds a per-call exit-status receipt to bash command arguments; it does not register replacement tool implementations. This is required because Pi 0.84.4 does not expose a structured bash exit code and can return a successful tool result for a signal-terminated shell.
- Workflow validity belongs in `src/core/`. `skills/repro-workflow/SKILL.md` explains procedure but must not define or duplicate completion gates.
- Keep one canonical workflow implementation for the Pi package and any later CLI.

## State and Evidence Invariants

- The runtime is model-driven, but phase transitions, evidence validity, and completion decisions are deterministic TypeScript rules.
- Persist versioned, validated state in Pi custom session entries. The Markdown report is a generated artifact, not the state database.
- Current checkpoints use schema version 2. Version 1 checkpoints lack execution provenance and must not be silently upgraded into trusted evidence; notify the user to start a new run.
- Restore only the latest valid ReproPilot entry on the current session branch and inject a compact state snapshot before model turns.
- Treat issue text, model arguments, command output, and restored state as untrusted input.
- Evidence is append-only, bounded, redacted, and stamped with its matching workflow phase.
- Executed command and test evidence requires the exact command and integer exit code; its kind, result, and exit code must agree.
- The adapter records observed executions with tool-call IDs, original commands, outputs, exit codes, phases, and before/after workspace fingerprints. Evidence references an execution ID; models cannot supply executable commands, outputs, or exit codes through the evidence tool. Missing or invalid receipts produce an unknown exit code and cannot satisfy executable gates.
- Commands longer than 16,000 characters are rejected instead of truncated. Credentials are redacted in stored commands and output; bounded output excerpts are not full execution logs.
- Executable evidence must refer to an unused, current-phase execution on the current stable workspace. Commands that change repository content must be re-run before their results can satisfy gates.
- Reproduction requires executed evidence showing actual versus expected behavior. Reading code is not proof.
- Reproduction comparisons explicitly separate `bugObserved` from command success. A completed no-bug attempt can finish as `not_reproduced`; missing dependencies and interrupted commands require an honest `blocked` explanation.
- Regression evidence must come from a test observed failing against the baseline before a fix is applied.
- Regression evidence identifies a test path and command. Verification must run that same regression; no-fix runs keep it failing, while fixed runs make it pass. Existing tests are verified separately.
- A `fixed` outcome requires positive fix evidence plus passing post-fix regression and relevant existing-test evidence.
- Completion uses the latest verification executions on the current workspace, never a historical pass. Further file changes invalidate old verification; an observed later failure of the same command invalidates a pass even if the model does not cite that failure.
- A fix-enabled run cannot finish as `reproduced`; it must finish as `fixed` or honestly `blocked`. Entering verification after fix requires an actual workspace change in addition to fix evidence.
- Finished runs are immutable. Recovery replays the same core evidence/transition/completion rules, checks append-only checkpoint history, and cannot grant fix authorization absent from an earlier checkpoint. Before resuming repository work, recheck the current GitHub origin and Git root.
- Only one run and one repository mutation/save operation may be active at a time. A second `/repro` cannot replace an unfinished run. Session navigation is refused while commands or saves are pending; stale asynchronous results cannot commit into another session.
- Reserve bash/edit/write calls from preparation through their result, including Pi's parallel tool batches. Release aborted or vetoed preparations on `tool_execution_end`; never promote them to known executable results. Preserve the user's shell errexit setting inside the original command while capturing its explicit exit receipt.
- Update in-memory state only after the Pi custom entry is saved successfully. A persistence error halts the adapter until Pi is restarted. Reports are written by atomic rename before completion is saved; a failed completion save restores/removes the report, with an explicit error and halted state if rollback also fails.
- Blocked and unsuccessful runs must preserve what was attempted and why work stopped; they must never fabricate success.

## TypeScript and Simplicity

- Use ESM, strict TypeScript, explicit domain types, and pure functions for workflow state.
- Avoid `any`; use `unknown` plus validation at trust and persistence boundaries.
- Use erasable TypeScript syntax. Avoid `enum`, `namespace`, parameter properties, `import =`, and `export =`.
- Implement only the current vertical slice. Do not add speculative abstractions, compatibility layers, or future placeholders.
- Prefer fewer files and direct functions. Add a layer only when it separates two current responsibilities.
- Inspect published Pi types or official examples instead of guessing API shapes.
- Keep formatting and mechanical style in Biome configuration.

## Testing and Verification

- Automated tests must be deterministic and must not call a live model, paid API, or GitHub network.
- Test GitHub integration with injected HTTP responses and temporary local Git repositories.
- Test invalid evidence, illegal transitions, unsuccessful outcomes, and persistence failures as well as happy paths.
- Exercise live GitHub and real-model behavior separately with a disposable checkout.
- After code changes, run the relevant focused test, `npm test`, `npm run typecheck`, and `npm run check`.

## MVP Delivery Stages

- Stage 1 proved the complete workflow with a local calculator fixture. It is complete; its demo repository and fixture loader are not shipped.
- Stage 2 is the final current MVP stage: accept a real GitHub issue URL and run against the user's matching local checkout.
- A standalone CLI is not part of these two stages. It is a possible later product only after the Pi package workflow stabilizes.

## Current MVP Scope

- Support GitHub issue URLs from `github.com`; use `GITHUB_TOKEN` when present and allow unauthenticated public issue reads.
- Require users to enter the matching local repository before `/repro`; do not clone or change repositories automatically.
- Support the complete Pi workflow, TUI status, session recovery, deterministic reports, optional fixes, and honest blocked outcomes.
- ReproPilot itself uses TypeScript and Vitest, but target repositories are not restricted by language or test framework.
- Use each target repository's existing commands and toolchain; do not add language-specific adapters without a current need.
- Workspace snapshots require a committed Git HEAD. Submodules and special files are rejected rather than certifying an incomplete fingerprint; dependency directories ignored by Git remain outside the repository-content fingerprint.
- Do not add a standalone CLI, web UI, database, cloud sandbox, GitHub App, PR creation, or multi-user support.

## Change Safety

- Ask before adding a production dependency or expanding MVP scope.
- Do not copy or modify Pi internals.
- Do not commit, push, publish, or modify remote repositories unless the user explicitly asks.

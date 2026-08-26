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
- `extensions/` adapts the core to public `@earendil-works/pi-coding-agent` APIs.
- Do not import `@earendil-works/pi-agent-core` directly unless a requirement recorded in this file cannot be met by Pi Coding Agent.
- Reuse Pi's built-in repository tools. Do not wrap or replace `read`, `bash`, `edit`, or `write`.
- Workflow validity belongs in `src/core/`. `skills/repro-workflow/SKILL.md` explains procedure but must not define or duplicate completion gates.
- Keep one canonical workflow implementation for the Pi package and any later CLI.

## State and Evidence Invariants

- The runtime is model-driven, but phase transitions, evidence validity, and completion decisions are deterministic TypeScript rules.
- Persist versioned, validated state in Pi custom session entries. The Markdown report is a generated artifact, not the state database.
- Restore only the latest valid ReproPilot entry on the current session branch and inject a compact state snapshot before model turns.
- Treat issue text, model arguments, command output, and restored state as untrusted input.
- Evidence is append-only, bounded, redacted, and stamped with its matching workflow phase.
- Executed command and test evidence requires the exact command and integer exit code; its kind, result, and exit code must agree.
- Reproduction requires executed evidence showing actual versus expected behavior. Reading code is not proof.
- Regression evidence must come from a test observed failing against the baseline before a fix is applied.
- A `fixed` outcome requires positive fix evidence plus passing post-fix regression and relevant existing-test evidence.
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
- Do not add a standalone CLI, web UI, database, cloud sandbox, GitHub App, PR creation, or multi-user support.

## Change Safety

- Ask before adding a production dependency or expanding MVP scope.
- Do not copy or modify Pi internals.
- Do not commit, push, publish, or modify remote repositories unless the user explicitly asks.

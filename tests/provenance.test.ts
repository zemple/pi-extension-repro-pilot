import { describe, expect, it } from "vitest";
import { recordEvidence } from "../src/core/evidence.ts";
import { setRunPhase } from "../src/core/run-state.ts";

import { initial } from "./fixtures.ts";

const timestamp = "2026-10-23T12:00:00.000Z";

describe("execution provenance", () => {
  it("rejects a command and exit code invented by the caller", () => {
    const state = setRunPhase(initial(), "reproduce");
    expect(() =>
      recordEvidence(
        state,
        {
          kind: "command",
          purpose: "reproduction",
          result: "observed",
          summary: "Claimed execution",
          ...({ command: "node repro.mjs", exitCode: 0 } as object),
        },
        timestamp,
      ),
    ).toThrow();
  });

  it("rejects an execution ID which was never observed", () => {
    const state = setRunPhase(initial(), "reproduce");
    expect(() =>
      recordEvidence(
        state,
        {
          kind: "command",
          purpose: "reproduction",
          summary: "Claimed execution",
          executionId: "unknown",
          reproduction: { bugObserved: true, actual: "1", expected: "0" },
        },
        timestamp,
      ),
    ).toThrow();
  });
});

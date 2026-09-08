// Builder outcome classification — turns an executor result + git commit
// state into a structured outcome so the implementation controller can decide
// whether to retry, continue, or stop without pressuring the Builder into a
// manufactured diff.
//
// Contract with Builder prompts:
//   - CONTRACT_NOOP <reason>     requested behavior already satisfied; no safe
//                                scoped edit is required
//   - CONTRACT_BLOCKED <reason>  a named file is missing, a required command
//                                cannot run, or the contract cannot be executed
//                                safely

import type { AgentExecutionResult } from "./interfaces.js";
import type { WorkspaceCommitResult } from "./git-ops.js";

export type BuilderOutcomeKind =
  | "implemented"
  | "contract-noop"
  | "contract-blocked"
  | "no-change-unclear"
  | "executor-failed";

export interface BuilderOutcome {
  kind: BuilderOutcomeKind;
  reason?: string;
}

// A directive line: at the start of a line, the exact token, and either end of
// line or a following reason. Multiline output commonly ends with the token,
// and the token may be wrapped in backticks, so match the token at the start
// of any line and take the rest of that line as the reason.
const NOOP_PATTERN = /(?:^|\n)\s*`?CONTRACT_NOOP`?(?:\s+(.+?))?\s*$/im;
const BLOCKED_PATTERN = /(?:^|\n)\s*`?CONTRACT_BLOCKED`?(?:\s+(.+?))?\s*$/im;

export function classifyBuilderOutcome(
  result: AgentExecutionResult,
  committedChange: WorkspaceCommitResult,
): BuilderOutcome {
  if (result.status !== "completed") {
    return {
      kind: "executor-failed",
      reason: result.errorMessage ?? `builder executor returned ${result.status}`,
    };
  }

  if (committedChange.committed) {
    return { kind: "implemented" };
  }

  const output = result.outputText?.trim() ?? "";
  const noop = output.match(NOOP_PATTERN);
  if (noop) {
    return {
      kind: "contract-noop",
      reason: noop[1]?.trim() || "Builder reported that the approved contract requires no code changes.",
    };
  }

  const blocked = output.match(BLOCKED_PATTERN);
  if (blocked) {
    return {
      kind: "contract-blocked",
      reason: blocked[1]?.trim() || "Builder reported that the approved contract cannot be executed safely.",
    };
  }

  return { kind: "no-change-unclear" };
}

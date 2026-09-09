import { nonGoalViolations } from "../../runtime/scope-check.js";
import type {
  ProviderVerificationResult,
  ScopeRequirement,
  VerificationProvider,
  VerificationProviderContext,
} from "../types.js";

export const scopeProvider: VerificationProvider = {
  type: "SCOPE",
  async verify(requirement, context: VerificationProviderContext): Promise<ProviderVerificationResult> {
    const scope = requirement as ScopeRequirement;
    const changedFiles = scope.affectedFiles ?? [];
    const violations = nonGoalViolations(changedFiles, scope.nonGoals);

    const evidenceId = `EV-scope-${++scopeEvidenceCounter}`;
    context.evidence[evidenceId] = {
      kind: "scope-check",
      nonGoals: scope.nonGoals,
      changedFiles,
      violations: violations.map((violation) => ({
        file: violation.file,
        nonGoal: violation.nonGoal,
        match: violation.match,
      })),
    };

    if (violations.length === 0) {
      return {
        requirementId: requirement.id,
        status: "PASS",
        evidence: [{ id: evidenceId, kind: "scope-check" }],
      };
    }
    return {
      requirementId: requirement.id,
      status: "FAIL",
      evidence: [{ id: evidenceId, kind: "scope-check" }],
      reason: `Changed files modify declared non-goals: ${violations.map((violation) => violation.file).join(", ")}`,
    };
  },
};

let scopeEvidenceCounter = 0;

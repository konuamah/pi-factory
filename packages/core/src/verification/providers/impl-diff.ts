import { isTransientFactoryPath } from "../../runtime/git-ops.js";
import type {
  ImplDiffRequirement,
  ProviderVerificationResult,
  VerificationProvider,
} from "../types.js";

let evidenceCounter = 0;

export const implDiffProvider: VerificationProvider = {
  type: "IMPL_DIFF",
  async verify(requirement, context): Promise<ProviderVerificationResult> {
    const input = requirement as ImplDiffRequirement;
    const productFiles = input.changedFiles.filter((file) => !isTransientFactoryPath(file));
    const evidenceId = `EV-impl-diff-${++evidenceCounter}`;
    context.evidence[evidenceId] = {
      kind: "impl-diff",
      baseBranch: input.baseBranch,
      productFiles: productFiles.slice(0, 50),
      totalChangedFiles: input.changedFiles.length,
    };
    return productFiles.length > 0
      ? { requirementId: requirement.id, status: "PASS", evidence: [{ id: evidenceId, kind: "impl-diff" }] }
      : {
          requirementId: requirement.id,
          status: "FAIL",
          evidence: [{ id: evidenceId, kind: "impl-diff" }],
          reason: `No non-generated product files were changed against base branch '${input.baseBranch}'.`,
        };
  },
};

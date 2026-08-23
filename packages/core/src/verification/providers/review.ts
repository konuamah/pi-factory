import type {
  ProviderVerificationResult,
  ReviewFinding,
  ReviewRequirement,
  VerificationProvider,
  VerificationProviderContext,
} from "../types.js";
import type { AgentExecutor } from "../../runtime/interfaces.js";

export interface ReviewProviderOptions {
  executor?: AgentExecutor;
  model?: { provider?: string; model: string };
  goal?: string;
  guidance?: string;
}

export function createReviewProvider(options: ReviewProviderOptions): VerificationProvider {
  return {
    type: "REVIEW",
    async verify(requirement, context): Promise<ProviderVerificationResult> {
      const review = requirement as ReviewRequirement;
      if (!options.executor) {
        return {
          requirementId: requirement.id,
          status: "INCONCLUSIVE",
          evidence: [],
          reason: "Review requirement exists but no reviewer executor is available; cannot auto-confirm.",
        };
      }

      const evidenceId = `EV-${++reviewCounter}`;
      const prompt = buildReviewPrompt(review, options.goal, options.guidance, context.results);
      try {
        const result = await options.executor.execute({
          executionId: `verification-review-${requirement.id}`,
          cwd: context.cwd,
          prompt,
          model: options.model,
          tools: ["read", "grep", "find", "ls"],
          metadata: { role: "reviewer", verificationRequirement: requirement.id },
        });

        const findings = parseFindings(result.outputText);
        const blockingFindings = findings.filter((finding) =>
          (review.blockingSeverities as string[]).includes(finding.severity),
        );

        context.evidence[evidenceId] = {
          kind: "review-result",
          focus: review.focus,
          findings,
        };

        if (blockingFindings.length > 0) {
          return {
            requirementId: requirement.id,
            status: "FAIL",
            evidence: [{ id: evidenceId, kind: "review-result" }],
            findings,
            reason: `Review found ${blockingFindings.length} blocking finding(s).`,
          };
        }
        return {
          requirementId: requirement.id,
          status: "PASS",
          evidence: [{ id: evidenceId, kind: "review-result" }],
          findings,
        };
      } catch (error) {
        return {
          requirementId: requirement.id,
          status: "INCONCLUSIVE",
          evidence: [],
          reason: `Review executor failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}

let reviewCounter = 0;

function buildReviewPrompt(
  review: ReviewRequirement,
  goal: string | undefined,
  guidance: string | undefined,
  priorResults: VerificationProviderContext["results"],
): string {
  const priorSummary = priorResults
    .map((result) => `- ${result.requirementId}: ${result.status}${result.reason ? ` (${result.reason})` : ""}`)
    .join("\n");
  return [
    `Goal: ${goal ?? "Factory task"}`,
    `Review focus: ${review.focus.join(", ")}`,
    `Blocking severities: ${review.blockingSeverities.join(", ")}`,
    guidance ? `Project guidance context:\n${guidance}` : undefined,
    priorSummary ? `Verification results so far:\n${priorSummary}` : undefined,
    "Review the candidate against the focus areas. Report findings as:",
    "FINDING <CRITICAL|HIGH|MEDIUM|LOW|INFO>: <claim>",
    "Return only findings lines, or 'CLEAN' if no findings.",
  ].filter(Boolean).join("\n");
}

export function parseFindings(outputText: string): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const line of outputText.split(/\r?\n/)) {
    const match = line.match(/^FINDING\s+(CRITICAL|HIGH|MEDIUM|LOW|INFO)\s*:\s*(.+)$/i);
    if (match) {
      findings.push({
        severity: match[1]!.toUpperCase() as ReviewFinding["severity"],
        claim: match[2]!.trim(),
      });
    }
  }
  return findings;
}

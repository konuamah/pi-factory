import type {
  ProviderVerificationResult,
  ReviewFinding,
  ReviewRequirement,
  VerificationProvider,
  VerificationProviderContext,
} from "../types.js";
import type { DecisionRequest } from "../../decisions/types.js";
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
        const needsDecision = findings.find((finding) => finding.disposition === "NEEDS_DECISION");
        const blockingFindings = findings.filter((finding) =>
          (review.blockingSeverities as string[]).includes(finding.severity),
        );

        context.evidence[evidenceId] = {
          kind: "review-result",
          focus: review.focus,
          findings,
        };

        if (needsDecision) {
          return {
            requirementId: requirement.id,
            status: "INCONCLUSIVE",
            evidence: [{ id: evidenceId, kind: "review-result" }],
            findings,
            reason: `Review requires a human decision: ${needsDecision.claim}`,
            decision: needsDecision.decision,
          };
        }

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
      const finding: ReviewFinding = {
        severity: match[1]!.toUpperCase() as ReviewFinding["severity"],
        claim: match[2]!.trim(),
      };
      // A disposition line follows the finding: NEEDS_DECISION question | optionA; optionB; optionC
      const dispositionMatch = line.match(/NEEDS_DECISION\s+([^|]+)\s*\|\s*(.+)/i);
      if (dispositionMatch) {
        finding.disposition = "NEEDS_DECISION";
        finding.decision = {
          id: `decision-${findings.length + 1}`,
          title: "Reviewer decision required",
          question: dispositionMatch[1]!.trim(),
          options: dispositionMatch[2]!.split(";").map((option, index) => {
            const [label, ...rest] = option.trim().split(" — ");
            return { id: `option-${index + 1}`, label: label ?? option.trim(), description: rest.join(" — ") || undefined };
          }),
          source: "REVIEWER",
          reason: "CONFLICT",
        };
      }
      findings.push(finding);
    }
  }
  return findings;
}

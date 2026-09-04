// LLM judge for benchmark run quality.
//
// The deterministic scorer (scoring.ts) measures mechanical signals — topic
// coverage, round counts, scope — but cannot judge quality ("was that a good
// question?"). This module adds an optional LLM judge that scores the run's
// artifacts against a rubric, following the same pattern as
// classifyVerificationFailuresWithAI: an AgentExecutor runs a strict-JSON
// prompt; if no executor is available the judge returns undefined and the
// caller falls back to the deterministic score. The judge never fabricates a
// score and never merges into the deterministic pillars — it is an additive,
// separately-reported signal (judge scores vary run to run by nature).

import type { RunArtifacts } from "../runs/artifacts-read.js";
import type { AgentExecutor } from "../runtime/interfaces.js";
import type { BenchmarkTaskSpec, PillarName } from "./types.js";

export interface JudgeVerdict {
  /** Judge-provided scores, 0..1 per pillar. Missing pillar = null. */
  scores: Partial<Record<PillarName, number>>;
  /** One-line reasoning per scored pillar. */
  reasoning: Partial<Record<PillarName, string>>;
  warnings: string[];
}

const ALL_PILLARS: PillarName[] = [
  "interviewQuality",
  "handoffQuality",
  "executionQuality",
  "mergeQuality",
  "adaptationQuality",
  "scopeQuality",
  "timeEfficiency",
];

export interface JudgeInput {
  executor?: AgentExecutor;
  model?: { provider?: string; model: string };
  artifacts: RunArtifacts;
  spec: BenchmarkTaskSpec;
  rubric: string;
  /** Neutral cwd for the judge session (defaults to process.cwd()). */
  cwd?: string;
}

export async function judgeRunQuality(input: JudgeInput): Promise<JudgeVerdict | undefined> {
  if (!input.executor) {
    return undefined;
  }

  const prompt = buildJudgePrompt(input.artifacts, input.spec, input.rubric);
  let outputText: string;
  try {
    const result = await input.executor.execute({
      executionId: `benchmark-judge-${Date.now()}`,
      // Judge from a neutral cwd, not the run dir: the run dir on the host is a
      // collected artifact folder with no pi session context, and the SDK
      // session may fail to create against it.
      cwd: input.cwd ?? process.cwd(),
      prompt,
      model: input.model,
      tools: [],
      metadata: { role: "reviewer", stage: "benchmark-judge" },
    });
    outputText = result.outputText;
  } catch {
    return undefined;
  }

  const parsed = parseStrictJson(outputText);
  if (!parsed) {
    return undefined;
  }
  return sanitizeJudgeVerdict(parsed);
}

export function buildJudgePrompt(artifacts: RunArtifacts, spec: BenchmarkTaskSpec, rubric: string): string {
  const evidence: Record<string, unknown> = {
    goal: spec.goal,
    taskId: spec.id,
    interviewRequired: spec.interviewRequired,
    interviewDecisions: artifacts.interviewDecisions.map((round) => ({
      stage: round.stage,
      question: round.question,
      answer: round.answer ?? null,
      questions: round.questions ?? null,
    })),
    plan: artifacts.plan
      ? {
          summary: artifacts.plan.summary,
          planText: artifacts.plan.planText,
          implementationContract: artifacts.plan.implementationContract,
        }
      : null,
    verification: artifacts.verification
      ? {
          overallStatus: (artifacts.verification as { overallStatus?: string }).overallStatus,
          cwd: (artifacts.verification as { cwd?: string }).cwd,
          commands: (artifacts.verification as { commands?: Array<{ name?: string; status?: string }> }).commands,
        }
      : null,
    changedFiles: [...new Set(artifacts.completedTasks.flatMap((task) => task.changedFiles ?? []))],
    finalMerge: artifacts.finalMerge ? { status: artifacts.finalMerge.status, outcome: artifacts.finalMerge.outcome } : null,
    summary: artifacts.summary ? { status: artifacts.summary.status, verificationStatus: artifacts.summary.verificationStatus } : null,
  };

  return [
    "You are a rigorous benchmark judge for a coding-agent orchestration harness.",
    "Score the run's quality on each pillar from the EVIDENCE ONLY. Do not guess or extrapolate.",
    "Return STRICT JSON only, no markdown, no prose:",
    "{",
    '  "scores": { "interviewQuality": 0.0-1.0, "handoffQuality": ..., "executionQuality": ..., "mergeQuality": ..., "adaptationQuality": ..., "scopeQuality": ..., "timeEfficiency": ... },',
    '  "reasoning": { "interviewQuality": "one line", ... }',
    "}",
    "",
    "Pillar meanings:",
    "- interviewQuality: did the interview ask the right clarifying questions and use the answers?",
    "- handoffQuality: did interview decisions and plan intent survive into the build?",
    "- executionQuality: did the run complete, verify, and land correctly?",
    "- mergeQuality: was the landing safe and correctly diagnosed?",
    "- adaptationQuality: did verification adapt to the repo's real commands?",
    "- scopeQuality: did it change only what it should?",
    "- timeEfficiency: was the agent time reasonable for the task?",
    "",
    "Rubric:",
    rubric,
    "",
    "Evidence (from the run artifacts):",
    JSON.stringify(evidence, null, 2),
  ].join("\n");
}

export function parseStrictJson(outputText: string): Record<string, unknown> | undefined {
  const fenced = outputText.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const raw = (fenced ?? outputText).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function sanitizeJudgeVerdict(parsed: Record<string, unknown>): JudgeVerdict {
  const warnings: string[] = [];
  const scores: JudgeVerdict["scores"] = {};
  const reasoning: JudgeVerdict["reasoning"] = {};
  const rawScores = parsed.scores && typeof parsed.scores === "object"
    ? (parsed.scores as Record<string, unknown>)
    : {};
  const rawReasoning = parsed.reasoning && typeof parsed.reasoning === "object"
    ? (parsed.reasoning as Record<string, unknown>)
    : {};

  for (const pillar of ALL_PILLARS) {
    const value = rawScores[pillar];
    if (typeof value === "number" && Number.isFinite(value)) {
      scores[pillar] = Math.max(0, Math.min(1, value));
    } else {
      warnings.push(`judge returned no numeric score for ${pillar}`);
    }
    if (typeof rawReasoning[pillar] === "string" && rawReasoning[pillar].trim()) {
      reasoning[pillar] = rawReasoning[pillar].trim();
    }
  }

  return { scores, reasoning, warnings };
}

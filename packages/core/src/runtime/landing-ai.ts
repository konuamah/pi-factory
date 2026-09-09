import { resolveModelForRole } from "../models/index.js";
import type { AgentExecutor, AgentExecutionInput } from "./interfaces.js";
import type {
  PrototypeCompletedTaskArtifact,
  PrototypeLandingDiagnosisArtifact,
} from "./artifacts.js";
import type { VerificationRunResult } from "./verification.js";
import type { EffectiveFactoryConfig, ModelSelection } from "@factory/schemas";
import type { LandingPlan } from "./landing-types.js";
import type { LandingAction } from "./landing-types.js";

export function resolveLandingModel(
  config: EffectiveFactoryConfig,
  taskType: string,
): { model: ModelSelection; source: string } {
  try {
    return resolveModelForRole({ role: "landing", taskType, config });
  } catch {
    const fallback = config.models.reviewer;
    if (!fallback?.model) {
      throw new Error(`No model configured for landing or reviewer under task type '${taskType}'.`);
    }
    return { model: fallback, source: "reviewer-fallback" };
  }
}

export async function buildLandingPlan(input: {
  executor?: AgentExecutor;
  model: ModelSelection;
  goal: string;
  mergeCwd: string;
  baseBranch: string;
  finalMergePolicy: "required" | "not-required";
  dirtyFiles: string[];
  dirtyRelevantFiles?: string[];
  dirtyUnrelatedFiles?: string[];
  completedTasks: PrototypeCompletedTaskArtifact[];
  candidateSha?: string;
  candidateBranch?: string;
  verification: VerificationRunResult;
  verificationFailureClassification?: unknown;
  limits?: AgentExecutionInput["limits"];
  recoveryFeedback?: string;
  recoveryAttempt?: number;
}): Promise<LandingPlan> {
  if (!input.executor) {
    throw new Error("Landing planning requires a landing or reviewer executor.");
  }
  const result = await input.executor.execute({
    executionId: `landing-plan-${input.recoveryAttempt && input.recoveryAttempt > 1 ? `retry-${input.recoveryAttempt}` : Date.now()}`,
    cwd: input.mergeCwd,
    prompt: buildLandingPlannerPrompt(input),
    model: input.model,
    tools: ["read", "grep", "find", "ls"],
    limits: input.limits,
    metadata: { role: "landing", stage: "landing", attempt: input.recoveryAttempt },
  });
  const parsed = parseJsonObject(result.outputText);
  if (!parsed) {
    throw new Error("Landing planner returned invalid JSON.");
  }
  return sanitizeLandingPlan(parsed, input);
}

export async function diagnoseLandingFailure(input: {
  executor?: AgentExecutor;
  model: ModelSelection;
  plan: LandingPlan;
  reason: string;
  dirtyFiles: string[];
  verification: VerificationRunResult;
  limits?: AgentExecutionInput["limits"];
}): Promise<PrototypeLandingDiagnosisArtifact> {
  if (!input.executor) {
    return fallbackDiagnosis(input.reason, input.dirtyFiles, input.verification.overallStatus);
  }
  try {
    const result = await input.executor.execute({
      executionId: `landing-diagnosis-${Date.now()}`,
      cwd: ".",
      prompt: buildLandingDiagnosisPrompt(input),
      model: input.model,
      tools: ["read", "grep", "find", "ls"],
      limits: input.limits,
      metadata: { role: "landing", stage: "landing-diagnosis" },
    });
    const parsed = parseJsonObject(result.outputText);
    if (!parsed) {
      return fallbackDiagnosis(input.reason, input.dirtyFiles, input.verification.overallStatus);
    }
    return sanitizeLandingDiagnosis(parsed, input.reason, input.dirtyFiles, input.verification.overallStatus);
  } catch {
    return fallbackDiagnosis(input.reason, input.dirtyFiles, input.verification.overallStatus);
  }
}

export function buildLandingPlannerPrompt(input: {
  goal: string;
  baseBranch: string;
  finalMergePolicy: string;
  dirtyFiles: string[];
  dirtyRelevantFiles?: string[];
  dirtyUnrelatedFiles?: string[];
  completedTasks: PrototypeCompletedTaskArtifact[];
  candidateSha?: string;
  candidateBranch?: string;
  verification: VerificationRunResult;
  verificationFailureClassification?: unknown;
  recoveryFeedback?: string;
  recoveryAttempt?: number;
}): string {
  return [
    "You are the Factory landing planner.",
    "Return STRICT JSON only. No markdown.",
    "Choose an ordered composed landing plan. Deterministic code will validate and execute your exact Git argv; it will never rewrite the plan.",
    "Return actions[] with git steps or a GitHub pull-request action. Prefer a branch merge for multiple commits. Use pull-request when direct landing is unsafe; do not stop when a safe delivery path exists.",
    "Git actions must not use --exec, -c, --upload-pack, --receive-pack, --config-env, shell metacharacters, or path traversal.",
    'Allowed risk: "low" | "medium" | "high".',
    JSON.stringify({
      actions: [{ kind: "git", step: { program: "git", args: ["merge", "--no-ff", input.candidateBranch ?? "candidate"], intent: "land candidate branch" } }],
      targetBranch: input.baseBranch,
      candidateSha: input.candidateSha,
      sourceBranch: input.candidateBranch,
      rationale: "short reason",
      verification: ["test"],
      risk: "low",
      expectedFiles: ["src/file.ts"],
      recoveryPlan: "If direct landing is unsafe or cannot complete, use pull-request to publish the candidate; never abandon a valid candidate.",
    }, null, 2),
    "Evidence:",
    JSON.stringify({
      goal: input.goal,
      baseBranch: input.baseBranch,
      finalMergePolicy: input.finalMergePolicy,
      dirtyFiles: input.dirtyFiles,
      dirtyRelevantFiles: input.dirtyRelevantFiles ?? [],
      dirtyUnrelatedFiles: input.dirtyUnrelatedFiles ?? [],
      candidateSha: input.candidateSha,
      candidateBranch: input.candidateBranch,
      completedTasks: input.completedTasks,
      verificationStatus: input.verification.overallStatus,
      verificationFailureClassification: input.verificationFailureClassification,
      verificationCommands: input.verification.commands.map((command) => ({
        name: command.name,
        status: command.status,
      })),
    }, null, 2),
    input.recoveryAttempt && input.recoveryAttempt > 1
      ? `Recovery attempt ${input.recoveryAttempt}: a previous landing plan was rejected or failed. Address the recovery guidance below.`
      : undefined,
    input.recoveryFeedback
      ? `Runtime recovery guidance from the user (revise):\n${truncateRecoveryFeedback(input.recoveryFeedback)}`
      : undefined,
  ].filter(Boolean).join("\n");
}

function truncateRecoveryFeedback(value: string): string {
  return value.length <= 8000 ? value : `${value.slice(0, 8000)}…`;
}

function buildLandingDiagnosisPrompt(input: {
  plan: LandingPlan;
  reason: string;
  dirtyFiles: string[];
  verification: VerificationRunResult;
}): string {
  return [
    "You diagnose Factory landing failures.",
    "Return STRICT JSON only. No markdown.",
    JSON.stringify({
      kind: "unknown",
      reasoning: ["short reason"],
      retryable: false,
      recoveryAction: "block",
      risk: "medium",
      recoveryHint: "what to do next",
    }, null, 2),
    "Evidence:",
    JSON.stringify({
      plan: input.plan,
      reason: input.reason,
      dirtyFiles: input.dirtyFiles,
      verificationStatus: input.verification.overallStatus,
      verificationCommands: input.verification.commands.map((command) => ({
        name: command.name,
        status: command.status,
      })),
    }, null, 2),
  ].join("\n");
}

function sanitizeLandingPlan(
  parsed: Record<string, unknown>,
  input: { baseBranch: string; candidateSha?: string; candidateBranch?: string; completedTasks: PrototypeCompletedTaskArtifact[] },
): LandingPlan {
  const risk = pick(parsed.risk, ["low", "medium", "high"]) ?? "high";
  const actions = sanitizeActions(parsed.actions);
  return {
    actions,
    targetBranch: typeof parsed.targetBranch === "string" && parsed.targetBranch.trim() ? parsed.targetBranch : input.baseBranch,
    candidateSha: typeof parsed.candidateSha === "string" ? parsed.candidateSha : input.candidateSha ?? input.completedTasks[0]?.commitSha,
    sourceBranch: typeof parsed.sourceBranch === "string" ? parsed.sourceBranch : input.candidateBranch ?? input.completedTasks[0]?.sourceBranch,
    rationale: typeof parsed.rationale === "string" ? parsed.rationale : "Landing planner returned no rationale.",
    verification: coerceStringArray(parsed.verification, []),
    risk,
    expectedFiles: coerceStringArray(parsed.expectedFiles, input.completedTasks.flatMap((task) => task.changedFiles)),
    recoveryPlan: typeof parsed.recoveryPlan === "string" ? parsed.recoveryPlan : undefined,
  };
}

function sanitizeActions(value: unknown): LandingAction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): LandingAction[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (record.kind === "git" && record.step && typeof record.step === "object") {
      const step = record.step as Record<string, unknown>;
      if (step.program === "git" && Array.isArray(step.args) && step.args.every((arg) => typeof arg === "string")) {
        return [{ kind: "git", step: { program: "git", args: step.args as string[], intent: typeof step.intent === "string" ? step.intent : "landing step" } }];
      }
    }
    if (record.kind === "pull-request" && record.provider === "github" && typeof record.sourceBranch === "string" && typeof record.targetBranch === "string") {
      return [{ kind: "pull-request", provider: "github", sourceBranch: record.sourceBranch, targetBranch: record.targetBranch, title: typeof record.title === "string" ? record.title : "Factory candidate", body: typeof record.body === "string" ? record.body : "Review the Factory candidate.", draft: record.draft === true }];
    }
    return [];
  });
}

function sanitizeLandingDiagnosis(
  parsed: Record<string, unknown>,
  reason: string,
  dirtyFiles: string[],
  verificationStatus: string,
): PrototypeLandingDiagnosisArtifact {
  const fallback = fallbackDiagnosis(reason, dirtyFiles, verificationStatus);
  return {
    kind: pick(parsed.kind, ["dirty-target", "merge-conflict", "cherry-pick-conflict", "rebase-conflict", "missing-candidate", "candidate-empty", "transient-only-change", "verification-failed", "verification-missing", "baseline-debt", "environment-failure", "unsafe-risk", "auth-required", "timeout", "unknown"]) ?? fallback.kind,
    reasoning: coerceStringArray(parsed.reasoning, [reason]),
    retryable: typeof parsed.retryable === "boolean" ? parsed.retryable : fallback.retryable,
    recoveryAction: pick(parsed.recoveryAction, ["repair-code", "resolve-conflict", "refresh-target", "rerun-verification", "replan-landing", "prepare-environment", "ask-approval", "block"]) ?? fallback.recoveryAction,
    risk: pick(parsed.risk, ["low", "medium", "high"]) ?? fallback.risk,
    recoveryHint: typeof parsed.recoveryHint === "string" && parsed.recoveryHint.trim() ? parsed.recoveryHint : fallback.recoveryHint,
  };
}

function fallbackDiagnosis(reason: string, dirtyFiles: string[], verificationStatus: string): PrototypeLandingDiagnosisArtifact {
  if (dirtyFiles.length > 0) {
    return {
      kind: "dirty-target",
      reasoning: ["Target checkout has uncommitted changes."],
      retryable: true,
      recoveryAction: "block",
      risk: "medium",
      recoveryHint: `Clean or stash these files, then retry landing: ${dirtyFiles.join(", ")}`,
    };
  }
  if (verificationStatus === "failed") {
    return {
      kind: "verification-failed",
      reasoning: ["Post-landing verification failed."],
      retryable: true,
      recoveryAction: "repair-code",
      risk: "medium",
      recoveryHint: "Repair the landed code and rerun verification.",
    };
  }
  return {
    kind: reason.includes("conflict") ? "merge-conflict" : "unknown",
    reasoning: [reason],
    retryable: reason.includes("conflict"),
    recoveryAction: reason.includes("conflict") ? "resolve-conflict" : "block",
    risk: reason.includes("conflict") ? "medium" : "high",
    recoveryHint: reason,
  };
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const raw = (fenced ?? value).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function coerceStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const result = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 20);
  return result.length > 0 ? result : fallback;
}

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : undefined;
}

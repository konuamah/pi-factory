import type { AgentExecutor, AgentExecutionInput } from "./interfaces.js";
import type {
  CommandFailureClassification,
  FailureCategory,
  VerificationFailureClassification,
} from "./failure-classification.js";
import type { VerificationCommandResult, VerificationPlan, VerificationRunResult } from "./verification.js";
import { isGeneratedPath, filesReferToSamePath } from "./failure-classification.js";

export type ClassificationSource = "ai" | "deterministic";

/** Strictly allowed categories — the LLM cannot invent others. */
const ALLOWED_CATEGORIES: FailureCategory[] = [
  "missing-executable",
  "invalid-command",
  "missing-dependency",
  "environment-policy",
  "real-code-failure",
  "baseline-unrelated",
  "harness/config",
  "unknown",
];

const ALLOWED_ACTIONS = ["repair", "prepare-environment", "diagnose", "ignore", "blocker"] as const;
const ALLOWED_PHASES = ["verification", "verification-planning"] as const;

export interface AiClassificationResult {
  kind: FailureCategory;
  reason: string;
  retryable: boolean;
  suggestedPhase: string;
  rootCause?: string;
  suggestedGeneralFix?: string;
  perCommand: CommandFailureClassification[];
}

/**
 * Build a compact, deterministic evidence packet for the LLM.
 * Deterministic code still owns extraction and normalization.
 */
export function buildFailureEvidence(input: {
  plan: VerificationPlan;
  result: VerificationRunResult;
  changedFiles?: string[];
  deterministic: VerificationFailureClassification;
}): Record<string, unknown> {
  const failedCommands = input.result.commands.filter((command) => command.status === "failed").map((command) => ({
    name: command.name,
    command: command.command,
    exitCode: command.exitCode,
    stdoutHead: truncate(command.stdout ?? "", 600),
    stderrHead: truncate(command.stderr ?? "", 600),
  }));
  return {
    verificationCwd: input.result.cwd,
    selectedPlan: {
      commands: input.plan.commands,
      rationale: input.plan.rationale,
    },
    changedFiles: input.changedFiles ?? [],
    failedCommands,
    deterministicClassification: {
      kind: input.deterministic.kind,
      reason: input.deterministic.reason,
      retryable: input.deterministic.retryable,
      suggestedPhase: input.deterministic.suggestedPhase,
      perCommand: input.deterministic.perCommand,
    },
  };
}

/**
 * Ask the LLM to classify the failure. Strict guards:
 * - Only allowed categories/actions/phases survive.
 * - A failure can never be marked PASS.
 * - repair is only allowed for real-code-failure (or harness/config diagnose).
 * - invalid JSON / model failure → returns undefined → caller falls back to deterministic.
 */
export async function classifyVerificationFailuresWithAI(input: {
  plan: VerificationPlan;
  result: VerificationRunResult;
  changedFiles?: string[];
  deterministic: VerificationFailureClassification;
  executor?: AgentExecutor;
  model?: { provider?: string; model: string };
  limits?: AgentExecutionInput["limits"];
}): Promise<AiClassificationResult | undefined> {
  if (!input.executor) {
    return undefined;
  }

  const evidence = buildFailureEvidence(input);
  const prompt = buildAiClassifierPrompt(input.deterministic, evidence);

  let outputText: string;
  try {
    const result = await input.executor.execute({
      executionId: `failure-classifier-${Date.now()}`,
      cwd: input.result.cwd,
      prompt,
      model: input.model,
      tools: ["read", "grep", "find", "ls"],
      limits: input.limits,
      metadata: { role: "reviewer", stage: "failure-classification" },
    });
    outputText = result.outputText;
  } catch {
    return undefined;
  }

  const parsed = parseStrictJson(outputText);
  if (!parsed) {
    return undefined;
  }
  return sanitizeAiClassification(parsed, input.deterministic, input.changedFiles);
}

function buildAiClassifierPrompt(
  deterministic: VerificationFailureClassification,
  evidence: Record<string, unknown>,
): string {
  return [
    "You are the Factory failure classifier. Your ONLY job is to classify verification failures.",
    "You cannot mark anything as passed. You only classify failures and suggest the next phase.",
    "",
    "Return STRICT JSON only, no markdown, matching exactly this shape:",
    JSON.stringify({
      kind: "real-code-failure | missing-executable | invalid-command | missing-dependency | environment-policy | baseline-unrelated | harness/config | unknown",
      reason: "short human reason",
      rootCause: "the underlying cause across all failed commands",
      suggestedGeneralFix: "one general fix for the root cause",
      retryable: true,
      suggestedPhase: "verification | verification-planning",
      perCommand: [
        {
          commandName: "lint",
          category: "real-code-failure",
          reason: "specific reason",
          retryable: true,
          suggestedAction: "repair | prepare-environment | diagnose | ignore | blocker",
          implicatedFiles: ["path/to/file.ts"],
        },
      ],
    }),
    "",
    "Constraints:",
    "- kind and perCommand[].category must be from the allowed set.",
    "- suggestedAction: repair is ONLY valid for real-code-failure or harness/config; prepare-environment for missing-executable/missing-dependency/environment-policy.",
    "- baseline-unrelated requires implicated files that are REAL SOURCE files (not .next/, dist/, build/, node_modules/ build output) and NOT among the changed files.",
    "- If implicated files are build output or overlap changed files, classify real-code-failure with action repair.",
    "- Give ONE rootCause and ONE suggestedGeneralFix that would fix all failing commands together; aim for the general fix, not per-command patches.",
    "- Keep perCommand aligned with the failed commands in the evidence.",
    "",
    "Evidence:",
    JSON.stringify(evidence, null, 2),
    "",
    "Deterministic classification (for reference):",
    JSON.stringify(deterministic, null, 2),
  ].join("\n");
}

function parseStrictJson(outputText: string): Record<string, unknown> | undefined {
  const fenced = outputText.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const raw = (fenced ?? outputText).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function sanitizeAiClassification(
  parsed: Record<string, unknown>,
  fallback: VerificationFailureClassification,
  changedFiles?: string[],
): AiClassificationResult {
  const kind = pickEnum(parsed.kind, ALLOWED_CATEGORIES) ?? fallback.kind;
  const reason = typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : fallback.reason;
  const retryable = typeof parsed.retryable === "boolean" ? parsed.retryable : fallback.retryable;
  const suggestedPhase = pickEnum(parsed.suggestedPhase, [...ALLOWED_PHASES]) ?? fallback.suggestedPhase;

  // Per-command sanitization with safety constraints.
  const rawPerCommand = Array.isArray(parsed.perCommand) ? parsed.perCommand : [];
  const perCommand: CommandFailureClassification[] = rawPerCommand.slice(0, 20).map((item) => {
    const raw = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    let category = pickEnum(raw.category, ALLOWED_CATEGORIES) ?? "unknown";
    const rawCategory = category;
    const implicatedFiles = Array.isArray(raw.implicatedFiles)
      ? raw.implicatedFiles.filter((file): file is string => typeof file === "string").slice(0, 20)
      : [];
    // Structural guard: baseline-unrelated requires implicated files that are real source
    // (not build output) and not among the changed files. Otherwise force repair.
    if (category === "baseline-unrelated") {
      const allSource = implicatedFiles.length > 0 && implicatedFiles.every((file) => !isGeneratedPath(file));
      const touchesChanged = implicatedFiles.some((file) =>
        (changedFiles ?? []).some((changed) => filesReferToSamePath(file, changed)),
      );
      if (implicatedFiles.length === 0 || !allSource || touchesChanged) {
        category = "real-code-failure";
      }
    }
    // If the guard rewrote the category, the AI's action no longer applies — recompute.
    const action = category !== rawCategory
      ? defaultAction(category)
      : pickEnum(raw.suggestedAction, [...ALLOWED_ACTIONS]) ?? defaultAction(category);
    // Structural invariant: baseline-unrelated means pre-existing debt not
    // caused by the change. It is never retryable and never repaired.
    const commandRetryable = category === "baseline-unrelated"
      ? false
      : typeof raw.retryable === "boolean" ? raw.retryable : retryable;
    const commandAction = category === "baseline-unrelated"
      ? "ignore" as const
      : constrainAction(action, category);
    return {
      commandName: typeof raw.commandName === "string" ? raw.commandName : "command",
      category,
      reason: typeof raw.reason === "string" && raw.reason.trim() ? raw.reason.trim() : reason,
      retryable: commandRetryable,
      suggestedAction: commandAction,
      implicatedFiles,
    };
  });

  return {
    kind: constrainKind(kind, perCommand),
    reason,
    retryable,
    suggestedPhase,
    rootCause: typeof parsed.rootCause === "string" && parsed.rootCause.trim() ? parsed.rootCause.trim() : undefined,
    suggestedGeneralFix: typeof parsed.suggestedGeneralFix === "string" && parsed.suggestedGeneralFix.trim() ? parsed.suggestedGeneralFix.trim() : undefined,
    perCommand: perCommand.length > 0 ? perCommand : fallback.perCommand,
  };
}

function constrainKind(kind: FailureCategory, perCommand: CommandFailureClassification[]): FailureCategory {
  // If any per-command is a real code failure, the aggregate cannot be baseline-unrelated.
  if (perCommand.some((c) => c.category === "real-code-failure")) {
    return "real-code-failure";
  }
  return kind;
}

function constrainAction(action: CommandFailureClassification["suggestedAction"], category: FailureCategory): CommandFailureClassification["suggestedAction"] {
  // Safety: repair is ONLY valid for real-code-failure or harness/config.
  if (action === "repair" && category !== "real-code-failure" && category !== "harness/config") {
    return defaultAction(category);
  }
  // Safety: prepare-environment only for env-ish categories.
  if (action === "prepare-environment" && !["missing-executable", "missing-dependency", "environment-policy"].includes(category)) {
    return defaultAction(category);
  }
  return action;
}

function defaultAction(category: FailureCategory): CommandFailureClassification["suggestedAction"] {
  switch (category) {
    case "real-code-failure": return "repair";
    case "harness/config": return "diagnose";
    case "invalid-command": return "diagnose";
    case "missing-executable":
    case "missing-dependency":
    case "environment-policy": return "prepare-environment";
    case "baseline-unrelated": return "ignore";
    case "unknown": return "diagnose";
  }
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

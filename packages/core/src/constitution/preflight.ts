import fs from "node:fs/promises";
import path from "node:path";
import type { AgentExecutor } from "../runtime/interfaces.js";
import { detectConstitutionRefreshState, hasStructuralConstitutionChanges } from "./refresh.js";

export type ConstitutionPreflightDecision = "skip" | "targeted" | "full";

export interface ConstitutionPreflightResult {
  decision: ConstitutionPreflightDecision;
  reason: string;
  deterministicFallback: ConstitutionPreflightDecision;
  changedFiles: string[];
  impactedAreaIds: number[];
  finalizedConstitution: boolean;
  usedLlm: boolean;
  errorMessage?: string;
}

export async function judgeConstitutionRefreshForTask(input: {
  cwd: string;
  goal: string;
  executor?: AgentExecutor;
}): Promise<ConstitutionPreflightResult> {
  const refresh = await detectConstitutionRefreshState(input.cwd);
  const finalizedConstitution = await hasFinalizedConstitution(input.cwd);
  const deterministicFallback = deterministicDecision(refresh, finalizedConstitution);
  const base = {
    deterministicFallback,
    changedFiles: refresh.changedFiles,
    impactedAreaIds: refresh.impactedAreaIds,
    finalizedConstitution,
  };

  if (!input.executor) {
    return {
      decision: deterministicFallback,
      reason: "No LLM preflight executor was available; using deterministic constitution refresh decision.",
      ...base,
      usedLlm: false,
    };
  }

  try {
    const result = await input.executor.execute({
      executionId: `constitution-preflight-${Date.now()}`,
      cwd: input.cwd,
      prompt: buildPreflightPrompt({
        goal: input.goal,
        finalizedConstitution,
        deterministicFallback,
        changedFiles: refresh.changedFiles,
        impactedAreaIds: refresh.impactedAreaIds,
      }),
      tools: ["read", "grep", "find", "ls"],
      metadata: { role: "constitution-preflight" },
    });
    const parsed = parsePreflightDecision(result.outputText);
    if (!parsed) {
      return {
        decision: deterministicFallback,
        reason: "LLM preflight did not return a valid decision; using deterministic constitution refresh decision.",
        ...base,
        usedLlm: true,
        errorMessage: result.errorMessage,
      };
    }
    const decision = constrainDecision(parsed.decision, deterministicFallback, finalizedConstitution);
    return {
      decision,
      reason: parsed.reason,
      ...base,
      usedLlm: true,
      errorMessage: result.errorMessage,
    };
  } catch (error) {
    return {
      decision: deterministicFallback,
      reason: "LLM preflight failed; using deterministic constitution refresh decision.",
      ...base,
      usedLlm: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

function deterministicDecision(
  refresh: Awaited<ReturnType<typeof detectConstitutionRefreshState>>,
  finalizedConstitution: boolean,
): ConstitutionPreflightDecision {
  if (refresh.noChange && finalizedConstitution) return "skip";
  if (
    finalizedConstitution &&
    refresh.impactedAreaIds.length > 0 &&
    refresh.impactedAreaIds.length <= 12 &&
    !hasStructuralConstitutionChanges(refresh.changedFiles)
  ) {
    return "targeted";
  }
  return "full";
}

async function hasFinalizedConstitution(cwd: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(cwd, ".factory", "constitution", "metadata.json"), "utf8");
    const parsed = JSON.parse(raw) as { finalized?: boolean };
    return parsed.finalized === true;
  } catch {
    return false;
  }
}

function buildPreflightPrompt(input: {
  goal: string;
  finalizedConstitution: boolean;
  deterministicFallback: ConstitutionPreflightDecision;
  changedFiles: string[];
  impactedAreaIds: number[];
}): string {
  return [
    "You are deciding whether Factory must refresh repository constitution context before this task.",
    "Choose one decision: skip, targeted, or full.",
    "skip means use the existing finalized constitution without scanning now.",
    "targeted means scan/interpret only areas affected by current changes.",
    "full means perform a full constitution refresh.",
    "Prefer skip only when the existing constitution is finalized and current changes do not affect the task's needed repo understanding.",
    "Prefer targeted for small local changes where focused context is enough.",
    "Prefer full for setup, architecture, dependency, config, security, deployment, multi-service, or broad refactor tasks.",
    `Goal: ${input.goal}`,
    `Existing finalized constitution: ${input.finalizedConstitution ? "yes" : "no"}`,
    `Deterministic fallback: ${input.deterministicFallback}`,
    `Changed files: ${input.changedFiles.slice(0, 60).join(", ") || "none"}`,
    `Impacted area IDs: ${input.impactedAreaIds.join(", ") || "none"}`,
    "Return JSON only: {\"decision\":\"skip|targeted|full\",\"reason\":\"short plain-English reason\"}",
  ].join("\n");
}

function parsePreflightDecision(raw: string): { decision: ConstitutionPreflightDecision; reason: string } | undefined {
  const json = extractJson(raw);
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as { decision?: string; reason?: string };
    if (parsed.decision !== "skip" && parsed.decision !== "targeted" && parsed.decision !== "full") {
      return undefined;
    }
    return { decision: parsed.decision, reason: String(parsed.reason ?? "LLM preflight decision.") };
  } catch {
    return undefined;
  }
}

function extractJson(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const match = trimmed.match(/\{[\s\S]*\}/);
  return match?.[0];
}

function constrainDecision(
  decision: ConstitutionPreflightDecision,
  deterministicFallback: ConstitutionPreflightDecision,
  finalizedConstitution: boolean,
): ConstitutionPreflightDecision {
  if (decision === "skip" && !finalizedConstitution) return deterministicFallback;
  if (decision === "skip" && deterministicFallback === "full") return "targeted";
  return decision;
}

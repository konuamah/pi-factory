// Planner output validation helpers — extracted from controller.ts so the
// runtime controller focuses on orchestration. Pure functions: no controller
// state, only the planner result + optional LLM executor.

import type { AgentExecutor, AgentExecutionInput } from "./interfaces.js";

export function sanitizePlannerOutput(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.replace(/\bWAITING_FOR_APPROVAL\b\s*$/m, "").trim() || undefined;
}

export function validatePlannerOutput(value: string | undefined): { ok: true } | { ok: false; reason: string } {
  const text = value?.toLowerCase() ?? "";
  if (!text) {
    return { ok: true };
  }
  // Narrow phrases that unambiguously delegate discovery to the builder
  const broadDiscoveryLanguage = [
    "search for the file",
    "search for where",
    "search for the relevant",
    "find where the file",
    "locate the file",
    "locate the relevant file",
    "identify the relevant file",
    "identify the exact file",
    "find the files that",
    "find the implementation file",
    "bounded evidence check",
    "search the codebase for",
    "search the repository for",
  ];
  const match = broadDiscoveryLanguage.find((term) => text.includes(term));
  if (match) {
    return { ok: false, reason: `Planner delegated broad discovery to Builder: "${match}"` };
  }
  return { ok: true };
}

export async function validatePlannerOutputWithLLM(input: {
  plannerOutput: string;
  executor: AgentExecutor;
  model?: { provider?: string; model: string };
  runId?: string;
  limits?: AgentExecutionInput["limits"];
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const result = await input.executor.execute({
    executionId: `${input.runId ?? "planner"}-validation`,
    cwd: ".",
    prompt: buildPlannerValidationPrompt(input.plannerOutput),
    model: input.model,
    tools: [],
    limits: input.limits,
    metadata: { role: "planner-validation", runId: input.runId },
  });
  const parsed = parsePlannerValidationResult(result.outputText);
  if (!parsed) {
    // If LLM validation fails, allow the plan through — deterministic check already passed
    return { ok: true };
  }
  return parsed;
}

export function buildPlannerValidationPrompt(plannerOutput: string): string {
  return [
    "You are validating a planner's output for a software factory.",
    "The planner should produce an implementation plan for a Builder to execute.",
    "The planner should NOT ask the Builder to do broad discovery (searching for files, locating code, identifying implementation surfaces).",
    "Discovery is a separate phase that already ran before planning.",
    "",
    "A narrow read/inspection of a specific file named by Discovery is allowed.",
    "Describing a feature using words like 'search', 'find', or 'locate' is allowed when those words describe the feature being built, not instructions to the Builder.",
    "",
    "Examples of LEGITIMATE usage:",
    '- "Improve gig search for a growing marketplace" — describes the feature',
    '- "Add search functionality to the navbar" — describes the feature',
    '- "Implement a search results page" — describes the feature',
    '- "Read backend/src/controllers/gigController.ts to understand the current search" — narrow file inspection',
    "",
    "Examples of DELEGATING DISCOVERY (reject these):",
    '- "Search for the file that handles gig creation" — asking Builder to find files',
    '- "Find where the search logic is implemented" — asking Builder to locate code',
    '- "Locate the relevant controller file" — asking Builder to find files',
    '- "Identify the files that need to change" — asking Builder to discover surfaces',
    "",
    "Planner output:",
    plannerOutput,
    "",
    "Return JSON only:",
    '{"ok": true} if the planner output is legitimate',
    '{"ok": false, "reason": "short explanation"} if the planner is delegating discovery to the Builder',
  ].join("\n");
}

export function parsePlannerValidationResult(outputText: string): { ok: true } | { ok: false; reason: string } | undefined {
  const fenced = outputText.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const raw = (fenced ?? outputText).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { ok?: unknown; reason?: unknown };
    if (typeof parsed.ok !== "boolean") {
      return undefined;
    }
    if (parsed.ok) {
      return { ok: true };
    }
    return { ok: false, reason: typeof parsed.reason === "string" ? parsed.reason : "Planner delegated broad discovery to Builder" };
  } catch {
    return undefined;
  }
}


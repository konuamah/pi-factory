import path from "node:path";
import type { AgentExecutor } from "../runtime/interfaces.js";
import type { FactorySetupContext } from "@factory/schemas";
import { buildFactorySetupContext } from "./setup-context.js";
import { validateFactorySetup } from "./validate.js";

export type FactoryConciergeAction =
  | "answer-only"
  | "run-setup"
  | "run-doctor"
  | "create-workflow"
  | "inspect-models"
  | "import-skills"
  | "refresh-constitution"
  | "show-status";

export interface FactoryConciergeInput {
  cwd: string;
  question: string;
  executor?: AgentExecutor;
  context?: FactorySetupContext;
  onEvent?: (text: string) => void;
}

export interface FactoryConciergeRecommendation {
  answer: string;
  recommendedAction: FactoryConciergeAction;
  why: string;
  needsApproval: boolean;
  suggestedCommand?: string;
  handoff?: string;
  details?: string[];
}

const ACTIONS = new Set<FactoryConciergeAction>([
  "answer-only",
  "run-setup",
  "run-doctor",
  "create-workflow",
  "inspect-models",
  "import-skills",
  "refresh-constitution",
  "show-status",
]);

const COMMANDS: Partial<Record<FactoryConciergeAction, string>> = {
  "run-setup": "/factory setup",
  "run-doctor": "/factory doctor",
  "create-workflow": "/factory workflow create",
  "inspect-models": "/factory models",
  "refresh-constitution": "/factory constitution",
  "show-status": "/factory status",
};

export async function recommendViaFactoryConciergeSkill(
  input: FactoryConciergeInput,
): Promise<FactoryConciergeRecommendation> {
  if (!input.executor) {
    throw new Error(
      "FACTORY_CONCIERGE_REQUIRES_PI_EXECUTOR: No Pi executor available. Run from a Pi session with auth so Concierge can answer with repository context."
    );
  }

  const skillSource = await loadFactoryConciergeSkillSource(input.cwd);
  const context = input.context ?? await buildFactorySetupContext(input.cwd);
  const validation = await validateFactorySetup(input.cwd).catch((error) => ({
    readiness: "UNKNOWN",
    checks: [{ name: "validation", ok: false, detail: error instanceof Error ? error.message : String(error) }],
  }));

  const prompt = buildFactoryConciergePrompt({
    question: input.question,
    context,
    validation,
    skillSource,
  });
  input.onEvent?.("Asking Factory Concierge...\n");
  const model = context.availableModels[0];
  const result = await input.executor.execute({
    executionId: `factory-concierge-${Date.now()}`,
    cwd: input.cwd,
    prompt,
    ...(model ? { model } : {}),
    tools: ["read", "grep", "find", "ls"],
    metadata: { role: "planner", purpose: "factory-concierge", streaming: true },
  });

  if (result.status !== "completed") {
    throw new Error(
      `FACTORY_CONCIERGE_FAILED: executor status=${result.status} — error=${result.errorMessage ?? "none"} — output was: ${result.outputText.slice(0, 800)}`
    );
  }

  const parsed = extractJson(result.outputText);
  if (!parsed) {
    throw new Error(
      `FACTORY_CONCIERGE_INVALID_JSON: Concierge did not return valid JSON — raw output (first 1200 chars) was: ${result.outputText.slice(0, 1200)}`
    );
  }

  return normalizeFactoryConciergeRecommendation(parsed);
}

export function normalizeFactoryConciergeRecommendation(raw: unknown): FactoryConciergeRecommendation {
  if (!raw || typeof raw !== "object") {
    throw new Error("FACTORY_CONCIERGE_INVALID: recommendation must be an object");
  }
  const r = raw as Record<string, unknown>;
  const action = String(r.recommendedAction ?? "answer-only") as FactoryConciergeAction;
  if (!ACTIONS.has(action)) {
    throw new Error(`FACTORY_CONCIERGE_INVALID_ACTION: ${action}`);
  }

  const answer = String(r.answer ?? "").trim();
  if (!answer) {
    throw new Error("FACTORY_CONCIERGE_INVALID: answer is required");
  }

  const suggestedCommand = typeof r.suggestedCommand === "string" && r.suggestedCommand.trim()
    ? r.suggestedCommand.trim()
    : COMMANDS[action];
  if (suggestedCommand && !isAllowedSuggestedCommand(action, suggestedCommand)) {
    throw new Error(`FACTORY_CONCIERGE_INVALID_COMMAND: ${suggestedCommand}`);
  }

  return {
    answer,
    recommendedAction: action,
    why: String(r.why ?? "").trim() || "Factory Concierge recommended this based on the repository setup context.",
    needsApproval: Boolean(r.needsApproval ?? actionRequiresApproval(action)),
    ...(suggestedCommand ? { suggestedCommand } : {}),
    ...(typeof r.handoff === "string" && r.handoff.trim() ? { handoff: r.handoff.trim() } : {}),
    ...(Array.isArray(r.details) ? { details: r.details.map((line) => String(line)).filter(Boolean).slice(0, 8) } : {}),
  };
}

async function loadFactoryConciergeSkillSource(cwd: string): Promise<string> {
  const fs = await import("node:fs/promises");
  const candidates = [
    path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../../skills/factory-concierge/SKILL.md"),
    path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../skills/factory-concierge/SKILL.md"),
    path.resolve(cwd, "..", "skills", "factory-concierge", "SKILL.md"),
    path.join(cwd, "skills", "factory-concierge", "SKILL.md"),
  ];
  for (const candidate of candidates) {
    try {
      const content = await fs.readFile(candidate, "utf8");
      if (content.trim()) return content;
    } catch {}
  }
  throw new Error(
    `factory-concierge skill not found — expected skills/factory-concierge/SKILL.md at: ${candidates.join(", ")}`
  );
}

function buildFactoryConciergePrompt(input: {
  question: string;
  context: FactorySetupContext;
  validation: unknown;
  skillSource: string;
}): string {
  const compactContext = {
    repository: input.context.repository,
    existing: {
      constitutionExists: input.context.existing.constitutionExists,
      hasProjectConfig: Boolean(input.context.existing.project),
      hasWorkflow: Boolean(input.context.existing.workflows?.length),
      effective: input.context.effective,
    },
    availableModels: input.context.availableModels.slice(0, 20),
    availableSkills: input.context.availableSkills.slice(0, 40),
    availableCapabilities: input.context.availableCapabilities,
    discoveredCommands: input.context.discoveredCommands,
    validation: input.validation,
  };

  return [
    "# Factory Concierge Skill",
    input.skillSource.slice(0, 7000),
    "",
    "## User question",
    input.question,
    "",
    "## Factory context",
    "```json",
    JSON.stringify(compactContext, null, 2).slice(0, 16000),
    "```",
    "",
    "Return the FactoryConciergeRecommendation JSON object only.",
  ].join("\n");
}

function extractJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {}
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {}
  }
  const brace = trimmed.match(/\{[\s\S]*\}/);
  if (brace?.[0]) {
    try {
      return JSON.parse(brace[0]);
    } catch {}
  }
  return undefined;
}

function actionRequiresApproval(action: FactoryConciergeAction): boolean {
  return ["run-setup", "create-workflow", "refresh-constitution", "import-skills"].includes(action);
}

function isAllowedSuggestedCommand(action: FactoryConciergeAction, command: string): boolean {
  if (action === "answer-only" || action === "import-skills") {
    return command === "" || command.startsWith("/factory status") || command.startsWith("/factory ask");
  }
  return command === COMMANDS[action];
}

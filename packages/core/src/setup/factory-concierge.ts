import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentExecutor } from "../runtime/interfaces.js";
import type { FactorySetupContext } from "@factory/schemas";
import { buildFactorySetupContext } from "./setup-context.js";
import { validateFactorySetup } from "./validate.js";

export type FactoryConciergeAction =
  | "answer-only"
  | "run-setup"
  | "run-doctor"
  | "create-workflow"
  | "list-workflows"
  | "show-workflow"
  | "set-default-workflow"
  | "inspect-models"
  | "import-skills"
  | "inspect-capabilities"
  | "show-capability"
  | "validate-capabilities"
  | "configure-dependencies"
  | "refresh-constitution"
  | "show-status"
  | "list-runs"
  | "show-run"
  | "show-logs"
  | "show-plan"
  | "dashboard-status"
  | "start-dashboard"
  | "cleanup-runs"
  | "guide-task-execution";

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
  "list-workflows",
  "show-workflow",
  "set-default-workflow",
  "inspect-models",
  "import-skills",
  "inspect-capabilities",
  "show-capability",
  "validate-capabilities",
  "configure-dependencies",
  "refresh-constitution",
  "show-status",
  "list-runs",
  "show-run",
  "show-logs",
  "show-plan",
  "dashboard-status",
  "start-dashboard",
  "cleanup-runs",
  "guide-task-execution",
]);

const COMMANDS: Partial<Record<FactoryConciergeAction, string>> = {
  "run-setup": "/factory setup",
  "run-doctor": "/factory doctor",
  "create-workflow": "/factory workflow create",
  "list-workflows": "/factory workflow list",
  "inspect-models": "/factory models",
  "inspect-capabilities": "/factory capabilities list",
  "validate-capabilities": "/factory capabilities validate",
  "refresh-constitution": "/factory constitution",
  "show-status": "/factory status",
  "list-runs": "/factory list",
  "show-logs": "/factory logs",
  "show-plan": "/factory plan",
  "dashboard-status": "/factory dashboard status",
  "start-dashboard": "/factory dashboard start",
  "cleanup-runs": "/factory cleanup",
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
  const docsContext = await loadFactoryConciergeDocsContext(input.cwd);
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
    docsContext,
  });
  input.onEvent?.("Asking Factory Concierge...\n");
  const model = context.availableModels[0];
  const result = await input.executor.execute({
    executionId: `factory-concierge-${Date.now()}`,
    cwd: input.cwd,
    prompt,
    ...(model ? { model } : {}),
    tools: [],
    metadata: { role: "planner", purpose: "factory-concierge", streaming: true, contextMode: "docs-first-dist-blind" },
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
    needsApproval: Boolean(r.needsApproval) || actionRequiresApproval(action),
    ...(suggestedCommand ? { suggestedCommand } : {}),
    ...(typeof r.handoff === "string" && r.handoff.trim() ? { handoff: r.handoff.trim() } : {}),
    ...(Array.isArray(r.details) ? { details: r.details.map((line) => String(line)).filter(Boolean).slice(0, 8) } : {}),
  };
}

async function loadFactoryConciergeSkillSource(cwd: string): Promise<string> {
  const fs = await import("node:fs/promises");
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "../../../../skills/factory-concierge/SKILL.md"),
    path.resolve(moduleDir, "../../../../../skills/factory-concierge/SKILL.md"),
    path.resolve(moduleDir, "../../../skills/factory-concierge/SKILL.md"),
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

async function loadFactoryConciergeDocsContext(cwd: string): Promise<string> {
  const fs = await import("node:fs/promises");
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const docsDirs = [
    path.join(cwd, "docs", "factory"),
    path.resolve(moduleDir, "../../../../docs/factory"),
    path.resolve(moduleDir, "../../../../../docs/factory"),
    path.resolve(moduleDir, "../../../docs/factory"),
  ];
  const seen = new Set<string>();
  for (const docsDir of docsDirs) {
    const resolved = path.resolve(docsDir);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    const agentPath = path.join(resolved, "AGENT.md");
    const readmePath = path.join(resolved, "README.md");
    const [agent, readme] = await Promise.all([
      readOptionalText(fs, agentPath),
      readOptionalText(fs, readmePath),
    ]);
    if (agent || readme) {
      return [
        agent ? `## docs/factory/AGENT.md\n${agent.slice(0, 5000)}` : undefined,
        readme ? `## docs/factory/README.md\n${readme.slice(0, 5000)}` : undefined,
      ].filter(Boolean).join("\n\n");
    }
  }
  return [
    "## Factory docs context unavailable",
    "Use Factory setup context and supported command routes only. Do not inspect dist, node_modules, build output, coverage output, generated files, or transient worktrees.",
  ].join("\n");
}

async function readOptionalText(
  fs: typeof import("node:fs/promises"),
  filePath: string,
): Promise<string | undefined> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content.trim() || undefined;
  } catch {
    return undefined;
  }
}

function buildFactoryConciergePrompt(input: {
  question: string;
  context: FactorySetupContext;
  validation: unknown;
  skillSource: string;
  docsContext: string;
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
    "# Factory docs reference",
    input.docsContext.slice(0, 10000),
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
  return ["run-setup", "create-workflow", "set-default-workflow", "configure-dependencies", "refresh-constitution", "import-skills", "start-dashboard", "cleanup-runs"].includes(action);
}

function isAllowedSuggestedCommand(action: FactoryConciergeAction, command: string): boolean {
  if (action === "guide-task-execution") {
    return command === "";
  }
  if (action === "answer-only" || action === "import-skills" || action === "configure-dependencies") {
    return command === "" || command.startsWith("/factory status") || command.startsWith("/factory ask");
  }
  if (action === "show-workflow") {
    return /^\/factory workflow show [A-Za-z0-9._-]+$/.test(command);
  }
  if (action === "set-default-workflow") {
    return /^\/factory workflow set-default [A-Za-z0-9._-]+$/.test(command);
  }
  if (action === "show-capability") {
    return /^\/factory capabilities show [A-Za-z0-9._:-]+$/.test(command);
  }
  if (action === "show-run") {
    return /^\/factory show [A-Za-z0-9._-]+$/.test(command);
  }
  if (action === "show-status") {
    return /^\/factory status(?: [A-Za-z0-9._-]+)?$/.test(command);
  }
  if (action === "show-logs") {
    return /^\/factory logs(?: [A-Za-z0-9._-]+)?$/.test(command);
  }
  if (action === "cleanup-runs") {
    return /^\/factory cleanup(?: \d+)?$/.test(command);
  }
  return command === COMMANDS[action];
}

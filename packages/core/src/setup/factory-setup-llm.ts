import type { AgentExecutor } from "../runtime/interfaces.js";
import type { FactorySetupContext, FactorySetupRecommendation } from "@factory/schemas";
import { validateSetupRecommendation } from "./recommend-validate.js";

export interface FactorySetupLlmInput {
  cwd: string;
  context: FactorySetupContext;
  executor?: AgentExecutor;
  onEvent?: (text: string) => void;
}

export async function recommendViaFactorySetupSkill(
  input: FactorySetupLlmInput,
): Promise<FactorySetupRecommendation> {
  const fallback = buildDeterministicRecommendation(input.context);
  if (!input.executor) {
    return fallback;
  }

  const skillSource = (await loadFactorySetupSkillSource(input.cwd).catch(() => undefined)) ?? "";
  const prompt = buildFactorySetupPrompt(input.context, skillSource);
  input.onEvent?.("Analyzing repository configuration...\n");

  const result = await input.executor.execute({
    executionId: `factory-setup-${Date.now()}`,
    cwd: input.cwd,
    prompt,
    tools: ["read", "grep", "find", "ls"],
    metadata: { role: "planner", purpose: "factory-setup-recommendation", streaming: true },
  });
  input.onEvent?.(result.outputText.slice(0, 200) + "\n");

  const parsed = extractJson(result.outputText);
  if (!parsed) return fallback;

  const rec = normalizeRecommendation(parsed, input.context, fallback);
  return validateSetupRecommendation(rec, input.context);
}

async function loadFactorySetupSkillSource(cwd: string): Promise<string> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const candidates = [
    path.join(cwd, "skills", "factory-setup", "SKILL.md"),
    path.join(cwd, ".pi", "skills", "factory-setup", "SKILL.md"),
    // when running from worktree, also try repo root
    path.resolve(cwd, "..", "skills", "factory-setup", "SKILL.md"),
  ];
  for (const p of candidates) {
    try {
      return await fs.readFile(p, "utf8");
    } catch {}
  }
  // Fallback: try relative to this file's location (dist or src)
  try {
    const fsSync = await import("node:fs");
    const candidates2 = [
      path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../skills/factory-setup/SKILL.md"),
      path.resolve(cwd, "skills/factory-setup/SKILL.md"),
    ];
    for (const p of candidates2) {
      try { return fsSync.readFileSync(p, "utf8"); } catch {}
    }
  } catch {}
  return "";
}

function buildFactorySetupPrompt(context: FactorySetupContext, skillSource: string): string {
  // Smart truncation: prioritize high-value context, drop raw text dumps first
  const compact = buildCompactContext(context);
  const ctxJson = JSON.stringify(compact, null, 2);
  const skillBudget = 6000;
  const ctxBudget = 12000;
  const skillSlice = skillSource ? skillSource.slice(0, skillBudget) : "";
  const ctxSlice = smartTruncateJson(ctxJson, ctxBudget, compact);
  return [
    skillSlice ? `# Factory Setup Skill\n\n${skillSlice}` : "",
    "\n## FactorySetupContext (JSON)\n",
    "```json",
    ctxSlice,
    "```",
    "\n## Task\nProduce a single JSON object matching FactorySetupRecommendation. Use only allowlisted choices. Follow the SKILL rules above.",
    "Return JSON only, no markdown.",
  ].filter(Boolean).join("\n");
}

function buildCompactContext(context: FactorySetupContext): Record<string, unknown> {
  // Omit raw text dumps; keep parsed provenance
  const { existing, ...rest } = context;
  const { rawGlobalText, rawProjectText, rawWorkflowText, ...provenance } = existing;
  // Also cap raw dumps to first 500 chars as evidence, not full file
  const evidence: Record<string, string | undefined> = {};
  if (rawGlobalText) evidence.globalSample = rawGlobalText.slice(0, 500);
  if (rawProjectText) evidence.projectSample = rawProjectText.slice(0, 500);
  if (rawWorkflowText) evidence.workflowSample = rawWorkflowText.slice(0, 800);
  return {
    ...rest,
    existing: {
      ...provenance,
      ...(Object.keys(evidence).length ? { _rawSamples: evidence } : {}),
    },
  };
}

function smartTruncateJson(json: string, budget: number, compact: Record<string, unknown>): string {
  if (json.length <= budget) return json;
  // Priority: keep repository, effective, availableModels/Capabilities, discoveredCommands;
  // truncate existing.workflows and availableSkills last
  const truncated: Record<string, unknown> = { ...compact };
  // Drop availableSkills descriptions first
  if (truncated.availableSkills && json.length > budget) {
    const skills = truncated.availableSkills as Array<{ id: string; description?: string }>;
    truncated.availableSkills = skills.map((s) => ({ id: s.id }));
    const rejson = JSON.stringify(truncated, null, 2);
    if (rejson.length <= budget) return rejson;
  }
  // Drop workflows body
  const ex = truncated.existing as Record<string, unknown> | undefined;
  if (ex?.workflows && JSON.stringify(truncated, null, 2).length > budget) {
    ex.workflows = (ex.workflows as unknown[]).slice(0, 2);
    const rejson = JSON.stringify(truncated, null, 2);
    if (rejson.length <= budget) return rejson;
  }
  // Hard slice as fallback, preserving JSON validity
  const sliced = json.slice(0, budget);
  const lastBrace = sliced.lastIndexOf("}");
  return sliced.slice(0, lastBrace + 1) || sliced;
}

function extractJson(text: string): unknown | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  // Try raw JSON
  try {
    return JSON.parse(trimmed);
  } catch {}
  // Try code fence
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) {
    try { return JSON.parse(fence[1].trim()); } catch {}
  }
  // Try first {...}
  const brace = trimmed.match(/\{[\s\S]*\}/);
  if (brace?.[0]) {
    try { return JSON.parse(brace[0]); } catch {}
  }
  return undefined;
}

function normalizeRecommendation(
  raw: unknown,
  ctx: FactorySetupContext,
  fallback: FactorySetupRecommendation,
): FactorySetupRecommendation {
  if (!raw || typeof raw !== "object") return fallback;
  const r = raw as Record<string, unknown>;

  // Coerce constitution
  const cRaw = String(r.constitution ?? fallback.constitution).toUpperCase();
  const constitution = (
    cRaw === "GENERATE" || cRaw === "REFRESH" || cRaw === "KEEP"
      ? cRaw
      : fallback.constitution
  ) as FactorySetupRecommendation["constitution"];

  const rec: FactorySetupRecommendation = {
    summary: typeof r.summary === "string" && r.summary.trim() ? r.summary.trim() : fallback.summary,
    constitution,
    explanation: Array.isArray(r.explanation) ? (r.explanation as string[]).filter((s) => typeof s === "string") : fallback.explanation,
    questions: Array.isArray(r.questions) ? (r.questions as FactorySetupRecommendation["questions"]) : fallback.questions,
  };

  if (r.workflow && typeof r.workflow === "object") {
    const w = r.workflow as Record<string, unknown>;
    const v = w.value as Record<string, unknown> | undefined;
    if (v?.preset && ["balanced", "fast", "safe"].includes(String(v.preset))) {
      rec.workflow = {
        value: { preset: String(v.preset) as import("@factory/schemas").WorkflowPreset, workflowId: String(v.workflowId ?? "default-dev") },
        reason: String(w.reason ?? "Workflow preset"),
      };
    }
  }
  if (r.models && typeof r.models === "object") rec.models = r.models as FactorySetupRecommendation["models"];
  if (r.commands && typeof r.commands === "object") rec.commands = normalizeCommands(r.commands as Record<string, unknown>, ctx, fallback);
  if (r.runtime && typeof r.runtime === "object") rec.runtime = r.runtime as FactorySetupRecommendation["runtime"];
  if (r.repair && typeof r.repair === "object") rec.repair = r.repair as FactorySetupRecommendation["repair"];
  if (r.approval && typeof r.approval === "object") rec.approval = r.approval as FactorySetupRecommendation["approval"];
  if (r.git && typeof r.git === "object") rec.git = r.git as FactorySetupRecommendation["git"];
  if (r.capabilities && typeof r.capabilities === "object") rec.capabilities = r.capabilities as FactorySetupRecommendation["capabilities"];
  if (Array.isArray(r.taskTypes)) rec.taskTypes = r.taskTypes as FactorySetupRecommendation["taskTypes"];

  return rec;
}

function normalizeCommands(
  raw: Record<string, unknown>,
  ctx: FactorySetupContext,
  fallback: FactorySetupRecommendation,
): FactorySetupRecommendation["commands"] {
  const out: FactorySetupRecommendation["commands"] = {};
  const discovered = new Set(Object.values(ctx.discoveredCommands).filter(Boolean) as string[]);
  for (const field of ["setup", "lint", "typecheck", "test", "build"] as const) {
    const entry = raw[field] as Record<string, unknown> | undefined;
    if (!entry || typeof entry.value !== "string") continue;
    const value = String(entry.value).trim();
    const isDiscovered = discovered.has(value);
    const source = isDiscovered ? "DISCOVERED" : "AI_SUGGESTED";
    const requiresConfirmation = source === "AI_SUGGESTED" ? true : undefined;
    out[field] = {
      value,
      reason: String(entry.reason ?? (isDiscovered ? `Discovered: ${value}` : `Suggested: ${value}`)),
      source: (entry.source as import("@factory/schemas").RecommendationSource) ?? source,
      confidence: (entry.confidence as import("@factory/schemas").RecommendationConfidence) ?? (isDiscovered ? "HIGH" : "MEDIUM"),
      ...(requiresConfirmation ? { requiresConfirmation } : {}),
    };
  }
  // Fill missing with fallback DISCOVERED where applicable
  for (const field of ["setup", "lint", "typecheck", "test", "build"] as const) {
    if (!out[field] && fallback.commands?.[field]) out[field] = fallback.commands[field]!;
  }
  return out;
}

function buildDeterministicRecommendation(ctx: FactorySetupContext): FactorySetupRecommendation {
  const pm = ctx.repository.packageManagers[0] ?? "npm";
  const hasTests = ctx.repository.testing.frameworks.length > 0 || ctx.discoveredCommands.test !== undefined;
  const complexity =
    (ctx.repository.testing.integration ? 1 : 0) +
    (ctx.repository.testing.e2e ? 1 : 0) +
    (ctx.repository.persistence.migrations ? 1 : 0) +
    (ctx.repository.ci.providers.length > 0 ? 1 : 0) +
    (ctx.repository.structure.monorepo ? 1 : 0);
  const preset: import("@factory/schemas").WorkflowPreset =
    complexity >= 3 ? "safe" : complexity === 0 && !hasTests ? "fast" : "balanced";

  const commands: FactorySetupRecommendation["commands"] = {};
  for (const field of ["setup", "lint", "typecheck", "test", "build"] as const) {
    const v = (ctx.discoveredCommands as Record<string, string | undefined>)[field];
    if (v) {
      commands[field] = { value: v, reason: `Discovered from ${pm}: ${v}`, source: "DISCOVERED", confidence: "HIGH" };
    }
  }

  const langs = ctx.repository.languages.join(", ") || "unknown";
  const tools = Object.values(ctx.discoveredCommands).filter(Boolean).length;

  return {
    summary: `Factory checked this project — ${langs} with ${pm} and ${tools} verification command(s). Recommended: ${preset} workflow.`,
    workflow: { value: { preset, workflowId: "default-dev" }, reason: `Complexity ${complexity} → ${preset}` },
    commands,
    constitution: ctx.existing.constitutionExists ? "KEEP" : "GENERATE",
    explanation: [
      `Matches tools already used: ${Object.values(ctx.discoveredCommands).filter(Boolean).join(", ") || "defaults"}.`,
      `Repository maturity: ${ctx.repository.maturity}, CI: ${ctx.repository.ci.providers.join(", ") || "none"}.`,
    ],
    questions: [],
    runtime: { maxParallelAgents: { value: 2, reason: "Default parallel workers", source: "DEFAULT", confidence: "MEDIUM" } },
    repair: {
      enabled: { value: true, reason: "Enable repair up to attempts", source: "DEFAULT", confidence: "MEDIUM" },
      maxAttempts: { value: 3, reason: "Up to 3 repair attempts", source: "DEFAULT", confidence: "MEDIUM" },
    },
    approval: { finalMerge: { value: "required", reason: "Ask for approval before merge", source: "DEFAULT", confidence: "MEDIUM" } },
  };
}

// Kept for reference; gateway creates the executor via piExecutors.createPiSdkSessionFactory directly.


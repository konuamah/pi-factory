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
  if (!input.executor) {
    throw new Error(
      "FACTORY_SETUP_REQUIRES_PI_EXECUTOR: No Pi executor — configure ~/.pi/agent/settings.json + auth.json and run /factory setup from a Pi session with auth. No fallback recommendation will be returned (fail-loud mode)."
    );
  }

  // FAIL-LOUD: skill must exist — do not return empty string and continue with a degraded prompt.
  const skillSource = await loadFactorySetupSkillSource(input.cwd);
  const prompt = buildFactorySetupPrompt(input.context, skillSource);
  input.onEvent?.("Analyzing repository configuration...\n");
  // Use the user's default chat model (commandcode/Spark) explicitly so we don't
  // fall back to a stale OPENAI_API_KEY (401) or a depleted deepseek (402).
  const defaultModel = resolveDefaultModel(input.context);
  const modelInfo = defaultModel ? ` (model: ${defaultModel.provider ?? "default"}/${defaultModel.model})` : "";
  input.onEvent?.(`Model: ${modelInfo || "Pi default"} — scanning providers...\n`);

  const result = await input.executor.execute({
    executionId: `factory-setup-${Date.now()}`,
    cwd: input.cwd,
    prompt,
    ...(defaultModel ? { model: defaultModel } : {}),
    tools: ["read", "grep", "find", "ls"],
    metadata: { role: "planner", purpose: "factory-setup-recommendation", streaming: true },
  });
  input.onEvent?.(result.outputText.slice(0, 200) + "\n");

  if (result.status !== "completed") {
    const providerHint = result.errorMessage?.includes("401") || result.errorMessage?.includes("api key")
      ? " — Provider auth failed (401). Remove the invalid OPENAI_API_KEY / refresh provider auth and retry."
      : "";
    throw new Error(
      `FACTORY_SETUP_LLM_FAILED: executor status=${result.status} — error=${result.errorMessage ?? "none"}${providerHint} — output was: ${result.outputText.slice(0, 800)}`
    );
  }

  const parsed = extractJson(result.outputText);
  if (!parsed) {
    const maybe401 = result.outputText.includes("401") || JSON.stringify(result.events ?? []).includes("401");
    if (maybe401 && !result.outputText.trim()) {
      throw new Error(
        `FACTORY_SETUP_LLM_PROVIDER_AUTH_FAILED: LLM returned empty output (likely invalid OPENAI_API_KEY or provider 401). Clear OPENAI_API_KEY or fix provider auth, then re-run /factory setup. Events contained: ${JSON.stringify(result.events?.slice(0, 3) ?? [], null, 2).slice(0, 800)}`
      );
    }
    throw new Error(
      `FACTORY_SETUP_LLM_INVALID_JSON: LLM did not return valid JSON — raw output (first 1200 chars) was: ${result.outputText.slice(0, 1200)}`
    );
  }

  // Normalize against deterministic template for missing fields, then strictly validate.
  const template = buildDeterministicRecommendation(input.context);
  const rec = normalizeRecommendation(parsed, input.context, template) as FactorySetupRecommendation & { projectUnderstanding: { summary: string } };
  // FAIL-LOUD: LLM must produce real understanding and workflow — empty summary/preset is provider fallback, not valid.
  if (!rec.projectUnderstanding?.summary?.trim() || !rec.workflow) {
    throw new Error(
      `FACTORY_SETUP_LLM_INCOMPLETE: LLM did not return projectUnderstanding.summary + workflow — raw output was: ${result.outputText.slice(0, 1200)}`
    );
  }
  return validateSetupRecommendation(rec, input.context);
}

async function loadFactorySetupSkillSource(cwd: string): Promise<string> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const candidates = [
    path.join(cwd, "skills", "factory-setup", "SKILL.md"),
    path.join(cwd, ".pi", "skills", "factory-setup", "SKILL.md"),
    path.resolve(cwd, "..", "skills", "factory-setup", "SKILL.md"),
  ];
  for (const p of candidates) {
    try {
      const content = await fs.readFile(p, "utf8");
      if (content.trim()) return content;
    } catch {}
  }
  try {
    const fsSync = await import("node:fs");
    const candidates2 = [
      path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../skills/factory-setup/SKILL.md"),
      path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../../skills/factory-setup/SKILL.md"),
      path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../../../skills/factory-setup/SKILL.md"),
      path.resolve(cwd, "skills/factory-setup/SKILL.md"),
    ];
    for (const p of candidates2) {
      try {
        const content = fsSync.readFileSync(p, "utf8");
        if (content.trim()) return content;
      } catch {}
    }
  } catch {}
  throw new Error(
    `factory-setup skill not found — expected skills/factory-setup/SKILL.md at: ${candidates.join(", ")}`
  );
}

function buildFactorySetupPrompt(context: FactorySetupContext, skillSource: string): string {
  const compact = buildCompactContext(context);
  const ctxJson = JSON.stringify(compact, null, 2);
  const skillBudget = 6000;
  const ctxBudget = 12000;
  const skillSlice = skillSource ? skillSource.slice(0, skillBudget) : "";
  const ctxSlice = smartTruncateJson(ctxJson, ctxBudget, compact);
  const workflowPrimitives = `
## Workflow primitives (Factory already supports these — you may emit a custom DAG)
Stages: { name, dependsOn?: string[], type?: "agent"|"command"|"approval", role?: ModelRole, commands?: string[], requiresApproval?: boolean, requiredCapabilities?: Capability[] }
Roles: discovery|planner|builder|reviewer|repair  · Keep DAG acyclic, 2-7 stages.
Example simple docs repo: plan -> build -> verify
Example mature app: discover{discovery} -> plan{planner} -> implementation{builder} -> verification{command} -> review{reviewer} -> approval
Example DB repo (recommended here): plan -> build -> migration-check{command} -> integration-verify{command} -> review -> approval — Why: DB changes affect app+deploy, verify before review.
You may return workflow as { kind:"preset", preset:"balanced"|"fast"|"safe" } or { kind:"custom", workflow: WorkflowDefinition }.
`;
  const englishRule = `Simple-English rule: translate internals — finalMerge=required -> "Ask before merging", maxParallelAgents -> "Parallel workers", retainRuns -> "Old workspaces kept".
`;
  return [
    skillSlice ? `# Factory Setup Skill\n\n${skillSlice}` : "",
    workflowPrimitives,
    englishRule,
    "\n## FactorySetupContext (JSON)\n",
    "```json",
    ctxSlice,
    "```",
    "\n## Task\nProduce FactorySetupRecommendation: projectUnderstanding{summary,highlights} + workflow + models/commands/runtime/git/dependencies/repair/approval/capabilities/taskTypes/skills/dashboard/constitution + whyNot[] + questions{kind=fact|recommendation|preference} . Use only allowlisted choices. Return JSON only.",
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

function normalizeRecommendationStrict(
  raw: unknown,
  ctx: FactorySetupContext,
  template: FactorySetupRecommendation,
): FactorySetupRecommendation {
  if (!raw || typeof raw !== "object") throw new Error("FACTORY_SETUP_LLM_INVALID: LLM returned null/non-object JSON.");
  return normalizeRecommendation(raw, ctx, template);
}

function normalizeRecommendation(
  raw: unknown,
  ctx: FactorySetupContext,
  fallback: FactorySetupRecommendation,
): FactorySetupRecommendation {
  if (!raw || typeof raw !== "object") return fallback;
  const r = raw as Record<string, unknown>;

  const cRaw = String(r.constitution ?? fallback.constitution).toUpperCase();
  const constitution = (
    cRaw === "GENERATE" || cRaw === "REFRESH" || cRaw === "KEEP" ? cRaw : fallback.constitution
  ) as FactorySetupRecommendation["constitution"];

  const puRaw = r.projectUnderstanding as Record<string, unknown> | undefined;
  const projectUnderstanding: FactorySetupRecommendation["projectUnderstanding"] =
    puRaw && typeof puRaw.summary === "string" && puRaw.summary.trim()
      ? {
          summary: String(puRaw.summary).trim(),
          highlights: Array.isArray(puRaw.highlights) ? (puRaw.highlights as string[]).filter((s) => typeof s === "string").slice(0, 8) : fallback.projectUnderstanding.highlights,
        }
      : fallback.projectUnderstanding;

  const rec: FactorySetupRecommendation = {
    projectUnderstanding,
    summary: typeof r.summary === "string" && r.summary.trim() ? r.summary.trim() : fallback.summary,
    constitution,
    explanation: Array.isArray(r.explanation) ? (r.explanation as string[]).filter((s) => typeof s === "string") : fallback.explanation,
    questions: Array.isArray(r.questions) ? (r.questions as FactorySetupRecommendation["questions"]) : fallback.questions,
  };

  if (r.workflow && typeof r.workflow === "object") {
    const w = r.workflow as Record<string, unknown>;
    const v = w.value as Record<string, unknown> | undefined;
    if (v?.kind === "custom" && v?.workflow && typeof v.workflow === "object") {
      const wf = v.workflow as Record<string, unknown>;
      if (Array.isArray(wf.stages) && wf.stages.length >= 2 && wf.stages.length <= 10) {
        rec.workflow = {
          value: { kind: "custom", workflow: wf as unknown as import("@factory/schemas").WorkflowDefinition, reason: String(v.reason ?? w.reason ?? "Custom workflow") },
          reason: String(w.reason ?? "Custom workflow"),
        };
      }
    } else if (v?.preset && ["balanced", "fast", "safe"].includes(String(v.preset))) {
      rec.workflow = {
        value: { kind: "preset", preset: String(v.preset) as import("@factory/schemas").WorkflowPreset, workflowId: String(v.workflowId ?? "default-dev") },
        reason: String(w.reason ?? "Workflow preset"),
      };
    } else if (v?.preset && ["balanced", "fast", "safe"].includes(String(v.preset))) {
      rec.workflow = {
        value: { kind: "preset", preset: String(v.preset) as import("@factory/schemas").WorkflowPreset, workflowId: String(v.workflowId ?? "default-dev") },
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
  if (r.dependencies && typeof r.dependencies === "object") rec.dependencies = r.dependencies as FactorySetupRecommendation["dependencies"];
  if (r.capabilities && typeof r.capabilities === "object") rec.capabilities = r.capabilities as FactorySetupRecommendation["capabilities"];
  if (Array.isArray(r.taskTypes)) rec.taskTypes = r.taskTypes as FactorySetupRecommendation["taskTypes"];
  if (r.skills && typeof r.skills === "object") rec.skills = r.skills as FactorySetupRecommendation["skills"];
  if (r.dashboard && typeof r.dashboard === "object") rec.dashboard = r.dashboard as FactorySetupRecommendation["dashboard"];
  if (Array.isArray(r.whyNot)) rec.whyNot = (r.whyNot as FactorySetupRecommendation["whyNot"]);
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
    const inferredSource = isDiscovered ? "DISCOVERED" : "AI_SUGGESTED";
    const source = (entry.source as import("@factory/schemas").RecommendationSource) ?? inferredSource;
    const requiresConfirmation = source === "AI_SUGGESTED" ? true : undefined;
    out[field] = {
      value,
      reason: String(entry.reason ?? (isDiscovered ? `Discovered: ${value}` : `Suggested: ${value}`)),
      source,
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

export function buildDeterministicRecommendation(ctx: FactorySetupContext): FactorySetupRecommendation {
  const pm = ctx.repository.packageManagers[0] ?? "npm";
  const hasTests = ctx.repository.testing.frameworks.length > 0 || ctx.discoveredCommands.test !== undefined;
  const hasMigrations = ctx.repository.persistence.migrations || ctx.repository.persistence.technologies.length > 0;
  const complexity =
    (ctx.repository.testing.integration ? 1 : 0) +
    (ctx.repository.testing.e2e ? 1 : 0) +
    (hasMigrations ? 1 : 0) +
    (ctx.repository.ci.providers.length > 0 ? 1 : 0) +
    (ctx.repository.structure.monorepo ? 1 : 0);
  const preset: import("@factory/schemas").WorkflowPreset =
    complexity >= 3 ? "safe" : complexity === 0 && !hasTests ? "fast" : "balanced";

  const commands: FactorySetupRecommendation["commands"] = {};
  for (const field of ["setup", "lint", "typecheck", "test", "build"] as const) {
    const v = (ctx.discoveredCommands as Record<string, string | undefined>)[field];
    if (v) commands[field] = { value: v, reason: `Discovered from ${pm}: ${v}`, source: "DISCOVERED", confidence: "HIGH" };
  }

  const langs = ctx.repository.languages.join(", ") || "unknown";
  const tools = Object.values(ctx.discoveredCommands).filter(Boolean).length;
  const pkgs = ctx.repository.structure.packages.length;
  const isMonorepo = ctx.repository.structure.monorepo || pkgs > 2;

  const projectUnderstanding: FactorySetupRecommendation["projectUnderstanding"] = {
    summary: `This is a ${isMonorepo ? `TypeScript monorepo with ${pkgs || "multiple"} packages` : `${langs} project`} using ${pm}.${hasMigrations ? " It has database migrations." : ""}${ctx.repository.ci.providers.length ? ` CI: ${ctx.repository.ci.providers.join(", ")}.` : ""}${ctx.repository.deployment.detected ? ` Deployment: ${ctx.repository.deployment.providers.join(", ")}.` : ""} Factory is ${ctx.existing.project ? "already partially configured" : "not yet configured"}.`,
    highlights: [
      `${langs} · ${pm}`,
      isMonorepo ? `Monorepo · ${pkgs} packages` : `Single package`,
      hasMigrations ? `Database: ${ctx.repository.persistence.technologies.join(", ") || "migrations"}` : "No database detected",
      `Tests: ${ctx.repository.testing.frameworks.join(", ") || (hasTests ? "yes" : "none")}`,
      `CI: ${ctx.repository.ci.providers.join(", ") || "none"} · Deploy: ${ctx.repository.deployment.providers.join(", ") || "none"}`,
      `Factory state: ${ctx.existing.constitutionExists ? "constitution exists" : "no constitution"}${ctx.existing.project ? ", config exists" : ""}`,
    ],
  };

  const whyNot: FactorySetupRecommendation["whyNot"] = [];
  if (ctx.repository.deployment.providers.length > 0 && !ctx.availableCapabilities.includes("deploy.production")) {
    whyNot.push({ area: "Production deployment", reason: "I found deployment config but no deploy.production capability is available.", howToEnable: "Configure a deploy provider and allow deploy.production in capabilities." });
  }

  const questions: FactorySetupRecommendation["questions"] = [];
  // Ambiguous test scripts
  const pkgScripts = Object.keys((ctx as unknown as { _pkgScripts?: Record<string,string> })._pkgScripts ?? {});
  if (pkgScripts.includes("test") && pkgScripts.includes("test:ci")) {
    questions.push({ id: "verification:test_choice", question: "I found both npm test and npm run test:ci — which should Factory use for verification?", options: [{ id: "npm test", label: "npm test" }, { id: "npm run test:ci", label: "npm run test:ci" }], kind: "preference", context: "Both appear to run the test suite." });
  }
  if (ctx.repository.deployment.detected) {
    questions.push({ id: "capabilities:production", question: "Should Factory ever be allowed to request production deployment?", options: [{ id: "no", label: "No" }, { id: "yes_ask", label: "Yes, but always ask first" }], kind: "preference", context: "Production deployment config detected." });
  }

  // Custom workflow sketch when migrations + API present
  let workflow: FactorySetupRecommendation["workflow"];
  if (hasMigrations && langs.includes("TypeScript")) {
    workflow = {
      value: {
        kind: "custom",
        workflow: {
          id: "default-dev",
          name: "DB-aware development",
          stages: [
            { name: "discover", type: "agent", role: "discovery" },
            { name: "plan", type: "agent", role: "planner", dependsOn: ["discover"] },
            { name: "build", type: "agent", role: "builder", dependsOn: ["plan"] },
            { name: "migration-check", type: "command", commands: ["pnpm check:migrations"], dependsOn: ["build"] },
            { name: "integration-verify", type: "command", commands: ["pnpm test"], dependsOn: ["migration-check"] },
            { name: "review", type: "agent", role: "reviewer", dependsOn: ["integration-verify"] },
            { name: "approval", type: "approval", dependsOn: ["review"] },
          ],
        },
        reason: "Database changes can affect app and deploy, so verify them before review.",
      },
      reason: "Custom DB-aware workflow generated from repo structure.",
    };
  } else {
    workflow = { value: { kind: "preset", preset, workflowId: "default-dev" }, reason: `Complexity ${complexity} → ${preset}` };
  }
  const defaultModel = resolveDefaultModel(ctx);
  const models: FactorySetupRecommendation["models"] | undefined = defaultModel
    ? {
        discovery: { value: defaultModel, reason: "Detected from your Pi model configuration; used for read-only discovery." },
        planner: { value: defaultModel, reason: "Detected from your Pi model configuration; used for planning." },
        builder: { value: defaultModel, reason: "Detected from your Pi model configuration; used for implementation." },
        reviewer: { value: defaultModel, reason: "Detected from your Pi model configuration; used for review." },
        repair: { value: defaultModel, reason: "Detected from your Pi model configuration; used for repair attempts." },
      }
    : undefined;

  return {
    projectUnderstanding,
    summary: `Factory checked this project — ${langs} with ${pm} and ${tools} verification command(s). Recommended: ${workflow.value.kind === "preset" ? workflow.value.preset : "custom"} workflow.`,
    workflow,
    ...(models ? { models } : {}),
    commands,
    constitution: ctx.existing.constitutionExists ? "KEEP" : "GENERATE",
    whyNot: whyNot.length ? whyNot : undefined,
    explanation: [
      `Matches tools already used: ${Object.values(ctx.discoveredCommands).filter(Boolean).join(", ") || "defaults"}.`,
      `Repository maturity: ${ctx.repository.maturity}, CI: ${ctx.repository.ci.providers.join(", ") || "none"}.`,
    ],
    questions,
    runtime: { maxParallelAgents: { value: 2, reason: "Default parallel workers", source: "DEFAULT", confidence: "MEDIUM" } },
    dependencies: {
      enabled: { value: true, reason: "Reuse shared package-manager caches while keeping each worktree isolated.", source: "DEFAULT", confidence: "HIGH" },
      hydrate: { value: "auto", reason: "Run setup only when the workspace dependency marker is missing or stale.", source: "DEFAULT", confidence: "HIGH" },
    },
    repair: {
      enabled: { value: true, reason: "Enable repair up to attempts", source: "DEFAULT", confidence: "MEDIUM" },
      maxAttempts: { value: 3, reason: "Up to 3 repair attempts", source: "DEFAULT", confidence: "MEDIUM" },
    },
    approval: { finalMerge: { value: "required", reason: "Ask for approval before merge", source: "DEFAULT", confidence: "MEDIUM" } },
  };
}

function resolveDefaultModel(context: FactorySetupContext): { provider?: string; model: string } | undefined {
  // buildFactorySetupContext orders the user's actual Pi default first.
  if (context.availableModels[0]?.provider) return context.availableModels[0];
  // Fall back to any configured model with a provider.
  const anyWithProvider = context.availableModels.find((m) => m.provider);
  if (anyWithProvider) return anyWithProvider;
  // Or first available at all (built-ins like opus/sonnet are allowed).
  return context.availableModels[0];
}

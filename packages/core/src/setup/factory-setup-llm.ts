import type { AgentExecutor } from "../runtime/interfaces.js";
import type { FactorySetupContext, FactorySetupRecommendation, ModelRole, ModelSelection } from "@factory/schemas";
import { validateSetupRecommendation } from "./recommend-validate.js";
import { loadFactorySetupSkillSource, buildFactorySetupPrompt, extractJson } from "./setup-llm-prompt.js";
import { normalizeRecommendation, normalizeRecommendationStrict, completeRoleModels } from "./setup-llm-normalize.js";

export const MODEL_ROLES: ModelRole[] = ["discovery", "planner", "builder", "reviewer", "repair", "landing"];

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
  return validateSetupRecommendation(completeRoleModels(rec, input.context), input.context);
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
            { name: "acceptance", type: "acceptance", dependsOn: ["review"] },
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

export function resolveDefaultModel(context: FactorySetupContext): { provider?: string; model: string } | undefined {
  return visibleSetupModels(context)[0];
}

export function visibleSetupModels(context: FactorySetupContext): ModelSelection[] {
  const builtInKeys = new Set(Object.values(context.existing.builtIn.models).filter(Boolean).map((selection) => modelKey(selection!)));
  return context.availableModels.filter((selection) => selection.model && !builtInKeys.has(modelKey(selection)));
}

export function modelKey(selection: ModelSelection): string {
  return `${selection.provider ?? ""}:${selection.model}`;
}

export function formatModel(selection: ModelSelection): string {
  return selection.provider ? `${selection.provider}/${selection.model}` : selection.model;
}

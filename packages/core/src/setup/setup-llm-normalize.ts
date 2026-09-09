// LLM recommendation normalization — extracted from factory-setup-llm.ts.
import { modelKey, MODEL_ROLES, resolveDefaultModel, visibleSetupModels, formatModel } from "./factory-setup-llm.js";
import { validateSetupRecommendation } from "./recommend-validate.js";
import type { FactorySetupContext, FactorySetupRecommendation, ModelRole, ModelSelection } from "@factory/schemas";
export function normalizeRecommendationStrict(
  raw: unknown,
  ctx: FactorySetupContext,
  template: FactorySetupRecommendation,
): FactorySetupRecommendation {
  if (!raw || typeof raw !== "object") throw new Error("FACTORY_SETUP_LLM_INVALID: LLM returned null/non-object JSON.");
  return normalizeRecommendation(raw, ctx, template);
}

export function normalizeRecommendation(
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
    }
  }
  // Object-valued sections are copied through when the LLM emitted them;
  // commands are normalized against the discovery context.
  const objectSections = [
    "models",
    "runtime",
    "repair",
    "approval",
    "git",
    "dependencies",
    "capabilities",
    "skills",
    "dashboard",
  ] as const;
  for (const section of objectSections) {
    if (r[section] && typeof r[section] === "object") {
      rec[section] = r[section] as never;
    }
  }
  if (r.commands && typeof r.commands === "object") rec.commands = normalizeCommands(r.commands as Record<string, unknown>, ctx, fallback);
  if (Array.isArray(r.taskTypes)) rec.taskTypes = r.taskTypes as FactorySetupRecommendation["taskTypes"];
  if (Array.isArray(r.whyNot)) rec.whyNot = r.whyNot as FactorySetupRecommendation["whyNot"];
  return rec;
}

export function completeRoleModels(
  rec: FactorySetupRecommendation,
  ctx: FactorySetupContext,
): FactorySetupRecommendation {
  const defaultModel = resolveDefaultModel(ctx);
  if (!defaultModel) {
    return rec;
  }

  const completed: FactorySetupRecommendation["models"] = { ...(rec.models ?? {}) };
  const visibleKeys = new Set(visibleSetupModels(ctx).map(modelKey));
  for (const role of MODEL_ROLES) {
    const current = completed[role];
    if (current?.value?.model && visibleKeys.has(modelKey(current.value))) {
      continue;
    }
    completed[role] = {
      value: defaultModel,
      reason: current?.value?.model
        ? `${current.reason} Replaced with detected Pi-visible setup default ${formatModel(defaultModel)}.`
        : `Detected from your Pi model configuration; used for ${role} role setup.`,
    };
  }

  return { ...rec, models: completed };
}

export function normalizeCommands(
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


// Setup + concierge command handlers — extracted from gateway.ts.

import {
  discoverFactoryProject,
  initializeFactoryProject,
  loadEffectiveConfig,
  runConstitutionScan,
  detectPiModelConfiguration,
  resolveModelForRole,
  recommendViaFactoryConciergeSkill,
  type FactoryConciergeAction,
  type FactoryConciergeRecommendation,
  planFactorySetup,
  applyFactorySetup,
  validateFactorySetup,
  type AgentExecutor,
} from "@factory/core";
import type { FactorySetupRecommendation, ModelRole, ModelSelection } from "@factory/schemas";
import { createPiSdkSessionFactory, PiAgentExecutor } from "@factory/executor-pi";
import { renderLines, renderIntro, clearFactoryWidget, FACTORY_WIDGET_ID } from "./gateway-render.js";
import { mountFactoryStreamingWidget } from "./streaming-panel.js";
import { createRequiredConstitutionExecutor } from "./gateway.js";
import { handleCapabilities, handleModels } from "./gateway-capabilities.js";
import { handleCleanup, handleConstitution, handleDoctor, handleLogs, handleList, handlePlan, handleResume, handleCancel } from "./gateway-runs.js";
import { handleStatus } from "./gateway-run-status.js";
import { handleShow } from "./gateway-run-show.js";
import { handleWorkflow } from "./gateway-workflow.js";
import { handleDashboard } from "./gateway.js";
import { requestPlanApprovalDecision, buildPlanApprovalPreviewLines } from "./approval.js";
import { requestDecisionInput } from "./decision-dialog.js";
import { promptFactorySetupChoices } from "./setup-wizard.js";
import type { FactoryPiAutocompleteItem, FactoryPiCommandContext } from "./types.js";
import type { StewardReviewSlide } from "./gateway-concierge.js";
import { stewardSlideSummaryLines, showStewardSlideDetails, stewardSlideDetailLines, stewardSlideOptions, stewardSlideDetailOptions, stewardSlideCanCustomize, isCustomizeChoice, truncateWidgetLine, wrapWidgetLine, renderSetupSummary, renderSetupDetails } from "./gateway-steward.js";
import { customizeWorkflow, customizeModels, customizeCommands, customizeRuntime, customizeGitWorktrees, customizeDependencies, customizeRepair, customizeApproval, customizeCapabilities, customizeTaskRouting, customizeConstitution, hasClearDeterministicSetup, recommendSetupWithPiSdk } from "./gateway-customize.js";

export async function handleSetup(rest: string[], ctx: FactoryPiCommandContext): Promise<void> {
  renderIntro(ctx, [
    "Factory setup will inspect this repository, propose a setup, and validate the result.",
    "Factory will use repository evidence first and ask only where authority or preference is needed.",
  ]);

  const force = rest.includes("--force");
  const fromConcierge = rest.includes("--from-concierge");
  const project = await discoverFactoryProject(ctx.cwd);
  const hasExistingSetup = Boolean(project.paths.constitutionPath || project.paths.workflowPath || project.paths.projectConfigPath);

  if (!force && ctx.ui.confirm) {
    const ok = await ctx.ui.confirm(
      hasExistingSetup ? "Reconcile Factory setup?" : "Initialize Factory?",
      hasExistingSetup
        ? "Compare current repository state with existing Factory config and propose changes?"
        : "Inspect this repository and propose a Factory setup?",
    );
    if (!ok) { ctx.ui.notify("Factory setup cancelled", "info"); return; }
  }

  // Step 1: deterministic inspection with provenance (streamed)
  const panel = mountFactoryStreamingWidget(ctx.ui, FACTORY_WIDGET_ID, {
    title: "Factory setup",
    goal: ctx.cwd,
    phase: "setup-inspection",
    role: "inspection",
    status: "inspecting",
    lines: ["Inspecting repository for factory setup..."],
    footer: "Live Factory setup stream. Use arrow keys to scroll.",
  });
  const { buildFactorySetupContext } = await import("@factory/core");
  panel.append("Provenance: builtIn < global < project < workflow — collecting layers...");
  const setupContext = await (buildFactorySetupContext as (cwd: string) => Promise<import("@factory/schemas").FactorySetupContext>)(ctx.cwd);
  panel.append(`Found: ${setupContext.repository.languages.join(", ") || "none"} · ${setupContext.repository.packageManagers.join(", ") || "none"} · ${Object.values(setupContext.discoveredCommands).filter(Boolean).length} commands`);

  // Step 2: use deterministic evidence when setup is clear; keep the Pi SDK
  // LLM on standby for missing or conflicting setup evidence.
  const { buildDeterministicRecommendation, recommendViaFactorySetupSkill } = await import("@factory/core");
  const deterministicSetup = hasClearDeterministicSetup(setupContext);
  panel.setPhase("setup-recommendation");
  panel.setRole(deterministicSetup ? "factory-setup" : "factory-setup-llm");
  if (deterministicSetup) {
    panel.setStatus("completed");
    panel.append("Using repository evidence; Pi SDK LLM not needed.");
  }
  const recommendation = deterministicSetup
    ? buildDeterministicRecommendation(setupContext)
    : await recommendSetupWithPiSdk(ctx, setupContext, panel, hasExistingSetup, force, recommendViaFactorySetupSkill);
  panel.setStatus("completed");

  if (fromConcierge && ctx.ui.select) {
    renderLines(ctx, [
      "Factory setup interview",
      "",
      "Using the bundled grilling skill pattern: Factory will ask the frontier setup questions now, then use those answers before writing config.",
    ]);
    const piStatus = await detectPiModelConfiguration(ctx.cwd);
    const choices = await promptFactorySetupChoices(ctx.ui, piStatus);
    recommendation!.workflow = {
      value: { kind: "preset", preset: choices.workflowPreset, workflowId: "default-dev" },
      reason: "Selected during the Concierge setup interview.",
    };
    recommendation!.models = mergeModelAssignmentsIntoRecommendation(recommendation!, choices.modelAssignments);
  }

  // Step 3: Steward walk — project understanding + review of every area before writing
  // Uses buildStewardSlides from @factory/core; falls back to simple choice when no interactive UI.
  const { buildStewardSlides } = await import("@factory/core");
  const slides = (buildStewardSlides as unknown as (c: unknown, r: unknown) => StewardReviewSlide[])(setupContext, recommendation!);
  let stewardCancelled = false;
  const answers: Record<string, string> = {};
  let slideIndex = 0;
  while (slideIndex < slides.length) {
    const slide = slides[slideIndex]!;
    renderLines(ctx, stewardSlideSummaryLines(slide));
    if (!ctx.ui.select) { slideIndex++; continue; } // non-interactive: auto-accept recommendation
    const opts = stewardSlideOptions(slide.id, slideIndex);
    const choice = await ctx.ui.select(slide.title, opts);
    if (!choice || choice === "Cancel") { stewardCancelled = true; break; }
    if (choice === "Back") {
      slideIndex = Math.max(0, slideIndex - 1);
      continue;
    }
    if (choice === "Show details") {
      await showStewardSlideDetails(ctx, slide);
      const c2 = await ctx.ui.select(slide.title, stewardSlideDetailOptions(slide.id, slideIndex));
      if (!c2 || c2 === "Cancel") { stewardCancelled = true; break; }
      if (c2 === "Back") {
        slideIndex = Math.max(0, slideIndex - 1);
        continue;
      }
      if (isCustomizeChoice(c2)) {
        const edit = await ctx.ui.input?.(`Modify ${slide.title}`, slide.lines.join("\n").slice(0, 120));
        if (edit?.trim()) answers[`custom:${slide.id}`] = edit.trim();
      }
    } else if (isCustomizeChoice(choice)) {
      const edit = await ctx.ui.input?.(`Modify ${slide.title}`, slide.lines.join("\n").slice(0, 120));
      if (edit?.trim()) answers[`custom:${slide.id}`] = edit.trim();
    }
    // "Next / Use this" keeps recommendation as-is.
    slideIndex++;
  }
  if (stewardCancelled) { ctx.ui.notify("Factory setup cancelled", "info"); return; }
  // Surface dynamic questions (only where evidence ambiguous)
  for (const q of (recommendation as { questions?: Array<{ id: string; question: string; options: Array<{ id: string; label: string }> }> }).questions ?? []) {
    if (!ctx.ui.select) continue;
    const ans = await ctx.ui.select(q.question, q.options.map((o) => o.label));
    if (ans) {
      const opt = q.options.find((o) => o.label === ans);
      if (opt) answers[q.id] = opt.id;
    }
  }

  // Step 5: SetupPlan -> deterministic writer -> doctor
  const finalPlan = await planFactorySetup({ cwd: ctx.cwd, answers, force, recommendation });

  renderLines(ctx, [
    "Factory setup plan",
    ...finalPlan.diffs.map((diff) => `  ${diff.file.replace(project.paths.gitRoot ?? ctx.cwd, ".")}${diff.changes.includes("create file") ? " (+create)" : diff.changes.includes("content changes") ? " (~update)" : " (unchanged)"}`),
  ]);

  if (ctx.ui.confirm) {
    const apply = await ctx.ui.confirm("Apply Factory setup?", "Preview shown above. Write these files?");
    if (!apply) { ctx.ui.notify("Factory setup not applied", "info"); return; }
  }

  const written = await applyFactorySetup(finalPlan);

  // Constitution from recommendation, not separate prompt
  const constAction = (answers["constitution"] as string) ?? recommendation.constitution.toLowerCase();
  if (constAction === "generate" || constAction === "refresh") {
    try {
      renderLines(ctx, ["Factory setup", "phase: constitution-refresh"]);
      const executor = await createRequiredConstitutionExecutor();
      await runConstitutionScan({ cwd: ctx.cwd, constitutionExecutor: executor });
    } catch {
      ctx.ui.notify("Constitution generation failed; stub remains", "warning");
    }
  }

  const loaded = await loadEffectiveConfig({ cwd: ctx.cwd });
  const validation = await validateFactorySetup(ctx.cwd);
  const pi = await detectPiModelConfiguration(ctx.cwd);

  // READY and READY_WITH_WARNINGS are both healthy
  const isHealthy = validation.readiness === "READY" || validation.readiness === "READY_WITH_WARNINGS";
  renderLines(ctx, [
    "Factory setup complete",
    `mode: ${finalPlan.mode}`,
    `files written: ${written.length}`,
    `readiness: ${validation.readiness}`,
    ...validation.checks.filter((c) => !c.ok).map((c) => `  ${c.name.startsWith("doctor:") ? "⚠" : "✗"} ${c.name}: ${c.detail}`),
    "",
    `workflow: ${(recommendation.workflow?.value as { kind?: string; preset?: string })?.kind === "custom" ? "custom DAG" : (recommendation.workflow?.value as { preset?: string })?.preset ?? answers["workflow-preset"] ?? "balanced"}`,
    `base branch: ${loaded.effectiveConfig.git.baseBranch}`,
    `constitution: ${recommendation.constitution}`,
    "",
    `pi auth configured: ${pi.hasAuth ? "yes" : "no"}`,
    `pi default model: ${pi.defaultProvider && pi.defaultModel ? `${pi.defaultProvider}/${pi.defaultModel}` : "none"}`,
    ...(!pi.hasModelSelection ? ["  hint: configure a Pi default model in ~/.pi/agent/settings.json"] : []),
    ...(!pi.hasAuth ? ["  hint: use /login before generating a constitution or running model-backed flows"] : []),
  ]);

  ctx.ui.notify(`Factory setup complete — ${validation.readiness}`, isHealthy ? "info" : "warning");
}

function mergeModelAssignmentsIntoRecommendation(
  recommendation: FactorySetupRecommendation,
  modelAssignments: Partial<Record<ModelRole, ModelSelection>>,
): FactorySetupRecommendation["models"] {
  const merged: FactorySetupRecommendation["models"] = { ...(recommendation.models ?? {}) };
  for (const [role, selection] of Object.entries(modelAssignments) as Array<[ModelRole, ModelSelection]>) {
    if (!selection?.model) {
      continue;
    }
    merged[role] = {
      value: selection,
      reason: "Selected during the Concierge setup interview.",
    };
  }
  return Object.keys(merged).length ? merged : recommendation.models;
}

export async function runSetupCustomize(
  ctx: import("@factory/schemas").FactorySetupContext,
  rec: import("@factory/schemas").FactorySetupRecommendation,
  answers: Record<string, string>,
  uiCtx: FactoryPiCommandContext,
): Promise<{ answers: Record<string, string>; recommendation: import("@factory/schemas").FactorySetupRecommendation } | undefined> {
  let current = structuredClone(rec) as import("@factory/schemas").FactorySetupRecommendation;
  const localAnswers: Record<string, string> = { ...answers };
  while (true) {
    const section = await uiCtx.ui.select?.("What would you like to change?", [
      "Workflow",
      "Models",
      "Commands",
      "Runtime",
      "Git / worktrees",
      "Dependencies",
      "Repair",
      "Approval",
      "Capabilities",
      "Task routing",
      "Constitution",
      "Done",
    ]);
    if (!section || section === "Done") break;
    await SETUP_CUSTOMIZE_HANDLERS[section]?.({ ctx, uiCtx, current, localAnswers });
  }
  return { answers: localAnswers, recommendation: current };
}

export interface SetupCustomizeArgs {
  ctx: import("@factory/schemas").FactorySetupContext;
  uiCtx: FactoryPiCommandContext;
  current: import("@factory/schemas").FactorySetupRecommendation;
  localAnswers: Record<string, string>;
}

type SetupCustomizeHandler = (args: SetupCustomizeArgs) => Promise<void>;

const SETUP_CUSTOMIZE_HANDLERS: Record<string, SetupCustomizeHandler> = {
  Workflow: customizeWorkflow,
  Models: customizeModels,
  Commands: customizeCommands,
  Runtime: customizeRuntime,
  "Git / worktrees": customizeGitWorktrees,
  Dependencies: customizeDependencies,
  Repair: customizeRepair,
  Approval: customizeApproval,
  Capabilities: customizeCapabilities,
  "Task routing": customizeTaskRouting,
  Constitution: customizeConstitution,
};

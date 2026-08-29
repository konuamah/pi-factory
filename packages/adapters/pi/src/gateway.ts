import path from "node:path";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import {
  discoverFactoryProject,
  initializeFactoryProject,
  loadEffectiveConfig,
  cancelLatestFactoryRun,
  cleanupFactoryRuns,
  createGitWorktree,
  inspectFactoryRun,
  runConstitutionScan,
  inspectGitIsolation,
  listFactoryRuns,
  readFactoryRunLogs,
  readLatestFactoryRunLogs,
  readLatestFactoryRunStatus,
  readLatestFactoryRunSummary,
  readLatestFactoryRunPlan,
  resumeLatestFactoryRun,
  runFactoryDoctor,
  runPrototypeFactoryFlow,
  showFactoryRun,
  readWorkflowRegistry,
  writeWorkflowRegistry,
  detectPiModelConfiguration,
  resolveModelForRole,
  classifyTaskType,
  preflightModelRouting,
  initializeCapabilitySystem,
  listRegisteredCapabilities,
  getRegisteredCapability,
  checkExecutability,
  registerCapability,
  validateCapabilityDefinition,
  parseCapabilityFile,
  judgeConstitutionRefreshForTask,
  recommendViaFactoryConciergeSkill,
  type FactoryConciergeAction,
  type FactoryConciergeRecommendation,
  planFactorySetup,
  applyFactorySetup,
  validateFactorySetup,
  appendFactoryRunEvent,
  updateFactoryRunState,
  type AgentExecutor,
  type FactoryRunProgressEvent,
} from "@factory/core";
import * as piExecutors from "@factory/executor-pi";
import { buildPlanApprovalPreviewLines, requestPlanApprovalDecision } from "./approval.js";
import { requestDecisionInput } from "./decision-dialog.js";
import { promptFactorySetupChoices } from "./setup-wizard.js";
import { mountFactoryStreamingWidget } from "./streaming-panel.js";
import type { FactoryPiAutocompleteItem, FactoryPiCommandContext } from "./types.js";
import { buildDecisionLines, buildGuidanceDiagnosticLines, buildVerificationDiagnosticLines, buildIntegrationFailureLines, renderLines, renderIntro, clearFactoryWidget, doctorWidgetLines, FACTORY_WIDGET_ID } from "./gateway-render.js";
import { handleWorkflow, handleWorkflowCreate } from "./gateway-workflow.js";
import type { ModelRole, ModelSelection, WorkflowNodeType, WorkflowStage } from "@factory/schemas";


const execFileAsync = promisify(execFile);
const FACTORY_SUBCOMMANDS = ["ask", "setup", "status", "doctor", "logs", "list", "show", "plan", "resume", "cancel", "worktree", "workflow", "capabilities", "models", "cleanup", "constitution", "dashboard"];

export async function getFactoryCommandCompletions(
  prefix: string,
): Promise<FactoryPiAutocompleteItem[] | null> {
  const trimmed = prefix.trimStart();
  const parts = trimmed.split(/\s+/).filter(Boolean);
  const trailingSpace = /\s$/.test(prefix);

  if (parts.length === 0) {
    return FACTORY_SUBCOMMANDS.map((value) => ({ value, label: value }));
  }

  if (parts.length === 1 && !trailingSpace) {
    const subPrefix = parts[0] ?? "";
    const matches = FACTORY_SUBCOMMANDS.filter((value) => value.startsWith(subPrefix));
    return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
  }

  const subcommand = parts[0];
  if (subcommand !== "status" && subcommand !== "logs" && subcommand !== "show") {
    return null;
  }

  const cwd = process.cwd();
  const project = await discoverFactoryProject(cwd);
  const runs = await listFactoryRuns(project.paths.runsDir);
  const runPrefix = trailingSpace ? "" : (parts[1] ?? "");
  const matches = runs.filter((run) => run.runId.startsWith(runPrefix));

  return matches.length > 0
    ? matches.map((run) => ({
        value: `${subcommand} ${run.runId}`,
        label: run.runId,
        description: [run.status, run.phase, run.goal].filter(Boolean).join(" • "),
      }))
    : null;
}

export async function handleFactoryCommand(
  rawArgs: string | undefined,
  ctx: FactoryPiCommandContext,
): Promise<void> {
  const args = (rawArgs ?? "").trim();
  clearFactoryWidget(ctx);

  try {
    if (!args) {
      renderLines(ctx, [
        "Factory",
        "",
        "/factory dashboard [start|stop|status|open] [--port N] [--host H]  dashboard control (opt-in via dashboard.enabled)",
        "/factory ask <question>  ask Factory Concierge what to do next",
        "/factory setup   initialize project-local Factory files",
        "/factory status [run-id] inspect config and latest or specific run state",
        "/factory doctor  validate repo and config readiness",
        "/factory logs [run-id] inspect latest or specific run state, events, and artifacts",
        "/factory list    list known run ids",
        "/factory show <run-id> show merged run details",
        "/factory plan    show latest run plan summary",
        "/factory resume  mark the latest interrupted run resumed",
        "/factory cancel  mark the latest run cancelled",
        "/factory worktree <branch> create or detect isolated workspace",
        "/factory workflow list|create|show|edit|clone|delete|set-default manage reusable workflows",
        "/factory capabilities list|show|validate inspect and validate custom capabilities",
        "/factory models show effective model routing by task type",
        "/factory cleanup [retain-count] prune old runs/worktrees/branches",
        "/factory constitution scan repository constitution via facts + AI interpretation",
        "/factory <goal>  run a minimal end-to-end prototype flow",
      ]);
      ctx.ui.notify("Factory command ready", "info");
      return;
    }

    const [subcommand, ...rest] = args.split(/\s+/);

    switch (subcommand) {
      case "setup":
        await handleSetup(rest, ctx);
        return;
      case "ask":
        await handleAsk(rest.join(" "), ctx);
        return;
      case "status":
        await handleStatus(ctx, rest[0]);
        return;
      case "doctor":
        await handleDoctor(ctx);
        return;
      case "logs":
        await handleLogs(ctx, rest[0]);
        return;
      case "list":
        await handleList(ctx);
        return;
      case "show":
        await handleShow(rest[0], ctx);
        return;
      case "plan":
        await handlePlan(ctx);
        return;
      case "resume":
        await handleResume(ctx);
        return;
      case "cancel":
        await handleCancel(ctx);
        return;
      case "worktree":
        await handleWorktree(rest[0], ctx);
        return;
      case "workflow":
        await handleWorkflow(rest, ctx);
        return;
      case "capabilities":
        await handleCapabilities(rest, ctx);
        return;
      case "models":
        await handleModels(rest, ctx);
        return;
      case "cleanup":
        await handleCleanup(rest[0], ctx);
        return;
      case "constitution":
        await handleConstitution(rest, ctx);
        return;
      case "dashboard":
        await handleDashboard(rest, ctx);
        return;
      default:
        await handlePrototypeGoal(args, ctx);
    }
  } catch (error) {
    await handleFactoryCommandError(error, ctx);
  }
}

async function handleSetup(rest: string[], ctx: FactoryPiCommandContext): Promise<void> {
  renderIntro(ctx, [
    "Factory setup will inspect this repository, propose a setup, and validate the result.",
    "Factory will use repository evidence first and ask only where authority or preference is needed.",
  ]);

  const force = rest.includes("--force");
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

async function handleAsk(questionText: string, ctx: FactoryPiCommandContext): Promise<void> {
  const question = questionText.trim();
  if (!question) {
    renderLines(ctx, [
      "Factory Concierge",
      "",
      "Ask a question, for example:",
      "/factory ask how does Factory work?",
      "/factory ask set everything up for this repo",
      "/factory ask help me run this task safely",
      "/factory ask turn on the dashboard",
      "/factory ask why is my model failing?",
    ]);
    ctx.ui.notify("Ask Factory Concierge a question", "info");
    return;
  }

  renderIntro(ctx, [
    "Factory Concierge will help with this repo's Factory setup, workflows, models, skills, commands, dashboard, runs, and readiness.",
    "It can prepare task execution guidance, but it will not start a Factory task for you.",
  ]);

  const panel = mountFactoryStreamingWidget(ctx.ui, FACTORY_WIDGET_ID, {
    title: "Factory Concierge",
    goal: question,
    phase: "ask",
    role: "factory-concierge",
    status: "thinking",
    lines: ["Reading Factory setup context..."],
    footer: "Factory Concierge routes only to approved Factory support commands.",
  });

  const executor = await createOptionalSetupExecutor(ctx, (_executionId, event) => {
    panel.setStatus("streaming");
    if (event.text) panel.appendStream(event.text);
  });
  const recommendation = await recommendViaFactoryConciergeSkill({
    cwd: ctx.cwd,
    question,
    executor,
    onEvent: (text) => panel.append(text),
  });

  panel.setStatus("completed");
  renderLines(ctx, factoryConciergeLines(recommendation));
  await handleConciergeRecommendationAction(recommendation, ctx);
}

function factoryConciergeLines(rec: FactoryConciergeRecommendation): string[] {
  return [
    "Factory Concierge",
    "",
    rec.answer,
    "",
    `Recommended action: ${formatConciergeAction(rec.recommendedAction)}`,
    `Why: ${rec.why}`,
    ...(rec.suggestedCommand ? [`Command: ${rec.suggestedCommand}`] : []),
    ...(rec.handoff ? [`Handoff: ${rec.handoff}`] : []),
    ...(rec.details?.length ? ["", "Details", ...rec.details.map((line) => `- ${line}`)] : []),
  ];
}

async function handleConciergeRecommendationAction(
  rec: FactoryConciergeRecommendation,
  ctx: FactoryPiCommandContext,
): Promise<void> {
  if (rec.recommendedAction === "answer-only" || rec.recommendedAction === "guide-task-execution") {
    ctx.ui.notify("Factory Concierge answered", "info");
    return;
  }

  if (rec.recommendedAction === "import-skills" || rec.recommendedAction === "configure-dependencies") {
    ctx.ui.notify("Factory Concierge recommended Factory configuration guidance", "info");
    return;
  }

  const command = rec.suggestedCommand ?? conciergeCommandForAction(rec.recommendedAction);
  if (!command) {
    ctx.ui.notify("Factory Concierge recommendation shown", "info");
    return;
  }

  const shouldRun = rec.needsApproval
    ? await ctx.ui.confirm?.("Run recommended Factory action?", `${command}\n\n${rec.why}`)
    : true;
  if (rec.needsApproval && !shouldRun) {
    ctx.ui.notify("Factory Concierge action not run", "info");
    return;
  }

  await runConciergeAction(rec, ctx);
}

async function runConciergeAction(rec: FactoryConciergeRecommendation, ctx: FactoryPiCommandContext): Promise<void> {
  switch (rec.recommendedAction) {
    case "run-setup":
      await handleSetup([], ctx);
      return;
    case "run-doctor":
      await handleDoctor(ctx);
      return;
    case "create-workflow":
      await handleWorkflow(["create"], ctx);
      return;
    case "list-workflows":
      await handleWorkflow(["list"], ctx);
      return;
    case "show-workflow": {
      const workflowId = commandArg(rec.suggestedCommand, /^\/factory workflow show (\S+)$/);
      await handleWorkflow(["show", workflowId ?? ""], ctx);
      return;
    }
    case "set-default-workflow": {
      const workflowId = commandArg(rec.suggestedCommand, /^\/factory workflow set-default (\S+)$/);
      await handleWorkflow(["set-default", workflowId ?? ""], ctx);
      return;
    }
    case "inspect-models":
      await handleModels([], ctx);
      return;
    case "inspect-capabilities":
      await handleCapabilities(["list"], ctx);
      return;
    case "show-capability": {
      const capabilityId = commandArg(rec.suggestedCommand, /^\/factory capabilities show (\S+)$/);
      await handleCapabilities(["show", capabilityId ?? ""], ctx);
      return;
    }
    case "validate-capabilities":
      await handleCapabilities(["validate"], ctx);
      return;
    case "refresh-constitution":
      await handleConstitution([], ctx);
      return;
    case "show-status":
      await handleStatus(ctx, commandArg(rec.suggestedCommand, /^\/factory status (\S+)$/));
      return;
    case "list-runs":
      await handleList(ctx);
      return;
    case "show-run": {
      const runId = commandArg(rec.suggestedCommand, /^\/factory show (\S+)$/);
      await handleShow(runId, ctx);
      return;
    }
    case "show-logs":
      await handleLogs(ctx, commandArg(rec.suggestedCommand, /^\/factory logs (\S+)$/));
      return;
    case "show-plan":
      await handlePlan(ctx);
      return;
    case "dashboard-status":
      await handleDashboard(["status"], ctx);
      return;
    case "start-dashboard":
      await handleDashboard(["start"], ctx);
      return;
    case "cleanup-runs":
      await handleCleanup(commandArg(rec.suggestedCommand, /^\/factory cleanup (\d+)$/), ctx);
      return;
    default:
      ctx.ui.notify("Factory Concierge recommendation shown", "info");
  }
}

function conciergeCommandForAction(action: FactoryConciergeAction): string | undefined {
  switch (action) {
    case "run-setup": return "/factory setup";
    case "run-doctor": return "/factory doctor";
    case "create-workflow": return "/factory workflow create";
    case "list-workflows": return "/factory workflow list";
    case "inspect-models": return "/factory models";
    case "inspect-capabilities": return "/factory capabilities list";
    case "validate-capabilities": return "/factory capabilities validate";
    case "refresh-constitution": return "/factory constitution";
    case "show-status": return "/factory status";
    case "list-runs": return "/factory list";
    case "show-logs": return "/factory logs";
    case "show-plan": return "/factory plan";
    case "dashboard-status": return "/factory dashboard status";
    case "start-dashboard": return "/factory dashboard start";
    case "cleanup-runs": return "/factory cleanup";
    default: return undefined;
  }
}

function commandArg(command: string | undefined, pattern: RegExp): string | undefined {
  return command?.match(pattern)?.[1];
}

function formatConciergeAction(action: FactoryConciergeAction): string {
  return action.replace(/-/g, " ");
}

interface StewardReviewSlide {
  id: string;
  title: string;
  simpleTitle: string;
  lines: string[];
  details?: string[];
  kind: string;
  recommended?: unknown;
}

function stewardSlideSummaryLines(slide: StewardReviewSlide): string[] {
  const body = slide.lines.filter((line) => !/widget truncated/i.test(line));
  const maxBodyLines = 9;
  const visible = body.slice(0, maxBodyLines);
  const hidden = Math.max(0, body.length - visible.length);
  return [
    slide.simpleTitle,
    `(${slide.title} — ${slide.kind})`,
    "",
    ...visible,
    ...(hidden > 0 ? ["", `${hidden} more line(s). Choose Show details to read the full section.`] : []),
  ];
}

async function showStewardSlideDetails(ctx: FactoryPiCommandContext, slide: StewardReviewSlide): Promise<void> {
  const detailLines = stewardSlideDetailLines(slide);
  if (ctx.ui.custom) {
    await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
      let scrollOffset = 0;
      return {
        render(width: number): string[] {
          const safeWidth = Math.max(20, width);
          const header = [
            `${slide.title} details`,
            `id: ${slide.id} · kind: ${slide.kind}`,
            "",
          ];
          const footer = [
            "",
            "↑↓ scroll · enter/escape close",
          ];
          const wrapped = detailLines.flatMap((line) => wrapWidgetLine(line, safeWidth));
          const availableRows = Math.max(6, 22 - header.length - footer.length - 1);
          const maxOffset = Math.max(0, wrapped.length - availableRows);
          scrollOffset = Math.min(scrollOffset, maxOffset);
          const visible = wrapped.slice(scrollOffset, scrollOffset + availableRows);
          const position = wrapped.length > availableRows
            ? [`Showing ${scrollOffset + 1}-${Math.min(wrapped.length, scrollOffset + availableRows)} of ${wrapped.length}`]
            : [];
          return [...header, ...position, ...visible, ...footer].map((line) => truncateWidgetLine(line, width));
        },
        handleInput(data: string) {
          if (data === "\r" || data === "\n" || data === "\u001b") {
            done();
            return;
          }
          if (data === "\u001b[A") {
            scrollOffset = Math.max(0, scrollOffset - 1);
            tui.requestRender();
          } else if (data === "\u001b[B") {
            scrollOffset += 1;
            tui.requestRender();
          }
        },
        invalidate() {},
      };
    });
    return;
  }

  renderLines(ctx, [
    `${slide.title} details`,
    `id: ${slide.id}`,
    "",
    ...detailLines.slice(0, 24),
    ...(detailLines.length > 24 ? ["", `${detailLines.length - 24} more line(s) hidden by this shell. Use an interactive Pi TUI for scrollable details.`] : []),
  ]);
}

function stewardSlideDetailLines(slide: StewardReviewSlide): string[] {
  const lines = [
    "Recommendation view",
    ...slide.lines.filter((line) => !/widget truncated/i.test(line)),
  ];
  if (slide.details?.length) {
    lines.push("", "Additional detail", ...slide.details);
  }
  if (slide.recommended !== undefined) {
    lines.push("", "Raw recommendation", ...JSON.stringify(slide.recommended, null, 2).split(/\r?\n/));
  }
  return lines;
}

function stewardSlideOptions(slideId: string, slideIndex: number): string[] {
  return [
    slideId === "understanding" ? "Looks right" : "Next / Use this",
    ...(slideIndex > 0 ? ["Back"] : []),
    ...(stewardSlideCanCustomize(slideId) ? [slideId === "understanding" ? "Correct something" : "Customize"] : []),
    "Show details",
    "Cancel",
  ];
}

function stewardSlideDetailOptions(slideId: string, slideIndex: number): string[] {
  return [
    slideId === "understanding" ? "Looks right" : "Next / Use this",
    ...(slideIndex > 0 ? ["Back"] : []),
    ...(stewardSlideCanCustomize(slideId) ? [slideId === "understanding" ? "Correct something" : "Customize"] : []),
    "Cancel",
  ];
}

function stewardSlideCanCustomize(slideId: string): boolean {
  return slideId !== "finalReview";
}

function isCustomizeChoice(choice: string): boolean {
  return choice === "Customize" || choice === "Correct something";
}

function truncateWidgetLine(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}

function wrapWidgetLine(value: string, width: number): string[] {
  if (width <= 0) return [""];
  if (value.length === 0) return [""];
  const out: string[] = [];
  let remaining = value;
  while (remaining.length > width) {
    out.push(remaining.slice(0, width));
    remaining = remaining.slice(width);
  }
  out.push(remaining);
  return out;
}

function renderSetupSummary(
  ctx: import("@factory/schemas").FactorySetupContext,
  rec: import("@factory/schemas").FactorySetupRecommendation,
): string[] {
  const langs = ctx.repository.languages.join(", ") || "none";
  const pms = ctx.repository.packageManagers.join(", ") || "none";
  const frameworks = ctx.repository.frameworks.join(", ") || "none";
  const discoveredCount = Object.values(ctx.discoveredCommands).filter(Boolean).length;
  const wfVal = rec.workflow?.value as { kind?: string; preset?: string; workflow?: { stages: Array<{ name: string }> } } | undefined;
  const presetLabel = wfVal?.kind === "custom" ? `Custom (${wfVal.workflow?.stages.map((s) => s.name).join(" → ") ?? "custom"})` : wfVal?.preset ? wfVal.preset.charAt(0).toUpperCase() + wfVal.preset.slice(1) : "Balanced";
  const cmds = Object.values(rec.commands ?? {}).map((c) => c!.value).join(", ") || "none";
  return [
    "Factory checked this project.",
    "",
    "I found:",
    `  ${langs}`,
    `  ${pms}`,
    ...(frameworks !== "none" ? [`  ${frameworks}`] : []),
    `  Git`,
    `  ${discoveredCount} build/verification command(s)`,
    "",
    "I recommend:",
    `  Workflow    ${presetLabel}`,
    ...(rec.models ? [`  Models      ${Object.entries(rec.models).map(([r, v]) => `${r}:${v!.value.model}`).join(", ")}`] : []),
    `  Verification  ${cmds}`,
    `  Parallel workers  ${rec.runtime?.maxParallelAgents?.value ?? 2}`,
    `  Repair  Up to ${rec.repair?.maxAttempts?.value ?? 3} attempts`,
    `  Final merge  ${rec.approval?.finalMerge?.value === "required" ? "Ask for approval" : "Auto-merge"}`,
    "",
    `I can also ${rec.constitution === "GENERATE" ? "generate" : rec.constitution === "REFRESH" ? "refresh" : "keep"} the repository constitution.`,
    "",
    "Why this setup?",
    ...(rec.explanation.slice(0, 2).map((e) => `  ${e}`)),
    "",
    rec.summary,
  ];
}

function renderSetupDetails(
  ctx: import("@factory/schemas").FactorySetupContext,
  rec: import("@factory/schemas").FactorySetupRecommendation,
): string[] {
  const lines: string[] = ["Details", ""];
  const src = ctx.existing;
  const provenance = (field: string, existingValue: unknown): string => {
    if (existingValue !== undefined && existingValue !== null && existingValue !== "") return `Source: Project configuration`;
    const g = src.global as Record<string, unknown> | undefined;
    if (g && (g as Record<string, unknown>)[field] !== undefined) return `Source: Global configuration`;
    return `Source: Built-in default`;
  };
  if (rec.models) {
    for (const [role, entry] of Object.entries(rec.models)) {
      lines.push(`  ${role}: ${entry!.value.model}${entry!.value.provider ? ` (${entry!.value.provider})` : ""} — ${entry!.reason}`);
      lines.push(`    ${provenance(role, (src.project?.models as Record<string, unknown> | undefined)?.[role])} / ${entry!.reason}`);
    }
  }
  if (rec.commands) {
    for (const [field, r] of Object.entries(rec.commands)) {
      if (!r) continue;
      const flag = r.source === "DISCOVERED" ? "✓" : r.source === "AI_SUGGESTED" ? "?" : "·";
      lines.push(`  ${field}: ${flag} ${r.value} [${r.source}] — ${r.reason}` + (r.requiresConfirmation ? " (needs confirmation)" : ""));
    }
  }
  if (rec.capabilities?.allow?.length) lines.push(`  capabilities allow: ${rec.capabilities.allow.join(", ")}`);
  if (rec.capabilities?.deny?.length) lines.push(`  capabilities deny: ${rec.capabilities.deny.join(", ")}`);
  if (rec.dependencies) {
    if (rec.dependencies.enabled) lines.push(`  dependency hydration: ${rec.dependencies.enabled.value ? "enabled" : "disabled"} — ${rec.dependencies.enabled.reason}`);
    if (rec.dependencies.hydrate) lines.push(`  dependency hydrate mode: ${rec.dependencies.hydrate.value} — ${rec.dependencies.hydrate.reason}`);
    if (rec.dependencies.cacheRoot) lines.push(`  dependency cache root: ${rec.dependencies.cacheRoot.value} — ${rec.dependencies.cacheRoot.reason}`);
  }
  if (rec.taskTypes?.length) lines.push(`  task types: ${rec.taskTypes.map((t) => t.id).join(", ")}`);
  lines.push(`  constitution: ${rec.constitution}`);
  lines.push("");
  lines.push(`Available models: ${ctx.availableModels.map((m) => (m.provider ? `${m.provider}/` : "") + m.model).join(", ")}`);
  lines.push(`Available capabilities: ${ctx.availableCapabilities.join(", ")}`);
  return lines;
}

async function runSetupCustomize(
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

interface SetupCustomizeArgs {
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

async function customizeWorkflow({ uiCtx, current }: SetupCustomizeArgs): Promise<void> {
  const choice = await uiCtx.ui.select?.("Workflow preset", ["Balanced", "Fast", "Safe"]);
  if (!choice) return;
  const preset = choice.toLowerCase().split(" ")[0] as import("@factory/schemas").WorkflowPreset;
  const curWf = current.workflow?.value as { workflowId?: string } | undefined;
  current.workflow = { value: { kind: "preset", preset, workflowId: curWf?.workflowId ?? "default-dev" }, reason: `User chose ${preset}` };
}

async function customizeModels({ ctx, uiCtx, current }: SetupCustomizeArgs): Promise<void> {
  for (const role of ["discovery", "planner", "builder", "reviewer", "repair"] as const) {
    const cur = current.models?.[role]?.value;
    const curLabel = cur ? `${cur.provider ? `${cur.provider}/` : ""}${cur.model}` : "unset";
    const choice = await uiCtx.ui.select?.(`Model for ${role} (now: ${curLabel})`, [
      ...ctx.availableModels.map((m) => `${m.provider ? `${m.provider}/` : ""}${m.model}`),
      "Keep current",
      "Skip / unset",
    ]);
    if (!choice || choice === "Keep current") continue;
    if (choice === "Skip / unset") { if (current.models) delete current.models[role]; continue; }
    const [provider, ...rest] = choice.split("/");
    const model = rest.length ? rest.join("/") : provider;
    const prov = rest.length ? provider : undefined;
    current.models = current.models ?? {};
    const matched = ctx.availableModels.find((m) => `${m.provider ?? ""}:${m.model}` === `${prov ?? ""}:${model}`);
    if (!matched && !choice.includes("/")) {
      // Single model id like "opus" — pick first match
      const byModel = ctx.availableModels.find((m) => m.model === choice);
      if (byModel) { current.models[role] = { value: byModel, reason: `User chose ${choice}` }; continue; }
    }
    const sel = matched ?? { provider: prov, model: model! };
    current.models[role] = { value: sel, reason: `User chose ${choice}` };
  }
}

async function customizeCommands({ ctx, uiCtx, current, localAnswers }: SetupCustomizeArgs): Promise<void> {
  for (const field of ["setup", "lint", "typecheck", "test", "build"] as const) {
    const cur = current.commands?.[field];
    const curLabel = cur ? `${cur.value} [${cur.source}]` : "unset";
    const discovered = (ctx.discoveredCommands as Record<string, string | undefined>)[field];
    const options = [
      ...(discovered ? [`Use discovered — ${discovered}`] : []),
      "Enter custom command",
      "Keep current",
      "Clear",
    ];
    const choice = await uiCtx.ui.select?.(`Command: ${field} (now: ${curLabel})`, options);
    if (!choice || choice === "Keep current") continue;
    if (choice === "Clear") { if (current.commands) delete current.commands[field]; continue; }
    if (choice.startsWith("Use discovered")) {
      if (discovered) { current.commands = current.commands ?? {}; current.commands[field] = { value: discovered, reason: `User kept discovered ${field}`, source: "DISCOVERED", confidence: "HIGH" }; }
      continue;
    }
    const custom = await uiCtx.ui.input?.(`Custom ${field} command`, "e.g. pnpm test:integration");
    if (!custom?.trim()) continue;
    const val = custom.trim();
    const isDiscovered = Object.values(ctx.discoveredCommands).includes(val);
    current.commands = current.commands ?? {};
    current.commands[field] = {
      value: val,
      reason: isDiscovered ? `User kept discovered: ${val}` : `User custom: ${val}`,
      source: isDiscovered ? "DISCOVERED" : "AI_SUGGESTED",
      confidence: isDiscovered ? "HIGH" : "MEDIUM",
      ...(isDiscovered ? {} : { requiresConfirmation: true as const }),
    };
    if (!isDiscovered) localAnswers[`confirm:${field}`] = "yes"; // user just confirmed by entering it in Customize
  }
}

async function customizeRuntime({ uiCtx, current, localAnswers }: SetupCustomizeArgs): Promise<void> {
  const cur = String(current.runtime?.maxParallelAgents?.value ?? 2);
  const val = await uiCtx.ui.input?.("Max parallel agents (1-16)", cur);
  if (!val?.trim()) return;
  const n = Number.parseInt(val.trim(), 10);
  if (Number.isFinite(n) && n >= 1 && n <= 16) { current.runtime = current.runtime ?? {}; current.runtime.maxParallelAgents = { value: n, reason: "User chose parallel workers", source: "DEFAULT", confidence: "HIGH" }; localAnswers["runtime:maxParallelAgents"] = String(n); }
}

async function customizeGitWorktrees({ ctx, uiCtx, current, localAnswers }: SetupCustomizeArgs): Promise<void> {
  const bb = await uiCtx.ui.input?.("Base branch", current.git?.baseBranch?.value ?? ctx.effective?.git.baseBranch ?? "main");
  if (bb?.trim()) { current.git = current.git ?? {}; current.git.baseBranch = { value: bb.trim(), reason: "User chose base branch", source: "DEFAULT", confidence: "HIGH" }; localAnswers["git:baseBranch"] = bb.trim(); }
  const aw = await uiCtx.ui.select?.("Allow worktrees?", ["Yes", "No", "Keep current"]);
  if (aw && aw !== "Keep current") { current.git = current.git ?? {}; current.git.allowWorktrees = { value: aw === "Yes", reason: "User chose worktree policy", source: "DEFAULT", confidence: "HIGH" }; }
}

async function customizeDependencies({ ctx, uiCtx, current }: SetupCustomizeArgs): Promise<void> {
  const enabled = await uiCtx.ui.select?.("Hydrate dependencies before work?", ["Enabled", "Disabled", "Keep current"]);
  if (enabled && enabled !== "Keep current") {
    current.dependencies = current.dependencies ?? {};
    current.dependencies.enabled = { value: enabled === "Enabled", reason: "User chose dependency hydration policy", source: "DEFAULT", confidence: "HIGH" };
  }
  const hydrate = await uiCtx.ui.select?.("Hydration mode", ["auto", "always", "never", "Keep current"]);
  if (hydrate && hydrate !== "Keep current") {
    current.dependencies = current.dependencies ?? {};
    current.dependencies.hydrate = { value: hydrate as import("@factory/schemas").DependencyHydrationMode, reason: "User chose dependency hydration mode", source: "DEFAULT", confidence: "HIGH" };
  }
  const cacheRoot = await uiCtx.ui.input?.("Shared dependency cache root", current.dependencies?.cacheRoot?.value ?? ctx.effective?.dependencies.cacheRoot ?? "");
  if (cacheRoot?.trim()) {
    current.dependencies = current.dependencies ?? {};
    current.dependencies.cacheRoot = { value: cacheRoot.trim(), reason: "User chose shared dependency cache root", source: "DEFAULT", confidence: "HIGH" };
  }
}

async function customizeRepair({ uiCtx, current, localAnswers }: SetupCustomizeArgs): Promise<void> {
  const en = await uiCtx.ui.select?.("Enable repair?", ["Enabled", "Disabled", "Keep current"]);
  if (en && en !== "Keep current") { current.repair = current.repair ?? {}; current.repair.enabled = { value: en === "Enabled", reason: "User chose repair policy", source: "DEFAULT", confidence: "HIGH" }; localAnswers["repair:enabled"] = String(en === "Enabled"); }
  const ma = await uiCtx.ui.input?.("Max repair attempts (0-10)", String(current.repair?.maxAttempts?.value ?? 3));
  if (ma?.trim()) { const n = Number.parseInt(ma.trim(), 10); if (Number.isFinite(n) && n >= 0 && n <= 10) { current.repair = current.repair ?? {}; current.repair.maxAttempts = { value: n, reason: "User chose maxAttempts", source: "DEFAULT", confidence: "HIGH" }; localAnswers["repair:maxAttempts"] = String(n); } }
}

async function customizeApproval({ uiCtx, current, localAnswers }: SetupCustomizeArgs): Promise<void> {
  const choice = await uiCtx.ui.select?.("Final merge", ["Ask for approval (required)", "Auto-merge (not-required)", "Keep current"]);
  if (!choice || choice === "Keep current") return;
  const v = choice.startsWith("Ask") ? "required" as const : "not-required" as const;
  current.approval = current.approval ?? {}; current.approval.finalMerge = { value: v, reason: "User chose merge policy", source: "DEFAULT", confidence: "HIGH" }; localAnswers["approval:finalMerge"] = v;
}

async function customizeCapabilities({ uiCtx, current }: SetupCustomizeArgs): Promise<void> {
  const curAllow = current.capabilities?.allow?.join(", ") || "none";
  const curDeny = current.capabilities?.deny?.join(", ") || "none";
  const want = await uiCtx.ui.select?.(`Capabilities (allow: ${curAllow} / deny: ${curDeny})`, ["Edit allow", "Edit deny", "Keep current"]);
  if (want === "Edit allow") {
    const val = await uiCtx.ui.input?.("Allow capabilities (comma-separated)", curAllow);
    if (val !== undefined) { const ids = val.split(",").map((s) => s.trim()).filter(Boolean) as import("@factory/schemas").Capability[]; current.capabilities = current.capabilities ?? {}; (current.capabilities as Record<string, unknown>).allow = ids; }
  } else if (want === "Edit deny") {
    const val = await uiCtx.ui.input?.("Deny capabilities (comma-separated)", curDeny);
    if (val !== undefined) { const ids = val.split(",").map((s) => s.trim()).filter(Boolean) as import("@factory/schemas").Capability[]; current.capabilities = current.capabilities ?? {}; (current.capabilities as Record<string, unknown>).deny = ids; }
  }
}

async function customizeTaskRouting({ uiCtx, current }: SetupCustomizeArgs): Promise<void> {
  const val = await uiCtx.ui.input?.("Task type IDs (comma-separated, e.g. database-migration)", current.taskTypes?.map((t) => t.id).join(", ") ?? "");
  if (val === undefined) return;
  const ids = val.split(",").map((s) => s.trim()).filter(Boolean);
  current.taskTypes = ids.map((id) => ({ id, reason: "User chose task types", source: "DEFAULT" as const, confidence: "MEDIUM" as const }));
}

async function customizeConstitution({ uiCtx, current }: SetupCustomizeArgs): Promise<void> {
  const choice = await uiCtx.ui.select?.("Constitution", ["GENERATE", "REFRESH", "KEEP"]);
  if (choice) current.constitution = choice as import("@factory/schemas").ConstitutionRecommendation;
}

function hasClearDeterministicSetup(context: import("@factory/schemas").FactorySetupContext): boolean {
  const setup = context.discoveredCommands.setup?.trim();
  const managers = context.repository.packageManagers;
  if (!setup || managers.length !== 1) return false;
  return true;
}

async function recommendSetupWithPiSdk(
  ctx: FactoryPiCommandContext,
  context: import("@factory/schemas").FactorySetupContext,
  panel: ReturnType<typeof mountFactoryStreamingWidget>,
  hasExistingSetup: boolean,
  force: boolean,
  recommend: (input: { cwd: string; context: import("@factory/schemas").FactorySetupContext; executor: import("@factory/core").AgentExecutor; onEvent?: (text: string) => void }) => Promise<import("@factory/schemas").FactorySetupRecommendation>,
): Promise<import("@factory/schemas").FactorySetupRecommendation> {
  const executor = await createOptionalSetupExecutor(ctx, (text) => panel.appendStream(text));
  if (!executor) {
    const isDestructive = hasExistingSetup && !force;
    const msg = isDestructive
      ? "FACTORY_SETUP_REQUIRES_PI_EXECUTOR: Setup evidence is missing or ambiguous and existing setup is protected. Re-run /factory setup with auth or use --force for destructive reset."
      : "FACTORY_SETUP_REQUIRES_PI_EXECUTOR: Setup evidence is missing or ambiguous. Configure Pi auth and re-run /factory setup, or add commands.setup manually. No fallback recommendation will be used.";
    panel.append(msg);
    throw new Error(msg);
  }
  panel.setStatus("streaming");
  panel.append("Setup evidence is missing or ambiguous; asking the Pi SDK LLM for a recommendation...");
  return recommend({ cwd: ctx.cwd, context, executor, onEvent: (text) => panel.append(text) });
}

async function createOptionalSetupExecutor(
  ctx: FactoryPiCommandContext,
  onEvent?: (executionId: string, event: { type: string; text?: string; data?: Record<string, unknown> }) => void,
): Promise<import("@factory/core").AgentExecutor> {
  const pi = await detectPiModelConfiguration(ctx.cwd);
  if (!pi.hasAuth) {
    throw new Error("FACTORY_SETUP_REQUIRES_PI_EXECUTOR: pi.hasAuth is false — no auth.json or provider mismatch. Configure auth and re-run /factory setup.");
  }
  const piExecutors = await import("@factory/executor-pi");
  const factory = (piExecutors as unknown as { createPiSdkSessionFactory: (opts: unknown) => unknown }).createPiSdkSessionFactory({ packageName: process.env.FACTORY_PI_SDK_PACKAGE });
  const { PiAgentExecutor } = piExecutors as unknown as { PiAgentExecutor: new (opts: unknown) => import("@factory/core").AgentExecutor };
  return new PiAgentExecutor({ sessionFactory: factory, onEvent });
}

async function runLegacySetupFlow(plan: import("@factory/core").FactorySetupPlan, ctx: FactoryPiCommandContext, force: boolean, project: Awaited<ReturnType<typeof discoverFactoryProject>>): Promise<void> {
  renderLines(ctx, [
    "Factory setup",
    `mode: ${plan.mode}`,
    `repository maturity: ${plan.profile.maturity}`,
    `languages: ${plan.profile.languages.join(", ") || "none"}`,
    `package managers: ${plan.profile.packageManagers.join(", ") || "none"}`,
    `frameworks: ${plan.profile.frameworks.join(", ") || "none"}`,
    `monorepo: ${plan.profile.structure.monorepo ? "yes" : "no"}`,
    `CI: ${plan.profile.ci.providers.join(", ") || "none"}`,
    `previous runs: ${plan.profile.factory.runsCount}`,
  ]);
  const answers: Record<string, string> = {};
  if (ctx.ui.select) {
    const choice = await ctx.ui.select("Workflow preset", ["Balanced", "Fast", "Safe"]);
    answers["workflow-preset"] = (choice ?? "Balanced").toLowerCase();
  } else { answers["workflow-preset"] = "balanced"; }
  if (ctx.ui.confirm) {
    const generate = await ctx.ui.confirm("Generate constitution now?", "Create a repository-specific CONSTITUTION.md, or write a minimal stub?");
    answers["constitution"] = generate ? "generate" : "stub";
  } else { answers["constitution"] = "stub"; }
  const finalPlan = await planFactorySetup({ cwd: ctx.cwd, answers, force });
  renderLines(ctx, ["Factory setup plan", ...finalPlan.diffs.map((d) => `  ${d.file.replace(project.paths.gitRoot ?? ctx.cwd, ".")}${d.changes.includes("create file") ? " (+create)" : d.changes.includes("content changes") ? " (~update)" : " (unchanged)"}`)]);
  if (ctx.ui.confirm) { const apply = await ctx.ui.confirm("Apply Factory setup?", "Preview shown above. Write these files?"); if (!apply) { ctx.ui.notify("Factory setup not applied", "info"); return; } }
  const written = await applyFactorySetup(finalPlan);
  if (answers["constitution"] === "generate") { try { renderLines(ctx, ["Factory setup", "phase: constitution-refresh"]); const executor = await createRequiredConstitutionExecutor(); await runConstitutionScan({ cwd: ctx.cwd, constitutionExecutor: executor }); } catch { ctx.ui.notify("Constitution generation failed; stub remains", "warning"); } }
  const loaded = await loadEffectiveConfig({ cwd: ctx.cwd });
  const validation = await validateFactorySetup(ctx.cwd);
  const pi = await detectPiModelConfiguration(ctx.cwd);
  renderLines(ctx, ["Factory setup complete", `mode: ${finalPlan.mode}`, `files written: ${written.length}`, `readiness: ${validation.readiness}`, "", `workflow preset: ${answers["workflow-preset"]}`, `base branch: ${loaded.effectiveConfig.git.baseBranch}`, "", `pi auth configured: ${pi.hasAuth ? "yes" : "no"}`, `pi default model: ${pi.defaultProvider && pi.defaultModel ? `${pi.defaultProvider}/${pi.defaultModel}` : "none"}`, ...(!pi.hasModelSelection ? ["  hint: configure a Pi default model in ~/.pi/agent/settings.json"] : []), ...(!pi.hasAuth ? ["  hint: use /login before generating a constitution or running model-backed flows"] : []),]);
  ctx.ui.notify(`Factory setup complete — ${validation.readiness}`, (validation.readiness === "READY" || validation.readiness === "READY_WITH_WARNINGS") ? "info" : "warning");
}

async function handleStatus(ctx: FactoryPiCommandContext, runId?: string): Promise<void> {
  const project = await discoverFactoryProject(ctx.cwd);
  const loaded = await loadEffectiveConfig({ cwd: ctx.cwd });

  if (runId) {
    const inspected = await inspectFactoryRun(project.paths.runsDir, runId);
    renderLines(ctx, [
      "Factory status",
      `cwd: ${ctx.cwd}`,
      `git root: ${project.paths.gitRoot ?? "(not found)"}`,
      `runs dir: ${project.paths.runsDir}`,
      "",
      `requested run: ${runId}`,
      `run dir: ${inspected.runDir ?? "none"}`,
      `state path: ${inspected.statePath ?? "none"}`,
      `summary path: ${inspected.summaryPath ?? "none"}`,
      `status: ${inspected.state?.status ?? inspected.summary?.status ?? "none"}`,
      `phase: ${inspected.state?.phase ?? inspected.summary?.phase ?? "none"}`,
      `goal: ${inspected.summary?.goal ?? "none"}`,
      `task count: ${inspected.summary?.taskPaths?.length ?? 0}`,
      `verification: ${inspected.summary?.verificationStatus ?? "none"}`,
      `approved: ${typeof inspected.summary?.approved === "boolean" ? (inspected.summary.approved ? "yes" : "no") : "none"}`,
    ]);
    ctx.ui.notify(inspected.runDir ? "Factory run status loaded" : "Factory run not found", inspected.runDir ? "info" : "warning");
    return;
  }

  const latestRun = await readLatestFactoryRunStatus(project.paths.runsDir);
  const latestSummary = await readLatestFactoryRunSummary(project.paths.runsDir);

  renderLines(ctx, [
    "Factory status",
    `cwd: ${ctx.cwd}`,
    `git root: ${project.paths.gitRoot ?? "(not found)"}`,
    `constitution: ${project.paths.constitutionPath ?? "missing"}`,
    `workflow: ${project.paths.workflowPath ?? "missing"}`,
    `project config: ${project.paths.projectConfigPath ?? "missing"}`,
    `runs dir: ${project.paths.runsDir}`,
    "",
    `global config: ${loaded.sources.globalConfigPath}`,
    `effective base branch: ${loaded.effectiveConfig.git.baseBranch}`,
    `effective max parallel agents: ${loaded.effectiveConfig.runtime.maxParallelAgents}`,
    `effective repair attempts: ${loaded.effectiveConfig.repair.maxAttempts}`,
    `effective approval: ${loaded.effectiveConfig.approval.finalMerge}`,
    `workflow: ${loaded.effectiveConfig.resolvedWorkflow?.name ?? "none"}`,
    `workflow id: ${loaded.effectiveConfig.resolvedWorkflowId ?? "none"}`,
    `workflow stages: ${loaded.effectiveConfig.resolvedWorkflow?.stages.map((stage) => stage.name).join(", ") ?? "none"}`,
    "",
    "Latest run",
    `run dir: ${latestRun.runDir ?? "none"}`,
    `run id: ${latestRun.state?.runId ?? latestSummary.summary?.runId ?? "none"}`,
    `status: ${latestRun.state?.status ?? latestSummary.summary?.status ?? "none"}`,
    `phase: ${latestRun.state?.phase ?? latestSummary.summary?.phase ?? "none"}`,
    `updated: ${latestRun.state?.updatedAt ?? "none"}`,
    `summary path: ${latestSummary.summaryPath ?? "none"}`,
    `goal: ${latestSummary.summary?.goal ?? "none"}`,
    `task count: ${latestSummary.summary?.taskPaths?.length ?? 0}`,
    `verification: ${latestSummary.summary?.verificationStatus ?? "none"}`,
    `approved: ${typeof latestSummary.summary?.approved === "boolean" ? (latestSummary.summary.approved ? "yes" : "no") : "none"}`,
  ]);

  ctx.ui.notify("Factory status refreshed", "info");
}

async function handleDoctor(ctx: FactoryPiCommandContext): Promise<void> {
  renderIntro(ctx, [
    "Factory doctor is checking whether this repository is ready for Factory runs.",
    "I’ll verify config, repository files, git/worktree readiness, and model routing against Pi-visible models now.",
  ]);

  const result = await runFactoryDoctor(ctx.cwd);

  renderLines(ctx, doctorWidgetLines(result));

  const hasFailure = result.checks.some((check) => !check.ok);
  ctx.ui.notify(hasFailure ? "Factory doctor found issues" : "Factory doctor passed", hasFailure ? "warning" : "info");
}

async function handleLogs(ctx: FactoryPiCommandContext, runId?: string): Promise<void> {
  renderIntro(ctx, [
    runId
      ? `Factory is loading logs for run ${runId}.`
      : "Factory is loading the latest run logs.",
    "I’ll show the run state, artifact paths, and recent events.",
  ]);

  const project = await discoverFactoryProject(ctx.cwd);
  const logs = runId
    ? await readFactoryRunLogs(project.paths.runsDir, runId, { limit: 12 })
    : await readLatestFactoryRunLogs(project.paths.runsDir, { limit: 12 });

  if (!logs.runDir) {
    renderLines(ctx, [
      "Factory logs",
      runId ? `Run not found: ${runId}` : "No runs found.",
      `runs dir: ${project.paths.runsDir}`,
    ]);
    ctx.ui.notify(runId ? "Factory run not found" : "No Factory runs found", "warning");
    return;
  }

  renderLines(ctx, [
    "Factory logs",
    `run dir: ${logs.runDir}`,
    `state path: ${logs.statePath ?? "none"}`,
    `events path: ${logs.eventsPath ?? "none"}`,
    `plan path: ${logs.planPath ?? "none"}`,
    `verification path: ${logs.verificationPath ?? "none"}`,
    `summary path: ${logs.summaryPath ?? "none"}`,
    `repair executions: ${logs.repairExecutionPaths.length}`,
    `status: ${String(logs.state?.status ?? "none")}`,
    `phase: ${String(logs.state?.phase ?? "none")}`,
    `plan decision: ${logs.planDecision ?? "none"}`,
    `plan feedback: ${logs.planFeedback ?? "none"}`,
    `implementation started: ${typeof logs.implementationStarted === "boolean" ? (logs.implementationStarted ? "yes" : "no") : "unknown"}`,
    ...buildDecisionLines(logs.decisions),
    ...buildGuidanceDiagnosticLines(logs.guidance),
    ...buildVerificationDiagnosticLines(logs.verificationContext, undefined),
    ...buildIntegrationFailureLines(logs.integrationFailure),
    "",
    "Recent events",
    ...logs.events,
  ]);

  ctx.ui.notify("Factory logs refreshed", "info");
}

async function handleList(ctx: FactoryPiCommandContext): Promise<void> {
  renderIntro(ctx, [
    "Factory is listing known runs for this repository.",
    "I’ll show run ids with their status, phase, and goal.",
  ]);

  const project = await discoverFactoryProject(ctx.cwd);
  const runs = await listFactoryRuns(project.paths.runsDir);

  if (runs.length === 0) {
    renderLines(ctx, [
      "Factory list",
      "No runs found.",
      `runs dir: ${project.paths.runsDir}`,
    ]);
    ctx.ui.notify("No Factory runs found", "warning");
    return;
  }

  renderLines(ctx, [
    "Factory list",
    `runs dir: ${project.paths.runsDir}`,
    ...runs.flatMap((run) => [
      "",
      `${run.runId}`,
      `  status: ${run.status ?? "none"}`,
      `  phase: ${run.phase ?? "none"}`,
      `  goal: ${run.goal ?? "none"}`,
      `  updated: ${run.updatedAt ?? "none"}`,
    ]),
  ]);

  ctx.ui.notify("Factory run list refreshed", "info");
}

async function handleShow(runId: string | undefined, ctx: FactoryPiCommandContext): Promise<void> {
  if (!runId) {
    renderLines(ctx, [
      "Factory show",
      "Usage: /factory show <run-id>",
    ]);
    ctx.ui.notify("Provide a run id", "warning");
    return;
  }

  renderIntro(ctx, [
    `Factory is loading the full run view for ${runId}.`,
    "I’ll merge state, summary, plan, verification, and plan feedback into one view.",
  ]);

  const project = await discoverFactoryProject(ctx.cwd);
  const result = await showFactoryRun(project.paths.runsDir, runId);

  if (!result.runDir) {
    renderLines(ctx, [
      "Factory show",
      `Run not found: ${runId}`,
      `runs dir: ${project.paths.runsDir}`,
    ]);
    ctx.ui.notify("Factory run not found", "warning");
    return;
  }

  const taskCount = Array.isArray(result.summary?.taskPaths) ? result.summary.taskPaths.length : 0;
  const workflowStages = Array.isArray(result.plan?.workflowStages)
    ? result.plan.workflowStages
        .map((stage) => (stage && typeof stage === "object" && "name" in stage ? String((stage as { name: unknown }).name) : undefined))
        .filter(Boolean)
        .join(", ")
    : "none";
  const verificationCommands = Array.isArray(result.verification?.commands)
    ? result.verification.commands.length
    : 0;
  const plannerStatus =
    result.plannerExecution && typeof result.plannerExecution.status === "string"
      ? result.plannerExecution.status
      : "none";
  const repairAttempts = Array.isArray(result.repairExecutions) ? result.repairExecutions.length : 0;
  const reviewerStatus =
    result.reviewerExecution && typeof result.reviewerExecution.status === "string"
      ? result.reviewerExecution.status
      : "none";
  const repairStatuses = Array.isArray(result.repairExecutions)
    ? result.repairExecutions
        .map((item) => {
          const attempt = item?.attempt;
          const status = item?.status;
          return typeof attempt === "number" || typeof status === "string"
            ? `${attempt ?? "?"}:${status ?? "unknown"}`
            : undefined;
        })
        .filter(Boolean)
        .join(", ")
    : "none";

  renderLines(ctx, [
    "Factory show",
    `run dir: ${result.runDir}`,
    `run id: ${String(result.state?.runId ?? result.summary?.runId ?? runId)}`,
    `goal: ${String(result.summary?.goal ?? "none")}`,
    `status: ${String(result.state?.status ?? result.summary?.status ?? "none")}`,
    `phase: ${String(result.state?.phase ?? result.summary?.phase ?? "none")}`,
    `approved: ${typeof result.summary?.approved === "boolean" ? (result.summary.approved ? "yes" : "no") : "none"}`,
    `plan decision: ${result.planDecision ?? "none"}`,
    `plan feedback: ${result.planFeedback ?? "none"}`,
    `implementation started: ${typeof result.implementationStarted === "boolean" ? (result.implementationStarted ? "yes" : "no") : "unknown"}`,
    `verification: ${String(result.summary?.verificationStatus ?? result.verification?.overallStatus ?? "none")}`,
    ...buildDecisionLines(result.decisions),
    `task count: ${taskCount}`,
    `workflow stages: ${workflowStages}`,
    `planner execution: ${plannerStatus}`,
    `repair attempts: ${repairAttempts}`,
    `repair statuses: ${repairStatuses || "none"}`,
    `reviewer execution: ${reviewerStatus}`,
    `verification commands: ${verificationCommands}`,
    ...buildGuidanceDiagnosticLines(result.guidance),
    ...buildVerificationDiagnosticLines(result.verificationContext, result.verification),
    ...buildIntegrationFailureLines(result.integrationFailure),
  ]);

  ctx.ui.notify("Factory run loaded", "info");
}

async function handlePlan(ctx: FactoryPiCommandContext): Promise<void> {
  renderIntro(ctx, [
    "Factory is loading the latest run plan.",
    "I’ll show the goal, workflow stages, summary, and planned tasks.",
  ]);

  const project = await discoverFactoryProject(ctx.cwd);
  const result = await readLatestFactoryRunPlan(project.paths.runsDir);

  if (!result.runDir) {
    renderLines(ctx, [
      "Factory plan",
      "No runs found.",
      `runs dir: ${project.paths.runsDir}`,
    ]);
    ctx.ui.notify("No Factory runs found", "warning");
    return;
  }

  if (!result.planPath || !result.tasks) {
    renderLines(ctx, [
      "Factory plan",
      `run id: ${result.runId ?? "none"}`,
      `run dir: ${result.runDir}`,
      `status: ${result.status ?? "none"}`,
      `phase: ${result.phase ?? "none"}`,
      "No plan artifact found for the latest run.",
    ]);
    ctx.ui.notify("Latest Factory run has no plan artifact", "warning");
    return;
  }

  renderLines(ctx, [
    "Factory plan",
    `run id: ${result.runId ?? "none"}`,
    `run dir: ${result.runDir}`,
    `plan path: ${result.planPath}`,
    `goal: ${result.goal ?? "none"}`,
    `status: ${result.status ?? "none"}`,
    `phase: ${result.phase ?? "none"}`,
    `workflow: ${result.workflowStages?.map((stage) => stage.name).join(" -> ") ?? "none"}`,
    `tasks: ${result.tasks.length}`,
    ...(result.planText ? ["", "Feature plan", ...result.planText.split(/\r?\n/).filter(Boolean).slice(0, 20)] : []),
    ...(result.summary ? ["", "Runtime summary", result.summary] : []),
    "",
    "Task list",
    ...result.tasks.slice(0, 12).map((task) => `- ${task.id ?? "?"} [${task.stage ?? "unknown"}] ${task.title ?? "untitled"} (${task.status ?? "unknown"})`),
  ]);

  ctx.ui.notify("Factory plan loaded", "info");
}

async function handleResume(ctx: FactoryPiCommandContext): Promise<void> {
  renderIntro(ctx, [
    "Factory is checking whether the latest run can be resumed safely.",
    "I’ll inspect the run state, recovery signals, and suggested next phase before updating anything.",
  ]);

  const project = await discoverFactoryProject(ctx.cwd);
  const result = await resumeLatestFactoryRun(project.paths.runsDir);

  renderLines(ctx, [
    "Factory resume",
    `resumed: ${result.resumed ? "yes" : "no"}`,
    `reason: ${result.reason}`,
    `run dir: ${result.runDir ?? "none"}`,
    `state path: ${result.statePath ?? "none"}`,
    `events path: ${result.eventsPath ?? "none"}`,
    `status: ${result.state?.status ?? "none"}`,
    `phase: ${result.state?.phase ?? "none"}`,
    `resumable: ${typeof result.recovery?.resumable === "boolean" ? (result.recovery.resumable ? "yes" : "no") : "none"}`,
    `suggested phase: ${result.recovery?.suggestedPhase ?? "none"}`,
    `next status: ${result.recovery?.nextStatus ?? "none"}`,
    `execution cwd: ${result.recovery?.executionCwd ?? "none"}`,
    `candidate sha: ${result.recovery?.candidateSha ?? "none"}`,
    `final merge artifact: ${result.recovery?.finalMergePath ?? "none"}`,
    `resume policy: ${result.recovery?.policyReason ?? "none"}`,
    ...(result.recovery?.checks.map((check) => `  ${check.ok ? "OK" : "WARN"} ${check.name}: ${check.detail}`) ?? []),
  ]);

  ctx.ui.notify(result.resumed ? "Factory run resumed" : "No resumable Factory run", result.resumed ? "info" : "warning");
}

async function handleConstitution(_args: string[], ctx: FactoryPiCommandContext): Promise<void> {
  renderIntro(ctx, [
    "Factory is refreshing the repository constitution now.",
    "I’ll scan observable facts, run the constitution interpreter, and then update CONSTITUTION.md with the latest result.",
  ]);

  renderLines(ctx, [
    "Factory constitution",
    `cwd: ${ctx.cwd}`,
    "phase: constitution-refresh",
    "message: Refreshing repository constitution",
  ]);

  const panel = mountFactoryStreamingWidget(ctx.ui, FACTORY_WIDGET_ID, {
    title: "Factory constitution",
    goal: ctx.cwd,
    phase: "constitution-refresh",
    role: "constitution-interpreter",
    status: "starting",
    lines: ["Refreshing repository constitution"],
    footer: "Live Factory stream. Use arrow keys to scroll.",
  });
  panel.setPhase("constitution-refresh");
  panel.setStatus("running");
  panel.append("Scanning repository facts...");
  const executor = await createRequiredConstitutionExecutor((executionId, event) => {
    panel.setRole(executionId.includes("planner") ? "planner" : "constitution-interpreter");
    panel.setStatus("streaming");
    if (event.text) {
      panel.appendStream(event.text);
    }
  });
  const result = await runConstitutionScan({
    cwd: ctx.cwd,
    constitutionExecutor: executor,
  });
  panel.setStatus("completed");
  panel.append("Constitution refresh completed.");

  renderLines(ctx, [
    "Factory constitution",
    `mode: ${result.mode}`,
    `finalized: ${result.finalized ? "yes" : "no"}`,
    `strategy: ${result.refreshStrategy}`,
    `interpreter: ${result.interpreter.status}`,
    `refresh mode: ${result.refresh.mode}`,
    `no change: ${result.refresh.noChange ? "yes" : "no"}`,
    `root: ${result.root}`,
    `constitution: ${result.constitutionPath}`,
    `facts: ${result.factsPath}`,
    `metadata: ${result.metadataPath}`,
    `languages: ${result.discovery.languages.join(", ") || "none"}`,
    `package managers: ${result.discovery.packageManagers.join(", ") || "none"}`,
    `tracked files: ${result.discovery.trackedFiles.length}`,
    `changed files: ${result.refresh.changedFiles.length}`,
    ...result.refresh.changedFiles.slice(0, 10).map((value) => `  change ${value}`),
    `impacted areas: ${result.refresh.impactedAreaIds.join(", ") || "none"}`,
    `reused areas: ${result.refresh.reusedAreaIds?.join(", ") || "none"}`,
    `areas: ${result.areas.length}`,
    ...(result.interpreter.errorMessage ? [`interpreter error: ${result.interpreter.errorMessage}`] : []),
  ]);

  ctx.ui.notify(result.finalized ? "Factory constitution updated" : "Factory constitution facts captured; interpretation unavailable", result.finalized ? "info" : "warning");
}

async function handleCleanup(retainArg: string | undefined, ctx: FactoryPiCommandContext): Promise<void> {
  renderIntro(ctx, [
    "Factory cleanup is preparing to prune old run state and git isolation artifacts.",
    "I’ll keep the most recent runs and remove older runs, worktrees, and branches according to policy.",
  ]);

  const retainRuns = retainArg ? Number.parseInt(retainArg, 10) : undefined;
  const result = await cleanupFactoryRuns({
    cwd: ctx.cwd,
    retainRuns: Number.isFinite(retainRuns) ? retainRuns : undefined,
  });

  renderLines(ctx, [
    "Factory cleanup",
    `runs dir: ${result.runsDir}`,
    `retain runs: ${result.retainRuns}`,
    `kept runs: ${result.keptRunIds.length}`,
    ...result.keptRunIds.map((runId) => `  keep ${runId}`),
    `removed runs: ${result.removedRunIds.length}`,
    ...result.removedRunIds.map((runId) => `  drop ${runId}`),
    `removed worktrees: ${result.removedWorktrees.length}`,
    ...result.removedWorktrees.map((value) => `  wt ${value}`),
    `removed branches: ${result.removedBranches.length}`,
    ...result.removedBranches.map((value) => `  br ${value}`),
    `warnings: ${result.warnings.length}`,
    ...result.warnings.map((value) => `  warn ${value}`),
  ]);

  ctx.ui.notify(
    result.warnings.length > 0 ? "Factory cleanup completed with warnings" : "Factory cleanup completed",
    result.warnings.length > 0 ? "warning" : "info",
  );
}

async function handleCancel(ctx: FactoryPiCommandContext): Promise<void> {
  renderIntro(ctx, [
    "Factory is checking whether the latest run can be cancelled.",
    "I’ll mark the run cancelled if it is still in a cancellable state.",
  ]);

  const project = await discoverFactoryProject(ctx.cwd);
  const result = await cancelLatestFactoryRun(project.paths.runsDir);

  renderLines(ctx, [
    "Factory cancel",
    `cancelled: ${result.cancelled ? "yes" : "no"}`,
    `reason: ${result.reason}`,
    `run dir: ${result.runDir ?? "none"}`,
    `state path: ${result.statePath ?? "none"}`,
    `events path: ${result.eventsPath ?? "none"}`,
    `status: ${result.state?.status ?? "none"}`,
    `phase: ${result.state?.phase ?? "none"}`,
  ]);

  ctx.ui.notify(result.cancelled ? "Factory run cancelled" : "No cancellable Factory run", result.cancelled ? "info" : "warning");
}

async function handleWorktree(branchName: string | undefined, ctx: FactoryPiCommandContext): Promise<void> {
  if (!branchName) {
    renderLines(ctx, [
      "Factory worktree",
      "Usage: /factory worktree <branch>",
    ]);
    ctx.ui.notify("Provide a branch name", "warning");
    return;
  }

  renderIntro(ctx, [
    `Factory is preparing a git worktree for branch ${branchName}.`,
    "I’ll inspect the current checkout, resolve the preferred worktree location, and create or reuse isolation as needed.",
  ]);

  const isolation = await inspectGitIsolation(ctx.cwd);
  const loaded = await loadEffectiveConfig({ cwd: ctx.cwd });
  const result = await createGitWorktree({
    cwd: ctx.cwd,
    branchName,
    baseBranch: loaded.effectiveConfig.git.baseBranch,
    preferredLocation: loaded.effectiveConfig.git.worktreeDir,
  });

  renderLines(ctx, [
    "Factory worktree",
    `mode: ${result.mode}`,
    `path: ${result.path}`,
    `branch: ${result.branch ?? branchName}`,
    `reason: ${result.reason ?? "none"}`,
    `current isolation: ${isolation.isLinkedWorktree ? "linked worktree" : isolation.isSubmodule ? "submodule checkout" : "standard checkout"}`,
  ]);

  ctx.ui.notify(result.mode === "created" ? "Factory worktree created" : "Factory worktree inspected", "info");
}

async function handleCapabilities(rest: string[], ctx: FactoryPiCommandContext): Promise<void> {
  const action = rest[0] ?? "list";
  const arg = rest[1];

  renderIntro(ctx, [
    "Factory capabilities.",
    "I’ll inspect registered capabilities, validate custom definitions, and report executability.",
  ]);

  const project = await discoverFactoryProject(ctx.cwd).catch(() => undefined);
  const report = await initializeCapabilitySystem(project?.paths.gitRoot ?? ctx.cwd);

  if (action === "list") {
    const capabilities = listRegisteredCapabilities();
    renderLines(ctx, [
      "Factory capabilities",
      `registered: ${capabilities.length}`,
      `custom discovered: ${report.registered.length}`,
      `skipped: ${report.skipped.length}`,
      `collisions: ${report.collisions.length}`,
      "",
      ...capabilities.map((capability) => {
        const source = capability.source === "BUILTIN" ? "built-in" : capability.source.toLowerCase();
        return `- ${capability.id} [${capability.effect}] (${source})`;
      }),
    ]);
    ctx.ui.notify(`Factory has ${capabilities.length} registered capability(ies)`, "info");
    return;
  }

  if (action === "show") {
    if (!arg) {
      ctx.ui.notify("Provide a capability id to show", "warning");
      return;
    }
    const capability = getRegisteredCapability(arg);
    if (!capability) {
      ctx.ui.notify(`No registered capability '${arg}'`, "error");
      return;
    }
    const executability = checkExecutability({ capabilityId: arg });
    renderLines(ctx, [
      `Factory capability: ${capability.id}`,
      `description: ${capability.description}`,
      `effect: ${capability.effect}`,
      `source: ${capability.source}`,
      capability.filePath ? `file: ${capability.filePath}` : "file: built-in",
      capability.input ? `input: ${JSON.stringify(capability.input)}` : "input: none",
      capability.output ? `output: ${JSON.stringify(capability.output)}` : "output: none",
      "",
      `executability: ${executability.status}`,
      `reason: ${executability.reason}`,
    ]);
    return;
  }

  if (action === "validate") {
    const projectDir = project ? `${project.paths.gitRoot ?? ctx.cwd}/.factory/capabilities` : "(no project)";
    renderLines(ctx, [
      "Factory capability validation",
      `scanning: ${projectDir}`,
      `custom registered: ${report.registered.length}`,
      "",
      ...report.skipped.map((item) => `invalid: ${item.id ?? "(unnamed)"} (${item.filePath})\n  ${item.errors.join("; ")}`),
      ...report.collisions.map((item) => `collision: ${item.id} — ${item.reason}`),
      report.skipped.length === 0 && report.collisions.length === 0 ? "All custom capabilities are valid." : "",
    ]);
    ctx.ui.notify(report.skipped.length === 0 ? "Capabilities valid" : "Some capabilities failed validation", report.skipped.length === 0 ? "info" : "warning");
    return;
  }

  ctx.ui.notify("Unknown capabilities action. Use list|show|validate", "warning");
}

async function handleModels(rest: string[], ctx: FactoryPiCommandContext): Promise<void> {
  renderIntro(ctx, [
    "Factory model routing.",
    "I’ll show the effective model per role and per user-defined task type, and flag any routing holes.",
  ]);

  const loaded = await loadEffectiveConfig({ cwd: ctx.cwd });
  const taskTypes = loaded.effectiveConfig.taskTypes ?? {};
  const roles = ["discovery", "planner", "builder", "reviewer", "repair"] as const;

  const lines: string[] = ["Factory model routing", ""];
  lines.push("Role defaults");
  for (const role of roles) {
    const model = loaded.effectiveConfig.models[role];
    lines.push(`  ${role}: ${model?.model ?? "MISSING ⚠"}${model?.provider ? ` (${model.provider})` : ""}`);
  }

  lines.push("");
  lines.push("Task types");
  const typeIds = Object.keys(taskTypes);
  if (typeIds.length === 0) {
    lines.push("  (none configured — goals classify to 'general')");
  }
  for (const typeId of typeIds) {
    lines.push(`  ${typeId}`);
    for (const role of roles) {
      try {
        const resolved = resolveModelForRole({ role, taskType: typeId, config: loaded.effectiveConfig });
        lines.push(`    ${role}: ${resolved.model.model} (${resolved.source})`);
      } catch {
        lines.push(`    ${role}: MISSING ⚠`);
      }
    }
  }

  const classifier = classifyTaskType("docs", loaded.effectiveConfig);
  lines.push("");
  lines.push(`Example classifier (goal 'docs'): ${classifier.id} (${classifier.source})`);

  renderLines(ctx, lines);
  ctx.ui.notify("Factory model routing shown", "info");
}

async function handlePrototypeGoal(rawGoal: string, ctx: FactoryPiCommandContext): Promise<void> {
  const parsed = parseGoalRequest(rawGoal);
  const trimmedGoal = parsed.goal.trim();
  if (!trimmedGoal) {
    renderLines(ctx, [
      "Factory",
      "",
      "Usage:",
      "/factory setup",
      "/factory status",
      "/factory doctor",
      "/factory logs",
      "/factory list",
      "/factory show <run-id>",
      "/factory resume",
      "/factory cancel",
      "/factory worktree <branch>",
      "/factory <goal>",
    ]);
    ctx.ui.notify("Provide a Factory goal", "warning");
    return;
  }

  renderLines(ctx, [
    "Factory run starting",
    `goal: ${trimmedGoal}`,
    "phase: planning",
  ]);

  const progressLines = [
    "Factory run starting",
    `goal: ${trimmedGoal}`,
  ];
  const loadedConfig = await loadEffectiveConfig({ cwd: ctx.cwd });
  const constitutionEnabled = loadedConfig.effectiveConfig.constitution.enabled;

  const effectiveExecutorMode = await resolveExecutorMode(parsed.executorMode, ctx.cwd);
  if (parsed.executorMode !== effectiveExecutorMode) {
    ctx.ui.notify(
      effectiveExecutorMode === "sdk"
        ? "Factory is using the Pi SDK executor by default"
        : "Factory is running without an AI executor",
      effectiveExecutorMode === "sdk" ? "info" : "warning",
    );
  }

  const panel = mountFactoryStreamingWidget(ctx.ui, FACTORY_WIDGET_ID, {
    title: "Factory run",
    goal: trimmedGoal,
    phase: constitutionEnabled ? "constitution-preflight" : "planning",
    role: constitutionEnabled ? "constitution-preflight" : undefined,
    status: "starting",
    lines: [constitutionEnabled ? "Checking whether repository memory needs a refresh..." : "Constitution is disabled; preparing Factory runtime..."],
    footer: "Live Factory stream. Use arrow keys to scroll.",
  });

  let constitutionSummary: {
    mode: string;
    finalized: boolean;
    refreshStrategy: string;
    refresh: { mode: string; changedFiles: string[] };
  };

  if (!constitutionEnabled) {
    constitutionSummary = {
      mode: "disabled",
      finalized: false,
      refreshStrategy: "disabled-by-config",
      refresh: { mode: "DISABLED", changedFiles: [] },
    };
  } else {
    panel.setPhase("constitution-preflight");
    panel.setStatus("running");
    panel.append("Asking the model whether this task needs a constitution scan...");

    const constitutionExecutor = await createRequiredConstitutionExecutor((executionId, event) => {
      panel.setRole(executionId.includes("preflight") ? "constitution-preflight" : executionId.includes("planner") ? "planner" : "constitution-interpreter");
      panel.setStatus("streaming");
      if (event.text) {
        panel.appendStream(event.text);
      }
    });

    const constitutionPreflight = await judgeConstitutionRefreshForTask({
      cwd: ctx.cwd,
      goal: trimmedGoal,
      executor: constitutionExecutor,
    });
    panel.append("Checking what changed...");
    panel.append(`Found ${constitutionPreflight.changedFiles.length} changed file(s).`);
    panel.append(`Impacted constitution areas: ${constitutionPreflight.impactedAreaIds.join(", ") || "none"}.`);
    panel.append(`Existing constitution: ${constitutionPreflight.finalizedConstitution ? "finalized and reusable" : "not finalized yet"}.`);
    panel.append(`Model judgment: ${constitutionPreflight.decision}`);
    panel.append(`Why: ${constitutionPreflight.reason}`);

    if (constitutionPreflight.decision === "skip") {
      panel.setStatus("completed");
      panel.append("Next: reuse existing constitution and go straight to planning.");
      constitutionSummary = {
        mode: "preflight",
        finalized: constitutionPreflight.finalizedConstitution,
        refreshStrategy: "skipped-by-preflight",
        refresh: { mode: "FAST", changedFiles: constitutionPreflight.changedFiles },
      };
    } else {
      panel.setPhase("constitution-refresh");
      panel.setRole("constitution-interpreter");
      panel.setStatus("running");
      panel.append(
        constitutionPreflight.decision === "targeted"
          ? `Next: refresh only impacted areas (${constitutionPreflight.impactedAreaIds.join(", ") || "none"}).`
          : "Next: run a full constitution refresh because broader repo context may matter.",
      );
      const constitutionResult = await runConstitutionScan({
        cwd: ctx.cwd,
        constitutionExecutor,
      });
      panel.setStatus("completed");
      panel.append("Constitution refresh completed.");
      panel.append(`Constitution strategy: ${constitutionResult.refreshStrategy}`);
      panel.append(`Changed files: ${constitutionResult.refresh.changedFiles.length}`);
      panel.append(`Reused areas: ${constitutionResult.refresh.reusedAreaIds?.length ?? 0}`);
      constitutionSummary = constitutionResult;
    }
  }
  panel.setPhase("planning");
  panel.setRole(effectiveExecutorMode && effectiveExecutorMode !== "off" ? "planner" : undefined);
  panel.setStatus("starting");
  panel.append("Preparing Factory runtime...");
  panel.setFooter("Live Factory stream. Use arrow keys to scroll.");

  const executorBundle = await createOptionalExecutorBundle(effectiveExecutorMode, (executionId, event) => {

    panel.setStatus("streaming");
    if (executionId.includes("discovery")) {
      panel.setRole("discovery");
    } else if (executionId.includes("planner")) {
      panel.setRole("planner");
    } else if (executionId.includes("builder")) {
      panel.setRole("builder");
    } else if (executionId.includes("repair")) {
      panel.setRole("repair");
    } else if (executionId.includes("reviewer")) {
      panel.setRole("reviewer");
    }
    if (event.text) {
      panel.appendStream(event.text);
    }
  }, ctx);

  const result = await runPrototypeFactoryFlow({
    cwd: ctx.cwd,
    goal: trimmedGoal,
    workflowId: parsed.workflowId,
    taskType: parsed.taskType,
    branchName: `factory-${trimmedGoal.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "run"}`,
    discoveryExecutor: executorBundle?.discoveryExecutor,
    plannerExecutor: executorBundle?.plannerExecutor,
    builderExecutor: executorBundle?.builderExecutor,
    repairExecutor: executorBundle?.repairExecutor,
    reviewerExecutor: executorBundle?.reviewerExecutor,
    verificationPlannerExecutor: executorBundle?.verificationPlannerExecutor,
    onProgress: async (event) => {
      panel.setPhase(event.phase);
      panel.setStatus(event.status.toLowerCase());
      panel.append(`${event.phase}: ${event.message}`);
    },
    requestPlanApproval: async ({ runId, goal, planPath, taskCount, workflowStages, summary, discoveryText, planText, tasks }) => {
      const preview = { runId, goal, planPath, taskCount, workflowStages, summary, discoveryText, planText, tasks };
      panel.setPhase("plan-approval");
      panel.setStatus("waiting-for-approval");
      panel.setLines(buildPlanApprovalPreviewLines(preview));
      const decision = await requestPlanApprovalDecision(ctx.ui, preview);
      ctx.ui.notify(
        decision.decision === "approve"
          ? "Factory plan approved"
          : decision.decision === "revise"
            ? "Factory plan revisions requested"
            : "Factory plan rejected",
        decision.decision === "approve" ? "info" : "warning",
      );
      return decision;
    },
    requestApproval: async ({ runId, goal, baselineDebt, contractComplete, verificationStatus }) => {
      // Surface baseline repository debt before asking for final approval.
      const debtLines = (baselineDebt ?? []).map((debt) => [
        `  failed command: ${debt.commandName}`,
        `  classification: ${debt.category}`,
        `  reason: ${debt.reason}`,
        `  action: ${debt.suggestedAction}`,
        ...(debt.implicatedFiles?.length ? [`  implicated files: ${debt.implicatedFiles.join(", ")}`] : []),
      ].join("\n"));
      if (debtLines.length > 0) {
        renderLines(ctx, [
          "Factory approval — baseline repository debt",
          "Task-specific contract passed, but the following pre-existing failures remain:",
          "",
          ...debtLines,
          "",
          `verification: ${verificationStatus ?? "unknown"} | contract complete: ${contractComplete ? "yes" : "no"}`,
          "Approving proceeds with these baseline issues still present.",
        ]);
      }
      if (!ctx.ui.confirm) {
        return true;
      }
      return ctx.ui.confirm(
        debtLines.length > 0 ? "Approve candidate despite baseline debt?" : "Approve Factory candidate?",
        `Approve prototype run ${runId} for goal: ${goal}${debtLines.length > 0 ? "\n\nBaseline debt shown above is NOT resolved by this run." : ""}`,
      );
    },
    requestDependencyRemediation: async (candidate) => {
      if (!ctx.ui.confirm) return false;
      return ctx.ui.confirm(
        "Fix dependency setup for this run?",
        `${candidate.reason}\n\nOriginal: ${candidate.originalCommand}\nTemporary: ${candidate.remediatedCommand}\n\nProject config will not be changed.`,
      );
    },
    requestDecision: async (request) => requestDecisionInput(ctx.ui, request),
  });

  const latestShown = await showFactoryRun(path.join((await discoverFactoryProject(ctx.cwd)).paths.runsDir), result.runId);
  const finalState = await readFactoryRunStateForSummary(result.statePath);
  const finalStatus = finalState?.status ?? (result.approved ? "COMPLETED" : "FAILED");
  const finalPhase = finalState?.phase ?? "unknown";
  const finalTitle = buildFactoryRunResultTitle(finalStatus, finalPhase);
  const finalTone = finalStatus === "COMPLETED" ? "info" : finalStatus === "CANCELLED" ? "warning" : "error";

  renderLines(ctx, [
    finalTitle,
    `goal: ${trimmedGoal}`,
    `status: ${finalStatus}`,
    `phase: ${finalPhase}`,
    `executor mode: ${effectiveExecutorMode ?? "off"}`,
    `constitution mode: ${constitutionSummary.mode}`,
    `constitution finalized: ${constitutionSummary.finalized ? "yes" : "no"}`,
    `constitution strategy: ${constitutionSummary.refreshStrategy}`,
    `constitution refresh: ${constitutionSummary.refresh.mode}`,
    `constitution changed files: ${constitutionSummary.refresh.changedFiles.length}`,
    `run id: ${result.runId}`,
    `run dir: ${result.runDir}`,
    `execution cwd: ${result.executionCwd}`,
    `worktree mode: ${result.worktree?.mode ?? "none"}`,
    `worktree path: ${result.worktree?.path ?? "none"}`,
    `state path: ${result.statePath}`,
    `events path: ${result.eventsPath}`,
    `plan path: ${result.planPath}`,
    `task artifacts: ${result.taskPaths.length}`,
    `planner execution path: ${result.plannerExecutionPath ?? "none"}`,
    `verification path: ${result.verificationPath}`,
    `summary path: ${result.summaryPath}`,
    `approved: ${result.approved ? "yes" : "no"}`,
    `phases: ${result.phases.join(" -> ")}`,
    ...(latestShown.integrationFailure
      ? [
          `integration failure: ${latestShown.integrationFailure.reason ?? "unknown"}`,
          `integration conflicts: ${latestShown.integrationFailure.conflictingFiles.join(", ") || "none"}`,
          `merge in progress: ${latestShown.integrationFailure.mergeInProgress ? "yes" : "no"}`,
        ]
      : []),
  ]);

  ctx.ui.notify(finalTitle, finalTone);
}

async function readFactoryRunStateForSummary(statePath: string): Promise<{ status?: string; phase?: string } | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, "utf8")) as { status?: string; phase?: string };
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function buildFactoryRunResultTitle(status: string, phase: string): string {
  if (status === "COMPLETED") {
    return "Factory prototype run complete";
  }
  if (status === "CANCELLED") {
    return "Factory prototype run cancelled";
  }
  if (phase === "implementation-failed") {
    return "Factory prototype run failed during implementation";
  }
  if (phase === "verification-failed") {
    return "Factory prototype run failed during verification";
  }
  if (phase === "discovery-failed") {
    return "Factory prototype run failed during discovery";
  }
  if (phase === "planning-failed") {
    return "Factory prototype run failed during planning";
  }
  return "Factory prototype run failed";
}

async function handleFactoryCommandError(error: unknown, ctx: FactoryPiCommandContext): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);

  if (isGitMergeConflictError(message)) {
    const merge = await loadLatestMergeConflictContext(ctx.cwd);

    renderLines(ctx, [
      "Factory merge conflict",
      `run id: ${merge?.runId ?? "unknown"}`,
      `run dir: ${merge?.runDir ?? "unknown"}`,
      `merge cwd: ${merge?.mergeCwd ?? "unknown"}`,
      "",
      "Factory hit a git merge conflict.",
      "Choose whether to auto fix with AI or stop.",
    ]);

    const choice = ctx.ui.select
      ? await ctx.ui.select("Factory merge conflict", [
          "Auto fix — use AI to resolve the merge conflict",
          "Stop — leave the run halted",
        ])
      : undefined;

    if (choice?.startsWith("Auto fix")) {
      await autoFixLatestMergeConflict(ctx, merge);
      return;
    }

    ctx.ui.notify("Factory run stopped because of a git merge conflict.", "error");
    return;
  }

  renderLines(ctx, [
    "Factory error",
    message,
  ]);
  ctx.ui.notify(message, "error");
}

interface LatestMergeConflictContext {
  runId?: string;
  runDir?: string;
  mergeCwd?: string;
  baseBranch?: string;
  candidateBranch?: string;
}

async function loadLatestMergeConflictContext(cwd: string): Promise<LatestMergeConflictContext | undefined> {
  const project = await discoverFactoryProject(cwd).catch(() => undefined);
  const latest = project ? await readLatestFactoryRunStatus(project.paths.runsDir).catch(() => undefined) : undefined;
  const runDir = latest?.runDir;
  if (!runDir) {
    return undefined;
  }

  let mergeCwd: string | undefined;
  let baseBranch: string | undefined;
  let candidateBranch: string | undefined;

  try {
    const raw = await fs.readFile(path.join(runDir, "final-merge.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      mergeCwd?: string;
      mergeBaseBranch?: string;
      candidateBranch?: string;
    };
    mergeCwd = parsed.mergeCwd;
    baseBranch = parsed.mergeBaseBranch;
    candidateBranch = parsed.candidateBranch;
  } catch {}

  if (!mergeCwd) {
    try {
      const raw = await fs.readFile(path.join(runDir, "integration.json"), "utf8");
      const parsed = JSON.parse(raw) as {
        executionCwd?: string;
      };
      mergeCwd = parsed.executionCwd;
    } catch {}
  }

  const candidates = [mergeCwd, cwd].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    const status = await readMergeConflictStatus(candidate).catch(() => undefined);
    if (status?.hasConflicts || status?.mergeInProgress) {
      mergeCwd = candidate;
      break;
    }
  }

  return {
    runId: latest?.state?.runId,
    runDir,
    mergeCwd,
    baseBranch,
    candidateBranch,
  };
}

async function autoFixLatestMergeConflict(
  ctx: FactoryPiCommandContext,
  merge: LatestMergeConflictContext | undefined,
): Promise<void> {
  if (!merge?.mergeCwd) {
    renderLines(ctx, [
      "Factory merge conflict",
      "Auto fix is unavailable because the merge workspace could not be located.",
    ]);
    ctx.ui.notify("Factory could not locate the merge workspace for auto fix.", "error");
    return;
  }

  renderLines(ctx, [
    "Factory auto-fix",
    `run id: ${merge.runId ?? "unknown"}`,
    `merge cwd: ${merge.mergeCwd}`,
    "phase: conflict-resolution",
    "status: starting",
  ]);

  const preStatus = await readMergeConflictStatus(merge.mergeCwd).catch(() => ({ hasConflicts: false, mergeInProgress: false }));
  if (!preStatus.hasConflicts && !preStatus.mergeInProgress) {
    renderLines(ctx, [
      "Factory merge conflict",
      `merge cwd: ${merge.mergeCwd}`,
      "Auto fix is unavailable because no in-progress merge was found there.",
    ]);
    ctx.ui.notify("Factory could not find an in-progress merge for auto fix.", "error");
    return;
  }

  const executor = await createRequiredConstitutionExecutor();
  const prompt = [
    "A git merge is in progress and has conflicts.",
    "Resolve the merge conflict in this repository safely.",
    "Instructions:",
    "1. Inspect the repo state with git status and identify all conflicted files.",
    "2. Resolve the conflicts using the available tools.",
    "3. Stage the resolved files.",
    "4. If the merge is ready to complete, finish it with a normal merge commit.",
    "5. Do not discard user changes and do not run git merge --abort unless absolutely necessary.",
    "6. At the end, leave a short summary of what was resolved.",
  ].join("\n");

  const execution = await executor.execute({
    executionId: `merge-fix-${merge.runId ?? Date.now()}`,
    cwd: merge.mergeCwd,
    prompt,
    tools: ["read", "write", "edit", "bash"],
    metadata: {
      purpose: "factory-merge-conflict-auto-fix",
      runId: merge.runId,
      candidateBranch: merge.candidateBranch,
      baseBranch: merge.baseBranch,
    },
  });

  await finalizeMergeIfReady(merge.mergeCwd);
  const status = await readMergeConflictStatus(merge.mergeCwd);

  renderLines(ctx, [
    status.hasConflicts ? "Factory auto-fix incomplete" : "Factory auto-fix complete",
    `run id: ${merge.runId ?? "unknown"}`,
    `merge cwd: ${merge.mergeCwd}`,
    `executor status: ${execution.status}`,
    `conflicts remaining: ${status.hasConflicts ? "yes" : "no"}`,
    `merge in progress: ${status.mergeInProgress ? "yes" : "no"}`,
    ...(execution.outputText ? ["", ...execution.outputText.split(/\r?\n/).filter(Boolean).slice(-8)] : []),
  ]);

  if (status.hasConflicts || execution.status !== "completed") {
    ctx.ui.notify("Factory could not fully auto-fix the merge conflict. Review git status.", "warning");
    return;
  }

  await continueLatestRunAfterAutoFix(ctx, merge, status);
}

async function finalizeMergeIfReady(cwd: string): Promise<void> {
  const status = await readMergeConflictStatus(cwd);
  if (status.hasConflicts || !status.mergeInProgress) {
    return;
  }

  try {
    await execFileAsync("git", ["commit", "--no-edit"], { cwd, windowsHide: true });
  } catch {
    // Leave the repo as-is if git still refuses to complete the merge.
  }
}

async function continueLatestRunAfterAutoFix(
  ctx: FactoryPiCommandContext,
  merge: LatestMergeConflictContext,
  status: { hasConflicts: boolean; mergeInProgress: boolean },
): Promise<void> {
  const project = await discoverFactoryProject(ctx.cwd).catch(() => undefined);
  const latest = project ? await readLatestFactoryRunStatus(project.paths.runsDir).catch(() => undefined) : undefined;

  if (!project || !latest?.statePath || !latest?.state) {
    ctx.ui.notify("Factory auto-fixed the merge conflict.", "info");
    return;
  }

  const eventsPath = path.join(latest.runDir ?? "", "events.jsonl");
  await appendFactoryRunEvent(eventsPath, {
    timestamp: new Date().toISOString(),
    type: "merge.auto_fix_completed",
    data: {
      runId: latest.state.runId,
      mergeCwd: merge.mergeCwd,
      conflictsRemaining: status.hasConflicts,
      mergeInProgress: status.mergeInProgress,
    },
  }).catch(() => undefined);

  if (latest.state.phase?.includes("merge") && !status.hasConflicts && !status.mergeInProgress) {
    await updateFactoryRunState({
      statePath: latest.statePath,
      patch: { status: "COMPLETED", phase: "complete" },
    });
    await appendFactoryRunEvent(eventsPath, {
      timestamp: new Date().toISOString(),
      type: "run.completed",
      data: {
        goal: "Auto-completed after AI merge conflict fix",
        autoFixed: true,
      },
    }).catch(() => undefined);

    renderLines(ctx, [
      "Factory auto-fix complete",
      `run id: ${latest.state.runId ?? merge.runId ?? "unknown"}`,
      `merge cwd: ${merge.mergeCwd ?? "unknown"}`,
      "run status: completed",
      "continue action: final merge finished automatically",
    ]);
    ctx.ui.notify("Factory auto-fixed the conflict and completed the run.", "info");
    return;
  }

  const resumed = await resumeLatestFactoryRun(project.paths.runsDir).catch(() => undefined);
  renderLines(ctx, [
    "Factory auto-fix complete",
    `run id: ${latest.state.runId ?? merge.runId ?? "unknown"}`,
    `merge cwd: ${merge.mergeCwd ?? "unknown"}`,
    `run status: ${resumed?.state?.status ?? latest.state.status ?? "unknown"}`,
    `next phase: ${resumed?.state?.phase ?? latest.state.phase ?? "unknown"}`,
    `continue action: ${resumed?.resumed ? "run resumed" : "manual follow-up may still be needed"}`,
  ]);
  ctx.ui.notify(
    resumed?.resumed
      ? "Factory auto-fixed the conflict and resumed the latest run state."
      : "Factory auto-fixed the conflict.",
    resumed?.resumed ? "info" : "warning",
  );
}

async function readMergeConflictStatus(cwd: string): Promise<{ hasConflicts: boolean; mergeInProgress: boolean }> {
  let hasConflicts = false;
  let mergeInProgress = false;

  try {
    const { stdout } = await execFileAsync("git", ["diff", "--name-only", "--diff-filter=U"], { cwd, windowsHide: true });
    hasConflicts = stdout.trim().length > 0;
  } catch {
    hasConflicts = true;
  }

  try {
    await execFileAsync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd, windowsHide: true });
    mergeInProgress = true;
  } catch {
    mergeInProgress = false;
  }

  return { hasConflicts, mergeInProgress };
}

function isGitMergeConflictError(message: string): boolean {
  return /git merge/i.test(message) && /(unmerged files|resolve.*conflict|unresolved conflict|Automatic merge failed)/i.test(message);
}

async function handleDashboard(rest: string[], ctx: FactoryPiCommandContext): Promise<void> {
  const action = (rest[0] ?? "status").toLowerCase();
  // parse --port/--host flags from rest
  let port: number | undefined;
  let host: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--port" && rest[i + 1]) port = Number.parseInt(rest[i + 1]!, 10);
    else if (rest[i]?.startsWith("--port=")) port = Number.parseInt(rest[i]!.slice("--port=".length), 10);
    else if (rest[i] === "--host" && rest[i + 1]) host = rest[i + 1];
    else if (rest[i]?.startsWith("--host=")) host = rest[i]!.slice("--host=".length);
  }
  const loaded = await loadEffectiveConfig({ cwd: ctx.cwd }).catch(() => undefined);
  const effectivePort = port ?? loaded?.effectiveConfig.dashboard.port;
  const effectiveHost = host ?? loaded?.effectiveConfig.dashboard.host ?? "127.0.0.1";
  const web = await loadDashboardWeb().catch(() => undefined);
  if (!web) {
    renderLines(ctx, ["Factory dashboard", "Dashboard adapter not available. Run npm run build."]);
    ctx.ui.notify("Dashboard not available", "warning");
    return;
  }
  const { getDashboardUrl, getDashboardServer, ensureDashboardServer, stopDashboardServer, resolveDashboardDist } = web as unknown as {
    getDashboardUrl: () => string | undefined;
    getDashboardServer: () => { port: number } | undefined;
    ensureDashboardServer: (o: { cwd: string; port?: number; host?: string; staticDir?: string }) => Promise<{ url: string; reused: boolean }>;
    stopDashboardServer: () => Promise<boolean>;
    resolveDashboardDist: (cwd: string) => string | undefined;
  };
  const dist = resolveDashboardDist(ctx.cwd);
  if (action === "start" || action === "up" || action === "" || action === "status") {
    if (action === "start" || action === "up") {
      try {
        const { url, reused } = await ensureDashboardServer({ cwd: ctx.cwd, port: effectivePort, host: effectiveHost, staticDir: dist });
        renderLines(ctx, [
          "Factory dashboard",
          `${reused ? "reused" : "started"}: ${url}`,
          `host: ${effectiveHost}`,
          `port: ${String(effectivePort ?? getDashboardServer()?.port ?? "?")}`,
          `static: ${dist ?? "(not built — run npm run dashboard:build)"}`,
          `config enabled: ${loaded?.effectiveConfig.dashboard.enabled ? "yes" : "no"} (set dashboard.enabled: true to auto-start on next pi)`,
        ]);
        ctx.ui.notify(`Dashboard ${reused ? "running" : "started"} at ${url}`, "info");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/EADDRINUSE/.test(msg)) {
          const existing = getDashboardUrl();
          renderLines(ctx, ["Factory dashboard", `port in use: ${effectivePort}`, existing ? `existing: ${existing}` : "try /factory dashboard stop then start"]);
          ctx.ui.notify("Dashboard port in use", "warning");
        } else throw e;
      }
      return;
    }
    const url = getDashboardUrl();
    const server = getDashboardServer();
    renderLines(ctx, [
      "Factory dashboard",
      url ? `running: ${url}` : "not running (use /factory dashboard start)",
      `configured: ${effectiveHost}:${String(effectivePort ?? 4199)}`,
      `auto-start: ${loaded?.effectiveConfig.dashboard.enabled ? "enabled" : "disabled"} (dashboard.enabled)` + (loaded?.effectiveConfig.dashboard.autoOpen ? " + autoOpen" : ""),
      `static: ${dist ?? "not built — run npm run dashboard:build"}`,
      "",
      "Commands: /factory dashboard start [--port N] [--host H] | stop | status | open",
    ]);
    ctx.ui.notify(url ? `Dashboard at ${url}` : "Dashboard not running", url ? "info" : "warning");
    return;
  }
  if (action === "stop" || action === "down") {
    const stopped = await stopDashboardServer();
    renderLines(ctx, ["Factory dashboard", stopped ? "stopped" : "not running"]);
    ctx.ui.notify(stopped ? "Dashboard stopped" : "Dashboard not running", stopped ? "info" : "warning");
    return;
  }
  if (action === "open") {
    let url = getDashboardUrl();
    if (!url) {
      const started = await ensureDashboardServer({ cwd: ctx.cwd, port: effectivePort, host: effectiveHost, staticDir: dist });
      url = started.url;
    }
    renderLines(ctx, ["Factory dashboard", `open: ${url}`]);
    // Try to open browser; do not fail if unavailable (headless)
    try {
      const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
      const args = process.platform === "win32" ? ["/c", "start", url] : [url];
      await execFileAsync(openCmd, args, { windowsHide: true }).catch(() => undefined);
    } catch {}
    ctx.ui.notify(`Dashboard: ${url}`, "info");
    return;
  }
  renderLines(ctx, ["Factory dashboard", "Usage: /factory dashboard [status|start|stop|open] [--port N] [--host H]"]);
  ctx.ui.notify("Unknown dashboard action", "warning");
}

async function loadDashboardWeb(): Promise<unknown> {
  try {
    return await import("@factory/adapter-web");
  } catch {}
  return undefined;
}


function parseGoalRequest(raw: string): {
  goal: string;
  executorMode?: "fake" | "sdk" | "off";
  workflowId?: string;
  taskType?: string;
} {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  const remaining: string[] = [];
  let executorMode: "fake" | "sdk" | "off" | undefined;
  let workflowId: string | undefined;
  let taskType: string | undefined;

  for (const part of parts) {
    if (part === "--executor=fake") {
      executorMode = "fake";
      continue;
    }
    if (part === "--executor=sdk") {
      executorMode = "sdk";
      continue;
    }
    if (part === "--executor=off") {
      executorMode = "off";
      continue;
    }
    if (part.startsWith("--workflow=")) {
      workflowId = part.slice("--workflow=".length);
      continue;
    }
    if (part.startsWith("--task-type=")) {
      taskType = part.slice("--task-type=".length);
      continue;
    }
    remaining.push(part);
  }

  if (!executorMode) {
    const envMode = process.env.FACTORY_PI_EXECUTOR_MODE;
    if (envMode === "fake" || envMode === "sdk" || envMode === "off") {
      executorMode = envMode;
    }
  }

  return {
    goal: remaining.join(" "),
    executorMode,
    workflowId,
    taskType,
  };
}

async function createRequiredConstitutionExecutor(
  onEvent?: (executionId: string, event: { type: string; text?: string; data?: Record<string, unknown> }) => void,
): Promise<AgentExecutor> {
  const sessionFactory = piExecutors.createPiSdkSessionFactory({
    packageName: process.env.FACTORY_PI_SDK_PACKAGE,
  });
  return new piExecutors.PiAgentExecutor({ sessionFactory, onEvent });
}

async function createOptionalExecutorBundle(
  mode: "fake" | "sdk" | "off" | undefined,
  onEvent?: (executionId: string, event: { type: string; text?: string; data?: Record<string, unknown> }) => void,
  ctx?: FactoryPiCommandContext,
): Promise<
  | {
      discoveryExecutor: AgentExecutor;
      plannerExecutor: AgentExecutor;
      builderExecutor: AgentExecutor;
      repairExecutor: AgentExecutor;
      reviewerExecutor: AgentExecutor;
      verificationPlannerExecutor: AgentExecutor;
    }
  | undefined
> {
  if (!mode || mode === "off") {
    return undefined;
  }

  const sessionFactory =
    mode === "sdk"
      ? piExecutors.createPiSdkSessionFactory({
          packageName: process.env.FACTORY_PI_SDK_PACKAGE,
          toolGate: {
            onApprovalRequired: async ({ capability, toolName }) => {
              if (!ctx?.ui.confirm) {
                return false;
              }
              return ctx.ui.confirm(
                "Factory capability approval",
                `Allow tool '${toolName}' to use capability '${capability}' for this node?`,
              );
            },
          },
        })
      : piExecutors.createFakePiSessionFactory();

  return {
    discoveryExecutor: new piExecutors.PiAgentExecutor({ sessionFactory, onEvent }),
    plannerExecutor: new piExecutors.PiAgentExecutor({ sessionFactory, onEvent }),
    builderExecutor: new piExecutors.PiAgentExecutor({ sessionFactory, onEvent }),
    repairExecutor: new piExecutors.PiAgentExecutor({ sessionFactory, onEvent }),
    reviewerExecutor: new piExecutors.PiAgentExecutor({ sessionFactory, onEvent }),
    verificationPlannerExecutor: new piExecutors.PiAgentExecutor({ sessionFactory, onEvent }),
  };
}

async function resolveExecutorMode(
  requested: "fake" | "sdk" | "off" | undefined,
  cwd: string,
): Promise<"fake" | "sdk" | "off" | undefined> {
  if (requested) {
    return requested;
  }

  const pi = await detectPiModelConfiguration(cwd).catch(() => undefined);
  if (pi?.hasAuth) {
    return "sdk";
  }

  return undefined;
}

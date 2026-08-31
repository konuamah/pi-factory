// Concierge command handlers — extracted from gateway-setup.ts.

import { recommendViaFactoryConciergeSkill } from "@factory/core";
import { renderLines, renderIntro, FACTORY_WIDGET_ID } from "./gateway-render.js";
import { mountFactoryStreamingWidget } from "./streaming-panel.js";
import { handleWorkflow, handleWorkflowCreate } from "./gateway-workflow.js";
import { handleDoctor, handleLogs, handleList, handlePlan, handleResume, handleCancel, handleCleanup, handleConstitution, handleWorktree } from "./gateway-runs.js";
import { handleStatus } from "./gateway-run-status.js";
import { handleShow } from "./gateway-run-show.js";
import { handleCapabilities, handleModels } from "./gateway-capabilities.js";
import { handleDashboard } from "./gateway.js";
import { handleSetup } from "./gateway-setup.js";
import { createOptionalSetupExecutor } from "./gateway-customize.js";
import type { FactoryPiCommandContext } from "./types.js";
import type { FactoryConciergeRecommendation, FactoryConciergeAction } from "@factory/core";

export async function handleAsk(questionText: string, ctx: FactoryPiCommandContext): Promise<void> {
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

export function factoryConciergeLines(rec: FactoryConciergeRecommendation): string[] {
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

export async function handleConciergeRecommendationAction(
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

export async function runConciergeAction(rec: FactoryConciergeRecommendation, ctx: FactoryPiCommandContext): Promise<void> {
  switch (rec.recommendedAction) {
    case "run-setup":
      await handleSetup(["--from-concierge"], ctx);
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

export function conciergeCommandForAction(action: FactoryConciergeAction): string | undefined {
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

export function commandArg(command: string | undefined, pattern: RegExp): string | undefined {
  return command?.match(pattern)?.[1];
}

export function formatConciergeAction(action: FactoryConciergeAction): string {
  return action.replace(/-/g, " ");
}

export interface StewardReviewSlide {
  id: string;
  title: string;
  simpleTitle: string;
  lines: string[];
  details?: string[];
  kind: string;
  recommended?: unknown;
}

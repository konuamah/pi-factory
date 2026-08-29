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
import { handleDoctor, handleLogs, handleList, handlePlan, handleResume, handleConstitution, handleCleanup, handleCancel, handleWorktree } from "./gateway-runs.js";
import { handleStatus } from "./gateway-run-status.js";
import { handleShow } from "./gateway-run-show.js";
import { handleCapabilities, handleModels } from "./gateway-capabilities.js";
import { handleSetup, handleAsk, handleConciergeRecommendationAction } from "./gateway-setup.js";
import { handlePrototypeGoal, handleFactoryCommandError, parseGoalRequest, resolveExecutorMode, createOptionalExecutorBundle, readFactoryRunStateForSummary, buildFactoryRunResultTitle, isGitMergeConflictError, loadLatestMergeConflictContext, autoFixLatestMergeConflict, finalizeMergeIfReady, continueLatestRunAfterAutoFix, readMergeConflictStatus, loadDashboardWeb, handleDashboard } from "./gateway-prototype.js";
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


export { handlePrototypeGoal, handleFactoryCommandError, handleDashboard, createRequiredConstitutionExecutor, parseGoalRequest } from "./gateway-prototype.js";
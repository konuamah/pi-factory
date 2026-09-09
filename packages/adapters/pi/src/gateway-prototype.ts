// Prototype-goal runner, error handling, merge helpers, dashboard — extracted
// from gateway.ts so the file is just the command dispatch surface.

import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { runPrototypeFactoryFlow, loadEffectiveConfig, discoverFactoryProject, readLatestFactoryRunStatus, appendFactoryRunEvent, updateFactoryRunState, judgeConstitutionRefreshForTask, runConstitutionScan, showFactoryRun, resumeLatestFactoryRun, detectPiModelConfiguration } from "@factory/core";
import * as piExecutors from "@factory/executor-pi";
import { createPiSdkSessionFactory, PiAgentExecutor } from "@factory/executor-pi";
import { renderLines, renderIntro } from "./gateway-render.js";
import { mountFactoryStreamingWidget } from "./streaming-panel.js";
import { FACTORY_WIDGET_ID } from "./gateway-render.js";
import { requestPlanApprovalDecision, requestAcceptanceDecision, buildPlanApprovalPreviewLines } from "./approval.js";
import { requestDecisionInput } from "./decision-dialog.js";
import type { FactoryPiCommandContext } from "./types.js";
import type { AgentExecutor } from "@factory/core";
import { loadLatestMergeConflictContext, autoFixLatestMergeConflict, finalizeMergeIfReady, continueLatestRunAfterAutoFix, readMergeConflictStatus, isGitMergeConflictError } from "./gateway-merge.js";
import { parseGoalRequest, resolveExecutorMode, createOptionalExecutorBundle, createRequiredConstitutionExecutor } from "./gateway-dashboard.js";

export async function handlePrototypeGoal(rawGoal: string, ctx: FactoryPiCommandContext): Promise<void> {
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
    const toolLine = piExecutors.formatToolActivityLine(event);
    if (toolLine) {
      panel.append(toolLine);
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
    requestAcceptance: async (acceptance) => requestAcceptanceDecision(ctx.ui, acceptance),
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
  const finalTitle = latestShown.pullRequest?.status === "created" || latestShown.pullRequest?.status === "existing"
    ? "Factory candidate published — awaiting PR review"
    : buildFactoryRunResultTitle(finalStatus, finalPhase);
  const finalTone = latestShown.pullRequest?.status === "created" || latestShown.pullRequest?.status === "existing"
    ? "warning"
    : finalStatus === "COMPLETED" ? "info" : finalStatus === "CANCELLED" ? "warning" : "error";

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
    ...(latestShown.runFailure?.reason ? [`run failure: ${latestShown.runFailure.reason}`] : []),
    ...(latestShown.pullRequest
      ? [
          `pull request: ${latestShown.pullRequest.status ?? "unknown"}`,
          `pull request url: ${latestShown.pullRequest.url ?? "none"}`,
          `pull request reason: ${latestShown.pullRequest.reason ?? "none"}`,
        ]
      : []),
    `phases: ${result.phases.join(" -> ")}`,
    ...(latestShown.taskFailure
      ? [
          `failed task: ${latestShown.taskFailure.taskId ?? "unknown"} (${latestShown.taskFailure.stage ?? "unknown"})`,
          `failure reason: ${latestShown.taskFailure.reason ?? "unknown"}`,
          `builder status: ${latestShown.taskFailure.builderStatus ?? "none"}`,
          `builder execution path: ${latestShown.taskFailure.builderExecutionPath ?? "none"}`,
        ]
      : []),
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

export async function readFactoryRunStateForSummary(statePath: string): Promise<{ status?: string; phase?: string } | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, "utf8")) as { status?: string; phase?: string };
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function buildFactoryRunResultTitle(status: string, phase: string): string {
  if (status === "COMPLETED") {
    return "Factory prototype run complete";
  }
  if (status === "CANCELLED") {
    return "Factory prototype run cancelled";
  }
  if (status === "BLOCKED" && phase === "implementation-blocked") {
    return "Factory prototype run blocked during implementation";
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

export async function handleFactoryCommandError(error: unknown, ctx: FactoryPiCommandContext): Promise<void> {
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

export interface LatestMergeConflictContext {
  runId?: string;
  runDir?: string;
  mergeCwd?: string;
  baseBranch?: string;
  candidateBranch?: string;
}

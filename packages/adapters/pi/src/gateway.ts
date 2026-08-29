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
import { handleStatus, handleDoctor, handleLogs, handleList, handleShow, handlePlan, handleResume, handleConstitution, handleCleanup, handleCancel, handleWorktree } from "./gateway-runs.js";
import { handleCapabilities, handleModels } from "./gateway-capabilities.js";
import { handleSetup, handleAsk, handleConciergeRecommendationAction } from "./gateway-setup.js";
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

export async function handleDashboard(rest: string[], ctx: FactoryPiCommandContext): Promise<void> {
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

export async function createRequiredConstitutionExecutor(
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

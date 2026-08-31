// Run-inspection command handlers (status/doctor/logs/list/show/plan/resume/
// constitution/cleanup/cancel/worktree) — extracted from gateway.ts.

import { inspectFactoryRun, readLatestFactoryRunLogs, readLatestFactoryRunPlan, readLatestFactoryRunStatus, readLatestFactoryRunSummary, showFactoryRun, listFactoryRuns, cancelLatestFactoryRun, resumeLatestFactoryRun, readFactoryRunLogs, cleanupFactoryRuns, runFactoryDoctor, discoverFactoryProject, loadEffectiveConfig, runConstitutionScan } from "@factory/core";
import { createGitWorktree, inspectGitIsolation } from "@factory/core";
import { renderLines, renderIntro, buildDecisionLines, buildGuidanceDiagnosticLines, buildVerificationDiagnosticLines, buildIntegrationFailureLines, doctorWidgetLines, FACTORY_WIDGET_ID } from "./gateway-render.js";
import { mountFactoryStreamingWidget } from "./streaming-panel.js";
import { createRequiredConstitutionExecutor } from "./gateway.js";
import type { FactoryPiCommandContext } from "./types.js";

export async function handleDoctor(ctx: FactoryPiCommandContext): Promise<void> {
  renderIntro(ctx, [
    "Factory doctor is checking whether this repository is ready for Factory runs.",
    "I’ll verify config, repository files, git/worktree readiness, and model routing against Pi-visible models now.",
  ]);

  const result = await runFactoryDoctor(ctx.cwd);

  renderLines(ctx, doctorWidgetLines(result));

  const hasFailure = result.checks.some((check) => !check.ok);
  ctx.ui.notify(hasFailure ? "Factory doctor found issues" : "Factory doctor passed", hasFailure ? "warning" : "info");
}

export async function handleLogs(ctx: FactoryPiCommandContext, runId?: string): Promise<void> {
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

export async function handleList(ctx: FactoryPiCommandContext): Promise<void> {
  renderIntro(ctx, [
    "Factory is listing known runs for this repository.",
    "I’ll show run ids with their status, phase, and smart title.",
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
      `  title: ${run.title ?? run.goal ?? "none"}`,
      `  status: ${run.status ?? "none"}`,
      `  phase: ${run.phase ?? "none"}`,
      `  goal: ${run.goal ?? "none"}`,
      `  updated: ${run.updatedAt ?? "none"}`,
    ]),
  ]);

  ctx.ui.notify("Factory run list refreshed", "info");
}

export async function handlePlan(ctx: FactoryPiCommandContext): Promise<void> {
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

export async function handleResume(ctx: FactoryPiCommandContext): Promise<void> {
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

export async function handleConstitution(_args: string[], ctx: FactoryPiCommandContext): Promise<void> {
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

export async function handleCleanup(retainArg: string | undefined, ctx: FactoryPiCommandContext): Promise<void> {
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

export async function handleCancel(ctx: FactoryPiCommandContext): Promise<void> {
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

export async function handleWorktree(branchName: string | undefined, ctx: FactoryPiCommandContext): Promise<void> {
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

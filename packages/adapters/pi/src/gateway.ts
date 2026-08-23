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
  planFactorySetup,
  applyFactorySetup,
  validateFactorySetup,
  appendFactoryRunEvent,
  updateFactoryRunState,
  type AgentExecutor,
  type FactoryRunProgressEvent,
} from "@factory/core";
import * as piExecutors from "../../../executors/pi/dist/index.js";
import { buildPlanApprovalPreviewLines, requestPlanApprovalDecision } from "./approval.js";
import { requestDecisionInput } from "./decision-dialog.js";
import { promptFactorySetupChoices } from "./setup-wizard.js";
import { mountFactoryStreamingWidget } from "./streaming-panel.js";
import type { FactoryPiAutocompleteItem, FactoryPiCommandContext } from "./types.js";

const execFileAsync = promisify(execFile);
const FACTORY_WIDGET_ID = "factory-status";
const FACTORY_SUBCOMMANDS = ["setup", "status", "doctor", "logs", "list", "show", "plan", "resume", "cancel", "worktree", "workflow", "capabilities", "models", "cleanup", "constitution"];

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

  try {
    if (!args) {
      renderLines(ctx, [
        "Factory",
        "",
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

  const plan = await planFactorySetup({ cwd: ctx.cwd, force });

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
  } else {
    answers["workflow-preset"] = "balanced";
  }

  if (ctx.ui.confirm) {
    const generate = await ctx.ui.confirm(
      "Generate constitution now?",
      "Create a repository-specific CONSTITUTION.md, or write a minimal stub?",
    );
    answers["constitution"] = generate ? "generate" : "stub";
  } else {
    answers["constitution"] = "stub";
  }

  const finalPlan = await planFactorySetup({ cwd: ctx.cwd, answers, force });

  renderLines(ctx, [
    "Factory setup plan",
    ...finalPlan.diffs.map((diff) => `  ${diff.file.replace(project.paths.gitRoot ?? ctx.cwd, ".")}${diff.changes.includes("create file") ? " (+create)" : diff.changes.includes("content changes") ? " (~update)" : " (unchanged)"}`),
  ]);

  if (ctx.ui.confirm) {
    const apply = await ctx.ui.confirm("Apply Factory setup?", "Preview shown above. Write these files?");
    if (!apply) { ctx.ui.notify("Factory setup not applied", "info"); return; }
  }

  const written = await applyFactorySetup(finalPlan);

  if (answers["constitution"] === "generate") {
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

  renderLines(ctx, [
    "Factory setup complete",
    `mode: ${finalPlan.mode}`,
    `files written: ${written.length}`,
    `readiness: ${validation.readiness}`,
    "",
    `workflow preset: ${answers["workflow-preset"]}`,
    `base branch: ${loaded.effectiveConfig.git.baseBranch}`,
    "",
    `pi auth configured: ${pi.hasAuth ? "yes" : "no"}`,
    `pi default model: ${pi.defaultProvider && pi.defaultModel ? `${pi.defaultProvider}/${pi.defaultModel}` : "none"}`,
    ...(!pi.hasModelSelection ? ["  hint: configure a Pi default model in ~/.pi/agent/settings.json"] : []),
    ...(!pi.hasAuth ? ["  hint: use /login before generating a constitution or running model-backed flows"] : []),
  ]);

  ctx.ui.notify(`Factory setup complete — ${validation.readiness}`, validation.readiness === "NOT_READY" ? "warning" : "info");
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
    "I’ll verify config, repository files, and git/worktree readiness now.",
  ]);

  const result = await runFactoryDoctor(ctx.cwd);

  renderLines(ctx, [
    "Factory doctor",
    ...result.checks.map((check) => `${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.detail}`),
  ]);

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
      panel.append(event.text);
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
  const roles = ["planner", "builder", "reviewer", "repair"] as const;

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

async function handleWorkflow(rest: string[], ctx: FactoryPiCommandContext): Promise<void> {
  const action = rest[0] ?? "list";
  const arg = rest[1];

  renderIntro(ctx, [
    "Factory workflow manager.",
    "I’ll read the project’s saved workflows and run the requested workflow action.",
  ]);

  const registry = await readWorkflowRegistry(ctx.cwd);

  if (action === "list") {
    renderLines(ctx, [
      "Factory workflows",
      `default: ${registry.defaultWorkflowId ?? "none"}`,
      "",
      ...registry.workflows.map((workflow) => {
        const marker = workflow.id === registry.defaultWorkflowId ? "*" : " ";
        return `${marker} ${workflow.id}: ${workflow.name} (${workflow.stages.map((stage) => stage.name).join(" → ")})`;
      }),
    ]);
    ctx.ui.notify(`Factory has ${registry.workflows.length} workflow(s)`, "info");
    return;
  }

  if (action === "set-default") {
    if (!arg) {
      ctx.ui.notify("Provide a workflow id to set as default", "warning");
      return;
    }
    const target = registry.workflows.find((workflow) => workflow.id === arg);
    if (!target) {
      ctx.ui.notify(`No workflow with id '${arg}'`, "error");
      return;
    }
    registry.defaultWorkflowId = target.id;
    await writeWorkflowRegistry(ctx.cwd, registry);
    renderLines(ctx, ["Factory workflow", `default: ${target.id}: ${target.name}`]);
    ctx.ui.notify(`Default workflow set to ${target.name}`, "info");
    return;
  }

  if (action === "show") {
    if (!arg) {
      ctx.ui.notify("Provide a workflow id to show", "warning");
      return;
    }
    const target = registry.workflows.find((workflow) => workflow.id === arg);
    if (!target) {
      ctx.ui.notify(`No workflow with id '${arg}'`, "error");
      return;
    }
    renderLines(ctx, [
      `Factory workflow: ${target.id}`,
      `name: ${target.name}`,
      target.description ? `description: ${target.description}` : "description: none",
      `stages: ${target.stages.length}`,
      "",
      ...target.stages.map((stage) => {
        const depends = stage.dependsOn?.length ? ` (after: ${stage.dependsOn.join(", ")})` : "";
        return `- ${stage.name} [${stage.type ?? "agent"}]${depends}`;
      }),
    ]);
    return;
  }

  if (action === "clone") {
    if (!arg) {
      ctx.ui.notify("Provide a workflow id to clone", "warning");
      return;
    }
    const source = registry.workflows.find((workflow) => workflow.id === arg);
    if (!source) {
      ctx.ui.notify(`No workflow with id '${arg}'`, "error");
      return;
    }
    const newId = `${source.id}-copy-${Date.now().toString().slice(-4)}`;
    registry.workflows.push({
      ...source,
      id: newId,
      name: `${source.name} (copy)`,
      stages: source.stages.map((stage) => ({ ...stage })),
    });
    await writeWorkflowRegistry(ctx.cwd, registry);
    renderLines(ctx, ["Factory workflow cloned", `new id: ${newId}`]);
    ctx.ui.notify(`Cloned ${source.name} as ${newId}`, "info");
    return;
  }

  if (action === "delete") {
    if (!arg) {
      ctx.ui.notify("Provide a workflow id to delete", "warning");
      return;
    }
    const target = registry.workflows.find((workflow) => workflow.id === arg);
    if (!target) {
      ctx.ui.notify(`No workflow with id '${arg}'`, "error");
      return;
    }
    if (registry.defaultWorkflowId === target.id) {
      ctx.ui.notify("Cannot delete the default workflow", "error");
      return;
    }
    registry.workflows = registry.workflows.filter((workflow) => workflow.id !== arg);
    await writeWorkflowRegistry(ctx.cwd, registry);
    renderLines(ctx, ["Factory workflow deleted", `id: ${arg}`]);
    ctx.ui.notify(`Deleted workflow ${arg}`, "info");
    return;
  }

  if (action === "create") {
    await handleWorkflowCreate(ctx, registry);
    return;
  }

  ctx.ui.notify("Unknown workflow action. Use list|create|show|edit|clone|delete|set-default", "warning");
}

async function handleWorkflowCreate(ctx: FactoryPiCommandContext, registry: Awaited<ReturnType<typeof readWorkflowRegistry>>): Promise<void> {
  if (!ctx.ui.input) {
    renderLines(ctx, ["Factory workflow create", "Interactive input is not available in this shell."]);
    ctx.ui.notify("Interactive input unavailable", "warning");
    return;
  }

  const name = await ctx.ui.input("Factory workflow name", "Workflow name (e.g. High Risk Change)");
  if (!name?.trim()) {
    ctx.ui.notify("Workflow creation cancelled", "info");
    return;
  }

  const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "workflow";
  const description = (await ctx.ui.input("Factory workflow description", "Optional short description")) ?? undefined;

  const stageNames: string[] = [];
  let nextName: string | undefined;
  do {
    nextName = await ctx.ui.input("Add workflow node", "Node name, or blank to finish");
    if (nextName?.trim()) {
      stageNames.push(nextName.trim().toLowerCase().replace(/\s+/g, "-"));
    }
  } while (nextName?.trim());

  if (stageNames.length === 0) {
    ctx.ui.notify("Workflow needs at least one node", "error");
    return;
  }

  const stages = stageNames.map((stageName, index) => ({
    name: stageName,
    dependsOn: index > 0 ? [stageNames[index - 1]!] : [],
    type: index === stageNames.length - 1 ? ("approval" as const) : ("agent" as const),
  }));

  registry.workflows.push({
    id,
    name: name.trim(),
    description: description?.trim() || undefined,
    stages,
  });
  await writeWorkflowRegistry(ctx.cwd, registry);
  renderLines(ctx, ["Factory workflow created", `id: ${id}`, `name: ${name.trim()}`, `nodes: ${stages.length}`]);
  ctx.ui.notify(`Workflow ${name.trim()} created`, "info");
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
    phase: "constitution-refresh",
    role: "constitution-interpreter",
    status: "starting",
    lines: ["Starting constitution refresh..."],
    footer: "Live Factory stream. Use arrow keys to scroll.",
  });

  let constitutionSummary: {
    mode: string;
    finalized: boolean;
    refreshStrategy: string;
    refresh: { mode: string; changedFiles: string[] };
  };

  panel.setPhase("constitution-refresh");
  panel.setStatus("running");
  panel.append("Scanning repository facts...");

  const constitutionExecutor = await createRequiredConstitutionExecutor((executionId, event) => {
    panel.setRole(executionId.includes("planner") ? "planner" : "constitution-interpreter");
    panel.setStatus("streaming");
    if (event.text) {
      panel.append(event.text);
    }
  });

  const constitutionResult = await runConstitutionScan({
    cwd: ctx.cwd,
    constitutionExecutor,
  });

  panel.setStatus("completed");
  panel.append("Constitution refresh completed.");
  panel.append(`Constitution strategy: ${constitutionResult.refreshStrategy}`);
  panel.append(`Changed files: ${constitutionResult.refresh.changedFiles.length}`);
  constitutionSummary = constitutionResult;
  panel.setPhase("planning");
  panel.setRole(effectiveExecutorMode && effectiveExecutorMode !== "off" ? "planner" : undefined);
  panel.setStatus("starting");
  panel.append("Preparing Factory runtime...");
  panel.setFooter("Live Factory stream. Use arrow keys to scroll.");

  const executorBundle = await createOptionalExecutorBundle(effectiveExecutorMode, (executionId, event) => {

    panel.setStatus("streaming");
    if (executionId.includes("planner")) {
      panel.setRole("planner");
    } else if (executionId.includes("builder")) {
      panel.setRole("builder");
    } else if (executionId.includes("repair")) {
      panel.setRole("repair");
    } else if (executionId.includes("reviewer")) {
      panel.setRole("reviewer");
    }
    if (event.text) {
      panel.append(event.text);
    }
  }, ctx);

  const result = await runPrototypeFactoryFlow({
    cwd: ctx.cwd,
    goal: trimmedGoal,
    workflowId: parsed.workflowId,
    taskType: parsed.taskType,
    branchName: `factory-${trimmedGoal.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "run"}`,
    plannerExecutor: executorBundle?.plannerExecutor,
    builderExecutor: executorBundle?.builderExecutor,
    repairExecutor: executorBundle?.repairExecutor,
    reviewerExecutor: executorBundle?.reviewerExecutor,
    onProgress: async (event) => {
      panel.setPhase(event.phase);
      panel.setStatus(event.status.toLowerCase());
      panel.append(`${event.phase}: ${event.message}`);
    },
    requestPlanApproval: async ({ runId, goal, planPath, taskCount, workflowStages, summary, planText, tasks }) => {
      const preview = { runId, goal, planPath, taskCount, workflowStages, summary, planText, tasks };
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
    requestApproval: async ({ runId, goal }) => {
      if (!ctx.ui.confirm) {
        return true;
      }
      return ctx.ui.confirm(
        "Approve Factory candidate?",
        `Approve prototype run ${runId} for goal: ${goal}`,
      );
    },
    requestDecision: async (request) => requestDecisionInput(ctx.ui, request),
  });

  const latestShown = await showFactoryRun(path.join((await discoverFactoryProject(ctx.cwd)).paths.runsDir), result.runId);

  renderLines(ctx, [
    result.approved ? "Factory prototype run complete" : "Factory prototype run cancelled",
    `goal: ${trimmedGoal}`,
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

  ctx.ui.notify(result.approved ? "Factory prototype run complete" : "Factory prototype run cancelled", result.approved ? "info" : "warning");
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

function buildDecisionLines(
  decisions: Array<{ type: "request" | "resolution"; requestId?: string; question?: string; optionId?: string; feedback?: string }> | undefined,
): string[] {
  if (!decisions?.length) {
    return [];
  }
  const lines = ["", "Decisions:"];
  for (const decision of decisions) {
    if (decision.type === "request") {
      lines.push(`  ? ${decision.requestId ?? "?"}: ${decision.question ?? ""}`);
    } else {
      lines.push(`  ✓ ${decision.requestId ?? "?"} → ${decision.optionId ?? "?"}${decision.feedback ? ` (${decision.feedback})` : ""}`);
    }
  }
  return lines;
}

function buildGuidanceDiagnosticLines(guidance:
  | {
      plannerInstructionFiles: string[];
      builderInstructionFiles: string[];
      repairInstructionFiles: string[];
      reviewerInstructionFiles: string[];
      plannerInstructionDetails?: Array<{ path: string; score: number; reason: string }>;
      builderInstructionDetails?: Array<{ path: string; score: number; reason: string }>;
      repairInstructionDetails?: Array<{ path: string; score: number; reason: string }>;
      reviewerInstructionDetails?: Array<{ path: string; score: number; reason: string }>;
      plannerHasConstitution: boolean;
      builderHasConstitution: boolean;
      repairHasConstitution: boolean;
      reviewerHasConstitution: boolean;
      plannerUsedConstitution: boolean;
      builderUsedConstitution: boolean;
      repairUsedConstitution: boolean;
      reviewerUsedConstitution: boolean;
      plannerGuidanceChars: number;
      builderGuidanceChars: number;
      repairGuidanceChars: number;
      reviewerGuidanceChars: number;
    }
  | undefined,
): string[] {
  if (!guidance) {
    return [];
  }

  return [
    `planner guidance files: ${guidance.plannerInstructionFiles.join(", ") || "none"}`,
    ...((guidance.plannerInstructionDetails ?? []).slice(0, 3).map((detail) => `  planner reason: ${detail.path} (score ${detail.score}) - ${detail.reason}`)),
    `builder guidance files: ${guidance.builderInstructionFiles.join(", ") || "none"}`,
    `repair guidance files: ${guidance.repairInstructionFiles.join(", ") || "none"}`,
    `reviewer guidance files: ${guidance.reviewerInstructionFiles.join(", ") || "none"}`,
    `planner constitution used: ${guidance.plannerUsedConstitution ? "yes" : "no"}`,
    `builder constitution used: ${guidance.builderUsedConstitution ? "yes" : "no"}`,
    `repair constitution used: ${guidance.repairUsedConstitution ? "yes" : "no"}`,
    `reviewer constitution used: ${guidance.reviewerUsedConstitution ? "yes" : "no"}`,
    `planner guidance chars: ${guidance.plannerGuidanceChars}`,
    `builder guidance chars: ${guidance.builderGuidanceChars}`,
    `repair guidance chars: ${guidance.repairGuidanceChars}`,
    `reviewer guidance chars: ${guidance.reviewerGuidanceChars}`,
  ];
}

function buildVerificationDiagnosticLines(
  verificationContext:
    | {
        cwd?: string;
        cwdResolution?: string;
        selectionSource?: string;
        rationale?: string;
        failureKind?: string;
        failureReason?: string;
      }
    | undefined,
  verification: Record<string, unknown> | undefined,
): string[] {
  if (!verificationContext && !verification) {
    return [];
  }

  const commands = Array.isArray(verification?.commands)
    ? verification.commands.filter((item): item is { name?: unknown; status?: unknown } => Boolean(item) && typeof item === "object")
    : [];
  const commandLines = commands.slice(0, 5).map((item) => `  command ${String(item.name ?? "?")}: ${String(item.status ?? "unknown")}`);
  const verificationEvidence = verification?.evidence && typeof verification.evidence === "object"
    ? verification.evidence as { commandDecisions?: unknown }
    : undefined;
  const decisionLines = Array.isArray(verificationEvidence?.commandDecisions)
    ? (verificationEvidence.commandDecisions as Array<{ name?: unknown; selected?: unknown; reason?: unknown }>)
        .slice(0, 5)
        .map((item) => `  selection ${String(item.name ?? "?")}: ${Boolean(item.selected) ? "run" : "skip"} - ${String(item.reason ?? "unknown")}`)
    : [];

  return [
    `verification cwd: ${verificationContext?.cwd ?? String(verification?.cwd ?? "none")}`,
    `verification cwd reason: ${verificationContext?.cwdResolution ?? String(verification?.cwdResolution ?? "none")}`,
    `verification selection source: ${verificationContext?.selectionSource ?? String(verification?.selectionSource ?? "none")}`,
    `verification rationale: ${verificationContext?.rationale ?? String(verification?.rationale ?? "none")}`,
    `verification failure class: ${verificationContext?.failureKind ?? String((verification?.failureClassification as { kind?: unknown } | undefined)?.kind ?? "none")}`,
    `verification failure reason: ${verificationContext?.failureReason ?? String((verification?.failureClassification as { reason?: unknown } | undefined)?.reason ?? "none")}`,
    ...decisionLines,
    ...commandLines,
  ];
}

function buildIntegrationFailureLines(
  integrationFailure:
    | {
        reason?: string;
        conflictingFiles: string[];
        mergeInProgress: boolean;
      }
    | undefined,
): string[] {
  if (!integrationFailure) {
    return [];
  }

  return [
    `integration failure: ${integrationFailure.reason ?? "unknown"}`,
    `integration conflicts: ${integrationFailure.conflictingFiles.join(", ") || "none"}`,
    `merge in progress: ${integrationFailure.mergeInProgress ? "yes" : "no"}`,
  ];
}

function renderLines(ctx: FactoryPiCommandContext, lines: string[]): void {
  ctx.ui.setWidget(FACTORY_WIDGET_ID, lines);
}

function renderIntro(ctx: FactoryPiCommandContext, lines: string[]): void {
  renderLines(ctx, ["Factory", "", ...lines]);
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
      plannerExecutor: AgentExecutor;
      builderExecutor: AgentExecutor;
      repairExecutor: AgentExecutor;
      reviewerExecutor: AgentExecutor;
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
    plannerExecutor: new piExecutors.PiAgentExecutor({ sessionFactory, onEvent }),
    builderExecutor: new piExecutors.PiAgentExecutor({ sessionFactory, onEvent }),
    repairExecutor: new piExecutors.PiAgentExecutor({ sessionFactory, onEvent }),
    reviewerExecutor: new piExecutors.PiAgentExecutor({ sessionFactory, onEvent }),
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


import {
  discoverFactoryProject,
  initializeFactoryProject,
  loadEffectiveConfig,
  cancelLatestFactoryRun,
  inspectFactoryRun,
  listFactoryRuns,
  readFactoryRunLogs,
  readLatestFactoryRunLogs,
  readLatestFactoryRunStatus,
  readLatestFactoryRunSummary,
  resumeLatestFactoryRun,
  runFactoryDoctor,
  runPrototypeFactoryFlow,
  showFactoryRun,
  type FactoryRunProgressEvent,
} from "@factory/core";
import type { FactoryPiAutocompleteItem, FactoryPiCommandContext } from "./types.js";

const FACTORY_WIDGET_ID = "factory-status";
const FACTORY_SUBCOMMANDS = ["setup", "status", "doctor", "logs", "list", "show", "resume", "cancel"];

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
      "/factory resume  mark the latest interrupted run resumed",
      "/factory cancel  mark the latest run cancelled",
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
    case "resume":
      await handleResume(ctx);
      return;
    case "cancel":
      await handleCancel(ctx);
      return;
    default:
      await handlePrototypeGoal(args, ctx);
  }
}

async function handleSetup(rest: string[], ctx: FactoryPiCommandContext): Promise<void> {
  const force = rest.includes("--force");

  if (!force && ctx.ui.confirm) {
    const ok = await ctx.ui.confirm(
      "Initialize Factory?",
      "Create project-local CONSTITUTION.md, factory.yaml, and .factory/config.yaml?",
    );
    if (!ok) {
      ctx.ui.notify("Factory setup cancelled", "info");
      return;
    }
  }

  const result = await initializeFactoryProject({ cwd: ctx.cwd, force });
  const loaded = await loadEffectiveConfig({ cwd: result.root });

  renderLines(ctx, [
    "Factory setup complete",
    `root: ${result.root}`,
    "",
    `created: ${result.created.length}`,
    ...result.created.map((filePath) => `  + ${filePath}`),
    `skipped: ${result.skipped.length}`,
    ...result.skipped.map((filePath) => `  - ${filePath}`),
    "",
    `base branch: ${loaded.effectiveConfig.git.baseBranch}`,
    `parallel agents: ${loaded.effectiveConfig.runtime.maxParallelAgents}`,
    `approval: ${loaded.effectiveConfig.approval.finalMerge}`,
    "",
    `setup run id: ${result.runId}`,
    `setup run dir: ${result.runDir}`,
  ]);

  ctx.ui.notify("Factory setup complete", "info");
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
    `workflow stages: ${loaded.effectiveConfig.workflow?.stages.map((stage) => stage.name).join(", ") ?? "none"}`,
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
  const result = await runFactoryDoctor(ctx.cwd);

  renderLines(ctx, [
    "Factory doctor",
    ...result.checks.map((check) => `${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.detail}`),
  ]);

  const hasFailure = result.checks.some((check) => !check.ok);
  ctx.ui.notify(hasFailure ? "Factory doctor found issues" : "Factory doctor passed", hasFailure ? "warning" : "info");
}

async function handleLogs(ctx: FactoryPiCommandContext, runId?: string): Promise<void> {
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
    `status: ${String(logs.state?.status ?? "none")}`,
    `phase: ${String(logs.state?.phase ?? "none")}`,
    "",
    "Recent events",
    ...logs.events,
  ]);

  ctx.ui.notify("Factory logs refreshed", "info");
}

async function handleList(ctx: FactoryPiCommandContext): Promise<void> {
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

  renderLines(ctx, [
    "Factory show",
    `run dir: ${result.runDir}`,
    `run id: ${String(result.state?.runId ?? result.summary?.runId ?? runId)}`,
    `goal: ${String(result.summary?.goal ?? "none")}`,
    `status: ${String(result.state?.status ?? result.summary?.status ?? "none")}`,
    `phase: ${String(result.state?.phase ?? result.summary?.phase ?? "none")}`,
    `approved: ${typeof result.summary?.approved === "boolean" ? (result.summary.approved ? "yes" : "no") : "none"}`,
    `verification: ${String(result.summary?.verificationStatus ?? result.verification?.overallStatus ?? "none")}`,
    `task count: ${taskCount}`,
    `workflow stages: ${workflowStages}`,
    `verification commands: ${verificationCommands}`,
  ]);

  ctx.ui.notify("Factory run loaded", "info");
}

async function handleResume(ctx: FactoryPiCommandContext): Promise<void> {
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
  ]);

  ctx.ui.notify(result.resumed ? "Factory run resumed" : "No resumable Factory run", result.resumed ? "info" : "warning");
}

async function handleCancel(ctx: FactoryPiCommandContext): Promise<void> {
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

async function handlePrototypeGoal(goal: string, ctx: FactoryPiCommandContext): Promise<void> {
  const trimmedGoal = goal.trim();
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

  const result = await runPrototypeFactoryFlow({
    cwd: ctx.cwd,
    goal: trimmedGoal,
    onProgress: async (event) => {
      updateProgressWidget(ctx, progressLines, event);
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
  });

  renderLines(ctx, [
    result.approved ? "Factory prototype run complete" : "Factory prototype run cancelled",
    `goal: ${trimmedGoal}`,
    `run id: ${result.runId}`,
    `run dir: ${result.runDir}`,
    `state path: ${result.statePath}`,
    `events path: ${result.eventsPath}`,
    `plan path: ${result.planPath}`,
    `task artifacts: ${result.taskPaths.length}`,
    `verification path: ${result.verificationPath}`,
    `summary path: ${result.summaryPath}`,
    `approved: ${result.approved ? "yes" : "no"}`,
    `phases: ${result.phases.join(" -> ")}`,
  ]);

  ctx.ui.notify(result.approved ? "Factory prototype run complete" : "Factory prototype run cancelled", result.approved ? "info" : "warning");
}

function renderLines(ctx: FactoryPiCommandContext, lines: string[]): void {
  ctx.ui.setWidget(FACTORY_WIDGET_ID, lines);
}

function updateProgressWidget(
  ctx: FactoryPiCommandContext,
  staticLines: string[],
  event: FactoryRunProgressEvent,
): void {
  renderLines(ctx, [
    ...staticLines,
    `run id: ${event.runId}`,
    `status: ${event.status}`,
    `phase: ${event.phase}`,
    `message: ${event.message}`,
  ]);
}

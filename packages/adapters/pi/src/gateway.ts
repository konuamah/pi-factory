import {
  discoverFactoryProject,
  initializeFactoryProject,
  loadEffectiveConfig,
  cancelLatestFactoryRun,
  readLatestFactoryRunLogs,
  readLatestFactoryRunStatus,
  resumeLatestFactoryRun,
  runFactoryDoctor,
  runPrototypeFactoryFlow,
  type FactoryRunProgressEvent,
} from "@factory/core";
import type { FactoryPiCommandContext } from "./types.js";

const FACTORY_WIDGET_ID = "factory-status";

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
      "/factory status  inspect discovered config and latest run state",
      "/factory doctor  validate repo and config readiness",
      "/factory logs    inspect latest run state, events, and artifacts",
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
      await handleStatus(ctx);
      return;
    case "doctor":
      await handleDoctor(ctx);
      return;
    case "logs":
      await handleLogs(ctx);
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

async function handleStatus(ctx: FactoryPiCommandContext): Promise<void> {
  const project = await discoverFactoryProject(ctx.cwd);
  const loaded = await loadEffectiveConfig({ cwd: ctx.cwd });
  const latestRun = await readLatestFactoryRunStatus(project.paths.runsDir);

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
    `run id: ${latestRun.state?.runId ?? "none"}`,
    `status: ${latestRun.state?.status ?? "none"}`,
    `phase: ${latestRun.state?.phase ?? "none"}`,
    `updated: ${latestRun.state?.updatedAt ?? "none"}`,
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

async function handleLogs(ctx: FactoryPiCommandContext): Promise<void> {
  const project = await discoverFactoryProject(ctx.cwd);
  const logs = await readLatestFactoryRunLogs(project.paths.runsDir, { limit: 12 });

  if (!logs.runDir) {
    renderLines(ctx, [
      "Factory logs",
      "No runs found.",
      `runs dir: ${project.paths.runsDir}`,
    ]);
    ctx.ui.notify("No Factory runs found", "warning");
    return;
  }

  renderLines(ctx, [
    "Factory logs",
    `run dir: ${logs.runDir}`,
    `state path: ${logs.statePath ?? "none"}`,
    `events path: ${logs.eventsPath ?? "none"}`,
    `plan path: ${logs.planPath ?? "none"}`,
    `verification path: ${logs.verificationPath ?? "none"}`,
    `status: ${String(logs.state?.status ?? "none")}`,
    `phase: ${String(logs.state?.phase ?? "none")}`,
    "",
    "Recent events",
    ...logs.events,
  ]);

  ctx.ui.notify("Factory logs refreshed", "info");
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
    `verification path: ${result.verificationPath}`,
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

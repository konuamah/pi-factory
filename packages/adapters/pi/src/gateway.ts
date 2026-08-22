import {
  discoverFactoryProject,
  initializeFactoryProject,
  loadEffectiveConfig,
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
      "/factory status  inspect discovered config and effective policy",
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
    default:
      renderLines(ctx, [
        `Unknown /factory subcommand: ${subcommand}`,
        "",
        "Available:",
        "- setup",
        "- status",
      ]);
      ctx.ui.notify(`Unknown factory subcommand: ${subcommand}`, "warning");
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
  ]);

  ctx.ui.notify("Factory setup complete", "info");
}

async function handleStatus(ctx: FactoryPiCommandContext): Promise<void> {
  const project = await discoverFactoryProject(ctx.cwd);
  const loaded = await loadEffectiveConfig({ cwd: ctx.cwd });

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
  ]);

  ctx.ui.notify("Factory status refreshed", "info");
}

function renderLines(ctx: FactoryPiCommandContext, lines: string[]): void {
  ctx.ui.setWidget(FACTORY_WIDGET_ID, lines);
}

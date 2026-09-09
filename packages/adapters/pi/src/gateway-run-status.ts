// Run status view — extracted from gateway-runs.ts.

import { inspectFactoryRun, discoverFactoryProject, loadEffectiveConfig, readLatestFactoryRunStatus, readLatestFactoryRunSummary } from "@factory/core";
import { renderLines, renderIntro } from "./gateway-render.js";
import type { FactoryPiCommandContext } from "./types.js";

export async function handleStatus(ctx: FactoryPiCommandContext, runId?: string): Promise<void> {
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
      `title: ${inspected.summary?.title ?? inspected.summary?.goal ?? "none"}`,
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
    `title: ${latestSummary.summary?.title ?? latestSummary.summary?.goal ?? "none"}`,
    `goal: ${latestSummary.summary?.goal ?? "none"}`,
    `task count: ${latestSummary.summary?.taskPaths?.length ?? 0}`,
    `verification: ${latestSummary.summary?.verificationStatus ?? "none"}`,
    `approved: ${typeof latestSummary.summary?.approved === "boolean" ? (latestSummary.summary.approved ? "yes" : "no") : "none"}`,
  ]);

  ctx.ui.notify("Factory status refreshed", "info");
}

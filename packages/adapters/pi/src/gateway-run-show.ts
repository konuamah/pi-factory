// Run detail view — extracted from gateway-runs.ts.

import { showFactoryRun, discoverFactoryProject } from "@factory/core";
import { renderLines, renderIntro, buildDecisionLines, buildGuidanceDiagnosticLines, buildVerificationDiagnosticLines, buildIntegrationFailureLines } from "./gateway-render.js";
import type { FactoryPiCommandContext } from "./types.js";

export async function handleShow(runId: string | undefined, ctx: FactoryPiCommandContext): Promise<void> {
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


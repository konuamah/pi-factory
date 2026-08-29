// Merge conflict helpers — extracted from gateway-prototype.ts.

import { appendFactoryRunEvent, discoverFactoryProject, readLatestFactoryRunStatus, updateFactoryRunState, resumeLatestFactoryRun } from "@factory/core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { renderLines } from "./gateway-render.js";
import type { FactoryPiCommandContext } from "./types.js";
import type { LatestMergeConflictContext } from "./gateway-prototype.js";

import type { AgentExecutor } from "@factory/core";
import { createRequiredConstitutionExecutor } from "./gateway.js";

const execFileAsync = promisify(execFile);

export async function loadLatestMergeConflictContext(cwd: string): Promise<LatestMergeConflictContext | undefined> {
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

export async function autoFixLatestMergeConflict(
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

export async function finalizeMergeIfReady(cwd: string): Promise<void> {
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

export async function continueLatestRunAfterAutoFix(
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

export async function readMergeConflictStatus(cwd: string): Promise<{ hasConflicts: boolean; mergeInProgress: boolean }> {
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

export function isGitMergeConflictError(message: string): boolean {
  return /git merge/i.test(message) && /(unmerged files|resolve.*conflict|unresolved conflict|Automatic merge failed)/i.test(message);
}


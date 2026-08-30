// Final merge phase — extracted from implementation.ts.

import { appendFactoryRunEvent, updateFactoryRunState } from "../runs/store.js";
import { emitProgress, movePhase, wait } from "./phase-plumbing.js";
import { readGitHeadSha, commitWorkspaceChanges } from "./git-ops.js";
import { writePrototypeFinalMergeArtifact, writePrototypeSummaryArtifact } from "./artifacts.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PlannerTask } from "./planner.js";
import type { EffectiveFactoryConfig } from "@factory/schemas";

const execFileAsync = promisify(execFile);


export async function runFinalMergePhase(input: {
  runDir: string;
  eventsPath: string;
  mergeCwd: string;
  candidateBranch?: string;
  candidateSha?: string;
  baseBranch: string;
  finalMergePolicy: "required" | "not-required";
  worktreeMode: "existing" | "created" | "in-place";
}): Promise<string | undefined> {
  if (process.env.FACTORY_SKIP_FINAL_MERGE === "1") {
    return writePrototypeFinalMergeArtifact(input.runDir, {
      mergeBaseBranch: input.baseBranch,
      candidateBranch: input.candidateBranch,
      candidateSha: input.candidateSha,
      mergeCwd: input.mergeCwd,
      status: "skipped",
      reason: "Final merge skipped by FACTORY_SKIP_FINAL_MERGE=1",
    });
  }

  if (input.finalMergePolicy !== "required") {
    return writePrototypeFinalMergeArtifact(input.runDir, {
      mergeBaseBranch: input.baseBranch,
      candidateBranch: input.candidateBranch,
      candidateSha: input.candidateSha,
      mergeCwd: input.mergeCwd,
      status: "skipped",
      reason: "Final merge policy does not require automatic merge",
    });
  }

  if (!input.candidateBranch) {
    return writePrototypeFinalMergeArtifact(input.runDir, {
      mergeBaseBranch: input.baseBranch,
      candidateBranch: input.candidateBranch,
      candidateSha: input.candidateSha,
      mergeCwd: input.mergeCwd,
      status: "skipped",
      reason: "No candidate branch available for merge",
    });
  }

  if (input.worktreeMode === "existing") {
    return writePrototypeFinalMergeArtifact(input.runDir, {
      mergeBaseBranch: input.baseBranch,
      candidateBranch: input.candidateBranch,
      candidateSha: input.candidateSha,
      mergeCwd: input.mergeCwd,
      status: "skipped",
      reason: "Existing linked worktree does not provide a known primary merge checkout",
    });
  }

  await appendFactoryRunEvent(input.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "merge.started",
    data: {
      baseBranch: input.baseBranch,
      candidateBranch: input.candidateBranch,
      candidateSha: input.candidateSha,
      mergeCwd: input.mergeCwd,
    },
  });

  try {
    await execFileAsync("git", ["checkout", input.baseBranch], { cwd: input.mergeCwd, windowsHide: true });
    await execFileAsync("git", ["merge", "--no-ff", "--no-edit", input.candidateBranch], {
      cwd: input.mergeCwd,
      windowsHide: true,
    });
    await appendFactoryRunEvent(input.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "merge.completed",
      data: {
        baseBranch: input.baseBranch,
        candidateBranch: input.candidateBranch,
        candidateSha: input.candidateSha,
      },
    });
    return writePrototypeFinalMergeArtifact(input.runDir, {
      mergeBaseBranch: input.baseBranch,
      candidateBranch: input.candidateBranch,
      candidateSha: input.candidateSha,
      mergeCwd: input.mergeCwd,
      status: "landed",
      outcome: "landed",
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await appendFactoryRunEvent(input.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "merge.skipped",
      data: {
        baseBranch: input.baseBranch,
        candidateBranch: input.candidateBranch,
        candidateSha: input.candidateSha,
        reason,
      },
    });
    return writePrototypeFinalMergeArtifact(input.runDir, {
      mergeBaseBranch: input.baseBranch,
      candidateBranch: input.candidateBranch,
      candidateSha: input.candidateSha,
      mergeCwd: input.mergeCwd,
      status: "skipped",
      reason,
    });
  }
}

/**
 * Resolve the task ids a task depends on, using the same stage-name mapping as
 * resolveTaskDependencies, with fallback to direct task-id matching.
 */
export function resolveDependencyTaskIds(task: PlannerTask, tasks: PlannerTask[]): string[] {
  const tasksByStage = new Map<string, string[]>();
  for (const candidate of tasks) {
    const stageKey = candidate.stage.toLowerCase();
    const existing = tasksByStage.get(stageKey) ?? [];
    existing.push(candidate.id);
    tasksByStage.set(stageKey, existing);
  }
  return task.dependsOn.flatMap((dependency) => {
    const byStage = tasksByStage.get(dependency.toLowerCase());
    if (byStage?.length) {
      return byStage;
    }
    // Fallback: treat as a direct task id.
    return tasks.some((candidate) => candidate.id === dependency) ? [dependency] : [];
  });
}

export function resolveTaskDependencies(tasks: PlannerTask[]): Map<string, string[]> {
  const tasksByStage = new Map<string, string[]>();
  for (const task of tasks) {
    const stageKey = task.stage.toLowerCase();
    const existing = tasksByStage.get(stageKey) ?? [];
    existing.push(task.id);
    tasksByStage.set(stageKey, existing);
  }

  const dependencies = new Map<string, string[]>();
  for (const task of tasks) {
    const resolved = task.dependsOn.flatMap((dependency) => tasksByStage.get(dependency.toLowerCase()) ?? []);
    dependencies.set(task.id, resolved);
  }
  return dependencies;
}



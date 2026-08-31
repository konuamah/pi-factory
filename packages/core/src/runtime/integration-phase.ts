// Integration phase — extracted from implementation.ts.

import { appendFactoryRunEvent, updateFactoryRunState } from "../runs/store.js";
import { appendRepoLearning } from "../learnings/store.js";
import { emitProgress, movePhase, wait } from "./phase-plumbing.js";
import { readGitConflictFiles, hasGitMergeInProgress, readChangedFiles, commitWorkspaceChanges, readGitHeadSha } from "./git-ops.js";
import { getChangedFilesFromBase } from "./verification-planning.js";
import { buildIntegrationRepairPrompt, renderSkillBundleForPrompt } from "./prompts.js";
import { writePrototypeIntegrationArtifact, writePrototypeSummaryArtifact } from "./artifacts.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PlannerTask } from "./planner.js";
import type { AgentExecutor } from "./interfaces.js";
import type { TaskWorkspaceSelection } from "./controller.js";
import type { EffectiveFactoryConfig } from "@factory/schemas";

const execFileAsync = promisify(execFile);


export async function runIntegrationPhase(input: {
  runDir: string;
  eventsPath: string;
  executionCwd: string;
  taskWorkspaces: TaskWorkspaceSelection[];
  goal: string;
  runId: string;
  repairExecutor?: AgentExecutor;
  repairModel?: { provider?: string; model: string };
  repairGuidanceContext?: string;
  repairSkillBundleText?: string;
  limits?: EffectiveFactoryConfig["runtime"]["limits"];
}): Promise<string | undefined> {
  const mergedBranches: Array<{
    taskId: string;
    branch?: string;
    workspacePath: string;
    status: "merged" | "skipped";
    reason?: string;
  }> = [];

  for (const workspace of input.taskWorkspaces) {
    if (!workspace.shouldIntegrate || !workspace.branch) {
      mergedBranches.push({
        taskId: workspace.taskId,
        branch: workspace.branch,
        workspacePath: workspace.path,
        status: "skipped",
        reason: "Task executed in primary workspace",
      });
      continue;
    }

    await appendFactoryRunEvent(input.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "integration.merge_started",
      data: {
        taskId: workspace.taskId,
        branch: workspace.branch,
        workspacePath: workspace.path,
      },
    });

    try {
      await execFileAsync("git", ["merge", "--no-ff", "--no-edit", workspace.branch], {
        cwd: input.executionCwd,
        windowsHide: true,
      });

      mergedBranches.push({
        taskId: workspace.taskId,
        branch: workspace.branch,
        workspacePath: workspace.path,
        status: "merged",
      });
    } catch (error) {
      const failure = await classifyIntegrationFailure(input.executionCwd, error);
      await appendFactoryRunEvent(input.eventsPath, {
        timestamp: new Date().toISOString(),
        type: "integration.merge_failed",
        data: {
          taskId: workspace.taskId,
          branch: workspace.branch,
          workspacePath: workspace.path,
          ...failure,
        },
      });

      const repaired = await attemptIntegrationAutoRepair({
        runId: input.runId,
        goal: input.goal,
        executionCwd: input.executionCwd,
        eventsPath: input.eventsPath,
        taskId: workspace.taskId,
        branch: workspace.branch,
        conflictingFiles: failure.conflictingFiles,
        repairExecutor: input.repairExecutor,
        repairModel: input.repairModel,
        repairGuidanceContext: input.repairGuidanceContext,
        repairSkillBundleText: input.repairSkillBundleText,
        limits: input.limits,
      });

      if (!repaired) {
        throw error;
      }

      mergedBranches.push({
        taskId: workspace.taskId,
        branch: workspace.branch,
        workspacePath: workspace.path,
        status: "merged",
      });
    }
  }

  await appendFactoryRunEvent(input.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "integration.completed",
    data: {
      mergedBranches,
    },
  });

  return writePrototypeIntegrationArtifact(input.runDir, {
    executionCwd: input.executionCwd,
    mergedBranches,
  });
}

export async function attemptIntegrationAutoRepair(input: {
  runId: string;
  goal: string;
  executionCwd: string;
  eventsPath: string;
  taskId: string;
  branch: string;
  conflictingFiles: string[];
  repairExecutor?: AgentExecutor;
  repairModel?: { provider?: string; model: string };
  repairGuidanceContext?: string;
  repairSkillBundleText?: string;
  limits?: EffectiveFactoryConfig["runtime"]["limits"];
}): Promise<boolean> {
  if (!input.repairExecutor || input.conflictingFiles.length === 0) {
    return false;
  }

  await appendFactoryRunEvent(input.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "integration.repair_requested",
    data: {
      taskId: input.taskId,
      branch: input.branch,
      conflictingFiles: input.conflictingFiles,
    },
  });

  await input.repairExecutor.execute({
    executionId: `${input.runId}-integration-repair-${input.taskId}`,
    cwd: input.executionCwd,
    prompt: buildIntegrationRepairPrompt(input.goal, input.branch, input.conflictingFiles, input.repairGuidanceContext, input.repairSkillBundleText),
    model: input.repairModel,
    tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
    limits: input.limits,
    metadata: {
      role: "repair",
      runId: input.runId,
      phase: "integration",
      taskId: input.taskId,
    },
  });

  const remainingConflicts = await readGitConflictFiles(input.executionCwd);
  const mergeInProgress = await hasGitMergeInProgress(input.executionCwd);
  if (remainingConflicts.length > 0) {
    await appendFactoryRunEvent(input.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "integration.repair_failed",
      data: {
        taskId: input.taskId,
        branch: input.branch,
        conflictingFiles: remainingConflicts,
      },
    });
    return false;
  }

  if (mergeInProgress) {
    await execFileAsync("git", ["add", "-A"], { cwd: input.executionCwd, windowsHide: true });
    await execFileAsync("git", ["commit", "--no-edit"], { cwd: input.executionCwd, windowsHide: true });
  }

  await appendFactoryRunEvent(input.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "integration.repair_completed",
    data: {
      taskId: input.taskId,
      branch: input.branch,
    },
  });
  return true;
}

export async function classifyIntegrationFailure(
  cwd: string,
  error: unknown,
): Promise<{ reason: string; conflictingFiles: string[]; mergeInProgress: boolean }> {
  const reason = error instanceof Error ? error.message : String(error);
  const conflictingFiles = await readGitConflictFiles(cwd);
  const mergeInProgress = await hasGitMergeInProgress(cwd);
  return {
    reason,
    conflictingFiles,
    mergeInProgress,
  };
}


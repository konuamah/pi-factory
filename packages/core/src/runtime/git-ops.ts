// Git primitives — extracted from controller.ts. Read-only + commit helpers
// around the worktree/merge lifecycle; no controller state.

import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createSiblingGitWorktree } from "../git/worktree.js";
import type { PlannerTask } from "./planner.js";
import type { TaskWorkspaceSelection } from "./controller.js";

const execFileAsync = promisify(execFile);

export async function readGitConflictFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--name-only", "--diff-filter=U"], {
      cwd,
      windowsHide: true,
    });
    return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export async function hasGitMergeInProgress(cwd: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], {
      cwd,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

export async function resolveTaskWorkspace(input: {
  cwd: string;
  taskId: string;
  executionBranch?: string;
  worktreeLocation?: string;
  allowTaskWorktrees: boolean;
}): Promise<TaskWorkspaceSelection> {
  if (!input.allowTaskWorktrees) {
    return {
      taskId: input.taskId,
      path: input.cwd,
      mode: "in-place",
      branch: input.executionBranch,
      shouldIntegrate: false,
    };
  }

  const workspace = await createSiblingGitWorktree({
    cwd: input.cwd,
    branchName: `${input.executionBranch ?? "factory"}-${input.taskId}`,
    baseRef: input.executionBranch,
    preferredLocation: input.worktreeLocation,
  });

  return {
    taskId: input.taskId,
    path: workspace.path,
    mode: workspace.mode,
    branch: workspace.branch,
    shouldIntegrate: workspace.path !== input.cwd && Boolean(workspace.branch),
  };
}

export interface WorkspaceCommitResult {
  committed: boolean;
  changedFiles: string[];
  allChangedFiles: string[];
  commitSha?: string;
}

export async function commitWorkspaceChanges(cwd: string, task: PlannerTask): Promise<WorkspaceCommitResult> {
  try {
    const allChangedFiles = await readChangedFiles(cwd);
    const changedFiles = allChangedFiles.filter((file) => !isTransientFactoryPath(file));
    if (changedFiles.length === 0) {
      return { committed: false, changedFiles, allChangedFiles };
    }
    await execFileAsync("git", ["add", "--all", "--", ...changedFiles], { cwd, windowsHide: true });
    await execFileAsync("git", ["commit", "-m", `Factory task ${task.id}: ${task.title}`], {
      cwd,
      windowsHide: true,
    });
    const commitSha = await readGitHeadSha(cwd);
    return { committed: true, changedFiles, allChangedFiles, commitSha };
  } catch {
    return { committed: false, changedFiles: [], allChangedFiles: [] };
  }
}

export async function readChangedFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd, windowsHide: true });
    return stdout
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => line.slice(3).trim())
      .filter(Boolean)
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function readGitHeadSha(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd, windowsHide: true });
    const value = stdout.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

export function isTransientFactoryPath(file: string): boolean {
  const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  const segments = [
    ".pi-glla/",
    ".factory/runs/",
    ".worktrees/",
    "worktrees/",
    "dist/",
    "build/",
    "coverage/",
    "node_modules/",
    ".next/",
    ".turbo/",
    "out/",
    "target/",
    "__pycache__/",
    ".cache/",
    ".venv/",
    "venv/",
  ];
  return segments.some((segment) => normalized === segment.slice(0, -1) || normalized.startsWith(segment));
}


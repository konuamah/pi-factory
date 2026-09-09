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

export interface CandidateDiffRenderResult {
  ok: boolean;
  diff: string;
  fileCount: number;
  additions: number;
  deletions: number;
  truncated: boolean;
  strategy?: "per-commit" | "origin-base" | "local-base";
  error?: string;
}

export async function renderCandidateDiff(input: {
  cwd: string;
  commitShas?: string[];
  changedFiles?: string[];
  baseBranch?: string;
  maxChars?: number;
}): Promise<CandidateDiffRenderResult> {
  const changedFiles = uniqueNormalizedPaths(input.changedFiles ?? []);
  const commitShas = [...new Set((input.commitShas ?? []).map((value) => value.trim()).filter(Boolean))];
  const maxChars = Math.max(1_000, input.maxChars ?? 40_000);

  const perCommit = await renderPerCommitDiff(input.cwd, commitShas, changedFiles);
  if (perCommit) {
    return finalizeCandidateDiff(perCommit, changedFiles, maxChars, "per-commit");
  }

  const baseBranch = (input.baseBranch ?? "main").trim() || "main";
  for (const candidate of [
    { ref: `origin/${baseBranch}`, strategy: "origin-base" as const },
    { ref: baseBranch, strategy: "local-base" as const },
  ]) {
    try {
      const args = ["diff", "--no-ext-diff", `${candidate.ref}...HEAD`];
      if (changedFiles.length > 0) {
        args.push("--", ...changedFiles);
      }
      const { stdout } = await execFileAsync("git", args, { cwd: input.cwd, windowsHide: true });
      if (stdout.trim()) {
        return finalizeCandidateDiff(stdout, changedFiles, maxChars, candidate.strategy);
      }
    } catch {
      // Try the next candidate ref.
    }
  }

  return {
    ok: false,
    diff: "",
    fileCount: changedFiles.length,
    additions: 0,
    deletions: 0,
    truncated: false,
    error: changedFiles.length > 0
      ? `Could not render candidate diff for ${changedFiles.length} changed file(s).`
      : "Could not render candidate diff because no changed files were available.",
  };
}

async function renderPerCommitDiff(cwd: string, commitShas: string[], changedFiles: string[]): Promise<string | undefined> {
  if (commitShas.length === 0) {
    return undefined;
  }

  const chunks: string[] = [];
  for (const commitSha of commitShas) {
    try {
      const args = ["diff", "--no-ext-diff", `${commitSha}^`, commitSha];
      if (changedFiles.length > 0) {
        args.push("--", ...changedFiles);
      }
      const { stdout } = await execFileAsync("git", args, { cwd, windowsHide: true });
      chunks.push(stdout.trimEnd());
    } catch {
      return undefined;
    }
  }

  const combined = chunks.filter(Boolean).join("\n\n").trim();
  return combined || undefined;
}

function finalizeCandidateDiff(
  rawDiff: string,
  changedFiles: string[],
  maxChars: number,
  strategy: CandidateDiffRenderResult["strategy"],
): CandidateDiffRenderResult {
  const normalized = rawDiff.trim();
  const additions = countUnifiedDiffLines(normalized, "+");
  const deletions = countUnifiedDiffLines(normalized, "-");
  const truncated = normalized.length > maxChars;
  const diff = truncated
    ? `${normalized.slice(0, maxChars)}\n\n[diff truncated after ${maxChars} characters]`
    : normalized;

  return {
    ok: Boolean(diff),
    diff,
    fileCount: changedFiles.length > 0 ? changedFiles.length : countDiffFiles(normalized),
    additions,
    deletions,
    truncated,
    strategy,
  };
}

function countUnifiedDiffLines(diff: string, prefix: "+" | "-"): number {
  return diff
    .split(/\r?\n/)
    .filter((line) => line.startsWith(prefix) && !line.startsWith(prefix.repeat(3)))
    .length;
}

function countDiffFiles(diff: string): number {
  return diff
    .split(/\r?\n/)
    .filter((line) => line.startsWith("diff --git "))
    .length;
}

function uniqueNormalizedPaths(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}


import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadEffectiveConfig } from "../config/loader.js";
import { pruneDependencyCache } from "../runtime/dependency-cache.js";

const execFileAsync = promisify(execFile);

export interface CleanupFactoryRunsResult {
  runsDir: string;
  retainRuns: number;
  keptRunIds: string[];
  removedRunIds: string[];
  removedWorktrees: string[];
  removedBranches: string[];
  removedRunDirs: string[];
  warnings: string[];
  prunedCache: Awaited<ReturnType<typeof pruneDependencyCache>>;
}

export interface RemoveRunGitIsolationResult {
  removedWorktrees: string[];
  removedBranches: string[];
  warnings: string[];
}

/**
 * Remove the git isolation (worktrees and branches) recorded for a single run.
 * Runs `git worktree prune` afterwards so stale metadata is cleared even when
 * a worktree directory was already removed externally.
 */
export async function removeRunGitIsolation(input: {
  runDir: string;
  projectRoot: string;
  pruneWorktrees: boolean;
  pruneBranches: boolean;
  baseBranch: string;
}): Promise<RemoveRunGitIsolationResult> {
  const tasks = await readTaskArtifacts(path.join(input.runDir, "tasks"));
  const removedWorktrees: string[] = [];
  const removedBranches: string[] = [];
  const warnings: string[] = [];

  if (input.pruneWorktrees) {
    // Only remove worktrees Factory actually created (mode === "created").
    // Pre-existing or in-place workspaces must never be removed.
    const createdEntries = tasks.filter((task) => task.workspaceMode === "created");
    const workspacePaths = Array.from(new Set(
      createdEntries
        .map((task) => (typeof task.workspacePath === "string" ? task.workspacePath : undefined))
        .filter((value): value is string => Boolean(value)),
    ));
    for (const workspacePath of workspacePaths) {
      if (workspacePath === input.projectRoot) {
        continue;
      }
      try {
        await execFileAsync("git", ["worktree", "remove", "--force", workspacePath], {
          cwd: input.projectRoot,
          windowsHide: true,
        });
        removedWorktrees.push(workspacePath);
      } catch (error) {
        warnings.push(`Failed to remove worktree ${workspacePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Clear stale worktree metadata even when directories were removed externally
    // (git worktree remove would fail for already-missing paths).
    try {
      await execFileAsync("git", ["worktree", "prune"], {
        cwd: input.projectRoot,
        windowsHide: true,
      });
    } catch (error) {
      warnings.push(`Failed to prune stale worktrees: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (input.pruneBranches) {
    // Only delete branches Factory created on worktrees it created.
    const createdEntries = tasks.filter((task) => task.workspaceMode === "created");
    const branchNames = Array.from(new Set(
      createdEntries
        .map((task) => (typeof task.workspaceBranch === "string" ? task.workspaceBranch : undefined))
        .filter((value): value is string => Boolean(value)),
    ));
    for (const branch of branchNames) {
      if (branch === input.baseBranch) {
        continue;
      }
      try {
        await execFileAsync("git", ["branch", "-D", branch], {
          cwd: input.projectRoot,
          windowsHide: true,
        });
        removedBranches.push(branch);
      } catch (error) {
        warnings.push(`Failed to delete branch ${branch}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return { removedWorktrees, removedBranches, warnings };
}

export async function cleanupFactoryRuns(input: {
  cwd: string;
  retainRuns?: number;
}): Promise<CleanupFactoryRunsResult> {
  const loaded = await loadEffectiveConfig({ cwd: input.cwd });
  const root = path.dirname(loaded.sources.projectConfigPath ?? path.join(input.cwd, ".factory", "config.yaml"));
  const projectRoot = path.dirname(root);
  const runsDir = path.join(projectRoot, ".factory", "runs");
  const retainRuns = input.retainRuns ?? loaded.effectiveConfig.git.cleanup.retainRuns;

  const runIds = await listRunDirectories(runsDir);
  const keptRunIds = runIds.slice(0, retainRuns);
  const removedRunIds = runIds.slice(retainRuns);
  const removedWorktrees: string[] = [];
  const removedBranches: string[] = [];
  const removedRunDirs: string[] = [];
  const warnings: string[] = [];

  for (const runId of removedRunIds) {
    const runDir = path.join(runsDir, runId);

    const isolation = await removeRunGitIsolation({
      runDir,
      projectRoot,
      pruneWorktrees: loaded.effectiveConfig.git.cleanup.pruneWorktrees,
      pruneBranches: loaded.effectiveConfig.git.cleanup.pruneBranches,
      baseBranch: loaded.effectiveConfig.git.baseBranch,
    });
    removedWorktrees.push(...isolation.removedWorktrees);
    removedBranches.push(...isolation.removedBranches);
    warnings.push(...isolation.warnings);

    try {
      await fs.rm(runDir, { recursive: true, force: true });
      removedRunDirs.push(runDir);
    } catch (error) {
      warnings.push(`Failed to remove run dir ${runDir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const prunedCache = await pruneDependencyCache({
    cacheRoot: loaded.effectiveConfig.dependencies.cacheRoot,
    maxAgeDays: loaded.effectiveConfig.dependencies.cacheMaxAgeDays,
  });
  warnings.push(...prunedCache.warnings);
  return {
    runsDir,
    retainRuns,
    keptRunIds,
    removedRunIds,
    removedWorktrees,
    removedBranches,
    removedRunDirs,
    warnings,
    prunedCache,
  };
}

async function listRunDirectories(runsDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(runsDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readTaskArtifacts(tasksDir: string): Promise<Record<string, unknown>[]> {
  try {
    const entries = await fs.readdir(tasksDir);
    const files = entries.filter((entry) => entry.endsWith(".json")).sort();
    const results: Record<string, unknown>[] = [];
    for (const file of files) {
      const raw = await fs.readFile(path.join(tasksDir, file), "utf8");
      results.push(JSON.parse(raw) as Record<string, unknown>);
    }
    return results;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

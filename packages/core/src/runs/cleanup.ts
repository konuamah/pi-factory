import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadEffectiveConfig } from "../config/loader.js";

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
    const tasks = await readTaskArtifacts(path.join(runDir, "tasks"));

    if (loaded.effectiveConfig.git.cleanup.pruneWorktrees) {
      const workspacePaths = Array.from(new Set(
        tasks
          .map((task) => (typeof task.workspacePath === "string" ? task.workspacePath : undefined))
          .filter((value): value is string => Boolean(value)),
      ));
      for (const workspacePath of workspacePaths) {
        if (workspacePath === projectRoot) {
          continue;
        }
        try {
          await execFileAsync("git", ["worktree", "remove", "--force", workspacePath], {
            cwd: projectRoot,
            windowsHide: true,
          });
          removedWorktrees.push(workspacePath);
        } catch (error) {
          warnings.push(`Failed to remove worktree ${workspacePath}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    if (loaded.effectiveConfig.git.cleanup.pruneBranches) {
      const branchNames = Array.from(new Set(
        tasks
          .map((task) => (typeof task.workspaceBranch === "string" ? task.workspaceBranch : undefined))
          .filter((value): value is string => Boolean(value)),
      ));
      for (const branch of branchNames) {
        if (branch === loaded.effectiveConfig.git.baseBranch) {
          continue;
        }
        try {
          await execFileAsync("git", ["branch", "-D", branch], {
            cwd: projectRoot,
            windowsHide: true,
          });
          removedBranches.push(branch);
        } catch (error) {
          warnings.push(`Failed to delete branch ${branch}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    try {
      await fs.rm(runDir, { recursive: true, force: true });
      removedRunDirs.push(runDir);
    } catch (error) {
      warnings.push(`Failed to remove run dir ${runDir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    runsDir,
    retainRuns,
    keptRunIds,
    removedRunIds,
    removedWorktrees,
    removedBranches,
    removedRunDirs,
    warnings,
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

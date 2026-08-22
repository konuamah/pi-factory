import fs from "node:fs/promises";
import { discoverFactoryProject } from "../project/discovery.js";
import { loadEffectiveConfig } from "../config/loader.js";
import { inspectGitIsolation, resolveWorktreeLocation } from "../git/worktree.js";

export interface FactoryDoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface FactoryDoctorResult {
  checks: FactoryDoctorCheck[];
}

export async function runFactoryDoctor(cwd: string): Promise<FactoryDoctorResult> {
  const project = await discoverFactoryProject(cwd);
  const checks: FactoryDoctorCheck[] = [];

  checks.push({
    name: "git-root",
    ok: Boolean(project.paths.gitRoot),
    detail: project.paths.gitRoot ?? "No .git directory found from cwd upward",
  });

  checks.push({
    name: "constitution",
    ok: Boolean(project.paths.constitutionPath),
    detail: project.paths.constitutionPath ?? "Missing CONSTITUTION.md",
  });

  checks.push({
    name: "workflow",
    ok: Boolean(project.paths.workflowPath),
    detail: project.paths.workflowPath ?? "Missing factory.yaml",
  });

  checks.push({
    name: "project-config",
    ok: Boolean(project.paths.projectConfigPath),
    detail: project.paths.projectConfigPath ?? "Missing .factory/config.yaml",
  });

  checks.push({
    name: "runs-dir",
    ok: await pathExists(project.paths.runsDir),
    detail: project.paths.runsDir,
  });

  try {
    const loaded = await loadEffectiveConfig({ cwd });
    checks.push({
      name: "config-load",
      ok: true,
      detail: `Loaded base branch ${loaded.effectiveConfig.git.baseBranch}`,
    });

    const configuredCommands = Object.entries(loaded.effectiveConfig.commands)
      .filter(([, value]) => Boolean(value))
      .map(([key, value]) => `${key}=${value}`);

    checks.push({
      name: "commands-configured",
      ok: configuredCommands.length > 0,
      detail: configuredCommands.length > 0 ? configuredCommands.join(", ") : "No repository commands configured",
    });

    const isolation = await inspectGitIsolation(cwd);
    checks.push({
      name: "git-isolation",
      ok: true,
      detail: isolation.isLinkedWorktree
        ? `Already in linked worktree${isolation.branch ? ` on ${isolation.branch}` : ""}`
        : isolation.isSubmodule
          ? "Inside submodule; treat as normal repo checkout"
          : "Standard checkout (not currently a linked worktree)",
    });

    if (project.paths.gitRoot && loaded.effectiveConfig.git.allowWorktrees) {
      const location = await resolveWorktreeLocation(
        project.paths.gitRoot,
        loaded.effectiveConfig.git.worktreeDir,
      );
      checks.push({
        name: "worktree-location",
        ok: true,
        detail: `${location.relativeDir} (${location.absoluteDir})`,
      });
    }
  } catch (error) {
    checks.push({
      name: "config-load",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  return { checks };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

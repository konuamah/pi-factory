import fs from "node:fs/promises";
import path from "node:path";
import type { ModelRole, ModelSelection } from "@factory/schemas";
import { discoverFactoryProject } from "../project/discovery.js";
import { loadEffectiveConfig } from "../config/loader.js";
import { inspectGitIsolation, resolveWorktreeLocation } from "../git/worktree.js";
import { preflightModelRouting, resolveModelForRole } from "../models/index.js";
import { collectVisiblePiModels, detectPiModelConfiguration, modelSelectionKey } from "../setup/pi-models.js";

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
  const projectRoot = project.paths.gitRoot ?? cwd;
  const checks: FactoryDoctorCheck[] = [];

  checks.push({
    name: "git-root",
    ok: Boolean(project.paths.gitRoot),
    detail: project.paths.gitRoot ? formatProjectPath(projectRoot, project.paths.gitRoot) : "No .git directory found from cwd upward",
  });

  let constitutionEnabled = false;
  try {
    const loaded = await loadEffectiveConfig({ cwd });
    constitutionEnabled = loaded.effectiveConfig.constitution.enabled;
  } catch {
    // Config-load reports malformed configuration below.
  }
  checks.push({
    name: "constitution",
    ok: !constitutionEnabled || Boolean(project.paths.constitutionPath),
    detail: constitutionEnabled
      ? project.paths.constitutionPath ?? "Missing CONSTITUTION.md"
      : "disabled",
  });

  checks.push({
    name: "workflow",
    ok: Boolean(project.paths.workflowPath),
    detail: project.paths.workflowPath ? formatProjectPath(projectRoot, project.paths.workflowPath) : "Missing factory.yaml",
  });

  checks.push({
    name: "project-config",
    ok: Boolean(project.paths.projectConfigPath),
    detail: project.paths.projectConfigPath ? formatProjectPath(projectRoot, project.paths.projectConfigPath) : "Missing .factory/config.yaml",
  });

  checks.push({
    name: "runs-dir",
    ok: await pathExists(project.paths.runsDir),
    detail: formatProjectPath(projectRoot, project.paths.runsDir),
  });

  try {
    const loaded = await loadEffectiveConfig({ cwd });
    checks.push({
      name: "config-load",
      ok: true,
      detail: `baseBranch=${loaded.effectiveConfig.git.baseBranch}`,
    });

    const configuredCommands = Object.entries(loaded.effectiveConfig.commands)
      .filter(([, value]) => Boolean(value))
      .map(([key]) => key);

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
        ? `linked worktree${isolation.branch ? ` on ${isolation.branch}` : ""}`
        : isolation.isSubmodule
          ? "submodule checkout"
          : "standard checkout",
    });

    if (project.paths.gitRoot && loaded.effectiveConfig.git.allowWorktrees) {
      const location = await resolveWorktreeLocation(
        project.paths.gitRoot,
        loaded.effectiveConfig.git.worktreeDir,
      );
      checks.push({
        name: "worktree-location",
        ok: true,
        detail: location.relativeDir,
      });
    }

    const modelReadinessChecks = await buildModelReadinessChecks(
      projectRoot,
      loaded.effectiveConfig,
    );
    checks.push(...modelReadinessChecks);
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

async function buildModelReadinessChecks(
  projectRoot: string,
  config: Awaited<ReturnType<typeof loadEffectiveConfig>>["effectiveConfig"],
): Promise<FactoryDoctorCheck[]> {
  const roles: ModelRole[] = ["discovery", "planner", "builder", "reviewer", "repair", "landing"];
  const taskTypes = ["general", ...Object.keys(config.taskTypes ?? {})];
  const checks: FactoryDoctorCheck[] = [];
  const routingErrors = preflightModelRouting({ taskTypes, roles, config });

  if (routingErrors.length === 0) {
    checks.push({
      name: "model-routing",
      ok: true,
      detail: `Validated ${taskTypes.length} task type path(s) across ${roles.length} role(s)`,
    });
  } else {
    for (const entry of routingErrors) {
      checks.push({
        name: "model-routing",
        ok: false,
        detail: [
          `role=${entry.role}`,
          `taskType=${entry.taskType}`,
          `configured source=${routingFixSource(entry.taskType, entry.role)}`,
          entry.error,
          "Fix: run /factory models, then edit .factory/config.yaml.",
        ].join(" | "),
      });
    }
  }

  const resolvedModels: Array<{ role: ModelRole; taskType: string; model: ModelSelection; source: string }> = [];
  for (const taskType of taskTypes) {
    for (const role of roles) {
      try {
        const resolved = resolveModelForRole({ role, taskType, config });
        resolvedModels.push({
          role,
          taskType,
          model: resolved.model,
          source: resolved.source,
        });
      } catch {
        // Routing failures are already reported above.
      }
    }
  }

  let visibleModels: ModelSelection[];
  try {
    const pi = await detectPiModelConfiguration(projectRoot);
    visibleModels = collectVisiblePiModels(pi);
  } catch (error) {
    checks.push({
      name: "model-availability",
      ok: false,
      detail: `Unable to load Pi model inventory: ${error instanceof Error ? error.message : String(error)} | Fix: run /factory models, then repair Pi model discovery or .factory/config.yaml.`,
    });
    return checks;
  }

  const visibleModelKeys = new Set(visibleModels.map((selection) => modelSelectionKey(selection)));
  const availabilityFailures = resolvedModels.filter(({ model }) => !visibleModelKeys.has(modelSelectionKey(model)));

  if (availabilityFailures.length === 0) {
    checks.push({
      name: "model-availability",
      ok: true,
      detail: `Validated ${resolvedModels.length} resolved model route(s) against Pi inventory`,
    });
    return checks;
  }

  for (const failure of availabilityFailures) {
    checks.push({
      name: "model-availability",
      ok: false,
      detail: [
        `role=${failure.role}`,
        `taskType=${failure.taskType}`,
        `configured source=${failure.source}`,
        `missing model key=${modelSelectionKey(failure.model)}`,
        "Fix: run /factory models, then edit .factory/config.yaml.",
      ].join(" | "),
    });
  }

  return checks;
}

function routingFixSource(taskType: string, role: ModelRole): string {
  if (taskType === "general") {
    return `models.${role}`;
  }
  return `taskTypes.${taskType}.routing.${role} -> models.${role}`;
}

function formatProjectPath(projectRoot: string, target: string): string {
  const relative = path.relative(projectRoot, target).replace(/\\/g, "/");
  if (relative === ".") {
    return ".";
  }
  if (!relative.startsWith("..")) {
    return relative;
  }
  return target;
}

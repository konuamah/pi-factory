import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  EffectiveFactoryConfig,
  GlobalFactoryConfig,
  ProjectFactoryConfig,
  RunOverrides,
  WorkflowConfig,
} from "@factory/schemas";
import { builtInDefaults } from "./defaults.js";
import { mergeConfigLayers } from "./merge.js";
import { validateEffectiveConfig } from "./validate.js";
import { discoverFactoryProject } from "../project/discovery.js";
import { readCurrentGitBranch } from "../git/branch.js";
import { CURRENT_BRANCH_SENTINEL } from "@factory/schemas";

export interface LoadedFactoryConfig {
  effectiveConfig: EffectiveFactoryConfig;
  sources: {
    globalConfigPath: string;
    projectConfigPath?: string;
    workflowPath?: string;
  };
  /** True when any baseBranch field used the `@current` sentinel this load. */
  baseBranchSource?: "current" | "explicit";
}

export async function loadEffectiveConfig(input: {
  cwd: string;
  runOverrides?: RunOverrides;
  globalConfigPath?: string;
}): Promise<LoadedFactoryConfig> {
  const project = await discoverFactoryProject(input.cwd);
  const globalConfigPath = input.globalConfigPath ?? path.join(os.homedir(), ".factory", "config.yaml");

  const [globalConfig, projectConfig, workflow] = await Promise.all([
    readJsonLike<GlobalFactoryConfig>(globalConfigPath),
    project.paths.projectConfigPath ? readJsonLike<ProjectFactoryConfig>(project.paths.projectConfigPath) : Promise.resolve(undefined),
    project.paths.workflowPath ? readJsonLike<WorkflowConfig>(project.paths.workflowPath) : Promise.resolve(undefined),
  ]);

  const projectRoot = project.paths.gitRoot ?? input.cwd;
  const mergedConfig = mergeConfigLayers({
    builtIns: builtInDefaults,
    global: globalConfig,
    project: projectConfig,
    workflow,
    runOverrides: input.runOverrides,
  });
  if (!path.isAbsolute(mergedConfig.dependencies.cacheRoot)) {
    mergedConfig.dependencies.cacheRoot = path.resolve(projectRoot, mergedConfig.dependencies.cacheRoot);
  }
  const hadSentinel =
    mergedConfig.git.baseBranch === CURRENT_BRANCH_SENTINEL ||
    mergedConfig.project.baseBranch === CURRENT_BRANCH_SENTINEL ||
    mergedConfig.git.pullRequest.baseBranch === CURRENT_BRANCH_SENTINEL;
  await resolveCurrentBranchSentinels(mergedConfig, projectRoot);
  const effectiveConfig = validateEffectiveConfig(mergedConfig, { projectRoot });

  return {
    effectiveConfig,
    sources: {
      globalConfigPath,
      projectConfigPath: project.paths.projectConfigPath,
      workflowPath: project.paths.workflowPath,
    },
    baseBranchSource: hadSentinel ? "current" : "explicit",
  };
}

/**
 * Resolve `git.baseBranch` / `project.baseBranch` / `git.pullRequest.baseBranch`
 * when set to the `@current` sentinel: use the branch checked out in the
 * project root. Resolved once per load, before validation, so the effective
 * config (and the per-run effective-config.json snapshot) always holds a
 * concrete branch name. Fails loud on detached HEAD / non-git so a run never
 * silently targets the wrong branch.
 */
async function resolveCurrentBranchSentinels(
  config: EffectiveFactoryConfig,
  projectRoot: string,
): Promise<void> {
  const fields: Array<{ path: string; value?: string }> = [
    { path: "git.baseBranch", value: config.git.baseBranch },
    { path: "project.baseBranch", value: config.project.baseBranch },
    { path: "git.pullRequest.baseBranch", value: config.git.pullRequest.baseBranch },
  ];
  const sentinelFields = fields.filter((field) => field.value === CURRENT_BRANCH_SENTINEL);
  if (sentinelFields.length === 0) {
    return;
  }

  const current = await readCurrentGitBranch(projectRoot);
  if (!current) {
    throw new Error(
      `baseBranch: ${CURRENT_BRANCH_SENTINEL} could not be resolved (detached HEAD or not a git repository at ${projectRoot}). ` +
        `Fields: ${sentinelFields.map((field) => field.path).join(", ")}. Check out a branch or set an explicit baseBranch.`,
    );
  }

  for (const field of sentinelFields) {
    if (field.path === "git.baseBranch") {
      config.git.baseBranch = current;
    } else if (field.path === "project.baseBranch") {
      config.project.baseBranch = current;
    } else {
      config.git.pullRequest.baseBranch = current;
    }
  }
}

async function readJsonLike<T>(filePath: string): Promise<T | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return parseConfigContent<T>(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new Error(`Failed to read config ${filePath}.`, {
      cause: error,
    });
  }
}

function parseConfigContent<T>(raw: string): T {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {} as T;
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed) as T;
  }

  return parseYaml(trimmed) as T;
}

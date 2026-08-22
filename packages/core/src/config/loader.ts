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

export interface LoadedFactoryConfig {
  effectiveConfig: EffectiveFactoryConfig;
  sources: {
    globalConfigPath: string;
    projectConfigPath?: string;
    workflowPath?: string;
  };
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

  const effectiveConfig = validateEffectiveConfig(
    mergeConfigLayers({
      builtIns: builtInDefaults,
      global: globalConfig,
      project: projectConfig,
      workflow,
      runOverrides: input.runOverrides,
    }),
  );

  return {
    effectiveConfig,
    sources: {
      globalConfigPath,
      projectConfigPath: project.paths.projectConfigPath,
      workflowPath: project.paths.workflowPath,
    },
  };
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

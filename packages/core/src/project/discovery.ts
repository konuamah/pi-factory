import fs from "node:fs/promises";
import path from "node:path";
import type { FactoryProjectPaths } from "@factory/schemas";
import { buildProjectPaths } from "../config/paths.js";

export interface DiscoveredFactoryProject {
  paths: FactoryProjectPaths;
}

export async function discoverFactoryProject(cwd: string): Promise<DiscoveredFactoryProject> {
  const gitRoot = await findGitRoot(cwd);
  const candidatePaths = buildProjectPaths(cwd, gitRoot);

  return {
    paths: {
      cwd,
      gitRoot,
      constitutionPath: await exists(candidatePaths.constitutionPath) ? candidatePaths.constitutionPath : undefined,
      workflowPath: await exists(candidatePaths.workflowPath) ? candidatePaths.workflowPath : undefined,
      projectConfigPath: await exists(candidatePaths.projectConfigPath) ? candidatePaths.projectConfigPath : undefined,
      runsDir: candidatePaths.runsDir,
    },
  };
}

async function findGitRoot(start: string): Promise<string | undefined> {
  let current = path.resolve(start);

  while (true) {
    if (await exists(path.join(current, ".git"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

async function exists(target: string | undefined): Promise<boolean> {
  if (!target) return false;
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

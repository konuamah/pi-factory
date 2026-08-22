import path from "node:path";
import type { FactoryProjectPaths } from "@factory/schemas";

export function buildProjectPaths(cwd: string, gitRoot?: string): FactoryProjectPaths {
  const root = gitRoot ?? cwd;

  return {
    cwd,
    gitRoot,
    constitutionPath: path.join(root, "CONSTITUTION.md"),
    workflowPath: path.join(root, "factory.yaml"),
    projectConfigPath: path.join(root, ".factory", "config.yaml"),
    runsDir: path.join(root, ".factory", "runs"),
  };
}

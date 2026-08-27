import os from "node:os";
import path from "node:path";
import type { FactoryBuiltInDefaults } from "@factory/schemas";

export const builtInDefaults: FactoryBuiltInDefaults = {
  models: {
    discovery: { model: "sonnet" },
    planner: { model: "opus" },
    builder: { model: "sonnet" },
    reviewer: { model: "opus" },
    repair: { model: "sonnet" },
  },
  runtime: {
    maxParallelAgents: 2,
  },
  ui: {
    showWorkerDetails: false,
  },
  defaults: {
    autonomy: "safe",
    workflow: "balanced",
  },
  repair: {
    enabled: true,
    maxAttempts: 3,
  },
  constitution: {
    enabled: false,
  },
  approval: {
    finalMerge: "required",
  },
  git: {
    cleanup: {
      retainRuns: 10,
      pruneWorktrees: true,
      pruneBranches: true,
    },
  },
  dashboard: {
    enabled: false,
    port: 4199,
    host: "127.0.0.1",
    autoOpen: false,
  },
  dependencies: {
    enabled: true,
    hydrate: "auto",
    cacheRoot: path.join(os.homedir(), ".factory", "cache"),
  },
};

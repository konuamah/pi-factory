import type { FactoryBuiltInDefaults } from "@factory/schemas";

export const builtInDefaults: FactoryBuiltInDefaults = {
  models: {
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
  approval: {
    finalMerge: "required",
  },
};

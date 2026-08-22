import type { EffectiveFactoryConfig } from "@factory/schemas";

export function validateEffectiveConfig(config: EffectiveFactoryConfig): EffectiveFactoryConfig {
  if (config.runtime.maxParallelAgents < 1) {
    throw new Error("runtime.maxParallelAgents must be >= 1");
  }

  if (config.repair.maxAttempts < 0) {
    throw new Error("repair.maxAttempts must be >= 0");
  }

  if (!config.git.baseBranch.trim()) {
    throw new Error("git.baseBranch is required");
  }

  if (!config.project.baseBranch.trim()) {
    throw new Error("project.baseBranch is required");
  }

  if (config.git.cleanup.retainRuns < 0) {
    throw new Error("git.cleanup.retainRuns must be >= 0");
  }

  return config;
}

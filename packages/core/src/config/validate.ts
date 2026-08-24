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

  if (typeof config.commands.cwd === "string" && !config.commands.cwd.trim()) {
    throw new Error("commands.cwd must not be empty when provided");
  }

  if (!Number.isInteger(config.dashboard.port) || config.dashboard.port < 1024 || config.dashboard.port > 65535) {
    throw new Error("dashboard.port must be an integer between 1024 and 65535");
  }

  if (!config.dashboard.host.trim()) {
    throw new Error("dashboard.host is required");
  }

  // Security: bind only to loopback by default; deny 0.0.0.0 / public bind without explicit intent.
  if (config.dashboard.host !== "127.0.0.1" && config.dashboard.host !== "localhost" && config.dashboard.host !== "::1") {
    throw new Error("dashboard.host must be 127.0.0.1, localhost, or ::1");
  }

  return config;
}

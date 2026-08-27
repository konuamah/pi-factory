import path from "node:path";
import type { EffectiveFactoryConfig } from "@factory/schemas";

export function validateEffectiveConfig(
  config: EffectiveFactoryConfig,
  options: { projectRoot?: string } = {},
): EffectiveFactoryConfig {
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

  validateSetupCommand(config.commands.setup);
  for (const key of ["lint", "typecheck", "test", "build"] as const) {
    validateCommandString(`commands.${key}`, config.commands[key]);
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

  if (!["auto", "always", "never"].includes(config.dependencies.hydrate)) {
    throw new Error("dependencies.hydrate must be auto, always, or never");
  }

  if (!config.dependencies.cacheRoot.trim()) {
    throw new Error("dependencies.cacheRoot is required");
  }

  const cacheRoot = path.resolve(config.dependencies.cacheRoot);
  if (options.projectRoot) {
    const projectRoot = path.resolve(options.projectRoot);
    const relative = path.relative(projectRoot, cacheRoot);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      throw new Error("dependencies.cacheRoot must be outside the active repository/worktree");
    }
  }

  return config;
}

function validateSetupCommand(value: EffectiveFactoryConfig["commands"]["setup"]): void {
  if (value === undefined) return;
  if (typeof value === "string") {
    if (!value.trim()) {
      throw new Error("commands.setup must not be empty when provided");
    }
    return;
  }
  if (!Array.isArray(value)) {
    throw new Error("commands.setup must be a shell command string or a list of setup steps with command");
  }
  if (value.length === 0) {
    throw new Error("commands.setup must include at least one setup step when provided as a list");
  }
  for (const [index, step] of value.entries()) {
    const label = `commands.setup[${index}]`;
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      throw new Error(`${label} must be an object with command`);
    }
    if (typeof step.command !== "string" || !step.command.trim()) {
      throw new Error(`${label}.command must be a non-empty shell command string`);
    }
    if (step.name !== undefined && (typeof step.name !== "string" || !step.name.trim())) {
      throw new Error(`${label}.name must be a non-empty string when provided`);
    }
    if (step.description !== undefined && typeof step.description !== "string") {
      throw new Error(`${label}.description must be a string when provided`);
    }
  }
}

function validateCommandString(name: string, value: string | undefined): void {
  if (value === undefined) return;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty shell command string when provided`);
  }
}

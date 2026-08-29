import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EffectiveFactoryConfig, SetupCommandConfig } from "@factory/schemas";
import { pathExists } from "./fs-utils.js";
import { applyRemediation, truncate, buildExecutionRemediationCandidate } from "./dependency-remediation.js";
import { resolveCommandCwd, collectDependencyFiles, inferPackageManagers, eventData, assertCacheRootOutsideWorkspace, computeDependencyKey, buildDependencyCacheEnv } from "./dependency-cache.js";
import { SHELL_BUILTINS, findAlternatives, buildRemediationCandidate } from "./dependency-remediation.js";
import { commandExists } from "./dependency-cache.js";

const execFileAsync = promisify(execFile);

export interface DependencyHydrationRemediationCandidate {
  executable: string;
  replacement: string;
  originalCommand: string;
  remediatedCommand: string;
  stepName?: string;
  reason: string;
  confidence: "HIGH" | "MEDIUM";
  temporary: true;
  category?: "missing-executable" | "isolated-environment";
}

export interface DependencyHydrationResult {
  status: "completed" | "skipped";
  reason: string;
  dependencyKey?: string;
  markerPath?: string;
  command?: string;
  commands?: DependencyHydrationCommand[];
  cwd?: string;
  cacheRoot: string;
}

export interface DependencyHydrationCommand {
  name?: string;
  description?: string;
  command: string;
}

export interface PreflightResult {
  ok: boolean;
  executable?: string;
  alternatives?: string[];
  remediation?: DependencyHydrationRemediationCandidate;
  stepName?: string;
  command?: string;
}

export class DependencyHydrationError extends Error {
  constructor(
    message: string,
    public readonly details: {
      dependencyKey?: string;
      command?: string;
      stepName?: string;
      cwd?: string;
      exitCode?: number;
      stdout?: string;
      stderr?: string;
    },
  ) {
    super(message);
    this.name = "DependencyHydrationError";
  }
}

export async function hydrateWorkspaceDependencies(input: {
  workspacePath: string;
  projectRoot: string;
  config: EffectiveFactoryConfig;
  runId: string;
  phase: string;
  taskId?: string;
  onEvent?: (event: { type: string; data: Record<string, unknown> }) => Promise<void>;
  onRemediation?: (candidate: DependencyHydrationRemediationCandidate) => Promise<boolean>;
  mode?: "harness" | "agent";
}): Promise<DependencyHydrationResult> {
  const cacheRoot = path.resolve(input.config.dependencies.cacheRoot);
  if (input.mode === "agent") {
    const result = {
      status: "skipped" as const,
      reason: "dependency preparation delegated to agent",
      cacheRoot,
    };
    await input.onEvent?.({ type: "dependencies.agent_delegated", data: eventData(input, result) });
    return result;
  }
  let setupCommands = normalizeSetupCommands(input.config.commands.setup);
  // Preflight: check that setup command executables exist before running.
  if (input.config.dependencies.enabled && input.config.dependencies.hydrate !== "never" && setupCommands.length > 0) {
    const preflight = await preflightSetupCommands(setupCommands);
    await input.onEvent?.({
      type: "dependencies.preflight",
      data: {
        runId: input.runId,
        phase: input.phase,
          workspacePath: input.workspacePath,
        ...preflight,
      },
    });
    if (!preflight.ok && preflight.remediation && input.onRemediation) {
      const approved = await input.onRemediation(preflight.remediation);
      await input.onEvent?.({
        type: approved ? "dependencies.remediation_approved" : "dependencies.remediation_rejected",
        data: {
          runId: input.runId,
          phase: input.phase,
          workspacePath: input.workspacePath,
          ...preflight.remediation,
        },
      });
      if (approved) {
        setupCommands = applyRemediation(setupCommands, preflight.remediation);
      }
    }
    if (!preflight.ok && !preflight.remediation) {
      const alts = preflight.alternatives?.length
        ? ` Alternatives found in PATH: ${preflight.alternatives.join(", ")}. Update the setup command or environment to provide \`${preflight.executable}\`.`
        : ` Update the setup command or add \`${preflight.executable}\` to PATH.`;
      throw new DependencyHydrationError(
        `Setup command requires \`${preflight.executable}\` which is not available in PATH.${alts}`,
        {
          dependencyKey: undefined,
          command: preflight.command,
          stepName: preflight.stepName,
          cwd: resolveCommandCwd(input.workspacePath, input.config.commands.cwd),
          exitCode: undefined,
          stdout: undefined,
          stderr: undefined,
        },
      );
    }
    if (!preflight.ok && preflight.remediation && !input.onRemediation) {
      const alts = preflight.alternatives?.length
        ? ` Alternatives found in PATH: ${preflight.alternatives.join(", ")}. Update the setup command or environment to provide \`${preflight.executable}\`.`
        : ` Update the setup command or add \`${preflight.executable}\` to PATH.`;
      throw new DependencyHydrationError(
        `Setup command requires \`${preflight.executable}\` which is not available in PATH.${alts}`,
        {
          dependencyKey: undefined,
          command: preflight.command,
          stepName: preflight.stepName,
          cwd: resolveCommandCwd(input.workspacePath, input.config.commands.cwd),
          exitCode: undefined,
          stdout: undefined,
          stderr: undefined,
        },
      );
    }
  }
  assertCacheRootOutsideWorkspace(cacheRoot, input.projectRoot);
  assertCacheRootOutsideWorkspace(cacheRoot, input.workspacePath);

  if (!input.config.dependencies.enabled || input.config.dependencies.hydrate === "never") {
    const result = {
      status: "skipped" as const,
      reason: input.config.dependencies.enabled ? "dependency hydration disabled by hydrate=never" : "dependency hydration disabled",
      cacheRoot,
    };
    await input.onEvent?.({ type: "dependencies.hydration_skipped", data: eventData(input, result) });
    return result;
  }

  if (setupCommands.length === 0) {
    const result = {
      status: "skipped" as const,
      reason: "no commands.setup configured",
      cacheRoot,
    };
    await input.onEvent?.({ type: "dependencies.hydration_skipped", data: eventData(input, result) });
    return result;
  }

  const commandCwd = resolveCommandCwd(input.workspacePath, input.config.commands.cwd);
  const setupCommand = formatSetupCommandSummary(setupCommands);
  const dependencyKey = await computeDependencyKey({
    workspacePath: input.workspacePath,
    commandCwd,
    setupCommand,
  });
  const markerPath = path.join(input.workspacePath, ".factory", "dependencies", `${dependencyKey}.json`);

  if (input.config.dependencies.hydrate === "auto" && await pathExists(markerPath)) {
    const result = {
      status: "skipped" as const,
      reason: "dependency marker is current",
      dependencyKey,
      markerPath,
      command: setupCommand,
      commands: setupCommands,
      cwd: commandCwd,
      cacheRoot,
    };
    await input.onEvent?.({ type: "dependencies.hydration_skipped", data: eventData(input, result) });
    return result;
  }

  await fs.mkdir(cacheRoot, { recursive: true });
  await fs.mkdir(path.dirname(markerPath), { recursive: true });
  await input.onEvent?.({
    type: "dependencies.hydration_started",
    data: eventData(input, {
      dependencyKey,
      markerPath,
      command: setupCommand,
      commands: setupCommands,
      cwd: commandCwd,
      cacheRoot,
    }),
  });

  const cacheEnv = await buildDependencyCacheEnv(cacheRoot);
  const stepOutputs: Array<{ name?: string; command: string; stdout?: string; stderr?: string }> = [];
  try {
    for (const step of setupCommands) {
      await input.onEvent?.({
        type: "dependencies.hydration_step_started",
        data: eventData(input, {
          dependencyKey,
          markerPath,
          command: step.command,
          stepName: step.name,
          cwd: commandCwd,
          cacheRoot,
        }),
      });
      let command = step.command;
      let retried = false;
      while (true) {
        try {
          const { stdout, stderr } = await execFileAsync(command, {
            cwd: commandCwd,
            shell: true,
            windowsHide: true,
            env: {
              ...process.env,
              ...cacheEnv,
            },
            maxBuffer: 1024 * 1024 * 10,
          });
          stepOutputs.push({
            name: step.name,
            command,
            stdout: truncate(stdout),
            stderr: truncate(stderr),
          });
          break;
        } catch (error) {
          if (retried) throw error;
          const candidate = buildExecutionRemediationCandidate(step, command, error, commandCwd);
          if (!candidate || !input.onRemediation) throw error;
          const approved = await input.onRemediation(candidate);
          await input.onEvent?.({
            type: approved ? "dependencies.remediation_approved" : "dependencies.remediation_rejected",
            data: eventData(input, { ...candidate }),
          });
          if (!approved) throw error;
          command = candidate.remediatedCommand;
          retried = true;
        }
      }
    }
    await fs.writeFile(markerPath, JSON.stringify({
      dependencyKey,
      command: setupCommand,
      commands: setupCommands,
      cwd: path.relative(input.workspacePath, commandCwd).replace(/\\/g, "/") || ".",
      cacheRoot,
      hydratedAt: new Date().toISOString(),
    }, null, 2), "utf8");
    const result = {
      status: "completed" as const,
      reason: input.config.dependencies.hydrate === "always" ? "hydrate=always" : "dependency marker was missing or stale",
      dependencyKey,
      markerPath,
      command: setupCommand,
      commands: setupCommands,
      cwd: commandCwd,
      cacheRoot,
    };
    await input.onEvent?.({ type: "dependencies.hydration_completed", data: { ...eventData(input, result), stepOutputs } });
    return result;
  } catch (error) {
    const execError = error as Error & { code?: number; stdout?: string; stderr?: string };
    const failedStep = setupCommands[stepOutputs.length] ?? setupCommands[0];
    await input.onEvent?.({
      type: "dependencies.hydration_failed",
      data: eventData(input, {
        dependencyKey,
        markerPath,
        command: failedStep.command,
        stepName: failedStep.name,
        commandPlan: setupCommand,
        commands: setupCommands,
        cwd: commandCwd,
        cacheRoot,
        reason: execError.message,
        exitCode: execError.code,
        stdout: truncate(execError.stdout),
        stderr: truncate(execError.stderr),
      }),
    });
    throw new DependencyHydrationError(
      `Dependency hydration failed while running setup command${failedStep.name ? ` (${failedStep.name})` : ""}: ${failedStep.command}`,
      {
        dependencyKey,
        command: failedStep.command,
        stepName: failedStep.name,
        cwd: commandCwd,
        exitCode: execError.code,
        stdout: execError.stdout,
        stderr: execError.stderr,
      },
    );
  }
}

export function normalizeSetupCommands(value: SetupCommandConfig | undefined): DependencyHydrationCommand[] {
  if (value === undefined) return [];
  if (typeof value === "string") {
    const command = value.trim();
    return command ? [{ command }] : [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((step) => ({
      name: typeof step.name === "string" ? step.name.trim() || undefined : undefined,
      description: typeof step.description === "string" ? step.description : undefined,
      command: typeof step.command === "string" ? step.command.trim() : "",
    }))
    .filter((step) => Boolean(step.command));
}

function formatSetupCommandSummary(commands: DependencyHydrationCommand[]): string {
  return commands.map((step) => step.command).join(" && ");
}

export function extractExecutable(command: string): string | undefined {
  const segments = command.split(/\s*[;&|]+\s*/);
  for (const segment of segments) {
    const parts = segment.trim().split(/\s+/);
    if (parts.length === 0) continue;
    const candidate = parts[0];
    if (!candidate || candidate === "cd") continue;
    return candidate;
  }
  return undefined;
}

export async function preflightSetupCommands(
  steps: DependencyHydrationCommand[],
): Promise<PreflightResult> {
  for (const step of steps) {
    const executable = extractExecutable(step.command);
    if (!executable) continue;
    if (SHELL_BUILTINS.has(executable)) continue;
    if (executable.startsWith("./") || executable.startsWith("../") || executable.includes("/")) continue;
    const found = await commandExists(executable);
    if (!found) {
      const alternatives = await findAlternatives(executable);
      const remediation = await buildRemediationCandidate(step, executable);
      return {
        ok: false,
        executable,
        alternatives,
        remediation,
        stepName: step.name,
        command: step.command,
      };
    }
  }
  return { ok: true };
}

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EffectiveFactoryConfig, SetupCommandConfig } from "@factory/schemas";
import { pathExists } from "./fs-utils.js";

const execFileAsync = promisify(execFile);

const DEPENDENCY_FILE_NAMES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "pyproject.toml",
  "uv.lock",
  "requirements.txt",
  "requirements-dev.txt",
  "poetry.lock",
  "Pipfile",
  "Pipfile.lock",
  "Cargo.toml",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "gradle.lockfile",
]);

const IGNORED_DIRS = new Set([
  ".git",
  ".factory",
  ".worktrees",
  "worktrees",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  "target",
  ".venv",
  "venv",
  "__pycache__",
]);

const SHELL_BUILTINS = new Set([
  "cd", "export", "source", ".", "alias", "unalias",
  "echo", "printf", "read", "test", "true", "false",
  "shift", "set", "unset", "eval", "exec", "return",
  "exit", "trap", "wait", "kill", "jobs", "bg", "fg",
  "hash", "type", "command", "builtin",
]);

const ENVIRONMENT_ALTERNATIVES: Record<string, string[]> = {
  python: ["python3"],
  pip: ["pip3"],
};

// Safe automatic replacements. Factory applies these only after user approval.
const SAFE_REMEDIATIONS: Record<string, string[]> = {
  pip: ["pip3"],
  python: ["python3"],
  mvn: ["./mvnw"],
  gradle: ["./gradlew"],
};

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

async function buildRemediationCandidate(
  step: DependencyHydrationCommand,
  executable: string,
): Promise<DependencyHydrationRemediationCandidate | undefined> {
  const replacement = await findSafeReplacement(executable);
  if (!replacement) return undefined;
  const remediatedCommand = replaceExecutableInCommand(step.command, executable, replacement);
  return {
    executable,
    replacement,
    originalCommand: step.command,
    remediatedCommand: remediatedCommand.trim(),
    stepName: step.name,
    reason: `${executable} is unavailable; ${replacement} was found in PATH.`,
    confidence: "HIGH",
    temporary: true,
  };
}

async function findAlternatives(executable: string): Promise<string[]> {
  const known = ENVIRONMENT_ALTERNATIVES[executable] ?? [];
  const found: string[] = [];
  for (const alt of known) {
    if (await commandExists(alt)) found.push(alt);
  }
  return found;
}

export async function remediateSetupCommands(
  steps: DependencyHydrationCommand[],
): Promise<DependencyHydrationRemediationCandidate | undefined> {
  for (const step of steps) {
    const executable = extractExecutable(step.command);
    if (!executable || SHELL_BUILTINS.has(executable)) continue;
    if (executable.startsWith("./") || executable.startsWith("../") || executable.includes("/")) continue;
    const found = await commandExists(executable);
    if (!found) {
      const replacement = await findSafeReplacement(executable);
      if (replacement) {
        const remediatedCommand = replaceExecutableInCommand(step.command, executable, replacement);
        return {
          executable,
          replacement,
          originalCommand: step.command,
          remediatedCommand,
          stepName: step.name,
          reason: `${executable} is unavailable; ${replacement} was found in PATH.`,
          confidence: "HIGH",
          temporary: true,
        };
      }
    }
  }
  return undefined;
}

function replaceExecutableInCommand(command: string, executable: string, replacement: string): string {
  // Find the executable in the command string, skipping leading 'cd' segments.
  const segments = command.split(/(\s*&&\s*|\s*;\s*|\s*\|\s*)/);
  const execPattern = new RegExp(["^", "\\s*", escapeRegExp(executable), "\\s"].join(""));
  return segments.map((seg) => {
    // Only replace in non-separator segments (actual commands)
    if (/^\s*[;&|]+\s*$/.test(seg)) return seg;
    return seg.replace(execPattern, `${replacement} `);
  }).join("");
}

function applyRemediation(
  steps: DependencyHydrationCommand[],
  remediation: DependencyHydrationRemediationCandidate,
): DependencyHydrationCommand[] {
  return steps.map((step) => ({
    ...step,
    command: step.name === remediation.stepName
      ? remediation.remediatedCommand
      : step.command,
  }));
}

async function findSafeReplacement(executable: string): Promise<string | undefined> {
  const candidates = SAFE_REMEDIATIONS[executable] ?? [];
  for (const candidate of candidates) {
    // Relative paths (./mvnw, ./gradlew) are checked against workspace; bare names (pip3, python3) against PATH.
    if (candidate.startsWith("./") || candidate.startsWith("../")) {
      // wrapper scripts must exist in the workspace; caller provides workspace
      // via commandExists shell probe, which also resolves relative paths
      if (await commandExists(candidate)) return candidate;
    } else {
      if (await commandExists(candidate)) return candidate;
    }
  }
  return undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildExecutionRemediationCandidate(
  step: DependencyHydrationCommand,
  command: string,
  error: unknown,
  cwd: string,
): DependencyHydrationRemediationCandidate | undefined {
  const details = error as { stderr?: string; stdout?: string };
  const output = `${details.stderr ?? ""}\n${details.stdout ?? ""}`;
  if (!/externally-managed-environment|PEP 668/i.test(output)) return undefined;
  const executable = extractExecutable(command);
  if (executable !== "pip" && executable !== "pip3") return undefined;
  const replacement = ".venv/bin/python -m pip";
  const remediatedCommand = command.replace(
    new RegExp(["\\\\b", escapeRegExp(executable), "\\\\b"].join("")),
    replacement,
  );
  const venvCommand = remediatedCommand.includes("&&")
    ? remediatedCommand.replace(/^(.*?&&\\s*)/, "$1python3 -m venv .venv && ")
    : `python3 -m venv .venv && ${remediatedCommand}`;
  return {
    executable,
    replacement,
    originalCommand: command,
    remediatedCommand: venvCommand,
    stepName: step.name,
    reason: "The Python environment is externally managed; install into a workspace-local virtual environment instead.",
    confidence: "HIGH",
    temporary: true,
    category: "isolated-environment",
  };
}

function truncate(value: string | undefined): string | undefined {
  if (!value) return value;
  return value.length > 4000 ? `${value.slice(0, 4000)}\n[truncated]` : value;
}

export async function computeDependencyKey(input: {
  workspacePath: string;
  commandCwd?: string;
  setupCommand?: string;
}): Promise<string> {
  const files = await collectDependencyFiles(input.workspacePath);
  const hash = crypto.createHash("sha256");
  hash.update(JSON.stringify({
    version: 1,
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    setupCommand: input.setupCommand ?? "",
    commandCwd: input.commandCwd ? path.relative(input.workspacePath, input.commandCwd).replace(/\\/g, "/") : ".",
    packageManagers: inferPackageManagers(files, input.setupCommand),
  }));
  for (const file of files) {
    hash.update("\n--file--\n");
    hash.update(file.relativePath);
    hash.update("\n");
    hash.update(file.content);
  }
  return hash.digest("hex");
}

export async function buildDependencyCacheEnv(cacheRoot: string): Promise<Record<string, string>> {
  const root = path.resolve(cacheRoot);
  const env: Record<string, string> = {
    npm_config_cache: path.join(root, "npm"),
    NPM_CONFIG_CACHE: path.join(root, "npm"),
    npm_config_store_dir: path.join(root, "pnpm-store"),
    PNPM_STORE_DIR: path.join(root, "pnpm-store"),
    YARN_CACHE_FOLDER: path.join(root, "yarn"),
    BUN_INSTALL_CACHE_DIR: path.join(root, "bun"),
    UV_CACHE_DIR: path.join(root, "uv"),
    PIP_CACHE_DIR: path.join(root, "pip"),
    CARGO_HOME: process.env.CARGO_HOME || path.join(root, "cargo"),
    SCCACHE_DIR: path.join(root, "sccache"),
  };
  if (await commandExists("sccache")) {
    env.RUSTC_WRAPPER = "sccache";
  }
  return env;
}

function resolveCommandCwd(workspacePath: string, configuredCwd?: string): string {
  return configuredCwd?.trim()
    ? path.resolve(workspacePath, configuredCwd)
    : workspacePath;
}

async function collectDependencyFiles(root: string): Promise<Array<{ relativePath: string; content: Buffer }>> {
  const files: Array<{ relativePath: string; content: Buffer }> = [];
  await walk(root, "");
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  async function walk(currentRoot: string, relativeDir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(currentRoot, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await walk(path.join(currentRoot, entry.name), path.join(relativeDir, entry.name));
        continue;
      }
      if (!entry.isFile() || !DEPENDENCY_FILE_NAMES.has(entry.name)) continue;
      const absolutePath = path.join(currentRoot, entry.name);
      const relativePath = path.join(relativeDir, entry.name).replace(/\\/g, "/");
      files.push({ relativePath, content: await fs.readFile(absolutePath) });
    }
  }
}

function inferPackageManagers(files: Array<{ relativePath: string }>, setupCommand?: string): string[] {
  const values = new Set<string>();
  const command = setupCommand ?? "";
  if (/\bpnpm\b/.test(command) || files.some((file) => file.relativePath.endsWith("pnpm-lock.yaml"))) values.add("pnpm");
  if (/\byarn\b/.test(command) || files.some((file) => file.relativePath.endsWith("yarn.lock"))) values.add("yarn");
  if (/\bbun\b/.test(command) || files.some((file) => file.relativePath.endsWith("bun.lock") || file.relativePath.endsWith("bun.lockb"))) values.add("bun");
  if (/\bnpm\b/.test(command) || files.some((file) => file.relativePath.endsWith("package-lock.json") || file.relativePath.endsWith("npm-shrinkwrap.json"))) values.add("npm");
  if (/\buv\b/.test(command) || files.some((file) => file.relativePath.endsWith("uv.lock"))) values.add("uv");
  if (/\bpip\b/.test(command) || files.some((file) => file.relativePath.endsWith("requirements.txt") || file.relativePath.endsWith("requirements-dev.txt"))) values.add("pip");
  if (/\bcargo\b/.test(command) || files.some((file) => file.relativePath.endsWith("Cargo.lock") || file.relativePath.endsWith("Cargo.toml"))) values.add("cargo");
  return [...values].sort();
}

function assertCacheRootOutsideWorkspace(cacheRoot: string, workspacePath: string): void {
  const relative = path.relative(path.resolve(workspacePath), cacheRoot);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("dependencies.cacheRoot must be outside the active repository/worktree");
  }
}

function eventData(
  input: { workspacePath: string; runId: string; phase: string; taskId?: string },
  result: Record<string, unknown>,
): Record<string, unknown> {
  return {
    runId: input.runId,
    phase: input.phase,
    workspacePath: input.workspacePath,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...result,
  };
}

async function commandExists(command: string): Promise<boolean> {
  try {
    const probe = process.platform === "win32" ? "where" : "sh";
    const args = process.platform === "win32" ? [command] : ["-c", `command -v ${JSON.stringify(command)}`];
    await execFileAsync(probe, args, { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}


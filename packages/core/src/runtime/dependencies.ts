import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EffectiveFactoryConfig } from "@factory/schemas";

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

export interface DependencyHydrationResult {
  status: "completed" | "skipped";
  reason: string;
  dependencyKey?: string;
  markerPath?: string;
  command?: string;
  cwd?: string;
  cacheRoot: string;
}

export class DependencyHydrationError extends Error {
  constructor(
    message: string,
    public readonly details: {
      dependencyKey?: string;
      command?: string;
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
}): Promise<DependencyHydrationResult> {
  const cacheRoot = path.resolve(input.config.dependencies.cacheRoot);
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

  const setupCommand = input.config.commands.setup?.trim();
  if (!setupCommand) {
    const result = {
      status: "skipped" as const,
      reason: "no commands.setup configured",
      cacheRoot,
    };
    await input.onEvent?.({ type: "dependencies.hydration_skipped", data: eventData(input, result) });
    return result;
  }

  const commandCwd = resolveCommandCwd(input.workspacePath, input.config.commands.cwd);
  const dependencyKey = await computeDependencyKey({
    workspacePath: input.workspacePath,
    commandCwd,
    setupCommand,
  });
  const markerPath = path.join(input.workspacePath, ".factory", "dependencies", `${dependencyKey}.json`);

  if (input.config.dependencies.hydrate === "auto" && await exists(markerPath)) {
    const result = {
      status: "skipped" as const,
      reason: "dependency marker is current",
      dependencyKey,
      markerPath,
      command: setupCommand,
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
      cwd: commandCwd,
      cacheRoot,
    }),
  });

  const cacheEnv = await buildDependencyCacheEnv(cacheRoot);
  try {
    const { stdout, stderr } = await execFileAsync(setupCommand, {
      cwd: commandCwd,
      shell: true,
      windowsHide: true,
      env: {
        ...process.env,
        ...cacheEnv,
      },
      maxBuffer: 1024 * 1024 * 10,
    });
    await fs.writeFile(markerPath, JSON.stringify({
      dependencyKey,
      command: setupCommand,
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
      cwd: commandCwd,
      cacheRoot,
    };
    await input.onEvent?.({ type: "dependencies.hydration_completed", data: { ...eventData(input, result), stdout: truncate(stdout), stderr: truncate(stderr) } });
    return result;
  } catch (error) {
    const execError = error as Error & { code?: number; stdout?: string; stderr?: string };
    await input.onEvent?.({
      type: "dependencies.hydration_failed",
      data: eventData(input, {
        dependencyKey,
        markerPath,
        command: setupCommand,
        cwd: commandCwd,
        cacheRoot,
        reason: execError.message,
        exitCode: execError.code,
        stdout: truncate(execError.stdout),
        stderr: truncate(execError.stderr),
      }),
    });
    throw new DependencyHydrationError(
      `Dependency hydration failed while running setup command: ${setupCommand}`,
      {
        dependencyKey,
        command: setupCommand,
        cwd: commandCwd,
        exitCode: execError.code,
        stdout: execError.stdout,
        stderr: execError.stderr,
      },
    );
  }
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

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

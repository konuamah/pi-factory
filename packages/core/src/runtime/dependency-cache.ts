// Dependency cache helpers — extracted from dependencies.ts.

import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readPackageJson } from "./verification-discovery.js";

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

import { pathExists } from "./fs-utils.js";

const execFileAsync = promisify(execFile);

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

export function resolveCommandCwd(workspacePath: string, configuredCwd?: string): string {
  return configuredCwd?.trim()
    ? path.resolve(workspacePath, configuredCwd)
    : workspacePath;
}

export async function collectDependencyFiles(root: string): Promise<Array<{ relativePath: string; content: Buffer }>> {
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

export function inferPackageManagers(files: Array<{ relativePath: string }>, setupCommand?: string): string[] {
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

export function assertCacheRootOutsideWorkspace(cacheRoot: string, workspacePath: string): void {
  const relative = path.relative(path.resolve(workspacePath), cacheRoot);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("dependencies.cacheRoot must be outside the active repository/worktree");
  }
}

export function eventData(
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

export async function commandExists(command: string): Promise<boolean> {
  try {
    const probe = process.platform === "win32" ? "where" : "sh";
    const args = process.platform === "win32" ? [command] : ["-c", `command -v ${JSON.stringify(command)}`];
    await execFileAsync(probe, args, { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export async function pruneDependencyCache(input: { cacheRoot: string; maxAgeDays: number; dryRun?: boolean }): Promise<{ cacheRoot: string; removedEntries: string[]; removedBytes: number; warnings: string[] }> {
  const removedEntries: string[] = [];
  const warnings: string[] = [];
  let removedBytes = 0;
  const root = path.resolve(input.cacheRoot);
  const cutoff = Date.now() - Math.max(0, input.maxAgeDays) * 86_400_000;
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`Failed to read dependency cache: ${String(error)}`);
    return [] as import("node:fs").Dirent[];
  });
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    try {
      const stat = await fs.stat(target);
      if (stat.mtimeMs >= cutoff) continue;
      removedEntries.push(target);
      removedBytes += await directorySize(target);
      if (!input.dryRun) await fs.rm(target, { recursive: true, force: true });
    } catch (error) {
      warnings.push(`Failed to prune ${target}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { cacheRoot: root, removedEntries, removedBytes, warnings };
}

async function directorySize(target: string): Promise<number> {
  const stat = await fs.stat(target).catch(() => undefined);
  if (!stat) return 0;
  if (stat.isFile()) return stat.size;
  const entries = await fs.readdir(target, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const entry of entries) total += await directorySize(path.join(target, entry.name));
  return total;
}


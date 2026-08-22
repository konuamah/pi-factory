import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitIsolationStatus {
  cwd: string;
  gitRoot?: string;
  gitDir?: string;
  gitCommonDir?: string;
  superprojectWorkingTree?: string;
  branch?: string;
  isLinkedWorktree: boolean;
  isSubmodule: boolean;
}

export interface CreateGitWorktreeInput {
  cwd: string;
  branchName: string;
  baseBranch?: string;
  preferredLocation?: string;
}

export interface CreateGitWorktreeResult {
  mode: "existing" | "created" | "in-place";
  path: string;
  branch?: string;
  reason?: string;
  location?: string;
}

export async function inspectGitIsolation(cwd: string): Promise<GitIsolationStatus> {
  const gitDir = await gitString(cwd, ["rev-parse", "--git-dir"]);
  const gitCommonDir = await gitString(cwd, ["rev-parse", "--git-common-dir"]);
  const branch = await gitString(cwd, ["branch", "--show-current"]);
  const superprojectWorkingTree = await gitString(cwd, ["rev-parse", "--show-superproject-working-tree"]);

  const resolvedGitDir = gitDir ? path.resolve(cwd, gitDir) : undefined;
  const resolvedGitCommonDir = gitCommonDir ? path.resolve(cwd, gitCommonDir) : undefined;
  const isSubmodule = Boolean(superprojectWorkingTree);
  const isLinkedWorktree = Boolean(
    resolvedGitDir &&
      resolvedGitCommonDir &&
      resolvedGitDir !== resolvedGitCommonDir &&
      !isSubmodule,
  );

  const gitRoot = await gitString(cwd, ["rev-parse", "--show-toplevel"]);

  return {
    cwd,
    gitRoot: gitRoot ? path.resolve(gitRoot) : undefined,
    gitDir: resolvedGitDir,
    gitCommonDir: resolvedGitCommonDir,
    superprojectWorkingTree: superprojectWorkingTree ? path.resolve(superprojectWorkingTree) : undefined,
    branch: branch || undefined,
    isLinkedWorktree,
    isSubmodule,
  };
}

export async function createGitWorktree(input: CreateGitWorktreeInput): Promise<CreateGitWorktreeResult> {
  const isolation = await inspectGitIsolation(input.cwd);

  if (isolation.isLinkedWorktree) {
    return {
      mode: "existing",
      path: input.cwd,
      branch: isolation.branch,
      reason: isolation.branch
        ? `Already in isolated workspace on branch ${isolation.branch}`
        : "Already in isolated workspace (detached HEAD or externally managed)",
    };
  }

  const gitRoot = isolation.gitRoot;
  if (!gitRoot) {
    return {
      mode: "in-place",
      path: input.cwd,
      reason: "No git root found; working in place",
    };
  }

  const location = await resolveWorktreeLocation(gitRoot, input.preferredLocation);
  await ensureWorktreeDirectoryIgnored(gitRoot, location.relativeDir);

  const targetPath = path.join(location.absoluteDir, input.branchName);
  const args = ["worktree", "add", targetPath, "-b", input.branchName];
  if (input.baseBranch) {
    args.push(input.baseBranch);
  }

  try {
    await execFileAsync("git", args, { cwd: gitRoot, windowsHide: true });
    return {
      mode: "created",
      path: targetPath,
      branch: input.branchName,
      location: location.relativeDir,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/denied|permission|sandbox/i.test(message)) {
      return {
        mode: "in-place",
        path: input.cwd,
        branch: isolation.branch,
        reason: "Worktree creation blocked by sandbox/permissions; working in place",
      };
    }
    throw error;
  }
}

export async function resolveWorktreeLocation(
  gitRoot: string,
  preferredLocation?: string,
): Promise<{ absoluteDir: string; relativeDir: string }> {
  if (preferredLocation) {
    return {
      absoluteDir: path.resolve(gitRoot, preferredLocation),
      relativeDir: normalizeRelativeDir(preferredLocation),
    };
  }

  const hiddenDir = path.join(gitRoot, ".worktrees");
  if (await exists(hiddenDir)) {
    return { absoluteDir: hiddenDir, relativeDir: ".worktrees" };
  }

  const visibleDir = path.join(gitRoot, "worktrees");
  if (await exists(visibleDir)) {
    return { absoluteDir: visibleDir, relativeDir: "worktrees" };
  }

  return { absoluteDir: hiddenDir, relativeDir: ".worktrees" };
}

export async function ensureWorktreeDirectoryIgnored(
  gitRoot: string,
  relativeDir: string,
): Promise<void> {
  const ignored = await isGitIgnored(gitRoot, relativeDir);
  if (ignored) {
    await fs.mkdir(path.join(gitRoot, relativeDir), { recursive: true });
    return;
  }

  const gitignorePath = path.join(gitRoot, ".gitignore");
  const existing = await readTextIfExists(gitignorePath);
  const marker = relativeDir.endsWith("/") ? relativeDir : `${relativeDir}/`;
  const next = existing
    ? existing.includes(marker)
      ? existing
      : `${existing.trimEnd()}\n${marker}\n`
    : `${marker}\n`;

  await fs.writeFile(gitignorePath, next, "utf8");
  await fs.mkdir(path.join(gitRoot, relativeDir), { recursive: true });
}

async function isGitIgnored(cwd: string, relativeDir: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["check-ignore", "-q", relativeDir], {
      cwd,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

async function gitString(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, windowsHide: true });
    const value = stdout.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function normalizeRelativeDir(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/$/, "") || ".worktrees";
}

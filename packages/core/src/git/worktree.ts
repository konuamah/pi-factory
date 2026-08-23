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

export interface CreateSiblingGitWorktreeInput {
  cwd: string;
  branchName: string;
  baseRef?: string;
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

  return createWorktreeAtGitRoot({
    cwd: input.cwd,
    branchName: input.branchName,
    baseRef: input.baseBranch,
    preferredLocation: input.preferredLocation,
  });
}

export async function createSiblingGitWorktree(input: CreateSiblingGitWorktreeInput): Promise<CreateGitWorktreeResult> {
  return createWorktreeAtGitRoot({
    cwd: input.cwd,
    branchName: input.branchName,
    baseRef: input.baseRef,
    preferredLocation: input.preferredLocation,
  });
}

async function createWorktreeAtGitRoot(input: {
  cwd: string;
  branchName: string;
  baseRef?: string;
  preferredLocation?: string;
}): Promise<CreateGitWorktreeResult> {
  const isolation = await inspectGitIsolation(input.cwd);
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

  const existing = await findWorktreeByBranch(gitRoot, input.branchName);
  if (existing) {
    return {
      mode: "existing",
      path: existing.path,
      branch: input.branchName,
      reason: `Reusing existing worktree for branch ${input.branchName}`,
      location: path.relative(gitRoot, path.dirname(existing.path)).replace(/\\/g, "/") || location.relativeDir,
    };
  }

  let branchName = input.branchName;
  let targetPath = path.join(location.absoluteDir, branchName);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const args = ["worktree", "add", targetPath, "-b", branchName];
    if (input.baseRef) {
      args.push(input.baseRef);
    }

    try {
      await execFileAsync("git", args, { cwd: gitRoot, windowsHide: true });
      return {
        mode: "created",
        path: targetPath,
        branch: branchName,
        location: location.relativeDir,
        reason: branchName === input.branchName ? undefined : `Created unique worktree branch after branch-name collision: ${branchName}`,
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
      if (/already exists/i.test(message) && /branch named/i.test(message)) {
        const currentExisting = await findWorktreeByBranch(gitRoot, branchName);
        if (currentExisting) {
          return {
            mode: "existing",
            path: currentExisting.path,
            branch: branchName,
            reason: `Reusing existing worktree for branch ${branchName}`,
            location: path.relative(gitRoot, path.dirname(currentExisting.path)).replace(/\\/g, "/") || location.relativeDir,
          };
        }
        branchName = `${input.branchName}-${Date.now().toString(36).slice(-6)}`;
        targetPath = path.join(location.absoluteDir, branchName);
        continue;
      }
      throw error;
    }
  }

  throw new Error(`Failed to create git worktree for branch ${input.branchName} after retrying branch-name collisions.`);
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

async function findWorktreeByBranch(
  gitRoot: string,
  branchName: string,
): Promise<{ path: string; branch?: string } | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
      cwd: gitRoot,
      windowsHide: true,
    });
    const entries = stdout.split(/\r?\n\r?\n/);
    for (const entry of entries) {
      const lines = entry.split(/\r?\n/).filter(Boolean);
      const worktreeLine = lines.find((line) => line.startsWith("worktree "));
      const branchLine = lines.find((line) => line.startsWith("branch refs/heads/"));
      const worktreePath = worktreeLine?.slice("worktree ".length).trim();
      const branch = branchLine?.slice("branch refs/heads/".length).trim();
      if (worktreePath && branch === branchName) {
        return { path: worktreePath, branch };
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
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

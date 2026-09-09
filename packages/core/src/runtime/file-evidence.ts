// File evidence collection — extracted from file-resolution.ts.
import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathExists } from "./fs-utils.js";
import { levenshtein } from "./file-apply.js";

const execFileAsync = promisify(execFile);
import type { FileResolutionEvidence, FileReference } from "./file-resolution.js";
export async function collectFileEvidence(
  cwd: string,
  refs: FileReference[],
): Promise<FileResolutionEvidence[]> {
  const evidence: FileResolutionEvidence[] = [];
  for (const ref of refs) {
    evidence.push(await collectSingleFileEvidence(cwd, ref.filename));
  }
  return evidence;
}

export async function collectSingleFileEvidence(
  cwd: string,
  filename: string,
): Promise<FileResolutionEvidence> {
  const absolutePath = path.resolve(cwd, filename);
  const tracked = await isTracked(cwd, filename);
  const staged = await isStaged(cwd, filename);
  const untrackedExists = await pathExists(absolutePath);
  const ignored = await isIgnored(cwd, filename);
  const similarFiles = tracked ? [] : await findSimilarFiles(cwd, filename);

  let size: number | undefined;
  let lastModified: string | undefined;
  if (untrackedExists) {
    try {
      const stat = await fs.stat(absolutePath);
      size = stat.size;
      lastModified = stat.mtime.toISOString();
    } catch {
      // best effort
    }
  }

  return {
    referencedFile: filename,
    tracked,
    staged,
    untrackedExists,
    ignored,
    similarFiles,
    absolutePath,
    size,
    lastModified,
  };
}

export async function isTracked(cwd: string, filename: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["ls-files", "--error-unmatch", filename], {
      cwd,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

export async function isStaged(cwd: string, filename: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--cached", "--name-only", "--", filename],
      { cwd, windowsHide: true },
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}


export async function isIgnored(cwd: string, filename: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["check-ignore", "-q", filename], {
      cwd,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

export async function findSimilarFiles(cwd: string, filename: string): Promise<string[]> {
  const basename = path.basename(filename).toLowerCase();
  const similar: string[] = [];
  try {
    const { stdout } = await execFileAsync("git", ["ls-files"], {
      cwd,
      windowsHide: true,
    });
    const tracked = stdout.split(/\r?\n/).filter(Boolean);
    for (const file of tracked) {
      const fileBasename = path.basename(file).toLowerCase();
      if (fileBasename === basename) {
        similar.push(file);
      } else if (
        levenshtein(fileBasename, basename) <= 2 ||
        fileBasename.includes(basename) ||
        basename.includes(fileBasename)
      ) {
        similar.push(file);
      }
    }
  } catch {
    // best effort
  }
  return similar.slice(0, 5);
}

// ── LLM Planning ────────────────────────────────────────────────────────────


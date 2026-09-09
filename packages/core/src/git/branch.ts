import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Read the currently checked-out branch in `cwd` via `git branch
 * --show-current`. Returns `undefined` when git fails or HEAD is detached
 * (empty output); callers decide whether that is fatal.
 */
export async function readCurrentGitBranch(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["branch", "--show-current"], {
      cwd,
      windowsHide: true,
    });
    const branch = stdout.trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
}

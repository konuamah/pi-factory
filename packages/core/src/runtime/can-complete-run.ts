import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isTransientFactoryPath } from "./git-ops.js";

const execFileAsync = promisify(execFile);

export async function canCompleteRun(input: {
  baseBranch: string;
  candidateSha?: string;
  executionCwd: string;
  finalMergePath?: string;
  anyTaskBlocked: boolean;
  verificationCanComplete: boolean;
  changedFiles: string[];
}): Promise<{ canComplete: true } | { canComplete: false; reason: string; phase: string }> {
  if (input.anyTaskBlocked) {
    return { canComplete: false, reason: "implementation task is blocked", phase: "implementation-blocked" };
  }
  if (!input.verificationCanComplete) {
    return { canComplete: false, reason: "verification did not pass", phase: "verification-blocked" };
  }

  let mergeStatus: string | undefined;
  if (input.finalMergePath) {
    try {
      mergeStatus = (JSON.parse(await fs.readFile(input.finalMergePath, "utf8")) as { status?: string }).status;
    } catch {
      return { canComplete: false, reason: "final-merge artifact is unreadable", phase: "merge-blocked" };
    }
  }
  if (mergeStatus !== "merged") {
    return { canComplete: false, reason: `final-merge status is '${mergeStatus ?? "missing"}'`, phase: "merge-blocked" };
  }

  let productFiles = input.changedFiles.filter((file) => !isTransientFactoryPath(file));
  if (productFiles.length === 0 && input.candidateSha) {
    try {
      const { stdout } = await execFileAsync("git", ["diff", "--name-only", input.baseBranch, input.candidateSha], {
        cwd: input.executionCwd,
        windowsHide: true,
      });
      productFiles = stdout.split(/\r?\n/).map((file) => file.trim()).filter(Boolean).filter((file) => !isTransientFactoryPath(file));
    } catch {
      // The empty productFiles result below is the actionable failure.
    }
  }
  return productFiles.length > 0
    ? { canComplete: true }
    : { canComplete: false, reason: "no non-generated product files changed", phase: "no-product-changes" };
}

// Resolution sanitization + application — extracted from file-resolution.ts.
import type { FileResolutionPlan, FileResolutionEvidence, FileResolution } from "./file-resolution.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export function sanitizeResolutionPlan(
  plan: FileResolutionPlan,
  evidence: FileResolutionEvidence[],
): FileResolutionPlan {
  const evidenceByFile = new Map(evidence.map((e) => [e.referencedFile, e]));
  const sanitized: FileResolutionPlan = {
    resolutions: [],
    warnings: [...plan.warnings],
    blockers: [],
  };

  for (const resolution of plan.resolutions) {
    const ev = evidenceByFile.get(resolution.file);
    if (!ev) {
      sanitized.warnings.push(
        `Resolution for unknown file ${resolution.file} ignored.`,
      );
      continue;
    }

    switch (resolution.action) {
      case "auto-stage": {
        if (ev.ignored) {
          sanitized.blockers.push(
            `Cannot auto-stage ${resolution.file}: file is in .gitignore.`,
          );
          break;
        }
        if (!ev.untrackedExists) {
          sanitized.blockers.push(
            `Cannot auto-stage ${resolution.file}: file does not exist on disk.`,
          );
          break;
        }
        if (ev.tracked) {
          // Already tracked, no action needed
          break;
        }
        sanitized.resolutions.push(resolution);
        break;
      }
      case "use-alternative": {
        if (!resolution.alternative) {
          sanitized.warnings.push(
            `use-alternative for ${resolution.file} has no alternative specified; skipping.`,
          );
          break;
        }
        if (!ev.similarFiles.includes(resolution.alternative)) {
          sanitized.warnings.push(
            `Alternative ${resolution.alternative} not in similar files for ${resolution.file}; skipping.`,
          );
          break;
        }
        sanitized.resolutions.push(resolution);
        break;
      }
      case "skip": {
        sanitized.resolutions.push(resolution);
        break;
      }
      case "block": {
        sanitized.blockers.push(
          resolution.reason || `Blocked: ${resolution.file}`,
        );
        break;
      }
      default: {
        sanitized.warnings.push(
          `Unknown action "${resolution.action}" for ${resolution.file}; skipping.`,
        );
      }
    }
  }

  // Catch files the LLM didn't address
  for (const ev of evidence) {
    if (ev.tracked) continue;
    const addressed = plan.resolutions.some((r) => r.file === ev.referencedFile);
    if (!addressed) {
      if (ev.untrackedExists && !ev.ignored) {
        sanitized.resolutions.push({
          file: ev.referencedFile,
          action: "auto-stage",
          reason: "Unreferenced by planner but exists untracked; auto-staging.",
        });
      } else if (!ev.untrackedExists && ev.similarFiles.length === 0) {
        sanitized.blockers.push(
          `@${ev.referencedFile} does not exist and no alternative was found.`,
        );
      }
    }
  }

  return sanitized;
}

// ── Apply ───────────────────────────────────────────────────────────────────

export async function applyResolutions(
  cwd: string,
  plan: FileResolutionPlan,
): Promise<Array<{ file: string; action: string; detail?: string }>> {
  const applied: Array<{ file: string; action: string; detail?: string }> = [];

  for (const resolution of plan.resolutions) {
    switch (resolution.action) {
      case "auto-stage": {
        try {
          await execFileAsync("git", ["add", resolution.file], {
            cwd,
            windowsHide: true,
          });
          applied.push({
            file: resolution.file,
            action: "auto-staged",
          });
        } catch (error) {
          applied.push({
            file: resolution.file,
            action: "auto-stage-failed",
            detail: error instanceof Error ? error.message : String(error),
          });
        }
        break;
      }
      case "use-alternative": {
        applied.push({
          file: resolution.file,
          action: "using-alternative",
          detail: resolution.alternative,
        });
        break;
      }
      case "skip": {
        applied.push({
          file: resolution.file,
          action: "skipped",
          detail: resolution.reason,
        });
        break;
      }
    }
  }

  return applied;
}

// ── Utils ───────────────────────────────────────────────────────────────────

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0),
  );
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1]![j - 1]!
          : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[m]![n]!;
}


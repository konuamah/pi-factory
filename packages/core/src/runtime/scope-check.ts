// Shared scope check: does a changed-file set violate declared non-goals?
// Used by verification (SCOPE contract requirement), the approval gate
// (scopeWarnings for the human), and the landing guard (authoritative final
// check). One implementation so all three agree.

import fs from "node:fs/promises";

export interface NonGoalViolation {
  file: string;
  nonGoal: string;
  match: "exact" | "prefix";
}

export interface PlanContract {
  targetFiles?: string[];
  nonGoals?: string[];
  verificationChecks?: Array<{ name: string; command?: string; reason?: string }>;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * Files in `changedFiles` that hit a declared `nonGoals` path. A non-goal
 * matches exactly, or as a directory prefix (non-goal "src/" forbids
 * "src/foo.ts"). Paths are normalized (backslash -> slash, "./" stripped).
 * Returns [] when either input is empty.
 */
export function nonGoalViolations(changedFiles: string[], nonGoals: string[]): NonGoalViolation[] {
  const violations: NonGoalViolation[] = [];
  const seen = new Set<string>();
  const normalizedNonGoals = nonGoals.map(normalizePath).filter(Boolean);

  for (const rawFile of changedFiles) {
    const file = normalizePath(rawFile);
    if (!file) continue;
    for (const nonGoal of normalizedNonGoals) {
      const match = file === nonGoal ? "exact" : file.startsWith(`${nonGoal}/`) ? "prefix" : undefined;
      if (!match) continue;
      const key = `${file}->${nonGoal}`;
      if (seen.has(key)) continue;
      seen.add(key);
      violations.push({ file, nonGoal, match });
    }
  }
  return violations;
}

/**
 * Read plan.json's implementationContract from a planPath. Returns undefined
 * when the file is missing or unreadable, so callers treat "no plan contract"
 * as "no scope constraint" without crashing.
 */
export async function loadPlanContract(planPath: string): Promise<PlanContract | undefined> {
  try {
    const raw = await fs.readFile(planPath, "utf8");
    const plan = JSON.parse(raw) as { implementationContract?: PlanContract };
    return plan.implementationContract ?? {};
  } catch {
    return undefined;
  }
}

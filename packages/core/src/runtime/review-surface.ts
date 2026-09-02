import fs from "node:fs/promises";
import path from "node:path";
import type { PrototypeCompletedTaskArtifact } from "./artifacts.js";
import type { VerificationRunResult } from "./verification.js";
import type { PlanContract, NonGoalViolation } from "./scope-check.js";
import type { VerificationFailureClassification } from "./failure-classification.js";
import { nonGoalViolations } from "./scope-check.js";
import { renderCandidateDiff, type CandidateDiffRenderResult } from "./git-ops.js";
import { isIgnorableBaselineFailure } from "./failure-classification.js";

const SOURCE_FILE_PATTERN = /\.(?:[cm]?js|[jt]sx?)$/i;
const DIRECT_IMPORT_PATTERN = /(?:import|export)\s+(?:[^"'\n]+?\s+from\s+)?["'](\.{1,2}\/[^"'#?]+)["']|import\(\s*["'](\.{1,2}\/[^"'#?]+)["']\s*\)|require\(\s*["'](\.{1,2}\/[^"'#?]+)["']\s*\)/g;
const RESOLUTION_SUFFIXES = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const INDEX_SUFFIXES = ["/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/index.mjs", "/index.cjs"];
const HIGH_RISK_BASENAMES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "npm-shrinkwrap.json",
  "tsconfig.json",
  "tsconfig.node.json",
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "factory.yaml",
  ".factory/config.yaml",
]);

export const TRIVIAL_REVIEW_MAX_FILES = 1;
export const TRIVIAL_REVIEW_MAX_CHANGED_LINES = 30;

export interface ReviewSurface {
  changedFiles: string[];
  directImports: string[];
  planTargetFiles: string[];
  planNonGoals: string[];
  nonGoalViolations: NonGoalViolation[];
  highRiskFiles: string[];
  diff: CandidateDiffRenderResult;
}

export interface DeterministicReviewDecision {
  eligible: boolean;
  reasons: string[];
}

export async function buildReviewSurface(input: {
  cwd: string;
  completedTasks: PrototypeCompletedTaskArtifact[];
  baseBranch: string;
  planContract?: PlanContract;
}): Promise<ReviewSurface> {
  const changedFiles = collectChangedFiles(input.completedTasks);
  const diff = await renderCandidateDiff({
    cwd: input.cwd,
    commitShas: input.completedTasks.map((task) => task.commitSha),
    changedFiles,
    baseBranch: input.baseBranch,
  });
  const directImports = await collectDirectImports(input.cwd, changedFiles);
  const planTargetFiles = normalizePaths(input.planContract?.targetFiles ?? []);
  const planNonGoals = normalizePaths(input.planContract?.nonGoals ?? []);

  return {
    changedFiles,
    directImports,
    planTargetFiles,
    planNonGoals,
    nonGoalViolations: nonGoalViolations(changedFiles, planNonGoals),
    highRiskFiles: changedFiles.filter(isHighRiskFile),
    diff,
  };
}

export function evaluateDeterministicReview(
  surface: ReviewSurface,
  verification: VerificationRunResult,
  classification: VerificationFailureClassification | undefined,
): DeterministicReviewDecision {
  const reasons: string[] = [];
  const changedLines = surface.diff.additions + surface.diff.deletions;
  const failedCommandNames = verification.commands
    .filter((command) => command.status === "failed")
    .map((command) => command.name);

  if (surface.changedFiles.length === 0) {
    reasons.push("no changed files were available");
  }
  if (!surface.diff.ok) {
    reasons.push(surface.diff.error ?? "candidate diff could not be rendered");
  }
  if (surface.diff.truncated) {
    reasons.push("candidate diff was truncated");
  }
  if (surface.changedFiles.length > TRIVIAL_REVIEW_MAX_FILES) {
    reasons.push(`changed ${surface.changedFiles.length} files`);
  }
  if (changedLines > TRIVIAL_REVIEW_MAX_CHANGED_LINES) {
    reasons.push(`changed ${changedLines} lines`);
  }
  if (surface.highRiskFiles.length > 0) {
    reasons.push(`high-risk files changed: ${surface.highRiskFiles.slice(0, 3).join(", ")}`);
  }
  if (surface.nonGoalViolations.length > 0) {
    reasons.push(`non-goal files changed: ${surface.nonGoalViolations.map((violation) => violation.file).slice(0, 3).join(", ")}`);
  }
  if (verification.overallStatus === "incomplete") {
    reasons.push("verification is incomplete");
  }
  if (
    verification.overallStatus === "failed"
    && !isIgnorableBaselineFailure(classification, failedCommandNames)
  ) {
    reasons.push("verification recorded non-ignorable failures");
  }

  return {
    eligible: reasons.length === 0,
    reasons,
  };
}

export function buildDeterministicReviewerText(
  surface: ReviewSurface,
  verification: VerificationRunResult,
): string {
  const changedFile = surface.changedFiles[0] ?? "the candidate file";
  const changedLines = surface.diff.additions + surface.diff.deletions;
  const verificationSummary = verification.overallStatus === "passed"
    ? "verification passed"
    : "verification recorded only pre-existing ignorable baseline debt";
  return `Ready for approval. Deterministic review passed for a trivial scoped change in ${changedFile} (+${surface.diff.additions}/-${surface.diff.deletions}, ${changedLines} changed line${changedLines === 1 ? "" : "s"}); ${verificationSummary}; no high-risk files or scope violations were detected.`;
}

function collectChangedFiles(completedTasks: PrototypeCompletedTaskArtifact[]): string[] {
  return normalizePaths(completedTasks.flatMap((task) => task.changedFiles ?? []));
}

function normalizePaths(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function isHighRiskFile(file: string): boolean {
  const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  const basename = path.posix.basename(normalized);
  if (HIGH_RISK_BASENAMES.has(normalized) || HIGH_RISK_BASENAMES.has(basename)) {
    return true;
  }
  return /(^|\/)(auth|secrets?|credentials?|tokens?|migrations?|schema|schemas|permissions?)($|\/)/.test(normalized)
    || /(^|\/)\.env(?:\.|$)/.test(normalized)
    || /(^|\/)dockerfile(?:\.|$)/.test(normalized)
    || /(^|\/)tsconfig\..+\.json$/.test(normalized)
    || /(^|\/)\.github\//.test(normalized);
}

async function collectDirectImports(cwd: string, changedFiles: string[]): Promise<string[]> {
  const imports: string[] = [];
  const seen = new Set<string>();
  const changed = new Set(changedFiles.map((file) => file.replace(/\\/g, "/")));

  for (const file of changedFiles) {
    if (!SOURCE_FILE_PATTERN.test(file)) {
      continue;
    }

    let content = "";
    try {
      content = await fs.readFile(path.join(cwd, file), "utf8");
    } catch {
      continue;
    }

    for (const match of content.matchAll(DIRECT_IMPORT_PATTERN)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!specifier) {
        continue;
      }
      const resolved = await resolveImportToWorkspacePath(cwd, file, specifier);
      if (!resolved || changed.has(resolved) || seen.has(resolved)) {
        continue;
      }
      seen.add(resolved);
      imports.push(resolved);
      if (imports.length >= 12) {
        return imports;
      }
    }
  }

  return imports;
}

async function resolveImportToWorkspacePath(
  cwd: string,
  importer: string,
  specifier: string,
): Promise<string | undefined> {
  const base = path.resolve(cwd, path.dirname(importer), specifier);
  const candidates = specifier.match(/\.[a-z0-9]+$/i)
    ? [base]
    : [...RESOLUTION_SUFFIXES.map((suffix) => `${base}${suffix}`), ...INDEX_SUFFIXES.map((suffix) => `${base}${suffix}`)];

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isFile()) {
        continue;
      }
      const relative = path.relative(cwd, candidate).replace(/\\/g, "/");
      if (!relative || relative.startsWith("../") || relative === "..") {
        return undefined;
      }
      return relative;
    } catch {
      // Try the next candidate.
    }
  }

  return undefined;
}

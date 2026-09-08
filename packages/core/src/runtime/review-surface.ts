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

export type ReviewerVerdict = "block" | "pass" | "unknown";

/**
 * Classify a reviewer's prose verdict from its conclusion. Positive markers
 * must not fire when negated ("not ready for approval"), and negative markers
 * must not fire on benign mid-transcript mentions ("would fail if ... but
 * ready for approval"). Mirrors the benchmark's reviewer-agreement heuristic
 * (packages/core/src/benchmark/scoring.ts) so the gate and scoring agree.
 */
export function classifyReviewerVerdict(outputText: string): ReviewerVerdict {
  const text = (outputText ?? "").toLowerCase();
  const headline = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
  const conclusion = text.slice(-600);
  const reviewWindow = [headline, conclusion].filter(Boolean).join("\n");
  const positive = /(?<!\bnot )(?<!\bcannot )(?<!\bcan't )(?<!\bcan not )\b(ready for approval|looks? ready|accepted|all checks? pass|no issues?|satisfies (all|every|the)|good to merge|ship it|no problems?|approve)\b/.test(reviewWindow);
  const negative = /\b(not ready|must fix|cannot approve|can't approve|blocked pending|needs (work|changes|fixes|rework)|reject|do not merge|does not (look )?ready|fails? (the )?(checks?|review|verification)|not satisfied|unacceptable)\b/.test(reviewWindow);
  if (negative && !positive) return "block";
  if (positive && !negative) return "pass";
  return "unknown";
}

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
  // A trivial diff cannot be judged "ready" if the plan named goal-bearing
  // target files the candidate did not touch at all: the deterministic check
  // only inspects scope/size, never whether the diff fulfills the goal. When
  // the candidate changed a strict subset of the plan's declared targets, an
  // LLM reviewer is required so a missing goal surface (e.g. only script.js
  // edited when the plan named index.html + script.js) is caught.
  if (surface.planTargetFiles.length > 0) {
    const touched = new Set(surface.changedFiles);
    const untouchedTargets = surface.planTargetFiles.filter((file) => !touched.has(file));
    if (untouchedTargets.length > 0) {
      reasons.push(`plan target files not changed: ${untouchedTargets.slice(0, 5).join(", ")}`);
    }
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

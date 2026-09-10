import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { filesReferToSamePath } from "./failure-classification.js";
import { isTransientFactoryPath } from "./git-ops.js";
import { nonGoalViolations } from "./scope-check.js";
import type { PrototypeCompletedTaskArtifact, PrototypeLandingDiagnosisArtifact } from "./artifacts.js";
import type {
  DirtyLandingContext,
  LandingExecutionResult,
  LandingGuardVerdict,
  LandingOutcome,
  LandingPlan,
  LandingStrategy,
} from "./landing-types.js";
import { parseGitAction } from "./git-command-parser.js";
import { classifyEffects } from "./git-command-effects.js";
import { executeLandingPlan } from "./git-execution.js";

const execFileAsync = promisify(execFile);

export async function readDirtyFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd, windowsHide: true });
    return stdout.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export async function readGitRemotes(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["remote"], { cwd, windowsHide: true });
    return stdout.split(/\r?\n/).map((remote) => remote.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function classifyDirtyFiles(
  dirtyFiles: string[],
  completedTasks: PrototypeCompletedTaskArtifact[],
): DirtyLandingContext {
  const landingFiles = completedTasks.flatMap((task) => task.changedFiles);
  const relevant: string[] = [];
  const unrelated: string[] = [];
  for (const file of dirtyFiles) {
    if (isTransientFactoryPath(file)) {
      unrelated.push(file);
      continue;
    }
    const overlapsLanding = landingFiles.some((landingFile) => filesReferToSamePath(file, landingFile));
    if (overlapsLanding) relevant.push(file);
    else unrelated.push(file);
  }
  return { all: dirtyFiles, relevant, unrelated };
}

export async function validateLandingPlan(input: {
  mergeCwd: string;
  plan: LandingPlan;
  dirtyRelevantFiles: string[];
  dirtyUnrelatedFiles: string[];
  finalMergePolicy: "required" | "not-required";
  completedTasks: PrototypeCompletedTaskArtifact[];
  verificationStatus: string;
  /** Plan-declared non-goal file paths; candidate changes must not touch them. */
  nonGoals?: string[];
  /** True when scope.landing is "block": a violation blocks the merge. */
  scopeGuardBlocking?: boolean;
  allowedRemotes?: string[];
}): Promise<LandingGuardVerdict> {
  const reasons: string[] = [];
  const notes: string[] = [];
  const currentBranch = await readCurrentBranch(input.mergeCwd);
  if (input.completedTasks.length === 0) {
    reasons.push("No completed task commit with non-transient changed files is available to land.");
  }
  if (input.dirtyRelevantFiles.length > 0) {
    reasons.push(`Dirty target checkout overlaps landing files: ${input.dirtyRelevantFiles.join(", ")}`);
  }
  if (currentBranch && currentBranch !== input.plan.targetBranch && input.dirtyUnrelatedFiles.length > 0) {
    reasons.push(`Cannot switch from ${currentBranch} to ${input.plan.targetBranch} while unrelated files are dirty: ${input.dirtyUnrelatedFiles.join(", ")}`);
  }
  const actions = input.plan.actions ?? [];
  if (input.finalMergePolicy === "required" && actions.length === 0) reasons.push("EMPTY_PLAN");
  for (const action of actions) {
    if (action.kind === "pull-request") {
      if (action.provider !== "github" || !action.sourceBranch || !action.targetBranch) reasons.push("Invalid pull-request action.");
      continue;
    }
    const parsed = parseGitAction({ args: action.step.args });
    if (!parsed.ok) {
      reasons.push(`PARSE_FAILED: ${parsed.reason}`);
      continue;
    }
    const effects = classifyEffects(parsed.command, { repoRoot: input.mergeCwd });
    if (effects.mayDiscardChanges && (input.dirtyRelevantFiles.length > 0 || input.dirtyUnrelatedFiles.length > 0)) reasons.push("WOULD_DESTROY_DIRTY_WORK");
    if (effects.modifiesRemoteRefs && !effects.remotes.every((remote) => (input.allowedRemotes ?? []).includes(remote))) reasons.push("UNAUTHORIZED_REMOTE");
  }
  if (input.finalMergePolicy === "required" && input.plan.strategy === "skip") reasons.push("Landing plan cannot skip while final merge policy is required.");
  // Risk is model-assessed evidence for the landing strategy, not a
  // deterministic command to abandon the candidate. Safety invariants below
  // still prevent invalid refs and unsafe checkout mutations.
  // Verification "incomplete" means no runnable commands existed, not that a
  // check failed. The human approval gate already sees verificationStatus and
  // baseline debt, and post-landing verification blocks a candidate whose
  // contract cannot complete — blocking here too made approval meaningless.
  if (input.plan.strategy && ["cherry-pick", "rebase"].includes(input.plan.strategy) && !input.plan.candidateSha) {
    reasons.push(`Strategy ${input.plan.strategy} requires a candidate SHA.`);
  }
  if (input.plan.strategy && ["merge", "merge-no-ff"].includes(input.plan.strategy) && !input.plan.sourceBranch) {
    reasons.push(`Strategy ${input.plan.strategy} requires a source branch.`);
  }
  if (!await gitRefExists(input.mergeCwd, input.plan.targetBranch)) {
    reasons.push(`Target branch does not exist: ${input.plan.targetBranch}`);
  }
  if (input.plan.candidateSha && !await gitCommitExists(input.mergeCwd, input.plan.candidateSha)) {
    reasons.push(`Candidate commit does not exist: ${input.plan.candidateSha}`);
  }
  if (input.plan.sourceBranch && !await gitRefExists(input.mergeCwd, input.plan.sourceBranch)) {
    reasons.push(`Source branch does not exist: ${input.plan.sourceBranch}`);
  }
  // Scope guard: plan-declared non-goals vs the committed change set. Warn
  // (notes) by default; block (reasons) when scope.landing is "block".
  const nonGoals = input.nonGoals ?? [];
  if (nonGoals.length > 0) {
    const changedFiles = input.completedTasks.flatMap((task) => task.changedFiles ?? []);
    const scopeViolations = nonGoalViolations(changedFiles, nonGoals);
    if (scopeViolations.length > 0) {
      const message = `Candidate changes files declared as non-goals: ${scopeViolations.map((violation) => violation.file).join(", ")}`;
      if (input.scopeGuardBlocking) {
        reasons.push(message);
      } else {
        notes.push(message);
      }
    }
  }
  return { ok: reasons.length === 0, reasons, ...(notes.length > 0 ? { notes } : {}) };
}

export async function executeLandingStrategy(input: {
  cwd: string;
  plan: LandingPlan;
}): Promise<LandingExecutionResult> {
  if (input.plan.actions?.length) return executeLandingPlan({ cwd: input.cwd, plan: input.plan });
  if (input.plan.strategy === "block") {
    return { status: "blocked", outcome: "unsafe-plan", reason: input.plan.rationale };
  }
  if (input.plan.strategy === "pull-request") {
    return { status: "blocked", outcome: "pull-request-failed", reason: "Landing planner selected pull-request; publish the candidate through the PR recovery path." };
  }
  if (input.plan.strategy === "skip") {
    return { status: "skipped", outcome: "policy-skipped", reason: input.plan.rationale };
  }
  try {
    await execFileAsync("git", ["checkout", input.plan.targetBranch], { cwd: input.cwd, windowsHide: true });
    if (input.plan.candidateSha && await isAncestorOfHead(input.cwd, input.plan.candidateSha)) {
      return { status: "landed", outcome: "landed", reason: "Candidate commit is already present on the target branch." };
    }
    await runGitLandingCommand(input.cwd, input.plan);
    return { status: "landed", outcome: "landed" };
  } catch (error) {
    await abortGitOperation(input.cwd, input.plan.strategy ?? "merge");
    const reason = error instanceof Error ? error.message : String(error);
    return { status: "blocked", outcome: classifyLandingOperationFailure(input.plan.strategy ?? "merge", reason), reason };
  }
}

/** Stable markers emitted by the deterministic dirty-working-tree guard. */
export const DIRTY_GUARD_REASON_PATTERNS: readonly RegExp[] = [
  /^Dirty target checkout overlaps landing files:/,
  /^Cannot switch from .+ to .+ while unrelated files are dirty:/,
  /^WOULD_DESTROY_DIRTY_WORK$/,
];

export function isDirtyGuardReason(reason: string): boolean {
  return DIRTY_GUARD_REASON_PATTERNS.some((pattern) => pattern.test(reason));
}

export function guardVerdictHasDirtyTreeReason(reasons: string[]): boolean {
  return reasons.some(isDirtyGuardReason);
}

/** Fails loudly if a blocked landing lost the candidate it was meant to preserve. */
export async function assertCandidatePreserved(input: {
  mergeCwd: string;
  candidateBranch?: string;
  candidateSha?: string;
}): Promise<void> {
  if (input.candidateBranch) {
    await execFileAsync("git", ["rev-parse", "--verify", input.candidateBranch], {
      cwd: input.mergeCwd,
      windowsHide: true,
    });
  }
  if (input.candidateSha) {
    await execFileAsync("git", ["cat-file", "-e", `${input.candidateSha}^{commit}`], {
      cwd: input.mergeCwd,
      windowsHide: true,
    });
  }
}

export function mapDiagnosisToOutcome(kind: PrototypeLandingDiagnosisArtifact["kind"]): LandingOutcome {
  switch (kind) {
    case "dirty-target": return "dirty-checkout";
    case "merge-conflict":
    case "cherry-pick-conflict":
    case "rebase-conflict": return "conflict";
    case "verification-failed":
    case "verification-missing":
    case "baseline-debt":
    case "environment-failure": return "verification-failed";
    case "missing-candidate":
    case "candidate-empty":
    case "transient-only-change": return "missing-candidate";
    case "unsafe-risk":
    case "auth-required": return "unsafe-plan";
    default: return "unknown";
  }
}

async function runGitLandingCommand(cwd: string, plan: LandingPlan): Promise<void> {
  if (plan.strategy === "cherry-pick") {
    await execFileAsync("git", ["cherry-pick", plan.candidateSha!], { cwd, windowsHide: true });
  } else if (plan.strategy === "merge-no-ff") {
    await execFileAsync("git", ["merge", "--no-ff", "--no-edit", plan.sourceBranch!], { cwd, windowsHide: true });
  } else if (plan.strategy === "merge") {
    await execFileAsync("git", ["merge", "--ff", plan.sourceBranch!], { cwd, windowsHide: true });
  } else if (plan.strategy === "rebase") {
    await execFileAsync("git", ["rebase", plan.candidateSha!], { cwd, windowsHide: true });
  }
}

function classifyLandingOperationFailure(strategy: LandingStrategy, reason: string): string {
  if (/conflict/i.test(reason)) {
    if (strategy === "cherry-pick") return "cherry-pick-conflict";
    if (strategy === "rebase") return "rebase-conflict";
    return "merge-conflict";
  }
  if (/could not apply|bad revision|unknown revision|not a valid object/i.test(reason)) {
    return "missing-candidate";
  }
  return "unknown";
}

async function readCurrentBranch(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["branch", "--show-current"], { cwd, windowsHide: true });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function gitRefExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", ref], { cwd, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function gitCommitExists(cwd: string, sha: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function isAncestorOfHead(cwd: string, sha: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { cwd, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function abortGitOperation(cwd: string, strategy: LandingStrategy): Promise<void> {
  const command = strategy === "cherry-pick"
    ? ["cherry-pick", "--abort"]
    : strategy === "rebase"
      ? ["rebase", "--abort"]
      : ["merge", "--abort"];
  try {
    await execFileAsync("git", command, { cwd, windowsHide: true });
  } catch {
    // best effort
  }
}

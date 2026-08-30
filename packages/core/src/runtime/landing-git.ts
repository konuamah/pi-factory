import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { filesReferToSamePath } from "./failure-classification.js";
import { isTransientFactoryPath } from "./git-ops.js";
import type { PrototypeCompletedTaskArtifact, PrototypeLandingDiagnosisArtifact } from "./artifacts.js";
import type {
  DirtyLandingContext,
  LandingExecutionResult,
  LandingGuardVerdict,
  LandingOutcome,
  LandingPlan,
  LandingStrategy,
} from "./landing-types.js";

const execFileAsync = promisify(execFile);

export async function readDirtyFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd, windowsHide: true });
    return stdout.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim()).filter(Boolean);
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
}): Promise<LandingGuardVerdict> {
  const reasons: string[] = [];
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
  if (input.finalMergePolicy === "required" && input.plan.strategy === "skip") {
    reasons.push("Landing plan cannot skip while final merge policy is required.");
  }
  if (input.plan.risk === "high" && input.plan.strategy !== "block") {
    reasons.push("High-risk landing plans must block instead of executing automatically.");
  }
  if (input.finalMergePolicy === "required" && input.verificationStatus === "incomplete" && input.plan.strategy !== "block") {
    reasons.push("Required landing cannot execute while verification is incomplete.");
  }
  if (["cherry-pick", "rebase"].includes(input.plan.strategy) && !input.plan.candidateSha) {
    reasons.push(`Strategy ${input.plan.strategy} requires a candidate SHA.`);
  }
  if (["merge", "merge-no-ff"].includes(input.plan.strategy) && !input.plan.sourceBranch) {
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
  return { ok: reasons.length === 0, reasons };
}

export async function executeLandingStrategy(input: {
  cwd: string;
  plan: LandingPlan;
}): Promise<LandingExecutionResult> {
  if (input.plan.strategy === "block") {
    return { status: "blocked", outcome: "unsafe-plan", reason: input.plan.reasoning.join("; ") };
  }
  if (input.plan.strategy === "skip") {
    return { status: "skipped", outcome: "policy-skipped", reason: input.plan.reasoning.join("; ") };
  }
  try {
    await execFileAsync("git", ["checkout", input.plan.targetBranch], { cwd: input.cwd, windowsHide: true });
    if (input.plan.candidateSha && await isAncestorOfHead(input.cwd, input.plan.candidateSha)) {
      return { status: "landed", outcome: "landed", reason: "Candidate commit is already present on the target branch." };
    }
    await runGitLandingCommand(input.cwd, input.plan);
    return { status: "landed", outcome: "landed" };
  } catch (error) {
    await abortGitOperation(input.cwd, input.plan.strategy);
    const reason = error instanceof Error ? error.message : String(error);
    return { status: "blocked", outcome: classifyLandingOperationFailure(input.plan.strategy, reason), reason };
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

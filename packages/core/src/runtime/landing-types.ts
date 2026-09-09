import type {
  PrototypeLandingDiagnosisArtifact,
  PrototypeLandingPlanArtifact,
} from "./artifacts.js";

export type LandingStrategy = "cherry-pick" | "merge" | "merge-no-ff" | "rebase" | "pull-request" | "skip" | "block";
export type LandingRisk = "low" | "medium" | "high";
export type LandingStatus = "landed" | "skipped" | "blocked" | "failed" | "pull-request";
export type LandingOutcome =
  | "landed"
  | "policy-skipped"
  | "dirty-checkout"
  | "conflict"
  | "verification-failed"
  | "missing-candidate"
  | "unsafe-plan"
  | "unknown"
  | "pull-request-created"
  | "pull-request-existing"
  | "pull-request-failed";
export type LandingTerminalPhase = "complete" | "merge-blocked" | "pull-request-opened" | "accepted" | "accepted-with-pr" | "acceptance-blocked";

export interface GitAction {
  program: "git";
  args: string[];
  intent: string;
}

export interface LandingActionGit {
  kind: "git";
  step: GitAction;
}

export interface LandingActionPullRequest {
  kind: "pull-request";
  provider: "github";
  sourceBranch: string;
  targetBranch: string;
  title: string;
  body: string;
  draft: boolean;
}

export type LandingAction = LandingActionGit | LandingActionPullRequest;

export interface LandingPlan {
  actions: LandingAction[];
  targetBranch: string;
  candidateSha?: string;
  sourceBranch?: string;
  rationale: string;
  verification: string[];
  risk: LandingRisk;
  expectedFiles: string[];
  recoveryPlan?: string;
  /** Derived display value; execution uses actions only. */
  strategy?: LandingStrategy;
}

export function derivedLandingStrategy(plan: Pick<LandingPlan, "actions">): LandingStrategy {
  const first = plan.actions[0];
  if (!first) return "block";
  if (first.kind === "pull-request") return "pull-request";
  if (first.step.args[0] === "merge" && first.step.args.includes("--no-ff")) return "merge-no-ff";
  if (first.step.args[0] === "merge") return "merge";
  if (first.step.args[0] === "cherry-pick") return "cherry-pick";
  if (first.step.args[0] === "rebase") return "rebase";
  return "block";
}

export interface LandingGuardVerdict {
  ok: boolean;
  reasons: string[];
  /** Non-blocking warnings surfaced to the human; do not affect `ok`. */
  notes?: string[];
}

export interface LandingExecutionResult {
  status: LandingStatus;
  outcome: string;
  reason?: string;
  steps?: Array<{ index: number; args: string[]; status: "applied" | "blocked"; exitCode?: number; stderr?: string }>;
}

export interface LandingResult {
  finalMergePath: string;
  status: "COMPLETED" | "BLOCKED";
  phase: LandingTerminalPhase;
  approved: boolean;
  landingStatus: LandingStatus;
  landingAttempts: number;
  recoveryHint?: string;
  pullRequest?: {
    status: "created" | "existing" | "skipped" | "failed";
    url?: string;
    sourceBranch: string;
    targetBranch: string;
    reason: string;
  };
  targetHeadBefore?: string;
  targetHeadAfter?: string;
  postLandingVerification?: {
    status: "pending" | "passed" | "failed" | "incomplete" | "error";
    commands: string[];
    reason?: string;
    repairAttempted?: boolean;
  };
}

export interface DirtyLandingContext {
  all: string[];
  relevant: string[];
  unrelated: string[];
}

export type LandingPlanArtifact = PrototypeLandingPlanArtifact;
export type LandingDiagnosisArtifact = PrototypeLandingDiagnosisArtifact;

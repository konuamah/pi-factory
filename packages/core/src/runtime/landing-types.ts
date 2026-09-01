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

export interface LandingPlan {
  strategy: LandingStrategy;
  targetBranch: string;
  candidateSha?: string;
  sourceBranch?: string;
  reasoning: string[];
  verification: string[];
  risk: LandingRisk;
  expectedFiles: string[];
  recoveryPlan?: string;
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
}

export interface LandingResult {
  finalMergePath: string;
  status: "COMPLETED" | "BLOCKED";
  phase: "complete" | "merge-blocked" | "pull-request-opened";
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
}

export interface DirtyLandingContext {
  all: string[];
  relevant: string[];
  unrelated: string[];
}

export type LandingPlanArtifact = PrototypeLandingPlanArtifact;
export type LandingDiagnosisArtifact = PrototypeLandingDiagnosisArtifact;

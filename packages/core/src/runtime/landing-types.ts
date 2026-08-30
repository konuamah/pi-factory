import type {
  PrototypeLandingDiagnosisArtifact,
  PrototypeLandingPlanArtifact,
} from "./artifacts.js";

export type LandingStrategy = "cherry-pick" | "merge" | "merge-no-ff" | "rebase" | "skip" | "block";
export type LandingRisk = "low" | "medium" | "high";
export type LandingStatus = "landed" | "skipped" | "blocked" | "failed";
export type LandingOutcome =
  | "landed"
  | "policy-skipped"
  | "dirty-checkout"
  | "conflict"
  | "verification-failed"
  | "missing-candidate"
  | "unsafe-plan"
  | "unknown";

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
}

export interface LandingExecutionResult {
  status: LandingStatus;
  outcome: string;
  reason?: string;
}

export interface LandingResult {
  finalMergePath: string;
  status: "COMPLETED" | "BLOCKED";
  phase: "complete" | "merge-blocked";
  approved: boolean;
  landingStatus: LandingStatus;
  landingAttempts: number;
  recoveryHint?: string;
}

export interface DirtyLandingContext {
  all: string[];
  relevant: string[];
  unrelated: string[];
}

export type LandingPlanArtifact = PrototypeLandingPlanArtifact;
export type LandingDiagnosisArtifact = PrototypeLandingDiagnosisArtifact;

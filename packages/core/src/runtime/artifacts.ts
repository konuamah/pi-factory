import fs from "node:fs/promises";
import path from "node:path";

export interface PrototypeTaskArtifact {
  id: string;
  title: string;
  stage: string;
  status: "pending" | "done" | "running" | "failed";
  dependsOn: string[];
  type?: string;
  role?: string;
  commands?: string[];
  requiresApproval?: boolean;
  skills?: {
    require?: string[];
    prefer?: string[];
    exclude?: string[];
  };
  context?: {
    fileHints?: string[];
    constitutionAreas?: number[];
    requiredCapabilities?: string[];
    includeDependencyArtifacts?: boolean;
  };
  workspacePath?: string;
  workspaceMode?: "existing" | "created" | "in-place";
  workspaceBranch?: string;
  controllerHandled?: boolean;
  artifactRefs?: {
    discoveryExecutionPath?: string;
    interviewExecutionPath?: string;
    plannerExecutionPath?: string;
  };
}

export interface PrototypePlanArtifact {
  goal: string;
  summary: string;
  discoveryText?: string;
  planText?: string;
  implementationContract?: {
    targetFiles?: string[];
    nonGoals?: string[];
    verificationChecks?: Array<{ name: string; command?: string; reason?: string }>;
    risks?: Array<{ risk: string; mitigation?: string }>;
    blockers?: string[];
  };
  workflowStages: Array<{
    name: string;
    dependsOn: string[];
    type?: string;
    role?: string;
    commands?: string[];
    requiresApproval?: boolean;
    skills?: {
      require?: string[];
      prefer?: string[];
      exclude?: string[];
    };
  }>;
  tasks: Array<{
    id: string;
    title: string;
    stage: string;
    status: "pending" | "done";
    dependsOn: string[];
    type?: string;
    role?: string;
    commands?: string[];
    requiresApproval?: boolean;
    skills?: {
      require?: string[];
      prefer?: string[];
      exclude?: string[];
    };
    context?: {
      fileHints?: string[];
      constitutionAreas?: number[];
      requiredCapabilities?: string[];
      includeDependencyArtifacts?: boolean;
    };
  }>;
}

export interface PrototypeVerificationArtifact {
  cwd: string;
  cwdResolution: "configured" | "root-package" | "inferred-single-package" | "default-root";
  commands: Array<{
    name: string;
    command: string;
    status: "configured" | "missing" | "passed" | "failed";
    exitCode?: number;
    stdout?: string;
    stderr?: string;
  }>;
  overallStatus: "passed" | "failed" | "incomplete";
  selectionSource?: "configured" | "ai" | "deterministic";
  rationale?: string;
  skill?: {
    id: string;
    version: string;
    mode: "verification" | "repair";
    selectionReasons: string[];
  };
  evidence?: {
    rootCwd: string;
    configuredCwd?: string;
    rootScripts: string[];
    candidateCwds: Array<{
      path: string;
      relativePath: string;
      reason: string;
      packageName?: string;
      scripts: string[];
      scriptCommands?: Record<string, string>;
      packageManager?: string;
      dependencyVersions?: Record<string, string>;
      staleScripts?: Array<{
        script: string;
        command: string;
        reason: string;
        replacementCommand?: string;
      }>;
    }>;
    selectedCandidate?: {
      path: string;
      relativePath: string;
      reason: string;
      packageName?: string;
      scripts: string[];
      scriptCommands?: Record<string, string>;
      packageManager?: string;
      dependencyVersions?: Record<string, string>;
      staleScripts?: Array<{
        script: string;
        command: string;
        reason: string;
        replacementCommand?: string;
      }>;
    };
    commandDecisions?: Array<{
      name: string;
      configured: boolean;
      selected: boolean;
      command?: string;
      reason: string;
    }>;
  };
  contract?: {
    plan: {
      requirements: Array<{
        id: string;
        type: string;
        blocking: boolean;
        description: string;
        source: string;
        scope: string;
      }>;
      createdFrom: {
        skills: string[];
        constitutionAreas: number[];
        taskType?: string;
        workflow?: string;
        userCriteria?: string[];
      };
    };
    results: Array<{
      requirementId: string;
      blocking: boolean;
      status: string;
      evidence: Array<{ id: string; kind: string }>;
      reason?: string;
    }>;
    evidenceStore: Record<string, { kind: string; [key: string]: unknown }>;
    overallStatus: string;
    canComplete: boolean;
  };
  failureClassification?: {
    kind: string;
    reason: string;
    retryable: boolean;
    suggestedPhase: string;
    classificationSource?: string;
    deterministicClassification?: {
      kind: string;
      reason: string;
      retryable: boolean;
      suggestedPhase: string;
      perCommand?: Array<{ commandName: string; category: string; reason: string; retryable: boolean; suggestedAction: string }>;
    };
    perCommand?: Array<{
      commandName: string;
      category: string;
      reason: string;
      retryable: boolean;
      suggestedAction: string;
      implicatedFiles?: string[];
    }>;
  };
}

export interface PrototypePlannerExecutionArtifact {
  executionId: string;
  status: "completed" | "failed" | "cancelled";
  outputText: string;
  events: Array<{
    type: string;
    data?: Record<string, unknown>;
  }>;
  errorMessage?: string;
}

export interface PrototypeDiscoveryExecutionArtifact {
  executionId: string;
  status: "completed" | "failed" | "cancelled";
  outputText: string;
  events: Array<{
    type: string;
    data?: Record<string, unknown>;
  }>;
  errorMessage?: string;
}

export interface PrototypeRepairExecutionArtifact {
  attempt: number;
  executionId: string;
  status: "completed" | "failed" | "cancelled";
  outputText: string;
  events: Array<{
    type: string;
    data?: Record<string, unknown>;
  }>;
  errorMessage?: string;
}

export interface PrototypeReviewerExecutionArtifact {
  executionId: string;
  status: "completed" | "failed" | "cancelled";
  outputText: string;
  events: Array<{
    type: string;
    data?: Record<string, unknown>;
  }>;
  errorMessage?: string;
}

export interface PrototypeBuilderExecutionArtifact {
  taskId: string;
  workspacePath?: string;
  workspaceBranch?: string;
  executionId: string;
  status: "completed" | "failed" | "cancelled";
  outputText: string;
  events: Array<{
    type: string;
    data?: Record<string, unknown>;
  }>;
  errorMessage?: string;
}

export interface PrototypeIntegrationArtifact {
  executionCwd: string;
  mergedBranches: Array<{
    taskId: string;
    branch?: string;
    workspacePath: string;
    status: "merged" | "skipped";
    reason?: string;
  }>;
}

export interface PrototypeCompletedTaskArtifact {
  taskId: string;
  targetBranch: string;
  sourceBranch?: string;
  commitSha: string;
  changedFiles: string[];
  workspaceMode: "created" | "existing" | "in-place";
  worktreePath?: string;
}

export interface PrototypeLandingPlanArtifact {
  strategy: "cherry-pick" | "merge" | "merge-no-ff" | "rebase" | "pull-request" | "skip" | "block";
  targetBranch: string;
  candidateSha?: string;
  sourceBranch?: string;
  reasoning: string[];
  verification: string[];
  risk: "low" | "medium" | "high";
  expectedFiles: string[];
  recoveryPlan?: string;
  guardVerdict: {
    ok: boolean;
    reasons: string[];
  };
}

export interface PrototypeLandingDiagnosisArtifact {
  kind:
    | "dirty-target"
    | "merge-conflict"
    | "cherry-pick-conflict"
    | "rebase-conflict"
    | "missing-candidate"
    | "candidate-empty"
    | "transient-only-change"
    | "verification-failed"
    | "verification-missing"
    | "baseline-debt"
    | "environment-failure"
    | "unsafe-risk"
    | "auth-required"
    | "timeout"
    | "unknown";
  reasoning: string[];
  retryable: boolean;
  recoveryAction:
    | "repair-code"
    | "resolve-conflict"
    | "refresh-target"
    | "rerun-verification"
    | "replan-landing"
    | "prepare-environment"
    | "ask-approval"
    | "block";
  risk: "low" | "medium" | "high";
  recoveryHint: string;
}

export interface PrototypeLandingAttemptArtifact {
  attempt: number;
  plan: PrototypeLandingPlanArtifact;
  execution: {
    status: "landed" | "blocked" | "failed" | "skipped";
    outcome: string;
    reason?: string;
  };
  verification?: {
    overallStatus: "passed" | "failed" | "incomplete";
    commands: string[];
  };
  diagnosis?: PrototypeLandingDiagnosisArtifact;
}

export interface PrototypeFinalMergeArtifact {
  mergeBaseBranch: string;
  candidateBranch?: string;
  candidateSha?: string;
  mergeCwd: string;
  status: "landed" | "skipped" | "blocked" | "failed" | "pull-request-created" | "pull-request-existing";
  outcome?:
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
  strategy?: "cherry-pick" | "merge" | "merge-no-ff" | "rebase" | "pull-request" | "skip" | "block";
  targetBranch?: string;
  sourceBranch?: string;
  recoveryHint?: string;
  reason?: string;
  pullRequest?: {
    status: "created" | "existing" | "skipped" | "failed";
    url?: string;
    sourceBranch: string;
    targetBranch: string;
    reason: string;
  };
}

export interface PrototypeSummaryArtifact {
  runId: string;
  goal: string;
  title?: string;
  status: "PENDING" | "COMPLETED" | "FAILED" | "CANCELLED" | "BLOCKED";
  phase: string;
  approved: boolean;
  candidateSha?: string;
  planPath: string;
  taskPaths: string[];
  discoveryExecutionPath?: string;
  plannerExecutionPath?: string;
  builderExecutionPaths?: string[];
  integrationPath?: string;
  finalMergePath?: string;
  landingStatus?: "landed" | "skipped" | "blocked" | "failed";
  landingAttempts?: number;
  recoveryHint?: string;
  pullRequest?: {
    status: "created" | "existing" | "skipped" | "failed";
    url?: string;
    sourceBranch: string;
    targetBranch: string;
    reason: string;
  };
  repairExecutionPaths?: string[];
  reviewerExecutionPath?: string;
  verificationPath: string;
  verificationStatus: "passed" | "failed" | "incomplete";
}


export { writePrototypePlanArtifact, writePrototypeTaskArtifacts, writePrototypeVerificationArtifact, writePrototypePlannerExecutionArtifact, writePrototypeDiscoveryExecutionArtifact, writePrototypeRepairExecutionArtifact, writePrototypeReviewerExecutionArtifact, writePrototypeBuilderExecutionArtifact, writePrototypeIntegrationArtifact, writePrototypeCompletedTasksArtifact, writePrototypeLandingPlanArtifact, writePrototypeLandingDiagnosisArtifact, appendPrototypeLandingAttemptArtifact, writePrototypeFinalMergeArtifact, writePrototypeSummaryArtifact } from "./artifact-writers.js";

import fs from "node:fs/promises";
import path from "node:path";

export interface PrototypeTaskArtifact {
  id: string;
  title: string;
  stage: string;
  status: "pending" | "done" | "running" | "failed" | "aborted";
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
}

export interface PrototypePlanArtifact {
  goal: string;
  summary: string;
  discoveryText?: string;
  planText?: string;
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
    status: "configured" | "missing" | "passed" | "failed" | "timed-out";
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    timeoutMs?: number;
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
    }>;
    selectedCandidate?: {
      path: string;
      relativePath: string;
      reason: string;
      packageName?: string;
      scripts: string[];
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
    perCommand?: Array<{
      commandName: string;
      category: string;
      reason: string;
      retryable: boolean;
      suggestedAction: string;
    }>;
  };
}

export interface PrototypePlannerExecutionArtifact {
  executionId: string;
  status: "completed" | "failed" | "cancelled" | "aborted";
  outputText: string;
  events: Array<{
    type: string;
    data?: Record<string, unknown>;
  }>;
  errorMessage?: string;
}

export interface PrototypeDiscoveryExecutionArtifact {
  executionId: string;
  status: "completed" | "failed" | "cancelled" | "aborted";
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
  status: "completed" | "failed" | "cancelled" | "aborted";
  outputText: string;
  events: Array<{
    type: string;
    data?: Record<string, unknown>;
  }>;
  errorMessage?: string;
}

export interface PrototypeReviewerExecutionArtifact {
  executionId: string;
  status: "completed" | "failed" | "cancelled" | "aborted";
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
  status: "completed" | "failed" | "cancelled" | "aborted";
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

export interface PrototypeFinalMergeArtifact {
  mergeBaseBranch: string;
  candidateBranch?: string;
  candidateSha?: string;
  mergeCwd: string;
  status: "merged" | "skipped";
  reason?: string;
}

export interface PrototypeSummaryArtifact {
  runId: string;
  goal: string;
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
  repairExecutionPaths?: string[];
  reviewerExecutionPath?: string;
  verificationPath: string;
  verificationStatus: "passed" | "failed" | "incomplete";
}

export async function writePrototypePlanArtifact(
  runDir: string,
  artifact: PrototypePlanArtifact,
): Promise<string> {
  const filePath = path.join(runDir, "plan.json");
  await fs.writeFile(filePath, JSON.stringify(artifact, null, 2), "utf8");
  return filePath;
}

export async function writePrototypeTaskArtifacts(
  runDir: string,
  tasks: PrototypeTaskArtifact[],
): Promise<string[]> {
  const tasksDir = path.join(runDir, "tasks");
  await fs.mkdir(tasksDir, { recursive: true });

  const paths: string[] = [];
  for (const task of tasks) {
    const filePath = path.join(tasksDir, `${task.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(task, null, 2), "utf8");
    paths.push(filePath);
  }

  return paths;
}

export async function writePrototypeVerificationArtifact(
  runDir: string,
  artifact: PrototypeVerificationArtifact,
): Promise<string> {
  const filePath = path.join(runDir, "verification.json");
  await fs.writeFile(filePath, JSON.stringify(artifact, null, 2), "utf8");
  return filePath;
}

export async function writePrototypePlannerExecutionArtifact(
  runDir: string,
  artifact: PrototypePlannerExecutionArtifact,
): Promise<string> {
  const filePath = path.join(runDir, "planner-execution.json");
  await fs.writeFile(filePath, JSON.stringify(artifact, null, 2), "utf8");
  return filePath;
}

export async function writePrototypeDiscoveryExecutionArtifact(
  runDir: string,
  artifact: PrototypeDiscoveryExecutionArtifact,
): Promise<string> {
  const filePath = path.join(runDir, "discovery-execution.json");
  await fs.writeFile(filePath, JSON.stringify(artifact, null, 2), "utf8");
  return filePath;
}

export async function writePrototypeRepairExecutionArtifact(
  runDir: string,
  artifact: PrototypeRepairExecutionArtifact,
): Promise<string> {
  const filePath = path.join(runDir, `repair-execution-${artifact.attempt}.json`);
  await fs.writeFile(filePath, JSON.stringify(artifact, null, 2), "utf8");
  return filePath;
}

export async function writePrototypeReviewerExecutionArtifact(
  runDir: string,
  artifact: PrototypeReviewerExecutionArtifact,
): Promise<string> {
  const filePath = path.join(runDir, "reviewer-execution.json");
  await fs.writeFile(filePath, JSON.stringify(artifact, null, 2), "utf8");
  return filePath;
}

export async function writePrototypeBuilderExecutionArtifact(
  runDir: string,
  artifact: PrototypeBuilderExecutionArtifact,
): Promise<string> {
  const filePath = path.join(runDir, `builder-execution-${artifact.taskId}.json`);
  await fs.writeFile(filePath, JSON.stringify(artifact, null, 2), "utf8");
  return filePath;
}

export async function writePrototypeIntegrationArtifact(
  runDir: string,
  artifact: PrototypeIntegrationArtifact,
): Promise<string> {
  const filePath = path.join(runDir, "integration.json");
  await fs.writeFile(filePath, JSON.stringify(artifact, null, 2), "utf8");
  return filePath;
}

export async function writePrototypeFinalMergeArtifact(
  runDir: string,
  artifact: PrototypeFinalMergeArtifact,
): Promise<string> {
  const filePath = path.join(runDir, "final-merge.json");
  await fs.writeFile(filePath, JSON.stringify(artifact, null, 2), "utf8");
  return filePath;
}

export interface PrototypeVerificationPlanArtifact {
  executionId: string;
  status: "completed" | "failed" | "cancelled" | "aborted";
  outputText: string;
  repairOutputText?: string;
  usedDeterministicFallback?: boolean;
  errorMessage?: string;
}

export async function writePrototypeVerificationPlanArtifact(
  runDir: string,
  artifact: PrototypeVerificationPlanArtifact,
): Promise<string> {
  const filePath = path.join(runDir, "verification-plan-execution.json");
  await fs.writeFile(filePath, JSON.stringify(artifact, null, 2), "utf8");
  return filePath;
}

export async function writePrototypeAbortDecisionArtifact(
  runDir: string,
  artifact: {
    taskId: string;
    originalExecutionId?: string;
    decisionExecutionId?: string;
    decision: { action: string; reason: string; instructions?: string };
    abortReason?: unknown;
    attempt: number;
    decidedAt: string;
  },
): Promise<string> {
  const filePath = path.join(runDir, "abort-decision.json");
  await fs.writeFile(filePath, JSON.stringify(artifact, null, 2), "utf8");
  return filePath;
}

export async function writePrototypeSummaryArtifact(
  runDir: string,
  artifact: PrototypeSummaryArtifact,
): Promise<string> {
  const filePath = path.join(runDir, "summary.json");
  await fs.writeFile(filePath, JSON.stringify(artifact, null, 2), "utf8");
  return filePath;
}

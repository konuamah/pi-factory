import fs from "node:fs/promises";
import path from "node:path";

export interface PrototypeTaskArtifact {
  id: string;
  title: string;
  stage: string;
  status: "pending" | "done" | "running" | "failed";
  dependsOn: string[];
  workspacePath?: string;
  workspaceMode?: "existing" | "created" | "in-place";
  workspaceBranch?: string;
}

export interface PrototypePlanArtifact {
  goal: string;
  summary: string;
  planText?: string;
  workflowStages: Array<{
    name: string;
    dependsOn: string[];
  }>;
  tasks: Array<{
    id: string;
    title: string;
    stage: string;
    status: "pending" | "done";
    dependsOn: string[];
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
  failureClassification?: {
    kind: "harness/config" | "repo script/config" | "real code failure" | "unknown";
    reason: string;
    retryable: boolean;
    suggestedPhase: string;
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
  status: "PENDING" | "COMPLETED" | "FAILED" | "CANCELLED";
  phase: string;
  approved: boolean;
  candidateSha?: string;
  planPath: string;
  taskPaths: string[];
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

export async function writePrototypeSummaryArtifact(
  runDir: string,
  artifact: PrototypeSummaryArtifact,
): Promise<string> {
  const filePath = path.join(runDir, "summary.json");
  await fs.writeFile(filePath, JSON.stringify(artifact, null, 2), "utf8");
  return filePath;
}

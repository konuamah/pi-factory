import fs from "node:fs/promises";
import path from "node:path";

export interface PrototypeTaskArtifact {
  id: string;
  title: string;
  stage: string;
  status: "pending" | "done" | "running";
  dependsOn: string[];
}

export interface PrototypePlanArtifact {
  goal: string;
  summary: string;
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
  commands: Array<{
    name: string;
    command: string;
    status: "configured" | "missing" | "passed" | "failed";
    exitCode?: number;
    stdout?: string;
    stderr?: string;
  }>;
  overallStatus: "passed" | "failed" | "incomplete";
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

export interface PrototypeSummaryArtifact {
  runId: string;
  goal: string;
  status: "COMPLETED" | "FAILED" | "CANCELLED";
  phase: string;
  approved: boolean;
  planPath: string;
  taskPaths: string[];
  plannerExecutionPath?: string;
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

export async function writePrototypeSummaryArtifact(
  runDir: string,
  artifact: PrototypeSummaryArtifact,
): Promise<string> {
  const filePath = path.join(runDir, "summary.json");
  await fs.writeFile(filePath, JSON.stringify(artifact, null, 2), "utf8");
  return filePath;
}

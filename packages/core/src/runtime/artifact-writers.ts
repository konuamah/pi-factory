// Prototype artifact writers — extracted from artifacts.ts.

import fs from "node:fs/promises";
import path from "node:path";
import type { PrototypePlanArtifact, PrototypeTaskArtifact, PrototypeVerificationArtifact, PrototypePlannerExecutionArtifact, PrototypeDiscoveryExecutionArtifact, PrototypeRepairExecutionArtifact, PrototypeReviewerExecutionArtifact, PrototypeBuilderExecutionArtifact, PrototypeIntegrationArtifact, PrototypeCompletedTaskArtifact, PrototypeLandingPlanArtifact, PrototypeLandingDiagnosisArtifact, PrototypeLandingAttemptArtifact, PrototypeFinalMergeArtifact, PrototypeSummaryArtifact } from "./artifacts.js";

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

export async function writePrototypeCompletedTasksArtifact(
  runDir: string,
  artifact: PrototypeCompletedTaskArtifact[],
): Promise<string> {
  const filePath = path.join(runDir, "completed-tasks.json");
  await fs.writeFile(filePath, JSON.stringify(artifact, null, 2), "utf8");
  return filePath;
}

export async function writePrototypeLandingPlanArtifact(
  runDir: string,
  artifact: PrototypeLandingPlanArtifact,
): Promise<string> {
  const filePath = path.join(runDir, "landing-plan.json");
  await fs.writeFile(filePath, JSON.stringify(artifact, null, 2), "utf8");
  return filePath;
}

export async function writePrototypeLandingDiagnosisArtifact(
  runDir: string,
  attempt: number,
  artifact: PrototypeLandingDiagnosisArtifact,
): Promise<string> {
  const filePath = path.join(runDir, `landing-diagnosis-${attempt}.json`);
  await fs.writeFile(filePath, JSON.stringify(artifact, null, 2), "utf8");
  return filePath;
}

export async function appendPrototypeLandingAttemptArtifact(
  runDir: string,
  artifact: PrototypeLandingAttemptArtifact,
): Promise<string> {
  const filePath = path.join(runDir, "landing-attempts.jsonl");
  await fs.appendFile(filePath, `${JSON.stringify(artifact)}\n`, "utf8");
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


import fs from "node:fs/promises";
import path from "node:path";
import type { FailureRecoveryContext } from "./failure-recovery.js";
import type { RunFactoryControllerResult } from "./controller.js";

export type RecoveryCheckpointPhase =
  | "implementation"
  | "verification-blocked"
  | "review"
  | "approval-ready"
  | "landing-planning"
  | "post-landing-verification";

export interface RecoveryCheckpoint {
  version: 1;
  runId: string;
  goal: string;
  phase: RecoveryCheckpointPhase;
  createdAt: string;
  executionCwd: string;
  projectRoot: string;
  worktree?: RunFactoryControllerResult["worktree"];
  planPath?: string;
  taskPaths?: string[];
  discoveryExecutionPath?: string;
  plannerExecutionPath?: string;
  builderExecutionPaths?: string[];
  integrationPath?: string;
  repairExecutionPaths?: string[];
  verificationPath?: string;
  finalMergePath?: string;
  candidateSha?: string;
  recoveryContext: FailureRecoveryContext;
}

export type RecoveryCheckpointInput = Omit<RecoveryCheckpoint, "version" | "createdAt" | "recoveryContext">;

export async function writeRecoveryCheckpoint(runDir: string, checkpoint: RecoveryCheckpoint): Promise<string> {
  const checkpointPath = recoveryCheckpointPath(runDir);
  await fs.writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2), "utf8");
  return checkpointPath;
}

export async function readRecoveryCheckpoint(runDir: string): Promise<RecoveryCheckpoint | undefined> {
  const checkpointPath = recoveryCheckpointPath(runDir);
  try {
    const parsed = JSON.parse(await fs.readFile(checkpointPath, "utf8")) as RecoveryCheckpoint;
    return isRecoveryCheckpoint(parsed) ? parsed : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

export async function clearRecoveryCheckpoint(runDir: string): Promise<void> {
  try {
    await fs.unlink(recoveryCheckpointPath(runDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function recoveryCheckpointPath(runDir: string): string {
  return path.join(runDir, "recovery-checkpoint.json");
}

function isRecoveryCheckpoint(value: unknown): value is RecoveryCheckpoint {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<RecoveryCheckpoint>;
  return item.version === 1
    && typeof item.runId === "string"
    && typeof item.goal === "string"
    && typeof item.phase === "string"
    && typeof item.createdAt === "string"
    && typeof item.executionCwd === "string"
    && typeof item.projectRoot === "string"
    && Boolean(item.recoveryContext)
    && typeof item.recoveryContext === "object";
}

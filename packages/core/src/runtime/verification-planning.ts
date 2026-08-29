// Verification planning helpers — extracted from controller.ts.
// Contract artifact building, failure signatures, task-type resolution,
// and impact filtering.

import type { RunFactoryControllerInput } from "./controller.js";
import { classifyTaskType, taskTypeMatchPaths, type TaskTypeSelection } from "../models/index.js";
import type { EffectiveFactoryConfig } from "@factory/schemas";
import type { VerificationContractPlan, VerificationEngineResult } from "../verification/index.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

export function buildContractArtifact(plan: VerificationContractPlan, result: VerificationEngineResult): {
  plan: {
    requirements: Array<{ id: string; type: string; blocking: boolean; description: string; source: string; scope: string }>;
    createdFrom: VerificationContractPlan["createdFrom"];
  };
  results: Array<{ requirementId: string; blocking: boolean; status: string; evidence: Array<{ id: string; kind: string }>; reason?: string }>;
  evidenceStore: VerificationEngineResult["evidence"];
  overallStatus: string;
  canComplete: boolean;
} {
  return {
    plan: {
      requirements: plan.requirements.map((requirement) => ({
        id: requirement.id,
        type: requirement.type,
        blocking: requirement.blocking,
        description: requirement.description,
        source: requirement.source,
        scope: requirement.scope,
      })),
      createdFrom: plan.createdFrom,
    },
    results: result.results.map((item) => ({
      requirementId: item.requirementId,
      blocking: item.blocking,
      status: item.status,
      evidence: item.evidence,
      reason: item.reason,
    })),
    evidenceStore: result.evidence,
    overallStatus: result.overallStatus,
    canComplete: result.canComplete,
  };
}

export function failureSignature(verification: { commands: Array<{ name: string; status: string; stderr?: string; stdout?: string }> }): string {
  const failed = verification.commands
    .filter((command) => command.status === "failed")
    .map((command) => {
      const text = `${command.stderr ?? ""}\n${command.stdout ?? ""}`.trim();
      const firstError = text.split(/\r?\n/).find((line) => /error|failed|exception|\d+:\d+/.test(line)) ?? text.slice(0, 200);
      return `${command.name}:${firstError.slice(0, 200)}`;
    });
  return JSON.stringify(failed);
}

export function resolveRunTaskType(input: RunFactoryControllerInput, config: EffectiveFactoryConfig): TaskTypeSelection {
  if (input.taskType) {
    return { id: input.taskType, source: "run-override", confidence: 1, reasons: ["Explicit run task-type override."] };
  }
  const classifier = classifyTaskType(input.goal, config);
  if (classifier.source === "classifier" || classifier.source === "default") {
    return classifier;
  }
  return { id: "general", source: "default", confidence: 0.2, reasons: ["No task type matched."] };
}

export async function resolveRunTaskTypeWithPaths(
  input: RunFactoryControllerInput,
  config: EffectiveFactoryConfig,
  projectRoot: string,
): Promise<TaskTypeSelection> {
  const classifier = resolveRunTaskType(input, config);
  if (input.taskType) {
    return classifier;
  }

  const changedFiles = await gitChangedFiles(projectRoot);
  if (changedFiles.length > 0) {
    const pathMatch = taskTypeMatchPaths(config.taskTypes ?? {}, changedFiles);
    if (pathMatch) {
      return {
        id: pathMatch,
        source: "classifier",
        confidence: 0.9,
        reasons: [`Changed files matched path hints: ${changedFiles.slice(0, 3).join(", ")}`],
      };
    }
  }
  return classifier;
}

export async function gitChangedFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd, windowsHide: true });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .filter((file) => file && file !== "NUL");
  } catch {
    return [];
  }
}

export async function getChangedFilesFromBase(cwd: string, branch: string | undefined): Promise<string[]> {
  const baseBranch = branch || "main";
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--name-only", `origin/${baseBranch}`, "HEAD"], { cwd, windowsHide: true });
    return stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export interface ImpactResult {
  commands: Record<string, unknown>;
  selected: Array<{ name: string; command: string; reason: string }>;
  skipped: Array<{ name: string; command: string; reason: string }>;
}

const HIGH_IMPACT_ROOT_FILES = new Set([
  "package.json", "package-lock.json", "pnpm-lock.yaml",
  "tsconfig.json", "tsconfig.node.json",
  "Dockerfile", "docker-compose.yml", "docker-compose.yaml",
  "factory.yaml", ".factory/config.yaml",
]);

export function filterVerificationByImpact(
  commands: Record<string, string>,
  changedFiles: string[],
): ImpactResult {
  if (changedFiles.length === 0) {
    return { commands, selected: Object.entries(commands).map(([name, command]) => ({ name, command, reason: "No change data; running all checks" })), skipped: [] };
  }

  const hasHighImpactChange = changedFiles.some((file) => {
    const basename = path.basename(file);
    return HIGH_IMPACT_ROOT_FILES.has(basename);
  });
  if (hasHighImpactChange) {
    return { commands, selected: Object.entries(commands).map(([name, command]) => ({ name, command, reason: "High-impact root file changed" })), skipped: [] };
  }

  const selected: Record<string, string> = {};
  const skipped: Array<{ name: string; command: string; reason: string }> = [];

  for (const [name, command] of Object.entries(commands)) {
    if (name === "cwd") continue;
    const checkDir = extractCommandCwd(command);
    if (!checkDir) {
      selected[name] = command;
      continue;
    }
    const hasOverlap = changedFiles.some((file) => file.startsWith(checkDir));
    if (hasOverlap) {
      selected[name] = command;
    } else {
      skipped.push({ name, command, reason: `No changed files under ${checkDir}` });
    }
  }

  return { commands: selected, selected: Object.entries(selected).map(([name, command]) => ({ name, command, reason: `Changed files under ${extractCommandCwd(command) ?? "."}` })), skipped };
}

export function extractCommandCwd(command: string): string | undefined {
  const match = command.match(/^\s*cd\s+([^&;|]+?)\s*&&/);
  return match ? match[1].trim() : undefined;
}


// Controller run setup — extracted from controller-run.ts.

import path from "node:path";
import { loadEffectiveConfig } from "../config/loader.js";
import { resolveFileReferences, FileResolutionError } from "./file-resolution.js";
import { inspectGitIsolation } from "../git/worktree.js";
import { createGitWorktree } from "../git/worktree.js";
import { createFactoryRun, appendFactoryRunEvent, updateFactoryRunState } from "../runs/store.js";
import { hydrateWorkspaceDependencies, DependencyHydrationError } from "./dependencies.js";
import { emitProgress, movePhase } from "./phase-plumbing.js";
import { writePrototypeSummaryArtifact } from "./artifacts.js";
import { slugifyGoal } from "./skills.js";
import { initializeFactorySkills } from "../skills/index.js";
import type { RunFactoryControllerInput, RunFactoryControllerResult, FactoryRunProgressEvent } from "./controller.js";
import type { EffectiveFactoryConfig } from "@factory/schemas";

export interface ControllerRunSetup {
  loaded: Awaited<ReturnType<typeof loadEffectiveConfig>>;
  projectRoot: string;
  worktree: NonNullable<RunFactoryControllerResult["worktree"]>;
  executionCwd: string;
  run: Awaited<ReturnType<typeof createFactoryRun>>;
  phases: string[];
  delayMs: number;
  builderExecutionPaths: string[];
  integrationPath: string | undefined;
  finalMergePath: string | undefined;
  candidateSha: string | undefined;
  repairExecutionPaths: string[];
}

export async function setupControllerRun(
  input: RunFactoryControllerInput,
  onWorkspaceReady?: (info: { runDir: string; projectRoot: string; createdWorktreePath?: string; baseBranch: string }) => void,
): Promise<RunFactoryControllerResult | ControllerRunSetup> {
  let runDir: string | undefined;

const loaded = await loadEffectiveConfig({
  cwd: input.cwd,
  runOverrides: input.workflowId ? { workflowId: input.workflowId } : undefined,
});
const root = path.dirname(loaded.sources.projectConfigPath ?? path.join(input.cwd, ".factory", "config.yaml"));
const projectRoot = path.dirname(root);

// ── File resolution: handle @-referenced files before worktree creation ──
let fileResolutionResult: Awaited<ReturnType<typeof resolveFileReferences>> | undefined;
try {
  fileResolutionResult = await resolveFileReferences({
    cwd: input.cwd,
    goal: input.goal,
    executor: input.discoveryExecutor ?? input.plannerExecutor,
    model: input.modelOverrides?.discovery ?? input.modelOverrides?.planner,
    runId: undefined, // run not created yet
  });
} catch (error) {
  if (error instanceof FileResolutionError) {
    throw error;
  }
  // Non-fatal: log and proceed — discovery will catch missing files
}

const isolation = await inspectGitIsolation(input.cwd);
const worktree = loaded.effectiveConfig.git.allowWorktrees
  ? await createGitWorktree({
      cwd: input.cwd,
      branchName: input.branchName ?? `${slugifyGoal(input.goal)}-${Date.now()}`,
      baseBranch: loaded.effectiveConfig.git.baseBranch,
      preferredLocation: loaded.effectiveConfig.git.worktreeDir,
    })
  : {
      mode: "in-place" as const,
      path: input.cwd,
      branch: isolation.branch,
      reason: "Project config disables worktrees",
    };
const executionCwd = worktree.path;

const run = await createFactoryRun({
  runsDir: path.join(projectRoot, ".factory", "runs"),
  initialPhase: "planning",
  effectiveConfig: loaded.effectiveConfig,
  workflowId: loaded.effectiveConfig.resolvedWorkflowId ?? input.workflowId,
});

onWorkspaceReady?.({
  runDir: run.runDir,
  projectRoot,
  createdWorktreePath: worktree.mode === "created" ? worktree.path : undefined,
  baseBranch: loaded.effectiveConfig.git.baseBranch,
});

const phases = ["discovery", "planning", "plan-approval", "implementation", "integration", "verification", "repair", "verified", "review", "approval-ready", "merge", "complete"];
const delayMs = input.delayMs ?? 150;
let builderExecutionPaths: string[] = [];
let integrationPath: string | undefined;
let finalMergePath: string | undefined;
let candidateSha: string | undefined;
let repairExecutionPaths: string[] = [];

await appendFactoryRunEvent(run.eventsPath, {
  timestamp: new Date().toISOString(),
  type: "run.goal_received",
  data: { goal: input.goal },
});

if (fileResolutionResult && fileResolutionResult.status !== "no-references") {
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "file_resolution.completed",
    data: {
      status: fileResolutionResult.status,
      resolutionSource: fileResolutionResult.resolutionSource,
      evidenceCount: fileResolutionResult.evidence.length,
      appliedCount: fileResolutionResult.appliedActions.length,
      blockers: fileResolutionResult.plan?.blockers,
      rationale: fileResolutionResult.rationale,
    },
  });
}

await appendFactoryRunEvent(run.eventsPath, {
  timestamp: new Date().toISOString(),
  type: "run.workspace_selected",
  data: {
    mode: worktree.mode,
    path: worktree.path,
    branch: worktree.branch,
    reason: worktree.reason,
    location: worktree.location,
  },
});

await emitProgress(input, {
  runId: run.runId,
  phase: "planning",
  status: "RUNNING",
  message: `Starting run for: ${input.goal}`,
});

try {
  await hydrateWorkspaceDependencies({
    workspacePath: executionCwd,
    projectRoot,
    config: loaded.effectiveConfig,
    runId: run.runId,
    phase: "workspace",
    onEvent: async (event) => appendFactoryRunEvent(run.eventsPath, {
      timestamp: new Date().toISOString(),
      type: event.type,
      data: event.data,
    }),
    onRemediation: input.requestDependencyRemediation,
    mode: "agent",
  });
} catch (error) {
  const failedState = await updateFactoryRunState({
    statePath: run.statePath,
    patch: { status: "FAILED", phase: "dependency-hydration-failed" },
  });
  const reason = error instanceof DependencyHydrationError
    ? error.message
    : `Dependency hydration failed: ${error instanceof Error ? error.message : String(error)}`;
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "run.failed",
    data: { reason },
  });
  await emitProgress(input, {
    runId: run.runId,
    phase: failedState.phase,
    status: "FAILED",
    message: reason,
  });
  const summaryPath = await writePrototypeSummaryArtifact(run.runDir, {
    runId: run.runId,
    goal: input.goal,
    status: "FAILED",
    phase: failedState.phase,
    approved: false,
    planPath: path.join(run.runDir, "plan.json"),
    taskPaths: [],
    builderExecutionPaths,
    integrationPath,
    repairExecutionPaths,
    verificationPath: path.join(run.runDir, "verification.json"),
    verificationStatus: "incomplete",
  });

  return {
    runId: run.runId,
    runDir: run.runDir,
    executionCwd,
    worktree,
    statePath: run.statePath,
    eventsPath: run.eventsPath,
    phases,
    approved: false,
    planPath: path.join(run.runDir, "plan.json"),
    taskPaths: [],
    builderExecutionPaths,
    integrationPath,
    repairExecutionPaths,
    verificationPath: path.join(run.runDir, "verification.json"),
    summaryPath,
  };
}


  return {
    loaded,
    projectRoot: projectRoot!,
    worktree: worktree as NonNullable<RunFactoryControllerResult["worktree"]>,
    executionCwd,
    run,
    phases,
    delayMs,
    builderExecutionPaths,
    integrationPath,
    finalMergePath,
    candidateSha,
    repairExecutionPaths,
  };
}

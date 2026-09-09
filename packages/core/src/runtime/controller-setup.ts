// Controller run setup — extracted from controller-run.ts.

import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
import { discoverFactoryProject } from "../project/discovery.js";
import { builtInDefaults } from "../config/defaults.js";
import type { RunFactoryControllerInput, RunFactoryControllerResult, FactoryRunProgressEvent } from "./controller.js";
import type { EffectiveFactoryConfig } from "@factory/schemas";

const execFileAsync = promisify(execFile);

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
  let createdWorktreePath: string | undefined;
  let projectRoot: string | undefined;
  let worktree: NonNullable<RunFactoryControllerResult["worktree"]> | undefined;

  try {
    const loaded = await loadEffectiveConfig({
      cwd: input.cwd,
      runOverrides: input.workflowId ? { workflowId: input.workflowId } : undefined,
    });
    const root = path.dirname(loaded.sources.projectConfigPath ?? path.join(input.cwd, ".factory", "config.yaml"));
    projectRoot = path.dirname(root);

    // One absolute run deadline, established when the run starts and shared across
    // every agent turn (discovery, planning, build, repair, review, landing). A new
    // prompt must never reset this budget.
    const runtimeLimits = loaded.effectiveConfig.runtime.limits ?? {};
    loaded.effectiveConfig.runtime.limits = runtimeLimits;
    const runTimeoutMs = runtimeLimits.runTimeoutMs;
    if (runTimeoutMs && runTimeoutMs > 0) {
      runtimeLimits.runDeadlineAt = Date.now() + runTimeoutMs;
    }

    // ── File resolution: handle @-referenced files before worktree creation ──
    let fileResolutionResult: Awaited<ReturnType<typeof resolveFileReferences>> | undefined;
    try {
      fileResolutionResult = await resolveFileReferences({
        cwd: input.cwd,
        goal: input.goal,
        executor: input.discoveryExecutor ?? input.plannerExecutor,
        model: input.modelOverrides?.discovery ?? input.modelOverrides?.planner,
        runId: undefined, // run not created yet
        limits: runtimeLimits,
      });
    } catch (error) {
      if (error instanceof FileResolutionError) {
        throw error;
      }
      // Non-fatal: log and proceed — discovery will catch missing files
    }

    const isolation = await inspectGitIsolation(input.cwd);
    const w = loaded.effectiveConfig.git.allowWorktrees
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
    worktree = w;
    if (w.mode === "created") {
      createdWorktreePath = w.path;
    }
    const executionCwd = w.path;

    const run = await createFactoryRun({
      runsDir: path.join(projectRoot, ".factory", "runs"),
      initialPhase: "planning",
      effectiveConfig: loaded.effectiveConfig,
      workflowId: loaded.effectiveConfig.resolvedWorkflowId ?? input.workflowId,
    });
    runDir = run.runDir;

    onWorkspaceReady?.({
      runDir: run.runDir,
      projectRoot: projectRoot!,
      createdWorktreePath: w.mode === "created" ? w.path : undefined,
      baseBranch: loaded.effectiveConfig.git.baseBranch,
    });

    const phases = ["discovery", "planning", "plan-approval", "implementation", "integration", "verification", "repair", "verified", "review", "landing", "acceptance"];
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
        mode: w.mode,
        path: w.path,
        branch: w.branch,
        reason: w.reason,
        location: w.location,
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
        projectRoot: projectRoot!,
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
  } catch (error) {
    // Early setup failed (config load, worktree creation, or run creation)
    // before the run produced any phase artifacts. Build a FAILED run record
    // so the user gets an inspectable artifact instead of a raw exception.
    return buildSetupFailureResult({
      input,
      error,
      runDir,
      projectRoot,
      createdWorktreePath,
      worktree,
    });
  }
}

async function buildSetupFailureResult(input: {
  input: RunFactoryControllerInput;
  error: unknown;
  runDir?: string;
  projectRoot?: string;
  createdWorktreePath?: string;
  worktree?: NonNullable<RunFactoryControllerResult["worktree"]>;
}): Promise<RunFactoryControllerResult> {
  const { input: runInput, error } = input;
  const reason = error instanceof Error ? error.message : String(error);

  try {
    // Ensure a run record exists: if run creation never happened (config or
    // worktree failure), create a minimal run in the discovered runs dir.
    const project = await discoverFactoryProject(runInput.cwd);
    const runsDir = input.projectRoot
      ? path.join(input.projectRoot, ".factory", "runs")
      : project.paths.runsDir;
    let runDir = input.runDir;
    let statePath: string;
    let eventsPath: string;
    let worktree = input.worktree;

    if (runDir) {
      statePath = path.join(runDir, "state.json");
      eventsPath = path.join(runDir, "events.jsonl");
    } else {
      const minimal = await createFactoryRun({
        runsDir,
        initialPhase: "setup-failed",
        effectiveConfig: minimalEffectiveConfig,
      });
      runDir = minimal.runDir;
      statePath = minimal.statePath;
      eventsPath = minimal.eventsPath;
      worktree = worktree ?? { mode: "in-place", path: runInput.cwd, reason: "Setup failed before workspace selection" };
    }

    // Mark FAILED, record the event, write the summary.
    await updateFactoryRunState({ statePath, patch: { status: "FAILED", phase: "setup-failed" } });
    await appendFactoryRunEvent(eventsPath, {
      timestamp: new Date().toISOString(),
      type: "run.failed",
      data: { reason, phase: "setup-failed" },
    });
    const summaryPath = await writePrototypeSummaryArtifact(runDir, {
      runId: path.basename(runDir),
      goal: runInput.goal,
      status: "FAILED",
      phase: "setup-failed",
      approved: false,
      planPath: path.join(runDir, "plan.json"),
      taskPaths: [],
      builderExecutionPaths: [],
      integrationPath: undefined,
      repairExecutionPaths: [],
      verificationPath: path.join(runDir, "verification.json"),
      verificationStatus: "incomplete",
      recoveryHint: reason,
    });

    // Best-effort cleanup of a worktree that was created before the failure.
    if (input.createdWorktreePath && input.projectRoot) {
      try {
        await execFileAsync("git", ["worktree", "remove", "--force", input.createdWorktreePath], {
          cwd: input.projectRoot,
          windowsHide: true,
        });
      } catch {
        // Best effort; run.cleanup_skipped in the outer finally handles residue.
      }
    }

    return {
      runId: path.basename(runDir),
      runDir,
      executionCwd: runInput.cwd,
      worktree,
      statePath,
      eventsPath,
      phases: [],
      approved: false,
      planPath: path.join(runDir, "plan.json"),
      taskPaths: [],
      builderExecutionPaths: [],
      integrationPath: undefined,
      repairExecutionPaths: [],
      verificationPath: path.join(runDir, "verification.json"),
      summaryPath,
    };
  } catch (artifactError) {
    // Could not even record the failure (disk full, unwritable runs dir).
    // Preserve the ORIGINAL setup error — the artifact failure is secondary.
    throw error;
  }
}

// Minimal effective config for the setup-failure run record. The real project
// config may be unreadable (that is why setup failed); the snapshot only needs
// to satisfy the run-record shape.
const minimalEffectiveConfig: EffectiveFactoryConfig = {
  ...builtInDefaults,
  project: { baseBranch: "main" },
  commands: {},
  git: {
    ...builtInDefaults.git,
    baseBranch: "main",
    allowWorktrees: true,
  },
};

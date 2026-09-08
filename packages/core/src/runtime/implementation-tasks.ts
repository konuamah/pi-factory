// Task orchestration (parallel fan-out) — extracted from implementation-task.ts.

import { runImplementationTask } from "./implementation-task.js";
import { resolveTaskDependencies } from "./final-merge.js";
import { resolveModelForRole } from "../models/index.js";
import { appendFactoryRunEvent } from "../runs/store.js";
import type { PlannerTask, ImplementationContract } from "./planner.js";
import type { BuilderOutcomeKind } from "./builder-outcome.js";
import type { TaskWorkspaceSelection, RunFactoryControllerInput, FactoryRunProgressEvent } from "./controller.js";
import type { AgentExecutor } from "./interfaces.js";
import type { SkillBundleSelection } from "../skills/index.js";
import type { AutonomyLevel } from "../capabilities/index.js";
import type { ModelSelection, EffectiveFactoryConfig, CapabilityPolicy } from "@factory/schemas";
import type { ModelRole } from "@factory/schemas";

export async function runImplementationTasks(input: {
  runId: string;
  runDir: string;
  statePath: string;
  eventsPath: string;
  goal: string;
  executionCwd: string;
  executionBranch?: string;
  worktreeLocation?: string;
  allowTaskWorktrees: boolean;
  tasks: PlannerTask[];
  maxParallelAgents: number;
  projectRoot: string;
  dependencyTasks?: PlannerTask[];
  planIntent?: ImplementationContract;
  roleExecutors: Partial<Record<ModelRole, AgentExecutor>>;
  roleModels: Partial<Record<ModelRole, { provider?: string; model: string }>>;
  roleSkills: Partial<Record<ModelRole, SkillBundleSelection>>;
  autonomy?: AutonomyLevel;
  projectCapabilityPolicy?: CapabilityPolicy;
  workflowCapabilityPolicy?: CapabilityPolicy;
  runTaskType?: string;
  runModelOverrides?: Partial<Record<ModelRole, ModelSelection>>;
  runDecisions?: Array<{ requestId: string; question: string; optionId: string; feedback?: string }>;
  config: EffectiveFactoryConfig;
  requestDependencyRemediation?: RunFactoryControllerInput["requestDependencyRemediation"];
  onProgress: (event: FactoryRunProgressEvent) => Promise<void>;
  delayMs: number;
  builderExecutionPaths: string[];
}): Promise<
  | { ok: true; taskWorkspaces: TaskWorkspaceSelection[] }
  | {
      ok: false;
      failedTask: PlannerTask;
      failedPhase: string;
      failureKind: BuilderOutcomeKind;
      failureReason: string;
      taskWorkspaces: TaskWorkspaceSelection[];
    }
> {
  if (input.tasks.length === 0) {
    return { ok: true, taskWorkspaces: [] };
  }

  const taskById = new Map(input.tasks.map((task) => [task.id, task]));
  const dependencyMap = resolveTaskDependencies(input.tasks);
  const completed = new Set<string>(
    input.tasks.filter((task) => task.status === "done").map((task) => task.id),
  );
  const pending = new Set<string>(
    input.tasks.filter((task) => task.status !== "done").map((task) => task.id),
  );
  const parallelism = Math.max(1, input.maxParallelAgents || 1);
  const taskWorkspaces: TaskWorkspaceSelection[] = [];

  while (pending.size > 0) {
    const runnable = Array.from(pending)
      .map((taskId) => taskById.get(taskId))
      .filter((task): task is PlannerTask => Boolean(task))
      .filter((task) => dependencyMap.get(task.id)?.every((dependencyId) => completed.has(dependencyId)) ?? true);

    if (runnable.length === 0) {
      const blockedTasks = Array.from(pending)
        .map((taskId) => taskById.get(taskId))
        .filter((task): task is PlannerTask => Boolean(task));
      const blockedTask = blockedTasks[0] ?? input.tasks[0]!;
      await appendFactoryRunEvent(input.eventsPath, {
        timestamp: new Date().toISOString(),
        type: "implementation.blocked",
        data: {
          blockedTaskIds: blockedTasks.map((task) => task.id),
          completedTaskIds: Array.from(completed),
        },
      });
      return {
        ok: false,
        failedTask: blockedTask,
        failedPhase: "implementation-blocked",
        failureKind: "contract-blocked",
        failureReason: "Implementation tasks could not be scheduled because dependencies were not satisfiable.",
        taskWorkspaces,
      };
    }

    const batch = runnable.slice(0, parallelism);
    await appendFactoryRunEvent(input.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "implementation.batch_started",
      data: {
        taskIds: batch.map((task) => task.id),
        parallelism,
      },
    });

    const results = await Promise.all(
      batch.map((task) =>
        runImplementationTask({
          runId: input.runId,
          runDir: input.runDir,
          eventsPath: input.eventsPath,
          goal: input.goal,
          executionCwd: input.executionCwd,
          executionBranch: input.executionBranch,
          worktreeLocation: input.worktreeLocation,
          allowTaskWorktrees: input.allowTaskWorktrees,
          task,
          projectRoot: input.projectRoot,
          dependencyTasks: input.dependencyTasks,
          planIntent: input.planIntent,
          roleExecutors: input.roleExecutors,
          roleModels: input.roleModels,
          roleSkills: input.roleSkills,
          autonomy: input.autonomy,
          projectCapabilityPolicy: input.projectCapabilityPolicy,
          workflowCapabilityPolicy: input.workflowCapabilityPolicy,
          runTaskType: input.runTaskType,
          runModelOverrides: input.runModelOverrides,
          runDecisions: input.runDecisions,
          config: input.config,
          onProgress: input.onProgress,
          delayMs: input.delayMs,
          builderExecutionPaths: input.builderExecutionPaths,
          requestDependencyRemediation: input.requestDependencyRemediation,
        }),
      ),
    );

    for (const result of results) {
      pending.delete(result.task.id);
      taskWorkspaces.push(result.workspace);
      if (result.ok) {
        completed.add(result.task.id);
        continue;
      }
      return {
        ok: false,
        failedTask: result.task,
        failedPhase: result.failureKind === "contract-noop" || result.failureKind === "contract-blocked"
          ? "implementation-blocked"
          : "implementation-failed",
        failureKind: result.failureKind ?? "executor-failed",
        failureReason: result.failureReason ?? "Implementation task failed.",
        taskWorkspaces,
      };
    }
  }

  return { ok: true, taskWorkspaces };
}


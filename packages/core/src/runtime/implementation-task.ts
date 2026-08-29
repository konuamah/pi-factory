// Single task execution — extracted from implementation.ts.

import path from "node:path";
import { writePrototypeBuilderExecutionArtifact } from "./artifacts.js";
import { updatePrototypeTaskArtifact } from "./tasks.js";
import { resolveTaskWorkspace, commitWorkspaceChanges, readChangedFiles, type WorkspaceCommitResult } from "./git-ops.js";
import { resolveNodeRole, attachDiscoveryFileHintsToBuildTasks } from "./controller.js";
import { resolveNodeSkillBundle } from "./skills.js";
import { compileAgentContext } from "../context/compiler.js";
import { buildCompiledPrompt, buildNoChangeRetryPrompt, renderSkillBundleForPrompt } from "./prompts.js";
import { appendModelLedgerEntry } from "../runs/model-ledger.js";
import { appendFactoryRunEvent } from "../runs/store.js";
import { hydrateWorkspaceDependencies, DependencyHydrationError } from "./dependencies.js";
import { roleTools, isExecutableWorkflowNode, uniqueStrings } from "./task-utils.js";
import { resolveEffectiveCapabilities, defaultCapabilitiesForRole, capabilitiesToToolNames } from "../capabilities/index.js";
import { resolveModelForRole } from "../models/index.js";
import { resolveDependencyTaskIds, resolveTaskDependencies } from "./final-merge.js";
import { wait } from "./phase-plumbing.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PlannerTask, ImplementationContract } from "./planner.js";
import type { TaskWorkspaceSelection, RunFactoryControllerInput, FactoryRunProgressEvent } from "./controller.js";
import type { AgentExecutor, AgentExecutionResult } from "./interfaces.js";
import type { SkillBundleSelection } from "../skills/index.js";
import type { ModelSelection, EffectiveFactoryConfig, CapabilityPolicy } from "@factory/schemas";
import type { AutonomyLevel } from "../capabilities/index.js";
import type { ModelRole } from "@factory/schemas";

const execFileAsync = promisify(execFile);

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
  | { ok: false; failedTask: PlannerTask; failedPhase: string; taskWorkspaces: TaskWorkspaceSelection[] }
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
      return { ok: false, failedTask: blockedTask, failedPhase: "implementation-blocked", taskWorkspaces };
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
      return { ok: false, failedTask: result.task, failedPhase: "implementation-failed", taskWorkspaces };
    }
  }

  return { ok: true, taskWorkspaces };
}

export async function runImplementationTask(input: {
  runId: string;
  runDir: string;
  eventsPath: string;
  goal: string;
  executionCwd: string;
  executionBranch?: string;
  worktreeLocation?: string;
  allowTaskWorktrees: boolean;
  task: PlannerTask;
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
  | { ok: true; task: PlannerTask; workspace: TaskWorkspaceSelection }
  | { ok: false; task: PlannerTask; workspace: TaskWorkspaceSelection }
> {
  const workspace = await resolveTaskWorkspace({
    cwd: input.executionCwd,
    taskId: input.task.id,
    executionBranch: input.executionBranch,
    worktreeLocation: input.worktreeLocation,
    allowTaskWorktrees: input.allowTaskWorktrees,
  });

  await updatePrototypeTaskArtifact({
    runDir: input.runDir,
    taskId: input.task.id,
    patch: {
      status: "running",
      workspacePath: workspace.path,
      workspaceMode: workspace.mode,
      workspaceBranch: workspace.branch,
    },
  });
  await appendFactoryRunEvent(input.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "task.started",
    data: {
      taskId: input.task.id,
      stage: input.task.stage,
      title: input.task.title,
      workspacePath: workspace.path,
      workspaceMode: workspace.mode,
      workspaceBranch: workspace.branch,
    },
  });
  await input.onProgress({
    runId: input.runId,
    phase: "implementation",
    status: "RUNNING",
    message: `Running task ${input.task.id}: ${input.task.title}`,
  });

  try {
    await hydrateWorkspaceDependencies({
      workspacePath: workspace.path,
      projectRoot: input.projectRoot,
      config: input.config,
      runId: input.runId,
      phase: "implementation",
      taskId: input.task.id,
      onEvent: async (event) => appendFactoryRunEvent(input.eventsPath, {
        timestamp: new Date().toISOString(),
        type: event.type,
        data: event.data,
      }),
      onRemediation: input.requestDependencyRemediation,
      mode: "agent",
    });
  } catch (error) {
    const reason = error instanceof DependencyHydrationError
      ? error.message
      : `Dependency hydration failed: ${error instanceof Error ? error.message : String(error)}`;
    await updatePrototypeTaskArtifact({
      runDir: input.runDir,
      taskId: input.task.id,
      patch: { status: "failed" },
    });
    await appendFactoryRunEvent(input.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "task.failed",
      data: {
        taskId: input.task.id,
        stage: input.task.stage,
        title: input.task.title,
        reason,
        workspacePath: workspace.path,
        workspaceBranch: workspace.branch,
      },
    });
    return { ok: false, task: input.task, workspace };
  }

  if (input.task.type === "command" && input.task.commands?.length) {
    for (const command of input.task.commands) {
      await appendFactoryRunEvent(input.eventsPath, {
        timestamp: new Date().toISOString(),
        type: "task.command_started",
        data: {
          taskId: input.task.id,
          command,
          workspacePath: workspace.path,
        },
      });
      try {
        const { stdout, stderr } = await execFileAsync(command, { cwd: workspace.path, shell: true, windowsHide: true });
        await appendFactoryRunEvent(input.eventsPath, {
          timestamp: new Date().toISOString(),
          type: "task.command_completed",
          data: {
            taskId: input.task.id,
            command,
            status: "passed",
            stdout,
            stderr,
          },
        });
      } catch (error) {
        const execError = error as Error & { code?: number; stdout?: string; stderr?: string };
        await appendFactoryRunEvent(input.eventsPath, {
          timestamp: new Date().toISOString(),
          type: "task.command_failed",
          data: {
            taskId: input.task.id,
            command,
            status: "failed",
            exitCode: execError.code,
            stdout: execError.stdout,
            stderr: execError.stderr,
          },
        });
        await updatePrototypeTaskArtifact({
          runDir: input.runDir,
          taskId: input.task.id,
          patch: { status: "failed" },
        });
        await appendFactoryRunEvent(input.eventsPath, {
          timestamp: new Date().toISOString(),
          type: "task.failed",
          data: {
            taskId: input.task.id,
            stage: input.task.stage,
            title: input.task.title,
            command,
            workspacePath: workspace.path,
            workspaceBranch: workspace.branch,
          },
        });
        return { ok: false, task: input.task, workspace };
      }
    }
  } else {
    const nodeRole = resolveNodeRole(input.task);
    const executor = input.roleExecutors[nodeRole];
    if (executor) {
      const nodeSkills = resolveNodeSkillBundle(input.roleSkills[nodeRole], input.task.skills);
      if (!nodeSkills.ok) {
        await appendFactoryRunEvent(input.eventsPath, {
          timestamp: new Date().toISOString(),
          type: "task.skill_policy_failed",
          data: {
            taskId: input.task.id,
            stage: input.task.stage,
            missingRequiredSkills: nodeSkills.missingRequired,
          },
        });
        await updatePrototypeTaskArtifact({
          runDir: input.runDir,
          taskId: input.task.id,
          patch: { status: "failed" },
        });
        await appendFactoryRunEvent(input.eventsPath, {
          timestamp: new Date().toISOString(),
          type: "task.failed",
          data: {
            taskId: input.task.id,
            stage: input.task.stage,
            title: input.task.title,
            reason: `Missing required workflow skill(s): ${nodeSkills.missingRequired.join(", ")}`,
            workspacePath: workspace.path,
            workspaceBranch: workspace.branch,
          },
        });
        return { ok: false, task: input.task, workspace };
      }
      const capabilities = resolveEffectiveCapabilities({
        requested: input.task.requiredCapabilities?.length ? input.task.requiredCapabilities : defaultCapabilitiesForRole(nodeRole),
        autonomy: (input.autonomy ?? "medium") as AutonomyLevel,
        projectPolicy: input.projectCapabilityPolicy,
        workflowPolicy: input.workflowCapabilityPolicy,
        nodePolicy: input.task.capabilityPolicy,
      });
      const compiled = await compileAgentContext({
        cwd: input.projectRoot,
        role: nodeRole,
        goal: input.goal,
        task: input.task,
        dependencyTasks: input.dependencyTasks?.filter((dep) => resolveDependencyTaskIds(input.task, input.dependencyTasks ?? []).includes(dep.id)),
        skills: nodeSkills.selected,
        fileHints: input.task.context?.fileHints,
        planIntent: input.planIntent,
        maxChars: 6000,
        grantedCapabilities: capabilities.granted,
        deniedCapabilities: capabilities.denied,
        runDecisions: input.runDecisions,
        useConstitution: input.config.constitution.enabled,
      });
      await appendFactoryRunEvent(input.eventsPath, {
        timestamp: new Date().toISOString(),
        type: "task.context_compiled",
        data: {
          taskId: input.task.id,
          role: nodeRole,
          files: compiled.files.map((file) => file.path),
          dependencies: compiled.dependencies.map((dep) => dep.taskId),
          skills: compiled.skills.map((skill) => skill.id),
          explicitSkills: input.task.skills,
          capabilities: capabilities.granted,
          deniedCapabilities: capabilities.denied,
          tokenEstimate: compiled.tokenEstimate,
        },
      });
      const nodeTaskType = input.task.taskType ?? input.runTaskType ?? "general";
      const nodeModel = resolveModelForRole({
        role: nodeRole,
        taskType: nodeTaskType,
        config: input.config,
        nodeModel: input.task.model,
        runModelOverride: input.runModelOverrides?.[nodeRole],
      });
      await appendModelLedgerEntry(input.runDir, {
        operationId: `${input.runId}-${nodeRole}-${input.task.id}`,
        taskId: input.task.id,
        nodeId: input.task.id,
        role: nodeRole,
        taskType: nodeTaskType,
        taskTypeSource: input.task.taskType ? "node-override" : "run",
        requestedModel: nodeModel.model.model,
        resolvedModel: nodeModel.model.model,
        provider: nodeModel.model.provider,
        modelSource: nodeModel.source,
      });
      const executeBuilder = async (attempt: "initial" | "no-change-retry", previousResult?: AgentExecutionResult): Promise<{
        result: AgentExecutionResult;
        executionPath: string;
        committedChange: WorkspaceCommitResult;
      }> => {
        const executionId = attempt === "initial"
          ? `${input.runId}-${nodeRole}-${input.task.id}`
          : `${input.runId}-${nodeRole}-${input.task.id}-no-change-retry`;
        const prompt = attempt === "initial"
          ? buildCompiledPrompt(input.goal, compiled, workspace.path)
          : buildNoChangeRetryPrompt(input.goal, compiled, previousResult, workspace.path);
        const result = await executor.execute({
          executionId,
          cwd: workspace.path,
          prompt,
          model: nodeModel.model,
          tools: [...roleTools(nodeRole), ...capabilitiesToToolNames(capabilities.granted)].filter((tool, index, arr) => arr.indexOf(tool) === index),
          limits: input.config.runtime.limits,
          metadata: {
            role: nodeRole,
            runId: input.runId,
            taskId: input.task.id,
            taskStage: input.task.stage,
            workspacePath: workspace.path,
            workspaceBranch: workspace.branch,
            grantedCapabilities: capabilities.granted,
            deniedCapabilities: capabilities.denied,
            needsApprovalCapabilities: capabilities.needsApproval,
            attempt,
          },
        });

        const executionPath = await writePrototypeBuilderExecutionArtifact(input.runDir, {
          taskId: attempt === "initial" ? input.task.id : `${input.task.id}-no-change-retry`,
          workspacePath: workspace.path,
          workspaceBranch: workspace.branch,
          ...result,
        });
        input.builderExecutionPaths.push(executionPath);

        let committedChange: WorkspaceCommitResult = { committed: false, changedFiles: [] };
        if (result.status === "completed") {
          committedChange = await commitWorkspaceChanges(workspace.path, input.task);
        }

        await appendFactoryRunEvent(input.eventsPath, {
          timestamp: new Date().toISOString(),
          type: "task.executor_completed",
          data: {
            taskId: input.task.id,
            taskStage: input.task.stage,
            attempt,
            builderExecutionPath: executionPath,
            builderStatus: result.status,
            errorMessage: result.errorMessage,
            workspacePath: workspace.path,
            workspaceBranch: workspace.branch,
            committed: committedChange.committed,
            changedFiles: committedChange.changedFiles,
          },
        });

        return { result, executionPath, committedChange };
      };

      let builderAttempt = await executeBuilder("initial");

      if (builderAttempt.result.status === "completed" && !builderAttempt.committedChange.committed) {
        await appendFactoryRunEvent(input.eventsPath, {
          timestamp: new Date().toISOString(),
          type: "task.no_changes_retrying",
          data: {
            taskId: input.task.id,
            stage: input.task.stage,
            title: input.task.title,
            builderExecutionPath: builderAttempt.executionPath,
            workspacePath: workspace.path,
            workspaceBranch: workspace.branch,
            reason: "builder completed without producing file changes; retrying once with explicit implementation instructions",
          },
        });
        builderAttempt = await executeBuilder("no-change-retry", builderAttempt.result);
      }

      const builderResult = builderAttempt.result;
      const builderExecutionPath = builderAttempt.executionPath;
      const committedChange = builderAttempt.committedChange;
      workspace.changedFiles = committedChange.changedFiles;

      if (builderResult.status !== "completed") {
        await updatePrototypeTaskArtifact({
          runDir: input.runDir,
          taskId: input.task.id,
          patch: { status: "failed" },
        });
        await appendFactoryRunEvent(input.eventsPath, {
          timestamp: new Date().toISOString(),
          type: "task.failed",
          data: {
            taskId: input.task.id,
            stage: input.task.stage,
            title: input.task.title,
            builderExecutionPath,
            builderStatus: builderResult.status,
            reason: builderResult.errorMessage ?? `builder executor returned ${builderResult.status}`,
            workspacePath: workspace.path,
            workspaceBranch: workspace.branch,
          },
        });
        return { ok: false, task: input.task, workspace };
      }
      if (!committedChange.committed) {
        await updatePrototypeTaskArtifact({
          runDir: input.runDir,
          taskId: input.task.id,
          patch: { status: "failed" },
        });
        await appendFactoryRunEvent(input.eventsPath, {
          timestamp: new Date().toISOString(),
          type: "task.no_changes",
          data: {
            taskId: input.task.id,
            stage: input.task.stage,
            title: input.task.title,
            builderExecutionPath,
            workspacePath: workspace.path,
            workspaceBranch: workspace.branch,
          },
        });
        await appendFactoryRunEvent(input.eventsPath, {
          timestamp: new Date().toISOString(),
          type: "task.failed",
          data: {
            taskId: input.task.id,
            stage: input.task.stage,
            title: input.task.title,
            reason: "implementation produced no file changes",
            builderExecutionPath,
            workspacePath: workspace.path,
            workspaceBranch: workspace.branch,
          },
        });
        return { ok: false, task: input.task, workspace };
      }
    } else {
      await wait(input.delayMs);
    }
  }

  await updatePrototypeTaskArtifact({
    runDir: input.runDir,
    taskId: input.task.id,
    patch: { status: "done" },
  });
  await appendFactoryRunEvent(input.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "task.completed",
    data: {
      taskId: input.task.id,
      stage: input.task.stage,
      title: input.task.title,
      workspacePath: workspace.path,
      workspaceBranch: workspace.branch,
    },
  });
  return { ok: true, task: input.task, workspace };
}


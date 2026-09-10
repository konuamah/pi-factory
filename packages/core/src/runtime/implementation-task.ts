// Single task execution — extracted from implementation.ts.

import path from "node:path";
import { writePrototypeBuilderExecutionArtifact } from "./artifacts.js";
import { updatePrototypeTaskArtifact } from "./tasks.js";
import { resolveTaskWorkspace, commitWorkspaceChanges, type WorkspaceCommitResult } from "./git-ops.js";
import { resolveNodeRole } from "./controller.js";
import { resolveNodeSkillBundle } from "./skills.js";
import { compileAgentContext } from "../context/compiler.js";
import { buildCompiledPrompt, buildNoChangeRetryPrompt } from "./prompts.js";
import { classifyBuilderOutcome, type BuilderOutcome, type BuilderOutcomeKind } from "./builder-outcome.js";
import { appendModelLedgerEntry } from "../runs/model-ledger.js";
import { appendFactoryRunEvent } from "../runs/store.js";
import { hydrateWorkspaceDependencies, DependencyHydrationError } from "./dependencies.js";
import { roleTools } from "./task-utils.js";
import { resolveEffectiveCapabilities, defaultCapabilitiesForRole, negotiateStageCapabilities } from "../capabilities/index.js";
import { resolveModelForRole } from "../models/index.js";
import { resolveDependencyTaskIds } from "./final-merge.js";
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
import { runCommandTasks } from "./run-command-task.js";

const execFileAsync = promisify(execFile);

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
  | {
      ok: false;
      task: PlannerTask;
      workspace: TaskWorkspaceSelection;
      failureKind: BuilderOutcomeKind;
      failureReason: string;
    }
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
    return {
      ok: false,
      task: input.task,
      workspace,
      failureKind: "executor-failed",
      failureReason: reason,
    };
  }

  if (input.task.type === "command" && input.task.commands?.length) {
    const commandResult = await runCommandTasks({ task: input.task, eventsPath: input.eventsPath, runDir: input.runDir }, workspace);
    if (!commandResult.ok) return commandResult;
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
        return {
          ok: false,
          task: input.task,
          workspace,
          failureKind: "executor-failed",
          failureReason: `Missing required workflow skill(s): ${nodeSkills.missingRequired.join(", ")}`,
        };
      }
      const capabilities = resolveEffectiveCapabilities({
        requested: input.task.requiredCapabilities?.length ? input.task.requiredCapabilities : defaultCapabilitiesForRole(nodeRole),
        autonomy: (input.autonomy ?? "medium") as AutonomyLevel,
        projectPolicy: input.projectCapabilityPolicy,
        workflowPolicy: input.workflowCapabilityPolicy,
        nodePolicy: input.task.capabilityPolicy,
      });
      const negotiated = negotiateStageCapabilities({
        stage: input.task,
        skills: nodeSkills.selected.map((item) => item.skill),
        safety: capabilities,
        provider: {
          available: roleTools(nodeRole),
          unavailable: [],
          unknown: [...(input.task.allowedTools ?? []), ...nodeSkills.selected.flatMap((item) => item.skill.permissions?.allowedTools ?? [])]
            .filter((tool) => !roleTools(nodeRole).includes(tool)),
        },
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
        negotiated,
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
      const executeBuilder = async (attempt: "initial" | "no-change-retry" | "transient-error-retry", previousResult?: AgentExecutionResult): Promise<{
        result: AgentExecutionResult;
        executionPath: string;
        committedChange: WorkspaceCommitResult;
        outcome: BuilderOutcome;
      }> => {
        const executionId = attempt === "initial"
          ? `${input.runId}-${nodeRole}-${input.task.id}`
          : `${input.runId}-${nodeRole}-${input.task.id}-${attempt}`;
        const prompt = attempt === "initial" || attempt === "transient-error-retry"
          ? buildCompiledPrompt(input.goal, compiled, workspace.path)
          : buildNoChangeRetryPrompt(input.goal, compiled, previousResult, workspace.path);
        const result = await executor.execute({
          executionId,
          cwd: workspace.path,
          prompt,
          model: nodeModel.model,
          tools: negotiated.granted,
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
            negotiated,
            attempt,
          },
        });

        const executionPath = await writePrototypeBuilderExecutionArtifact(input.runDir, {
          taskId: attempt === "initial" ? input.task.id : `${input.task.id}-${attempt}`,
          workspacePath: workspace.path,
          workspaceBranch: workspace.branch,
          ...result,
        });
        input.builderExecutionPaths.push(executionPath);

        let committedChange: WorkspaceCommitResult = { committed: false, changedFiles: [], allChangedFiles: [] };
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

        return { result, executionPath, committedChange, outcome: classifyBuilderOutcome(result, committedChange) };
      };

      let builderAttempt = await executeBuilder("initial");

      // Transient provider/SDK failures (server_error, missing tool results,
      // dropped stream) are not builder mistakes: retry once with the same
      // prompt so one flaky provider response does not fail the whole run.
      const TRANSIENT_ERROR_PATTERN = /server_error|server error|tool results are missing|temporarily unavailable|rate.?limit|overloaded|ECONNRESET|ECONNREFUSED|socket hang up|ETIMEDOUT/i;
      if (builderAttempt.result.status === "failed" && TRANSIENT_ERROR_PATTERN.test(builderAttempt.result.errorMessage ?? "")) {
        await appendFactoryRunEvent(input.eventsPath, {
          timestamp: new Date().toISOString(),
          type: "task.transient_error_retrying",
          data: {
            taskId: input.task.id,
            stage: input.task.stage,
            title: input.task.title,
            builderExecutionPath: builderAttempt.executionPath,
            workspacePath: workspace.path,
            workspaceBranch: workspace.branch,
            reason: `builder executor hit a transient provider error; retrying once: ${builderAttempt.result.errorMessage}`,
          },
        });
        builderAttempt = await executeBuilder("transient-error-retry");
      }

      if (builderAttempt.outcome.kind === "no-change-unclear") {
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
            reason: "builder completed without changes or a structured contract outcome; retrying once",
          },
        });
        builderAttempt = await executeBuilder("no-change-retry", builderAttempt.result);
      }

      const builderResult = builderAttempt.result;
      const builderExecutionPath = builderAttempt.executionPath;
      const committedChange = builderAttempt.committedChange;
      workspace.changedFiles = committedChange.changedFiles;
      workspace.commitSha = committedChange.commitSha;

      if (builderAttempt.outcome.kind === "contract-noop" || builderAttempt.outcome.kind === "contract-blocked") {
        const terminalEvent = builderAttempt.outcome.kind === "contract-noop"
          ? "task.contract_noop"
          : "task.contract_blocked";
        await updatePrototypeTaskArtifact({
          runDir: input.runDir,
          taskId: input.task.id,
          patch: { status: "failed" },
        });
        await appendFactoryRunEvent(input.eventsPath, {
          timestamp: new Date().toISOString(),
          type: terminalEvent,
          data: {
            taskId: input.task.id,
            stage: input.task.stage,
            title: input.task.title,
            reason: builderAttempt.outcome.reason,
            builderExecutionPath,
            workspacePath: workspace.path,
            workspaceBranch: workspace.branch,
          },
        });
        return {
          ok: false,
          task: input.task,
          workspace,
          failureKind: builderAttempt.outcome.kind,
          failureReason: builderAttempt.outcome.reason ?? "Builder reported a terminal contract outcome.",
        };
      }

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
        return {
          ok: false,
          task: input.task,
          workspace,
          failureKind: "executor-failed",
          failureReason: builderResult.errorMessage ?? `builder executor returned ${builderResult.status}`,
        };
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
            reason: "Builder completed twice without producing file changes or a structured contract outcome.",
            builderExecutionPath,
            workspacePath: workspace.path,
            workspaceBranch: workspace.branch,
          },
        });
        return {
          ok: false,
          task: input.task,
          workspace,
          failureKind: "no-change-unclear",
          failureReason: "Builder completed twice without producing file changes or a structured contract outcome.",
        };
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

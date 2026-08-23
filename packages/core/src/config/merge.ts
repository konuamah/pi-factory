import type {
  EffectiveFactoryConfig,
  FactoryBuiltInDefaults,
  GlobalFactoryConfig,
  ProjectFactoryConfig,
  RunOverrides,
  WorkflowConfig,
  WorkflowDefinition,
} from "@factory/schemas";
import { resolveWorkflowDefinition, normalizeWorkflowConfig } from "../workflows/registry.js";

export function mergeConfigLayers(input: {
  builtIns: FactoryBuiltInDefaults;
  global?: GlobalFactoryConfig;
  project?: ProjectFactoryConfig;
  workflow?: WorkflowConfig;
  runOverrides?: RunOverrides;
}): EffectiveFactoryConfig {
  const { builtIns, global, project, workflow, runOverrides } = input;

  const mergedWorkflow = workflow ?? normalizeWorkflowConfig(undefined);
  const resolvedWorkflow: WorkflowDefinition | undefined = resolveWorkflowDefinition(
    { workflow: mergedWorkflow } as EffectiveFactoryConfig,
    runOverrides?.workflowId,
  );

  return {
    models: {
      ...builtIns.models,
      ...global?.models,
      ...project?.models,
      ...runOverrides?.models,
    },
    runtime: {
      maxParallelAgents:
        runOverrides?.runtime?.maxParallelAgents ??
        project?.runtime?.maxParallelAgents ??
        global?.runtime?.maxParallelAgents ??
        builtIns.runtime.maxParallelAgents,
    },
    ui: {
      showWorkerDetails:
        global?.ui?.showWorkerDetails ?? builtIns.ui.showWorkerDetails,
    },
    defaults: {
      autonomy: global?.defaults?.autonomy ?? builtIns.defaults.autonomy,
      workflow: global?.defaults?.workflow ?? builtIns.defaults.workflow,
    },
    project: {
      baseBranch:
        project?.project?.baseBranch ??
        project?.git?.baseBranch ??
        "main",
    },
    commands: {
      ...project?.commands,
    },
    capabilities: project?.capabilities,
    git: {
      baseBranch:
        project?.git?.baseBranch ?? project?.project?.baseBranch ?? "main",
      allowWorktrees: project?.git?.allowWorktrees ?? true,
      worktreeDir: project?.git?.worktreeDir,
      cleanup: {
        retainRuns: project?.git?.cleanup?.retainRuns ?? builtIns.git.cleanup.retainRuns,
        pruneWorktrees: project?.git?.cleanup?.pruneWorktrees ?? builtIns.git.cleanup.pruneWorktrees,
        pruneBranches: project?.git?.cleanup?.pruneBranches ?? builtIns.git.cleanup.pruneBranches,
      },
    },
    repair: {
      enabled: project?.repair?.enabled ?? builtIns.repair.enabled,
      maxAttempts: project?.repair?.maxAttempts ?? builtIns.repair.maxAttempts,
    },
    approval: {
      finalMerge:
        runOverrides?.approval?.finalMerge ??
        project?.approval?.finalMerge ??
        builtIns.approval.finalMerge,
    },
    workflow: mergedWorkflow,
    resolvedWorkflow,
    resolvedWorkflowId: resolvedWorkflow?.id,
  };
}

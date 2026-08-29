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

  const normalizeModels = (
    models?: GlobalFactoryConfig["models"] | ProjectFactoryConfig["models"],
  ): Partial<FactoryBuiltInDefaults["models"]> => {
    if (!models) return {};
    const { provider, roles, ...direct } = models;
    const nested = roles ?? {};
    const withProvider = (selection?: { model?: string; provider?: string }) => selection?.model
      ? { ...selection, ...(!selection.provider && provider ? { provider } : {}) }
      : selection;
    const normalized = Object.fromEntries(
      Object.entries({ ...direct, ...nested }).map(([role, selection]) => [role, withProvider(selection as { model?: string; provider?: string })]),
    ) as Partial<FactoryBuiltInDefaults["models"]>;
    // A roles map is a complete project model policy. Reuse its first valid
    // model for omitted roles instead of leaking provider-less built-in aliases.
    const fallback = Object.values(normalized).find((selection) => selection?.model);
    if (roles && fallback) {
      for (const role of ["discovery", "planner", "builder", "reviewer", "repair"] as const) {
        if (!normalized[role]) normalized[role] = fallback;
      }
    }
    return normalized;
  };

  return {
    models: {
      ...builtIns.models,
      ...normalizeModels(global?.models),
      ...normalizeModels(project?.models),
      ...runOverrides?.models,
    },
    runtime: {
      maxParallelAgents:
        runOverrides?.runtime?.maxParallelAgents ??
        project?.runtime?.maxParallelAgents ??
        global?.runtime?.maxParallelAgents ??
        builtIns.runtime.maxParallelAgents,
      limits: {
        ...builtIns.runtime.limits,
        ...global?.runtime?.limits,
        ...project?.runtime?.limits,
        ...runOverrides?.runtime?.limits,
      },
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
    taskTypes: project?.taskTypes,
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
      maxTotalAttempts: project?.repair?.maxTotalAttempts ?? builtIns.repair.maxTotalAttempts,
    },
    constitution: {
      enabled: project?.constitution?.enabled ?? global?.constitution?.enabled ?? builtIns.constitution.enabled,
    },
    approval: {
      finalMerge:
        runOverrides?.approval?.finalMerge ??
        project?.approval?.finalMerge ??
        builtIns.approval.finalMerge,
    },
    dashboard: {
      enabled: project?.dashboard?.enabled ?? global?.dashboard?.enabled ?? builtIns.dashboard.enabled,
      port: project?.dashboard?.port ?? global?.dashboard?.port ?? builtIns.dashboard.port,
      host: project?.dashboard?.host ?? global?.dashboard?.host ?? builtIns.dashboard.host,
      autoOpen: project?.dashboard?.autoOpen ?? global?.dashboard?.autoOpen ?? builtIns.dashboard.autoOpen,
    },
    dependencies: {
      enabled: project?.dependencies?.enabled ?? global?.dependencies?.enabled ?? builtIns.dependencies.enabled,
      hydrate: project?.dependencies?.hydrate ?? global?.dependencies?.hydrate ?? builtIns.dependencies.hydrate,
      cacheRoot: project?.dependencies?.cacheRoot ?? global?.dependencies?.cacheRoot ?? builtIns.dependencies.cacheRoot,
    },
    workflow: mergedWorkflow,
    resolvedWorkflow,
    resolvedWorkflowId: resolvedWorkflow?.id,
  };
}

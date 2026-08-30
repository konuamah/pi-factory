export type ModelRole = "discovery" | "planner" | "builder" | "reviewer" | "repair" | "landing";

export interface ExecutionLimits {
  totalRunTimeoutMs?: number;
  modelTimeoutMs?: number;
  toolTimeoutMs?: number;
  maxTurns?: number;
}

export interface ModelSelection {
  provider?: string;
  model: string;
}

export interface SetupCommandStep {
  name?: string;
  description?: string;
  command: string;
}

export type SetupCommandConfig = string | SetupCommandStep[];

export type WorkflowNodeType = "agent" | "command" | "approval" | "task-graph" | "interview";

export type Capability =
  | "repo.read"
  | "repo.write"
  | "shell.execute"
  | "git.commit"
  | "git.push"
  | "ci.read"
  | "ci.trigger"
  | "pr.comment"
  | "deploy.staging"
  | "deploy.production";

export interface CapabilityPolicy {
  allow?: Capability[];
  deny?: Capability[];
}

export interface WorkflowStageSkillPolicy {
  require?: string[];
  prefer?: string[];
  exclude?: string[];
}

export interface WorkflowStage {
  name: string;
  description?: string;
  dependsOn?: string[];
  type?: WorkflowNodeType;
  role?: ModelRole;
  commands?: string[];
  requiresApproval?: boolean;
  requiredCapabilities?: Capability[];
  taskType?: string;
  model?: ModelSelection;
  skills?: WorkflowStageSkillPolicy;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description?: string;
  stages: WorkflowStage[];
  capabilityPolicy?: CapabilityPolicy;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description?: string;
  stages: WorkflowStage[];
}

export interface WorkflowRegistry {
  defaultWorkflowId?: string;
  workflows: WorkflowDefinition[];
}

export interface WorkflowConfig {
  defaultWorkflowId?: string;
  workflows?: WorkflowDefinition[];
}

export interface FactoryBuiltInDefaults {
  models: Partial<Record<ModelRole, ModelSelection>>;
  runtime: {
    maxParallelAgents: number;
    limits?: ExecutionLimits;
  };
  ui: {
    showWorkerDetails: boolean;
  };
  defaults: {
    autonomy: string;
    workflow: string;
  };
  repair: {
    enabled: boolean;
    maxAttempts: number;
    maxTotalAttempts: number;
  };
  constitution: {
    enabled: boolean;
  };
  approval: {
    finalMerge: "required" | "not-required";
  };
  git: {
    cleanup: {
      retainRuns: number;
      pruneWorktrees: boolean;
      pruneBranches: boolean;
    };
  };
  dashboard: {
    enabled: boolean;
    port: number;
    host: string;
    autoOpen: boolean;
  };
  dependencies: {
    enabled: boolean;
    hydrate: DependencyHydrationMode;
    cacheRoot: string;
  };
}

export type DependencyHydrationMode = "auto" | "always" | "never";

export interface GlobalFactoryConfig {
  models?: Partial<Record<ModelRole, ModelSelection>> & {
    provider?: string;
    roles?: Partial<Record<ModelRole, ModelSelection>>;
  };
  runtime?: {
    maxParallelAgents?: number;
    limits?: ExecutionLimits;
  };
  ui?: {
    showWorkerDetails?: boolean;
  };
  defaults?: {
    autonomy?: string;
    workflow?: string;
  };
  constitution?: {
    enabled?: boolean;
  };
  dashboard?: {
    enabled?: boolean;
    port?: number;
    host?: string;
    autoOpen?: boolean;
  };
  dependencies?: {
    enabled?: boolean;
    hydrate?: DependencyHydrationMode;
    cacheRoot?: string;
  };
}

export interface TaskTypeMatch {
  keywords?: string[];
  paths?: string[];
}

export interface TaskTypeRouting {
  model: string;
  provider?: string;
}

export interface TaskTypeDefinition {
  description?: string;
  match?: TaskTypeMatch;
  routing?: Partial<Record<ModelRole, TaskTypeRouting>>;
}

export interface ProjectFactoryConfig {
  project?: {
    baseBranch?: string;
  };
  capabilities?: CapabilityPolicy;
  taskTypes?: Record<string, TaskTypeDefinition>;
  commands?: {
    cwd?: string;
    setup?: SetupCommandConfig;
    lint?: string;
    typecheck?: string;
    test?: string;
    build?: string;
    checks?: Record<string, { description?: string; command: string; timeout?: number }>;
  };
  runtime?: {
    maxParallelAgents?: number;
    limits?: ExecutionLimits;
  };
  git?: {
    baseBranch?: string;
    allowWorktrees?: boolean;
    worktreeDir?: string;
    cleanup?: {
      retainRuns?: number;
      pruneWorktrees?: boolean;
      pruneBranches?: boolean;
    };
  };
  repair?: {
    enabled?: boolean;
    maxAttempts?: number;
    maxTotalAttempts?: number;
  };
  constitution?: {
    enabled?: boolean;
  };
  approval?: {
    finalMerge?: "required" | "not-required";
  };
  models?: Partial<Record<ModelRole, ModelSelection>> & {
    provider?: string;
    roles?: Partial<Record<ModelRole, ModelSelection>>;
  };
  dashboard?: {
    enabled?: boolean;
    port?: number;
    host?: string;
    autoOpen?: boolean;
  };
  dependencies?: {
    enabled?: boolean;
    hydrate?: DependencyHydrationMode;
    cacheRoot?: string;
  };
}

export interface RunOverrides {
  workflowId?: string;
  taskType?: string;
  models?: Partial<Record<ModelRole, ModelSelection>>;
  runtime?: {
    maxParallelAgents?: number;
    limits?: ExecutionLimits;
  };
  approval?: {
    finalMerge?: "required" | "not-required";
  };
}

export interface EffectiveFactoryConfig {
  models: Partial<Record<ModelRole, ModelSelection>>;
  runtime: {
    maxParallelAgents: number;
    limits?: ExecutionLimits;
  };
  ui: {
    showWorkerDetails: boolean;
  };
  defaults: {
    autonomy: string;
    workflow: string;
  };
  project: {
    baseBranch: string;
  };
  commands: {
    cwd?: string;
    setup?: SetupCommandConfig;
    lint?: string;
    typecheck?: string;
    test?: string;
    build?: string;
    checks?: Record<string, { description?: string; command: string; timeout?: number }>;
  };
  git: {
    baseBranch: string;
    allowWorktrees: boolean;
    worktreeDir?: string;
    cleanup: {
      retainRuns: number;
      pruneWorktrees: boolean;
      pruneBranches: boolean;
    };
  };
  repair: {
    enabled: boolean;
    maxAttempts: number;
    maxTotalAttempts: number;
  };
  constitution: {
    enabled: boolean;
  };
  approval: {
    finalMerge: "required" | "not-required";
  };
  dashboard: {
    enabled: boolean;
    port: number;
    host: string;
    autoOpen: boolean;
  };
  dependencies: {
    enabled: boolean;
    hydrate: DependencyHydrationMode;
    cacheRoot: string;
  };
  capabilities?: CapabilityPolicy;
  taskTypes?: Record<string, TaskTypeDefinition>;
  workflow?: WorkflowConfig;
  resolvedWorkflow?: WorkflowDefinition;
  resolvedWorkflowId?: string;
}

export interface FactoryProjectPaths {
  cwd: string;
  gitRoot?: string;
  constitutionPath?: string;
  workflowPath?: string;
  projectConfigPath?: string;
  runsDir: string;
}

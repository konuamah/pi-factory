export type ModelRole = "planner" | "builder" | "reviewer" | "repair";

export interface ModelSelection {
  provider?: string;
  model: string;
}

export type WorkflowNodeType = "agent" | "command" | "approval" | "task-graph";

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

export interface WorkflowStage {
  name: string;
  dependsOn?: string[];
  type?: WorkflowNodeType;
  role?: ModelRole;
  commands?: string[];
  requiresApproval?: boolean;
  requiredCapabilities?: Capability[];
  taskType?: string;
  model?: ModelSelection;
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
}

export interface GlobalFactoryConfig {
  models?: Partial<Record<ModelRole, ModelSelection>>;
  runtime?: {
    maxParallelAgents?: number;
  };
  ui?: {
    showWorkerDetails?: boolean;
  };
  defaults?: {
    autonomy?: string;
    workflow?: string;
  };
  dashboard?: {
    enabled?: boolean;
    port?: number;
    host?: string;
    autoOpen?: boolean;
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
    setup?: string;
    lint?: string;
    typecheck?: string;
    test?: string;
    build?: string;
  };
  runtime?: {
    maxParallelAgents?: number;
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
  };
  approval?: {
    finalMerge?: "required" | "not-required";
  };
  models?: Partial<Record<ModelRole, ModelSelection>>;
  dashboard?: {
    enabled?: boolean;
    port?: number;
    host?: string;
    autoOpen?: boolean;
  };
}

export interface RunOverrides {
  workflowId?: string;
  taskType?: string;
  models?: Partial<Record<ModelRole, ModelSelection>>;
  runtime?: {
    maxParallelAgents?: number;
  };
  approval?: {
    finalMerge?: "required" | "not-required";
  };
}

export interface EffectiveFactoryConfig {
  models: Partial<Record<ModelRole, ModelSelection>>;
  runtime: {
    maxParallelAgents: number;
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
    setup?: string;
    lint?: string;
    typecheck?: string;
    test?: string;
    build?: string;
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

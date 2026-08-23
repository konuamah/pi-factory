export type ModelRole = "planner" | "builder" | "reviewer" | "repair";

export interface ModelSelection {
  provider?: string;
  model: string;
}

export interface WorkflowStage {
  name: string;
  dependsOn?: string[];
}

export interface WorkflowConfig {
  stages: WorkflowStage[];
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
}

export interface ProjectFactoryConfig {
  project?: {
    baseBranch?: string;
  };
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
}

export interface RunOverrides {
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
  workflow?: WorkflowConfig;
}

export interface FactoryProjectPaths {
  cwd: string;
  gitRoot?: string;
  constitutionPath?: string;
  workflowPath?: string;
  projectConfigPath?: string;
  runsDir: string;
}

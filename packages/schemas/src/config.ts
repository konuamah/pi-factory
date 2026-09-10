export type ModelRole = "discovery" | "planner" | "builder" | "reviewer" | "repair" | "landing";

/**
 * Sentinel value for git/project baseBranch config: resolve to the branch
 * checked out in the project root at run start instead of a hard-coded name.
 * Resolved by the config loader (packages/core/src/config/loader.ts); must
 * never survive into the effective config. See docs/factory/ configuration
 * reference.
 */
export const CURRENT_BRANCH_SENTINEL = "@current";

export interface ExecutionLimits {
  /** Hard ceiling for one dependency setup step. */
  dependencySetupTimeoutMs?: number;
  /** Hard ceiling for captured dependency setup output. */
  dependencySetupMaxBufferBytes?: number;
  /**
   * Hard ceiling for one agent turn (model + tool activity combined).
   * Replaces the ambiguous `totalRunTimeoutMs` (which was actually per-turn).
   */
  turnTimeoutMs?: number;
  /**
   * Fires when the model/provider emits no activity (SDK events) for this long.
   * Text events count as activity and keep this timer reset.
   */
  modelIdleTimeoutMs?: number;
  /**
   * Hard ceiling for a single tool execution. The model idle watchdog is paused
   * while a tool owns execution.
   */
  toolTimeoutMs?: number;
  /**
   * Hard ceiling across all turns/phases of one Factory run (controller-owned).
   */
  runTimeoutMs?: number;
  /**
   * Absolute wall-clock deadline (ms epoch) for the whole run, established by
   * the controller when the run starts and shared across all agent turns.
   */
  runDeadlineAt?: number;
  /**
   * Optional deterministic grace for model reasoning pauses. At most one
   * extension per turn; never extends tool or turn/run hard ceilings.
   */
  adaptiveGrace?: {
    enabled?: boolean;
    durationMs?: number;
    maxExtensionsPerTurn?: number;
  };
  maxTurns?: number;
  /** @deprecated Alias for `modelIdleTimeoutMs`. */
  modelTimeoutMs?: number;
  /** @deprecated Alias for `turnTimeoutMs` (was misnamed as a run timeout). */
  totalRunTimeoutMs?: number;
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

export type WorkflowNodeType = "agent" | "command" | "approval" | "acceptance" | "task-graph" | "interview";

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
  allowedTools?: string[];
  denyTools?: string[];
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
    policy?: RuntimePolicyConfig;
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
  scope: {
    verification: "warn" | "block";
    landing: "warn" | "block";
  };
  git: {
    cleanup: {
      retainRuns: number;
      pruneWorktrees: boolean;
      pruneBranches: boolean;
      preserveFailedRuns: boolean;
    };
    pullRequest: {
      enabled: boolean;
      provider: "github";
      cli: "gh";
      draft: boolean;
      baseBranch?: string;
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
    cacheMaxAgeDays: number;
  };
}

export type DependencyHydrationMode = "auto" | "always" | "never";

export interface RuntimePolicyConfig {
  enabled?: boolean;
  policyModel?: ModelSelection;
  maxPolicyAttempts?: number;
  allowedPhasesByPhase?: Record<string, string[]>;
}

export interface GlobalFactoryConfig {
  models?: Partial<Record<ModelRole, ModelSelection>> & {
    provider?: string;
    roles?: Partial<Record<ModelRole, ModelSelection>>;
  };
  runtime?: {
    maxParallelAgents?: number;
    limits?: ExecutionLimits;
    policy?: RuntimePolicyConfig;
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
    cacheMaxAgeDays?: number;
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
    policy?: RuntimePolicyConfig;
  };
  git?: {
    baseBranch?: string;
    allowWorktrees?: boolean;
    worktreeDir?: string;
    cleanup?: {
      retainRuns?: number;
      pruneWorktrees?: boolean;
      pruneBranches?: boolean;
      preserveFailedRuns?: boolean;
    };
    pullRequest?: {
      enabled?: boolean;
      provider?: "github";
      cli?: "gh";
      draft?: boolean;
      baseBranch?: string;
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
  scope?: {
    /** Whether a plan non-goal violation fails verification ("block") or only warns ("warn"). */
    verification?: "warn" | "block";
    /** Whether a landing scope violation blocks the merge ("block") or only notes it ("warn"). */
    landing?: "warn" | "block";
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
    cacheMaxAgeDays?: number;
  };
}

export interface RunOverrides {
  workflowId?: string;
  taskType?: string;
  models?: Partial<Record<ModelRole, ModelSelection>>;
  runtime?: {
    maxParallelAgents?: number;
    limits?: ExecutionLimits;
    policy?: RuntimePolicyConfig;
  };
  approval?: {
    finalMerge?: "required" | "not-required";
  };
  scope?: {
    verification?: "warn" | "block";
    landing?: "warn" | "block";
  };
}

export interface EffectiveFactoryConfig {
  models: Partial<Record<ModelRole, ModelSelection>>;
  runtime: {
    maxParallelAgents: number;
    limits?: ExecutionLimits;
    policy?: RuntimePolicyConfig;
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
      preserveFailedRuns: boolean;
    };
    pullRequest: {
      enabled: boolean;
      provider: "github";
      cli: "gh";
      draft: boolean;
      baseBranch?: string;
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
  scope: {
    verification: "warn" | "block";
    landing: "warn" | "block";
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
    cacheMaxAgeDays: number;
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

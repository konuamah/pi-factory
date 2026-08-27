import type {
  Capability,
  EffectiveFactoryConfig,
  FactoryBuiltInDefaults,
  GlobalFactoryConfig,
  ModelRole,
  ModelSelection,
  ProjectFactoryConfig,
  DependencyHydrationMode,
  WorkflowDefinition,
} from "./config.js";

export type RecommendationSource = "DISCOVERED" | "AI_SUGGESTED" | "DEFAULT";
export type RecommendationConfidence = "HIGH" | "MEDIUM" | "LOW";

export interface Recommendation<T> {
  value: T;
  reason: string;
  source: RecommendationSource;
  confidence: RecommendationConfidence;
  requiresConfirmation?: boolean;
}

export interface DiscoveredCommands {
  setup?: string;
  lint?: string;
  typecheck?: string;
  test?: string;
  build?: string;
}

export interface SkillSummary {
  id: string;
  description?: string;
}

export interface RepositoryProfileSummary {
  maturity: string;
  gitRoot?: string;
  languages: string[];
  packageManagers: string[];
  frameworks: string[];
  structure: { monorepo: boolean; packages: string[] };
  commands: { install?: string; build?: string; test?: string; lint?: string; typecheck?: string; start?: string };
  testing: { frameworks: string[]; unit: boolean; integration: boolean; e2e: boolean };
  persistence: { technologies: string[]; migrations: boolean };
  ci: { providers: string[] };
  deployment: { detected: boolean; providers: string[] };
  factory: { files: { constitution: boolean; workflow: boolean; projectConfig: boolean }; runsCount: number; hasConstitutionMetadata: boolean };
}

export interface FactorySetupContext {
  repository: RepositoryProfileSummary;
  existing: {
    builtIn: FactoryBuiltInDefaults;
    global?: GlobalFactoryConfig;
    project?: ProjectFactoryConfig;
    workflows?: WorkflowDefinition[];
    constitutionExists: boolean;
    rawGlobalText?: string;
    rawProjectText?: string;
    rawWorkflowText?: string;
  };
  effective?: EffectiveFactoryConfig;
  availableModels: ModelSelection[];
  availableSkills: SkillSummary[];
  availableCapabilities: Capability[];
  discoveredCommands: DiscoveredCommands;
}

export type WorkflowPreset = "balanced" | "fast" | "safe";

export type WorkflowRecommendation =
  | { kind: "preset"; preset: WorkflowPreset; workflowId: string }
  | { kind: "custom"; workflow: WorkflowDefinition; reason: string };

export type RecommendationKind = "fact" | "recommendation" | "preference";

export interface QuestionKindMeta {
  kind: RecommendationKind;
}

export interface WhyNot {
  area: string;
  reason: string;
  howToEnable?: string;
}

export interface TaskTypeRecommendation {
  id: string;
  description?: string;
  match?: { keywords?: string[]; paths?: string[] };
  routing?: Partial<Record<ModelRole, { model: string; provider?: string; reason?: string }>>;
  reason: string;
  source: RecommendationSource;
  confidence: RecommendationConfidence;
}

export interface SetupQuestion {
  id: string;
  question: string;
  options: Array<{ id: string; label: string }>;
  context?: string;
  kind?: RecommendationKind; // fact=discoverable, recommendation=AI default, preference=user must decide
}

export type ConstitutionRecommendation = "GENERATE" | "REFRESH" | "KEEP";

export interface ProjectUnderstanding {
  summary: string; // 3-6 sentence simple-English repo description
  highlights: string[]; // bullets: monorepo, API, DB, tests, CI, Docker, Factory state
  correctionsPrompt?: string; // "Looks right / Correct something" — first steward slide
}

export interface FactorySetupRecommendation {
  projectUnderstanding: ProjectUnderstanding;
  summary: string;
  workflow?: { value: WorkflowRecommendation; reason: string };
  models?: Partial<Record<ModelRole, { value: ModelSelection; reason: string }>>;
  commands?: {
    setup?: Recommendation<string>;
    lint?: Recommendation<string>;
    typecheck?: Recommendation<string>;
    test?: Recommendation<string>;
    build?: Recommendation<string>;
  };
  runtime?: { maxParallelAgents?: Recommendation<number> };
  repair?: { enabled?: Recommendation<boolean>; maxAttempts?: Recommendation<number> };
  approval?: { finalMerge?: Recommendation<"required" | "not-required"> };
  git?: {
    baseBranch?: Recommendation<string>;
    allowWorktrees?: Recommendation<boolean>;
    worktreeDir?: Recommendation<string>;
    cleanup?: {
      retainRuns?: Recommendation<number>;
      pruneWorktrees?: Recommendation<boolean>;
      pruneBranches?: Recommendation<boolean>;
    };
  };
  capabilities?: { allow?: Capability[]; deny?: Capability[] };
  taskTypes?: TaskTypeRecommendation[];
  skills?: { ids: string[]; reason: string };
  dashboard?: {
    enabled?: Recommendation<boolean>;
    port?: Recommendation<number>;
    host?: Recommendation<string>;
    autoOpen?: Recommendation<boolean>;
  };
  dependencies?: {
    enabled?: Recommendation<boolean>;
    hydrate?: Recommendation<DependencyHydrationMode>;
    cacheRoot?: Recommendation<string>;
  };
  constitution: ConstitutionRecommendation;
  whyNot?: WhyNot[]; // things intentionally skipped, with reason
  explanation: string[];
  questions: SetupQuestion[];
}

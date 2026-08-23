export type RepoMaturity = "EMPTY" | "NEW" | "ESTABLISHED";

export type SettingOrigin = "DISCOVERED" | "INFERRED" | "USER" | "DEFAULT";

export interface RepositoryProfile {
  maturity: RepoMaturity;
  gitRoot?: string;
  languages: string[];
  packageManagers: string[];
  frameworks: string[];
  structure: {
    monorepo: boolean;
    packages: string[];
  };
  commands: {
    install?: string;
    build?: string;
    test?: string;
    lint?: string;
    typecheck?: string;
    start?: string;
  };
  testing: {
    frameworks: string[];
    unit: boolean;
    integration: boolean;
    e2e: boolean;
  };
  persistence: {
    technologies: string[];
    migrations: boolean;
  };
  ci: {
    providers: string[];
  };
  deployment: {
    detected: boolean;
    providers: string[];
  };
  factory: ExistingFactoryState;
}

export interface ExistingFactoryState {
  files: {
    constitution: boolean;
    workflow: boolean;
    projectConfig: boolean;
  };
  runsCount: number;
  hasConstitutionMetadata: boolean;
}

export type SetupCategory =
  | "WORKFLOW"
  | "MODEL"
  | "VERIFICATION"
  | "SKILL"
  | "CAPABILITY"
  | "CONSTITUTION"
  | "RUNTIME";

export interface SetupRecommendation {
  id: string;
  category: SetupCategory;
  proposedValue: unknown;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  reason: string;
  evidenceRefs?: string[];
  requiresDecision: boolean;
  origin: SettingOrigin;
}

export interface SetupDecision {
  id: string;
  question: string;
  options: Array<{ id: string; label: string }>;
  context?: string;
}

export type SetupMode = "BOOTSTRAP" | "ADOPT" | "RECONCILE";

export interface ProposedFactorySetup {
  files: Array<{
    path: string;
    content: string;
    action: "create" | "update" | "unchanged";
  }>;
}

export interface SetupDiff {
  file: string;
  before: string;
  after: string;
  changes: string[];
}

export interface FactorySetupPlan {
  mode: SetupMode;
  profile: RepositoryProfile;
  recommendations: SetupRecommendation[];
  decisions: SetupDecision[];
  proposed: ProposedFactorySetup;
  diffs: SetupDiff[];
}

export type SetupReadiness = "READY" | "READY_WITH_WARNINGS" | "NOT_READY";

export interface SetupValidationResult {
  readiness: SetupReadiness;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

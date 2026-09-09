import type { DecisionRequest } from "../decisions/types.js";

export type VerificationRequirementType =
  | "COMMAND"
  | "TEST"
  | "STATIC_ANALYSIS"
  | "CONSTITUTION"
  | "REVIEW"
  | "ARTIFACT"
  | "SCOPE";

export type VerificationSource =
  | "SKILL"
  | "CONSTITUTION"
  | "TASK_TYPE"
  | "WORKFLOW"
  | "USER"
  | "FACTORY"
  | "PLAN";

export type VerificationScope = "TASK" | "NODE" | "RUN";

export interface VerificationRequirementBase {
  id: string;
  type: VerificationRequirementType;
  blocking: boolean;
  description: string;
  source: VerificationSource;
  scope: VerificationScope;
  taskId?: string;
  affectedFiles?: string[];
}

export interface CommandRequirement extends VerificationRequirementBase {
  type: "COMMAND";
  command: string;
  cwd?: string;
  expectedExitCode?: number;
}

export interface TestRequirement extends VerificationRequirementBase {
  type: "TEST";
  command?: string;
  cwd?: string;
  selector?: string;
  minimumPassed?: number;
}

export interface StaticAnalysisRequirement extends VerificationRequirementBase {
  type: "STATIC_ANALYSIS";
  command?: string;
  pattern?: string;
}

export interface ConstitutionRequirement extends VerificationRequirementBase {
  type: "CONSTITUTION";
  areaIds: number[];
  requiredStatus?: Array<"DEFINED" | "INFERRED" | "NOT_DEFINED" | "NOT_APPLICABLE" | "UNCERTAIN">;
}

export interface ReviewFinding {
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
  claim: string;
  evidence?: string[];
  disposition?: ReviewDisposition;
  decision?: DecisionRequest;
}

export type ReviewDisposition = "PASS" | "REPAIR" | "NEEDS_DECISION";

export interface ReviewRequirement extends VerificationRequirementBase {
  type: "REVIEW";
  focus: string[];
  blockingSeverities: Array<"CRITICAL" | "HIGH" | "MEDIUM">;
  decision?: DecisionRequest;
}

export interface ArtifactRequirement extends VerificationRequirementBase {
  type: "ARTIFACT";
  path?: string;
  pattern?: string;
  mustExist: boolean;
  changed?: boolean;
}

export interface ScopeRequirement extends VerificationRequirementBase {
  type: "SCOPE";
  nonGoals: string[];
}

export type VerificationRequirement =
  | CommandRequirement
  | TestRequirement
  | StaticAnalysisRequirement
  | ConstitutionRequirement
  | ReviewRequirement
  | ArtifactRequirement
  | ScopeRequirement;

export type VerificationStatus =
  | "PASS"
  | "FAIL"
  | "BLOCKED"
  | "NOT_APPLICABLE"
  | "NOT_RUN"
  | "INCONCLUSIVE";

export interface EvidenceRef {
  id: string;
  kind: string;
}

export interface VerificationResult {
  requirementId: string;
  blocking: boolean;
  status: VerificationStatus;
  evidence: EvidenceRef[];
  findings?: ReviewFinding[];
  reason?: string;
  decision?: DecisionRequest;
}

export interface VerificationContractPlan {
  requirements: VerificationRequirement[];
  createdFrom: {
    skills: string[];
    constitutionAreas: number[];
    taskType?: string;
    workflow?: string;
    userCriteria?: string[];
  };
}

export interface VerificationEvidenceStore {
  [evidenceId: string]: {
    kind: string;
    [key: string]: unknown;
  };
}

export type ProviderVerificationResult = Omit<VerificationResult, "blocking">;

export interface VerificationProviderContext {
  cwd: string;
  evidence: VerificationEvidenceStore;
  results: ProviderVerificationResult[];
}

export interface VerificationProvider {
  type: string;
  verify(requirement: VerificationRequirement, context: VerificationProviderContext): Promise<ProviderVerificationResult>;
}

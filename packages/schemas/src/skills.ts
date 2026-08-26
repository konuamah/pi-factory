export type SkillExecutionStage = "discover" | "plan" | "interview" | "build" | "verification" | "review" | "repair";

export interface SkillApplicability {
  filePatterns?: string[];
  languages?: string[];
  dependencies?: string[];
  frameworks?: string[];
  taskKinds?: string[];
  constitutionAreas?: number[];
  stages?: SkillExecutionStage[];
}

export interface SkillEvidenceRequirements {
  required?: string[];
  optional?: string[];
}

export interface SkillPermissions {
  allowedTools?: string[];
  readScopes?: string[];
  writeScopes?: string[];
  forbiddenWriteScopes?: string[];
  requiresApproval?: string[];
  riskLevel?: "low" | "medium" | "high";
}

export interface SkillModeDefinition {
  objective: string;
  constraints?: string[];
}

export interface SkillValidationDefinition {
  commands?: string[];
  assertions?: string[];
}

export interface SkillOutputDefinition {
  fields: string[];
}

export interface SkillDependencyRules {
  any?: string[];
  all?: string[];
}

export interface SkillProvidesDefinition {
  capabilities?: string[];
}

export interface SkillCompatibleWithDefinition {
  factory?: string;
}

export interface SkillContract {
  id: string;
  version: string;
  description: string;
  body?: string;
  applicability?: SkillApplicability;
  constitutionDependencies?: number[];
  evidence?: SkillEvidenceRequirements;
  permissions?: SkillPermissions;
  modes?: Partial<Record<SkillExecutionStage, SkillModeDefinition>>;
  validation?: SkillValidationDefinition;
  outputs?: SkillOutputDefinition;
  extends?: string[];
  taskTypes?: string[];
  provides?: SkillProvidesDefinition;
  requiresSkills?: string[];
  conflictsWith?: string[];
  exclusiveGroup?: string;
  filePatterns?: string[];
  dependencies?: SkillDependencyRules;
  compatibleWith?: SkillCompatibleWithDefinition;
}

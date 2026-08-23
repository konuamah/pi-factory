import type { SkillContract, SkillExecutionStage } from "@factory/schemas";

export interface SkillSelectionContext {
  goal: string;
  stage: SkillExecutionStage;
  languages?: string[];
  taskKinds?: string[];
  constitutionAreas?: number[];
  dependencies?: string[];
  frameworks?: string[];
  affectedFiles?: string[];
  requiredCapabilities?: string[];
  availableTools?: string[];
}

export interface SkillSelectionScores {
  semantic: number;
  repository: number;
  files: number;
  constitution: number;
  historical: number;
  stage: number;
  capabilities: number;
}

export interface SkillSelectionResult<TSkill extends SkillContract = SkillContract> {
  skill: TSkill;
  score: number;
  reasons: string[];
  scores?: Partial<SkillSelectionScores>;
}

export interface SkillCandidate<TSkill extends SkillContract = SkillContract> extends SkillSelectionResult<TSkill> {
  provides: string[];
}

export interface SkillCapabilityCoverage {
  required: string[];
  covered: string[];
  missing: string[];
}

export interface SkillBundleSelection {
  selected: SkillCandidate[];
  rejected: Array<SkillCandidate & { rejectedReason: string }>;
  capabilityCoverage: SkillCapabilityCoverage;
  confidence: number;
}

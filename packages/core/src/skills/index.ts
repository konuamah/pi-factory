import { registerFactorySkill } from "./registry.js";
import {
  acceptanceReviewSkill,
  architecturePlanningSkill,
  implementationTaskSkill,
  repairTriageSkill,
  repoInterpretationSkill,
} from "./factory-stage-skills.js";
import { verificationPlanningSkill } from "./verification-planning.js";

let initialized = false;

export function initializeFactorySkills(): void {
  if (initialized) {
    return;
  }
  initialized = true;
  registerFactorySkill(repoInterpretationSkill);
  registerFactorySkill(architecturePlanningSkill);
  registerFactorySkill(implementationTaskSkill);
  registerFactorySkill(acceptanceReviewSkill);
  registerFactorySkill(repairTriageSkill);
  registerFactorySkill(verificationPlanningSkill);
}

export * from "./types.js";
export * from "./registry.js";
export * from "./factory-stage-skills.js";
export * from "./verification-planning.js";

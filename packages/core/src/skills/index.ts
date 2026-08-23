import path from "node:path";
import { clearFactorySkillRegistry, registerFactorySkill } from "./registry.js";
import {
  acceptanceReviewSkill,
  architecturePlanningSkill,
  implementationTaskSkill,
  repairTriageSkill,
  repoInterpretationSkill,
} from "./factory-stage-skills.js";
import { verificationPlanningSkill } from "./verification-planning.js";
import { discoverSkillFiles, parseSkillFile, skillFileToContract } from "./loader.js";

let initialized = false;

export async function initializeFactorySkills(cwd?: string): Promise<void> {
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

  if (cwd) {
    await loadProjectSkills(cwd);
  }
}

export async function loadProjectSkills(cwd: string): Promise<number> {
  const candidates = [path.join(cwd, ".pi", "skills"), path.join(cwd, ".agents", "skills")];
  let loaded = 0;
  for (const root of candidates) {
    const files = await discoverSkillFiles(root).catch(() => []);
    for (const file of files) {
      const parsed = await parseSkillFile(file);
      if (!parsed) {
        continue;
      }
      registerFactorySkill(skillFileToContract(parsed));
      loaded += 1;
    }
  }
  return loaded;
}

export function resetFactorySkills(): void {
  initialized = false;
  clearFactorySkillRegistry();
}

export * from "./types.js";
export * from "./registry.js";
export * from "./loader.js";
export * from "./factory-stage-skills.js";
export * from "./verification-planning.js";

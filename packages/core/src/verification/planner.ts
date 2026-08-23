import type { EffectiveFactoryConfig } from "@factory/schemas";
import type { SkillContract } from "@factory/schemas";
import type {
  VerificationContractPlan,
  VerificationRequirement,
} from "./types.js";

export interface VerificationContractPlannerInput {
  goal: string;
  taskType?: string;
  config: EffectiveFactoryConfig;
  skills?: SkillContract[];
  constitutionAreas?: number[];
  workflowId?: string;
  userCriteria?: string[];
  constitutionConflicts?: Array<{ areas: number[]; message: string }>;
  explicitConstitutionAreas?: boolean;
  conflictAreas?: number[];
  commands?: {
    lint?: string;
    typecheck?: string;
    test?: string;
    build?: string;
  };
  taskId?: string;
}

export function gatherVerificationRequirements(input: VerificationContractPlannerInput): VerificationContractPlan {
  const requirements: VerificationRequirement[] = [];
  let idCounter = 0;
  const nextId = (): string => `req-${++idCounter}`;

  // 1. FACTORY: base command requirements from configured commands.
  const commands = input.commands ?? {};
  if (commands.lint) {
    requirements.push({
      id: nextId(),
      type: "COMMAND",
      blocking: true,
      description: "Run lint",
      source: "FACTORY",
      scope: "RUN",
      taskId: input.taskId,
      command: commands.lint,
    });
  }
  if (commands.typecheck) {
    requirements.push({
      id: nextId(),
      type: "COMMAND",
      blocking: true,
      description: "Run typecheck",
      source: "FACTORY",
      scope: "RUN",
      taskId: input.taskId,
      command: commands.typecheck,
    });
  }
  if (commands.test) {
    requirements.push({
      id: nextId(),
      type: "TEST",
      blocking: true,
      description: "Run tests",
      source: "FACTORY",
      scope: "RUN",
      taskId: input.taskId,
      command: commands.test,
    });
  }
  if (commands.build) {
    requirements.push({
      id: nextId(),
      type: "COMMAND",
      blocking: true,
      description: "Run build",
      source: "FACTORY",
      scope: "RUN",
      taskId: input.taskId,
      command: commands.build,
    });
  }

  // 2. SKILL: skills declare validation.commands as requirements.
  for (const skill of input.skills ?? []) {
    for (const command of skill.validation?.commands ?? []) {
      requirements.push({
        id: nextId(),
        type: "COMMAND",
        blocking: true,
        description: `Skill '${skill.id}' validation: ${command}`,
        source: "SKILL",
        scope: "NODE",
        taskId: input.taskId,
        command,
      });
    }
  }

  // 3. CONSTITUTION: relevant areas become constitution requirements.
  // Only when explicitly declared (skills/task), not generic repo signals.
  const constitutionAreas = input.constitutionAreas ?? [];
  if (constitutionAreas.length > 0 && input.explicitConstitutionAreas) {
    requirements.push({
      id: nextId(),
      type: "CONSTITUTION",
      blocking: true,
      description: `Relevant constitution areas must be DEFINED/INFERRED: ${constitutionAreas.join(", ")}`,
      source: "CONSTITUTION",
      scope: "RUN",
      taskId: input.taskId,
      areaIds: constitutionAreas,
      requiredStatus: ["DEFINED", "INFERRED"],
    });
  }

  // 3b. CONSTITUTION conflict matching uses areas too, but does not force a status requirement.
  const conflictAreas = input.conflictAreas ?? constitutionAreas;

  // 4. TASK_TYPE: high-risk types add a review requirement.
  if (input.taskType && isHighRiskTaskType(input.taskType)) {
    requirements.push({
      id: nextId(),
      type: "REVIEW",
      blocking: true,
      description: `Review for high-risk task type '${input.taskType}'`,
      source: "TASK_TYPE",
      scope: "NODE",
      taskId: input.taskId,
      focus: ["architecture", "backwards-compatibility", "data-safety"],
      blockingSeverities: ["CRITICAL", "HIGH"],
    });
  }

  // 5. USER: acceptance criteria become artifact/review requirements.
  for (const criterion of input.userCriteria ?? []) {
    requirements.push({
      id: nextId(),
      type: "REVIEW",
      blocking: true,
      description: `User acceptance criterion: ${criterion}`,
      source: "USER",
      scope: "TASK",
      taskId: input.taskId,
      focus: [criterion],
      blockingSeverities: ["CRITICAL", "HIGH", "MEDIUM"],
    });
  }

  // 6. CONSTITUTION: consequential contradictions raise a decision gate,
  // only when the run's relevant constitution areas intersect the conflict areas.
  const relevantConflicts = (conflictAreas.length
    ? (input.constitutionConflicts ?? []).filter((conflict) =>
        conflict.areas.some((area) => conflictAreas.includes(area)),
      )
    : []);
  for (const conflict of relevantConflicts.slice(0, 2)) {
    requirements.push({
      id: nextId(),
      type: "REVIEW",
      blocking: true,
      description: `Constitution contradiction needs a decision: ${conflict.message}`,
      source: "CONSTITUTION",
      scope: "RUN",
      taskId: input.taskId,
      focus: conflict.areas.map((area) => `area-${area}`),
      blockingSeverities: ["CRITICAL", "HIGH"],
      decision: {
        id: `decision-${nextId()}`,
        title: "Constitution contradiction",
        question: conflict.message,
        options: [
          { id: "follow-constitution", label: "Follow constitution", description: "Apply documented convention." },
          { id: "preserve-current", label: "Preserve current implementation", description: "Keep the existing architecture." },
          { id: "amend-constitution", label: "Amend constitution", description: "Update the constitution to match reality." },
        ],
        evidenceRefs: [],
        source: "CONSTITUTION",
        reason: "CONFLICT",
      },
    });
  }

  return {
    requirements: dedupeRequirements(requirements),
    createdFrom: {
      skills: (input.skills ?? []).map((skill) => skill.id),
      constitutionAreas,
      taskType: input.taskType,
      workflow: input.workflowId,
      userCriteria: input.userCriteria,
    },
  };
}

function dedupeRequirements(requirements: VerificationRequirement[]): VerificationRequirement[] {
  const seen = new Set<string>();
  return requirements.filter((requirement) => {
    const key = `${requirement.type}:${requirement.source}:${requirement.description}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function isHighRiskTaskType(taskType: string): boolean {
  return /security|migration|schema|production|risk|auth/.test(taskType);
}

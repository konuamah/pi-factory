import type { SkillContract } from "@factory/schemas";

export const repoInterpretationSkill: SkillContract = {
  id: "repo-interpretation",
  version: "1.0.0",
  description: "Interpret repository structure, conventions, and likely authoritative roots from repo evidence.",
  taskTypes: ["repo-interpretation", "planning"],
  provides: {
    capabilities: ["repo-interpretation"],
  },
  applicability: {
    stages: ["plan", "build", "review", "repair", "verification"],
    taskKinds: ["repo-interpretation", "planning", "implementation", "review", "repair", "verification"],
  },
  permissions: {
    allowedTools: ["read", "grep", "find", "ls"],
    riskLevel: "low",
  },
};

export const architecturePlanningSkill: SkillContract = {
  id: "architecture-planning",
  version: "1.0.0",
  description: "Produce a scoped implementation plan aligned with repository architecture and constraints.",
  taskTypes: ["planning", "architecture-change"],
  provides: {
    capabilities: ["architecture-planning"],
  },
  applicability: {
    stages: ["plan"],
    taskKinds: ["planning"],
  },
  permissions: {
    allowedTools: ["read", "grep", "find", "ls"],
    riskLevel: "low",
  },
};

export const implementationTaskSkill: SkillContract = {
  id: "implementation-task",
  version: "1.0.0",
  description: "Implement a scoped repository change while preserving local conventions and minimizing unrelated edits.",
  taskTypes: ["implementation"],
  provides: {
    capabilities: ["implementation-task"],
  },
  applicability: {
    stages: ["build"],
    taskKinds: ["implementation"],
  },
  permissions: {
    allowedTools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
    riskLevel: "medium",
  },
};

export const acceptanceReviewSkill: SkillContract = {
  id: "acceptance-review",
  version: "1.0.0",
  description: "Review a candidate for scope control, verification completeness, and repository consistency.",
  taskTypes: ["review"],
  provides: {
    capabilities: ["acceptance-review"],
  },
  applicability: {
    stages: ["review"],
    taskKinds: ["review"],
  },
  permissions: {
    allowedTools: ["read", "grep", "find", "ls"],
    riskLevel: "low",
  },
};

export const repairTriageSkill: SkillContract = {
  id: "repair-triage",
  version: "1.0.0",
  description: "Interpret verification failures, distinguish harness/config issues from code failures, and focus repair scope accordingly.",
  taskTypes: ["repair", "verification"],
  provides: {
    capabilities: ["failure-triage", "verification-repair"],
  },
  applicability: {
    stages: ["repair"],
    taskKinds: ["repair", "verification"],
  },
  permissions: {
    allowedTools: ["read", "grep", "find", "ls"],
    riskLevel: "low",
  },
};

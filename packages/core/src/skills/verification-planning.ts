import type { SkillContract } from "@factory/schemas";

export const verificationPlanningSkill: SkillContract = {
  id: "verification-planning",
  version: "1.0.0",
  description: "Choose the most appropriate verification working directory and authoritative verification commands for the current repository.",
  taskTypes: ["verification", "repo-interpretation", "command-selection"],
  provides: {
    capabilities: ["verification-root-selection", "verification-command-selection", "repo-interpretation"],
  },
  filePatterns: ["package.json", "**/*.json", "frontend/**", "src/**"],
  applicability: {
    taskKinds: ["verification", "repo-interpretation"],
    languages: ["TypeScript", "JavaScript", "Python", "Go", "Rust"],
    constitutionAreas: [1, 2, 3, 18, 73, 76],
    stages: ["verification", "repair"],
  },
  constitutionDependencies: [1, 2, 3, 18, 73, 76],
  evidence: {
    required: ["candidate package roots", "configured verification commands", "package manifests", "package scripts"],
    optional: ["constitution summary", "repo learnings", "recent verification failures"],
  },
  permissions: {
    allowedTools: ["read", "grep", "find", "ls"],
    readScopes: ["repository"],
    forbiddenWriteScopes: ["repository"],
    riskLevel: "low",
  },
  modes: {
    verification: {
      objective: "Select the verification root and only the commands that are authoritative for this repository.",
      constraints: [
        "Do not invent missing package scripts.",
        "Prefer the weakest valid plan that matches repository structure.",
        "Ignore transient/generated workspace content.",
      ],
    },
    repair: {
      objective: "Re-plan verification after harness/config-style failures so repair work targets the right root and commands.",
      constraints: [
        "Keep verification scope narrow and evidence-backed.",
      ],
    },
  },
  validation: {
    assertions: [
      "chosen cwd must be one of the discovered candidates or a configured override",
      "selected commands must come from configured verification commands",
      "missing/non-authoritative commands should be omitted rather than invented",
    ],
  },
  outputs: {
    fields: ["cwd", "commands", "rationale", "selectionSource", "evidence.commandDecisions"],
  },
};

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
    required: ["candidate package roots", "configured verification commands", "package manifests", "package script bodies", "dependency versions"],
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
        "Treat configured commands as intent; verify the selected cwd and package manager from candidate evidence.",
        "Adapt package-script commands to the selected package manager when the script exists in the chosen root.",
        "Do not select scripts marked stale by framework/version evidence; use a provided replacement command when available.",
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
      "selected commands must be valid for the selected cwd",
      "configured package-script commands may be adapted to an equivalent discovered package-manager command",
      "stale framework scripts such as Next.js 16 next lint must be rejected in favor of evidence-backed replacements",
      "missing/non-authoritative commands should be omitted rather than invented",
    ],
  },
  outputs: {
    fields: ["cwd", "commands", "rationale", "selectionSource", "evidence.commandDecisions"],
  },
};

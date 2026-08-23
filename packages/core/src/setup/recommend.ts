import type { RepositoryProfile, SetupRecommendation } from "./types.js";

export function recommendFromProfile(profile: RepositoryProfile): SetupRecommendation[] {
  const recommendations: SetupRecommendation[] = [];

  // Package manager — HIGH confidence, DISCOVERED.
  if (profile.packageManagers.length > 0) {
    recommendations.push({
      id: "runtime:package-manager",
      category: "RUNTIME",
      proposedValue: profile.packageManagers[0],
      confidence: "HIGH",
      reason: `Lockfile/manifests indicate ${profile.packageManagers.join(", ")}.`,
      origin: "DISCOVERED",
      requiresDecision: false,
    });
  }

  // Commands from package scripts — HIGH confidence, DISCOVERED.
  const commandMap: Array<[keyof RepositoryProfile["commands"], string]> = [
    ["test", "test"],
    ["lint", "lint"],
    ["typecheck", "typecheck"],
    ["build", "build"],
    ["install", "setup"],
  ];
  for (const [field, label] of commandMap) {
    const value = profile.commands[field];
    if (value) {
      recommendations.push({
        id: `verification:${field}`,
        category: "VERIFICATION",
        proposedValue: value,
        confidence: "HIGH",
        reason: `package.json defines the ${label} script.`,
        origin: "DISCOVERED",
        requiresDecision: false,
      });
    }
  }

  // Workflow preset — MEDIUM confidence, INFERRED.
  const workflowPreset = inferWorkflowPreset(profile);
  recommendations.push({
    id: "workflow:preset",
    category: "WORKFLOW",
    proposedValue: workflowPreset,
    confidence: "MEDIUM",
    reason: `Repository has ${describeRepoShape(profile)}.`,
    origin: "INFERRED",
    requiresDecision: true,
  });

  // Testing framework — MEDIUM, INFERRED.
  if (profile.testing.frameworks.length > 0) {
    recommendations.push({
      id: "verification:testing-framework",
      category: "VERIFICATION",
      proposedValue: profile.testing.frameworks,
      confidence: "MEDIUM",
      reason: `Testing files suggest ${profile.testing.frameworks.join(", ")}.`,
      origin: "INFERRED",
      requiresDecision: false,
    });
  }

  // Skills hints — LOW/MEDIUM, INFERRED.
  const skillHints = inferSkillHints(profile);
  if (skillHints.length > 0) {
    recommendations.push({
      id: "skill:suggestions",
      category: "SKILL",
      proposedValue: skillHints,
      confidence: "MEDIUM",
      reason: `Repository shape suggests these skills.`,
      origin: "INFERRED",
      requiresDecision: false,
    });
  }

  // Constitution refresh — MEDIUM, INFERRED.
  recommendations.push({
    id: "constitution:refresh",
    category: "CONSTITUTION",
    proposedValue: profile.factory.hasConstitutionMetadata ? "refresh" : "generate",
    confidence: "MEDIUM",
    reason: profile.factory.hasConstitutionMetadata
      ? "Constitution metadata exists; refresh keeps it current."
      : "No constitution metadata; generate one for repository truth.",
    origin: "INFERRED",
    requiresDecision: true,
  });

  return recommendations;
}

function inferWorkflowPreset(profile: RepositoryProfile): string {
  const complexity =
    (profile.testing.integration ? 1 : 0) +
    (profile.testing.e2e ? 1 : 0) +
    (profile.persistence.migrations ? 1 : 0) +
    (profile.ci.providers.length > 0 ? 1 : 0) +
    (profile.structure.monorepo ? 1 : 0);
  if (complexity >= 3) {
    return "safe";
  }
  if (complexity === 0 && profile.commands.test && !profile.testing.frameworks.length) {
    return "fast";
  }
  return "balanced";
}

function describeRepoShape(profile: RepositoryProfile): string {
  const parts: string[] = [];
  if (profile.languages.length > 0) parts.push(profile.languages.join("/"));
  if (profile.structure.monorepo) parts.push("monorepo");
  if (profile.ci.providers.length > 0) parts.push("CI");
  if (profile.persistence.migrations) parts.push("migrations");
  if (profile.testing.frameworks.length > 0) parts.push("tests");
  return parts.join(", ") || "minimal structure";
}

function inferSkillHints(profile: RepositoryProfile): string[] {
  const hints: string[] = [];
  if (profile.languages.includes("TypeScript") || profile.languages.includes("JavaScript")) {
    hints.push("typescript-development");
  }
  if (profile.frameworks.some((f) => /vite|next/.test(f))) {
    hints.push("frontend-development");
  }
  if (profile.persistence.technologies.includes("prisma") || profile.persistence.migrations) {
    hints.push("prisma-migrations");
  }
  if (profile.testing.frameworks.length > 0) {
    hints.push(`${profile.testing.frameworks[0]}-testing`);
  }
  return hints;
}

// Skill resolution + repo signal helpers — extracted from controller.ts.
// resolveFactorySkills/applyWorkflowSkillPolicy, repo dependency/framework
// inference, and goal slugging.

import { discoverConstitutionRepository } from "../constitution/discovery.js";
import type { SkillBundleSelection, SkillCandidate } from "../skills/index.js";
import { getFactorySkill, resolveFactorySkills } from "../skills/index.js";
import type { WorkflowStage } from "@factory/schemas";
import type { PlannerTask } from "./planner.js";
import fs from "node:fs/promises";
import path from "node:path";

export function applyWorkflowSkillPolicy(
  bundle: SkillBundleSelection,
  policy: PlannerTask["skills"],
): { ok: true; bundle: SkillBundleSelection } | { ok: false; missingRequired: string[] } {
  const resolved = resolveNodeSkillBundle(bundle, policy);
  if (!resolved.ok) {
    return resolved;
  }
  return {
    ok: true,
    bundle: {
      ...bundle,
      selected: resolved.selected,
    },
  };
}

export function resolveNodeSkillBundle(
  roleBundle: SkillBundleSelection | undefined,
  policy: PlannerTask["skills"],
): { ok: true; selected: SkillCandidate[] } | { ok: false; missingRequired: string[] } {
  const excluded = new Set(policy?.exclude ?? []);
  const selected = new Map<string, SkillCandidate>();
  const missingRequired: string[] = [];

  for (const id of policy?.require ?? []) {
    const explicit = explicitSkillCandidate(id, "Required by workflow stage.");
    if (!explicit) {
      missingRequired.push(id);
      continue;
    }
    if (!excluded.has(id)) {
      selected.set(id, explicit);
    }
  }

  if (missingRequired.length > 0) {
    return { ok: false, missingRequired };
  }

  for (const id of policy?.prefer ?? []) {
    const explicit = explicitSkillCandidate(id, "Preferred by workflow stage.");
    if (explicit && !excluded.has(id)) {
      selected.set(id, explicit);
    }
  }

  for (const item of roleBundle?.selected ?? []) {
    if (!excluded.has(item.skill.id) && !selected.has(item.skill.id)) {
      selected.set(item.skill.id, item);
    }
  }

  return { ok: true, selected: [...selected.values()] };
}

export function explicitSkillCandidate(id: string, reason: string): SkillCandidate | undefined {
  const skill = getFactorySkill(id);
  if (!skill) {
    return undefined;
  }
  return {
    skill,
    score: 100,
    reasons: [reason],
    scores: {},
    provides: skill.provides?.capabilities ?? [],
  };
}

export function summarizeSkillBundle(bundle: SkillBundleSelection): Record<string, unknown> {
  return {
    selected: bundle.selected.map((item) => ({
      id: item.skill.id,
      version: item.skill.version,
      provides: item.provides,
      reasons: item.reasons,
      score: item.score,
    })),
    rejected: bundle.rejected.map((item) => ({
      id: item.skill.id,
      version: item.skill.version,
      rejectedReason: item.rejectedReason,
      score: item.score,
    })),
    capabilityCoverage: bundle.capabilityCoverage,
    confidence: bundle.confidence,
  };
}

export async function collectRuntimeSkillSignals(projectRoot: string): Promise<{
  languages: string[];
  dependencies: string[];
  frameworks: string[];
  constitutionAreas: number[];
}> {
  try {
    const discovery = await discoverConstitutionRepository(projectRoot);
    const dependencies = await readRepositoryDependencies(projectRoot, discovery.manifests);
    const frameworks = inferFrameworksFromDependencies(dependencies);
    return {
      languages: discovery.languages,
      dependencies,
      frameworks,
      constitutionAreas: inferRelevantConstitutionAreas(discovery),
    };
  } catch {
    return {
      languages: [],
      dependencies: [],
      frameworks: [],
      constitutionAreas: [],
    };
  }
}

export async function readRepositoryDependencies(projectRoot: string, manifests: string[]): Promise<string[]> {
  const deps = new Set<string>();
  for (const manifest of manifests.filter((file) => /(^|\/)package\.json$/i.test(file)).slice(0, 8)) {
    try {
      const raw = await fs.readFile(path.join(projectRoot, manifest), "utf8");
      const parsed = JSON.parse(raw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      for (const name of Object.keys(parsed.dependencies ?? {})) {
        deps.add(name);
      }
      for (const name of Object.keys(parsed.devDependencies ?? {})) {
        deps.add(name);
      }
    } catch {
      // ignore malformed manifests while collecting broad skill signals
    }
  }
  return [...deps].sort();
}

export function inferFrameworksFromDependencies(dependencies: string[]): string[] {
  const lower = new Set(dependencies.map((value) => value.toLowerCase()));
  const frameworks: string[] = [];
  if (lower.has("next")) frameworks.push("next");
  if (lower.has("react")) frameworks.push("react");
  if (lower.has("fastify")) frameworks.push("fastify");
  if (lower.has("express")) frameworks.push("express");
  if (lower.has("vitest")) frameworks.push("vitest");
  if (lower.has("jest")) frameworks.push("jest");
  if (lower.has("prisma") || lower.has("@prisma/client")) frameworks.push("prisma");
  if (lower.has("zod")) frameworks.push("zod");
  return frameworks;
}

export function inferRelevantConstitutionAreas(discovery: { languages: string[]; commands: Record<string, string>; testFiles: string[]; sourceFiles: string[] }): number[] {
  const areas = new Set<number>([1, 2, 3, 18]);
  if (discovery.sourceFiles.length > 0) {
    areas.add(40);
  }
  if (Object.keys(discovery.commands).length > 0) {
    areas.add(73);
  }
  if (discovery.testFiles.length > 0) {
    areas.add(76);
  }
  if (discovery.languages.some((language) => /typescript|javascript/i.test(language))) {
    areas.add(43);
    areas.add(45);
  }
  return [...areas].sort((a, b) => a - b);
}

export function slugifyGoal(goal: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "factory-run";
}


import type { SkillContract } from "@factory/schemas";
import type {
  SkillBundleSelection,
  SkillCandidate,
  SkillSelectionContext,
  SkillSelectionResult,
  SkillSelectionScores,
} from "./types.js";

const skillRegistry = new Map<string, SkillContract>();

export function registerFactorySkill(skill: SkillContract): void {
  skillRegistry.set(skill.id, skill);
}

export function clearFactorySkillRegistry(): void {
  skillRegistry.clear();
}

export function listFactorySkills(): SkillContract[] {
  return [...skillRegistry.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function findFactorySkills(context: SkillSelectionContext): SkillSelectionResult[] {
  return buildCandidates(context).map(({ provides, ...candidate }) => candidate);
}

export function resolveFactorySkills(context: SkillSelectionContext): SkillBundleSelection {
  const candidates = buildCandidates(context);
  const required = dedupe(context.requiredCapabilities ?? []);
  const selected: SkillCandidate[] = [];
  const rejected: Array<SkillCandidate & { rejectedReason: string }> = [];
  const covered = new Set<string>();
  const usedExclusiveGroups = new Set<string>();
  const selectedIds = new Set<string>();

  const working = [...candidates];
  while (working.length > 0) {
    const next = pickBestCandidate(working, covered, usedExclusiveGroups, selectedIds, required);
    if (!next) {
      break;
    }
    selected.push(next);
    selectedIds.add(next.skill.id);
    if (next.skill.exclusiveGroup) {
      usedExclusiveGroups.add(next.skill.exclusiveGroup);
    }
    for (const capability of next.provides) {
      covered.add(capability);
    }
    removeCandidate(working, next.skill.id);
  }

  for (const candidate of candidates) {
    if (selectedIds.has(candidate.skill.id)) {
      continue;
    }
    rejected.push({
      ...candidate,
      rejectedReason: classifyRejection(candidate, selected, required),
    });
  }

  const coveredList = required.length > 0
    ? required.filter((capability) => covered.has(capability))
    : dedupe(selected.flatMap((candidate) => candidate.provides));
  const missing = required.filter((capability) => !covered.has(capability));
  const confidence = required.length === 0
    ? Math.min(1, selected.length > 0 ? selected[0]!.score / 20 : 0)
    : coveredList.length / required.length;

  return {
    selected,
    rejected: rejected.sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id)),
    capabilityCoverage: {
      required,
      covered: coveredList,
      missing,
    },
    confidence,
  };
}

function buildCandidates(context: SkillSelectionContext): SkillCandidate[] {
  return listFactorySkills()
    .flatMap((skill) => {
      const eligibility = evaluateEligibility(skill, context);
      if (!eligibility.allowed) {
        return [];
      }
      const scored = scoreSkill(skill, context);
      if (scored.score <= 0) {
        return [];
      }
      return [{
        skill,
        score: scored.score,
        reasons: [...eligibility.reasons, ...scored.reasons],
        scores: scored.scores,
        provides: dedupe(skill.provides?.capabilities ?? []),
      } satisfies SkillCandidate];
    })
    .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id));
}

function evaluateEligibility(skill: SkillContract, context: SkillSelectionContext): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const applicability = skill.applicability;

  if (applicability?.stages?.length && !applicability.stages.includes(context.stage)) {
    return { allowed: false, reasons: [`Does not support ${context.stage} stage.`] };
  }
  if (applicability?.languages?.length && !matchesAny(applicability.languages, context.languages)) {
    return { allowed: false, reasons: ["Repository language requirements do not match."] };
  }
  if (applicability?.frameworks?.length && !matchesAny(applicability.frameworks, context.frameworks)) {
    return { allowed: false, reasons: ["Repository framework requirements do not match."] };
  }
  if (!matchesDependencyRules(skill.dependencies, context.dependencies)) {
    return { allowed: false, reasons: ["Repository dependency requirements do not match."] };
  }
  if (skill.permissions?.allowedTools?.length && !containsAll(context.availableTools, skill.permissions.allowedTools)) {
    return { allowed: false, reasons: ["Required tools are not available."] };
  }

  reasons.push(`Eligible for ${context.stage} stage.`);
  return { allowed: true, reasons };
}

function scoreSkill(skill: SkillContract, context: SkillSelectionContext): {
  score: number;
  reasons: string[];
  scores: SkillSelectionScores;
} {
  const reasons: string[] = [];
  const applicability = skill.applicability;
  const provides = dedupe(skill.provides?.capabilities ?? []);

  const scores: SkillSelectionScores = {
    semantic: scoreGoalSemantics(skill, context.goal),
    repository: scoreRepositoryMatch(skill, context),
    files: scoreFileMatch(skill, context.affectedFiles),
    constitution: scoreConstitutionMatch(skill, context.constitutionAreas),
    historical: 0,
    stage: applicability?.stages?.includes(context.stage) ? 1 : 0,
    capabilities: scoreCapabilityMatch(provides, context.requiredCapabilities),
  };

  const score =
    0.3 * scores.semantic +
    0.2 * scores.repository +
    0.15 * scores.files +
    0.15 * scores.constitution +
    0.1 * scores.stage +
    0.1 * scores.historical +
    0.2 * scores.capabilities;

  if (scores.stage > 0) {
    reasons.push(`Supports ${context.stage} stage.`);
  }
  if (scores.repository > 0) {
    reasons.push("Repository technology matched.");
  }
  if (scores.files > 0) {
    reasons.push("Affected-file patterns matched.");
  }
  if (scores.constitution > 0) {
    reasons.push("Constitution areas matched.");
  }
  if (scores.capabilities > 0) {
    reasons.push("Required capabilities matched.");
  }
  if (scores.semantic > 0) {
    reasons.push("Goal/task semantics matched.");
  }
  if (reasons.length === 0) {
    reasons.push("Fallback candidate with no strong signal match.");
  }

  return {
    score,
    reasons,
    scores,
  };
}

function scoreGoalSemantics(skill: SkillContract, goal: string): number {
  const tokens = tokenize(goal);
  const signals = [
    skill.id,
    skill.description,
    ...(skill.taskTypes ?? []),
    ...(skill.applicability?.taskKinds ?? []),
    ...(skill.provides?.capabilities ?? []),
  ].flatMap((value) => [...tokenize(value)]);
  if (tokens.size === 0 || signals.length === 0) {
    return 0;
  }
  let hits = 0;
  for (const token of signals) {
    if (tokens.has(token)) {
      hits += 1;
    }
  }
  return clamp01(hits / Math.max(1, tokens.size));
}

function scoreRepositoryMatch(skill: SkillContract, context: SkillSelectionContext): number {
  const languageScore = ratioMatch(skill.applicability?.languages, context.languages);
  const frameworkScore = ratioMatch(skill.applicability?.frameworks, context.frameworks);
  const dependencyScore = ratioMatch(skill.applicability?.dependencies, context.dependencies);
  return clamp01(languageScore * 0.4 + frameworkScore * 0.3 + dependencyScore * 0.3);
}

function scoreFileMatch(skill: SkillContract, affectedFiles: string[] | undefined): number {
  if (!skill.filePatterns?.length || !affectedFiles?.length) {
    return 0;
  }
  let hits = 0;
  for (const file of affectedFiles) {
    if (skill.filePatterns.some((pattern) => matchesFilePattern(pattern, file))) {
      hits += 1;
    }
  }
  return clamp01(hits / affectedFiles.length);
}

function scoreConstitutionMatch(skill: SkillContract, constitutionAreas: number[] | undefined): number {
  const areas = skill.constitutionDependencies?.length ? skill.constitutionDependencies : skill.applicability?.constitutionAreas;
  if (!areas?.length || !constitutionAreas?.length) {
    return 0;
  }
  const set = new Set(constitutionAreas);
  return clamp01(areas.filter((value) => set.has(value)).length / areas.length);
}

function scoreCapabilityMatch(provides: string[], requiredCapabilities: string[] | undefined): number {
  if (provides.length === 0 || !requiredCapabilities?.length) {
    return 0;
  }
  const required = new Set(requiredCapabilities.map((value) => value.toLowerCase()));
  const matches = provides.filter((value) => required.has(value.toLowerCase())).length;
  return clamp01(matches / required.size);
}

function pickBestCandidate(
  candidates: SkillCandidate[],
  covered: Set<string>,
  usedExclusiveGroups: Set<string>,
  selectedIds: Set<string>,
  required: string[],
): SkillCandidate | undefined {
  let best: SkillCandidate | undefined;
  let bestUtility = -1;

  for (const candidate of candidates) {
    if (selectedIds.has(candidate.skill.id)) {
      continue;
    }
    if (candidate.skill.exclusiveGroup && usedExclusiveGroups.has(candidate.skill.exclusiveGroup)) {
      continue;
    }
    if (hasConflict(candidate.skill, selectedIds, candidates)) {
      continue;
    }

    const uncoveredGain = required.length > 0
      ? candidate.provides.filter((capability) => required.includes(capability) && !covered.has(capability)).length
      : Math.max(1, candidate.provides.length);
    const specificity = candidate.provides.length > 0 ? 1 / candidate.provides.length : 0.25;
    const utility = uncoveredGain * 10 + candidate.score + specificity;
    if (uncoveredGain <= 0 && required.length > 0) {
      continue;
    }
    if (utility > bestUtility) {
      best = candidate;
      bestUtility = utility;
    }
  }

  return best;
}

function hasConflict(skill: SkillContract, selectedIds: Set<string>, candidates: SkillCandidate[]): boolean {
  const conflicts = new Set(skill.conflictsWith ?? []);
  if (conflicts.size === 0) {
    return false;
  }
  for (const selectedId of selectedIds) {
    if (conflicts.has(selectedId)) {
      return true;
    }
    const selectedSkill = candidates.find((candidate) => candidate.skill.id === selectedId)?.skill;
    if (selectedSkill?.conflictsWith?.includes(skill.id)) {
      return true;
    }
  }
  return false;
}

function classifyRejection(candidate: SkillCandidate, selected: SkillCandidate[], required: string[]): string {
  if (candidate.skill.exclusiveGroup && selected.some((item) => item.skill.exclusiveGroup === candidate.skill.exclusiveGroup)) {
    return `Rejected because another skill in exclusive group '${candidate.skill.exclusiveGroup}' ranked higher.`;
  }
  if (candidate.skill.conflictsWith?.some((id) => selected.some((item) => item.skill.id === id))) {
    return "Rejected because it conflicts with a selected skill.";
  }
  if (required.length > 0 && candidate.provides.every((capability) => !required.includes(capability))) {
    return "Rejected because it did not provide a required capability.";
  }
  return "Rejected because a smaller or higher-confidence bundle covered the required capabilities.";
}

function removeCandidate(candidates: SkillCandidate[], skillId: string): void {
  const index = candidates.findIndex((candidate) => candidate.skill.id === skillId);
  if (index >= 0) {
    candidates.splice(index, 1);
  }
}

function matchesDependencyRules(rules: SkillContract["dependencies"], actual: string[] | undefined): boolean {
  if (!rules) {
    return true;
  }
  const lower = new Set((actual ?? []).map((value) => value.toLowerCase()));
  if (rules.all?.length && !rules.all.every((value) => lower.has(value.toLowerCase()))) {
    return false;
  }
  if (rules.any?.length && !rules.any.some((value) => lower.has(value.toLowerCase()))) {
    return false;
  }
  return true;
}

function containsAll(actual: string[] | undefined, expected: string[]): boolean {
  if (!expected.length) {
    return true;
  }
  const lower = new Set((actual ?? []).map((value) => value.toLowerCase()));
  return expected.every((value) => lower.has(value.toLowerCase()));
}

function matchesAny(expected: string[] | undefined, actual: string[] | undefined): boolean {
  if (!expected?.length || !actual?.length) {
    return false;
  }
  const lower = new Set(actual.map((value) => value.toLowerCase()));
  return expected.some((value) => lower.has(value.toLowerCase()));
}

function ratioMatch(expected: string[] | undefined, actual: string[] | undefined): number {
  if (!expected?.length || !actual?.length) {
    return 0;
  }
  const lower = new Set(actual.map((value) => value.toLowerCase()));
  const matches = expected.filter((value) => lower.has(value.toLowerCase())).length;
  return clamp01(matches / expected.length);
}

function matchesFilePattern(pattern: string, file: string): boolean {
  const normalizedPattern = pattern.replace(/\\/g, "/").toLowerCase();
  const normalizedFile = file.replace(/\\/g, "/").toLowerCase();
  if (normalizedPattern.endsWith("/**")) {
    return normalizedFile.startsWith(normalizedPattern.slice(0, -3));
  }
  if (normalizedPattern.startsWith("**/*.")) {
    return normalizedFile.endsWith(normalizedPattern.slice(4));
  }
  return normalizedFile === normalizedPattern || normalizedFile.startsWith(`${normalizedPattern}/`);
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3),
  );
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

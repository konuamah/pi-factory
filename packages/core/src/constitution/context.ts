import fs from "node:fs/promises";
import path from "node:path";

export interface ProjectGuidanceContext {
  text?: string;
  instructionFiles: string[];
  instructionDetails: Array<{
    path: string;
    score: number;
    reason: string;
  }>;
  hasConstitution: boolean;
  usedConstitution: boolean;
  approxChars: number;
}

export async function selectConstitutionContext(input: {
  cwd: string;
  role: "planner" | "builder" | "reviewer" | "repair";
  goal: string;
}): Promise<ProjectGuidanceContext> {
  const policy = guidancePolicyForRole(input.role);
  const selectedInstructions = await readProjectInstructionFiles(input.cwd, input.goal, policy.maxInstructionFiles, policy.maxInstructionFileChars);
  const instructionFiles = selectedInstructions.map((item) => item.path);
  const totalInstructionChars = instructionFiles.reduce((sum, file) => sum + (readCache.get(file)?.length ?? 0), 0);

  const constitutionPath = path.join(input.cwd, "CONSTITUTION.md");
  const text = await readIfExists(constitutionPath);
  const summary = text ? extractSection(text, "## Agent Operating Summary", "## Interpretation") : undefined;
  const projectSnapshot = text ? extractSection(text, "## Project Snapshot", "## Status Legend") : undefined;
  const fullBody = text ? extractSection(text, "# Observable Facts") : undefined;

  const relevant = [
    findArea(fullBody, /Repository layout/i),
    findArea(fullBody, /Monorepo \/ single-project model/i),
    findArea(fullBody, /Package management/i),
    findArea(fullBody, /Testing approach/i),
    findArea(fullBody, /CI\/CD/i),
    findArea(fullBody, /Commands/i),
  ].filter(Boolean);

  const shouldUseConstitution = shouldIncludeConstitution(input.role, instructionFiles.length, totalInstructionChars);
  const sections = [
    roleSection(buildRoleHint(input.role, input.goal)),
    roleSection(buildRoleRules(input.role)),
    instructionFiles.length > 0
      ? roleSection(
          `Project instruction files:\n${instructionFiles.map((file) => `${file}:\n${truncate(readCache.get(file) ?? "", policy.maxInstructionFileChars)}`).join("\n\n")}`,
        )
      : undefined,
    instructionFiles.length > 0
      ? roleSection("If these instruction files reference additional repo-local guidance, read those referenced files before acting.")
      : undefined,
    shouldUseConstitution && summary
      ? roleSection(`Constitution summary:\n${truncate(summary, policy.maxConstitutionChars)}`)
      : undefined,
    input.role === "planner" && projectSnapshot
      ? roleSection(`Project Snapshot:\n${truncate(projectSnapshot, 500)}`)
      : undefined,
    relevant.length > 0
      ? roleSection(`Relevant Constitution Areas:\n${truncate(relevant.join("\n\n"), policy.maxRelevantAreaChars)}`)
      : undefined,
  ].filter((value): value is string => Boolean(value));

  const compact = fitSectionsWithinBudget(sections, policy.totalChars);
  const joined = compact.join("\n\n").trim();

  return {
    text: joined || undefined,
    instructionFiles,
    instructionDetails: selectedInstructions,
    hasConstitution: Boolean(text),
    usedConstitution: Boolean(shouldUseConstitution && summary && joined.includes("Constitution summary:")),
    approxChars: joined.length,
  };
}

function buildRoleHint(role: "planner" | "builder" | "reviewer" | "repair", goal: string): string {
  switch (role) {
    case "planner":
      return `Use the repository guidance to plan work for: ${goal}`;
    case "builder":
      return `Use the repository guidance while implementing: ${goal}`;
    case "reviewer":
      return `Use the repository guidance while reviewing work for: ${goal}`;
    case "repair":
      return `Use the repository guidance while repairing verification failures for: ${goal}`;
  }
}

function buildRoleRules(role: "planner" | "builder" | "reviewer" | "repair"): string {
  switch (role) {
    case "planner":
      return [
        "Role rules:",
        "- Produce architecture and execution guidance only; do not implement code.",
        "- Prefer broad repo structure, constraints, and approval-safe planning.",
        "- Do not broaden scope beyond the requested outcome.",
      ].join("\n");
    case "builder":
      return [
        "Role rules:",
        "- Keep changes tightly scoped to the requested task.",
        "- Do not rewrite unrelated docs or adjacent files unless required by the task.",
        "- Do not perform verification-stage content edits unless necessary to complete the build task safely.",
      ].join("\n");
    case "reviewer":
      return [
        "Role rules:",
        "- Focus on acceptance, consistency, risk, and scope control.",
        "- Flag unrelated edits, stale docs, missing verification, and deviations from instructions.",
      ].join("\n");
    case "repair":
      return [
        "Role rules:",
        "- Focus only on the concrete verification failures.",
        "- Minimize changes and avoid opportunistic refactors or unrelated doc rewrites.",
      ].join("\n");
  }
}

function guidancePolicyForRole(role: "planner" | "builder" | "reviewer" | "repair"): {
  maxInstructionFiles: number;
  maxInstructionFileChars: number;
  maxConstitutionChars: number;
  maxRelevantAreaChars: number;
  totalChars: number;
} {
  switch (role) {
    case "planner":
      return { maxInstructionFiles: 4, maxInstructionFileChars: 1400, maxConstitutionChars: 900, maxRelevantAreaChars: 1200, totalChars: 5200 };
    case "reviewer":
      return { maxInstructionFiles: 3, maxInstructionFileChars: 1200, maxConstitutionChars: 700, maxRelevantAreaChars: 900, totalChars: 3600 };
    case "builder":
      return { maxInstructionFiles: 2, maxInstructionFileChars: 1000, maxConstitutionChars: 500, maxRelevantAreaChars: 700, totalChars: 2600 };
    case "repair":
      return { maxInstructionFiles: 2, maxInstructionFileChars: 900, maxConstitutionChars: 450, maxRelevantAreaChars: 700, totalChars: 2400 };
  }
}

function shouldIncludeConstitution(
  role: "planner" | "builder" | "reviewer" | "repair",
  instructionFileCount: number,
  totalInstructionChars: number,
): boolean {
  if (role === "builder" || role === "repair") {
    return instructionFileCount === 0;
  }
  if (role === "reviewer") {
    return instructionFileCount === 0 || totalInstructionChars < 1600;
  }
  return totalInstructionChars < 2800;
}

function roleSection(value: string): string {
  return value.trim();
}

function fitSectionsWithinBudget(sections: string[], maxChars: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const section of sections) {
    const nextCost = section.length + (kept.length > 0 ? 2 : 0);
    if (used + nextCost <= maxChars) {
      kept.push(section);
      used += nextCost;
      continue;
    }
    const remaining = maxChars - used - (kept.length > 0 ? 2 : 0);
    if (remaining > 80) {
      kept.push(truncate(section, remaining));
    }
    break;
  }
  return kept;
}

function extractSection(text: string, startHeading: string, endHeading?: string): string | undefined {
  const start = text.indexOf(startHeading);
  if (start < 0) {
    return undefined;
  }
  const from = start + startHeading.length;
  const end = endHeading ? text.indexOf(endHeading, from) : -1;
  const sliced = (end >= 0 ? text.slice(start, end) : text.slice(start)).trim();
  return sliced || undefined;
}

function findArea(body: string | undefined, title: RegExp): string | undefined {
  if (!body) {
    return undefined;
  }
  const lines = body.split(/\r?\n/);
  const blocks: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (/^##\s+\d+\./.test(line)) {
      if (current.length > 0) {
        blocks.push(current.join("\n"));
      }
      current = [line];
      continue;
    }
    if (current.length > 0) {
      current.push(line);
    }
  }
  if (current.length > 0) {
    blocks.push(current.join("\n"));
  }

  return blocks.find((block) => title.test(block));
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

const readCache = new Map<string, string>();

async function readProjectInstructionFiles(
  cwd: string,
  goal: string,
  maxInstructionFiles: number,
  maxInstructionFileChars: number,
): Promise<Array<{ path: string; score: number; reason: string }>> {
  readCache.clear();
  const discovered = await discoverInstructionCandidates(cwd);
  const goalTokens = tokenize(goal);

  const ranked = discovered
    .map((filePath) => ({
      filePath,
      score: scoreInstructionFile(filePath, goalTokens),
    }))
    .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath));

  const selected: Array<{ path: string; score: number; reason: string }> = [];
  const seen = new Set<string>();

  for (const entry of ranked) {
    const normalized = entry.filePath.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    const fullPath = path.join(cwd, entry.filePath);
    const text = await readIfExists(fullPath);
    if (!text) {
      continue;
    }
    readCache.set(entry.filePath, truncate(text.trim(), maxInstructionFileChars));
    selected.push({ path: entry.filePath, score: entry.score, reason: describeInstructionReason(entry.filePath, goalTokens) });
    if (selected.length >= maxInstructionFiles) {
      break;
    }
  }

  return selected;
}

function describeInstructionReason(filePath: string, goalTokens: Set<string>): string {
  const normalized = filePath.toLowerCase();
  const segments = normalized.split("/").slice(0, -1);
  const matched = segments.filter((segment) => goalTokens.has(segment) || [...goalTokens].some((token) => token.length >= 4 && segment.includes(token)));
  if (matched.length > 0) {
    return `matched goal-relevant path segment(s): ${matched.join(", ")}`;
  }
  return segments.length > 0 ? "selected nested repo-local guidance" : "selected root repo guidance";
}

async function discoverInstructionCandidates(cwd: string): Promise<string[]> {
  const results: string[] = [];
  await walkInstructionFiles(cwd, cwd, results);
  return results;
}

async function walkInstructionFiles(root: string, current: string, results: string[]): Promise<void> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    const relativePath = path.relative(root, fullPath).replace(/\\/g, "/");
    if (shouldSkip(relativePath)) {
      continue;
    }
    if (entry.isDirectory()) {
      await walkInstructionFiles(root, fullPath, results);
      continue;
    }
    if (/(^|\/)(AGENTS\.md|CLAUDE\.md|\.claude\.md)$/i.test(relativePath)) {
      results.push(relativePath);
    }
  }
}

function shouldSkip(relativePath: string): boolean {
  return relativePath.split("/").some((segment) =>
    [".git", "node_modules", ".factory", ".worktrees", "worktrees", "dist", "build", "coverage", ".next"].includes(segment),
  );
}

function scoreInstructionFile(filePath: string, goalTokens: Set<string>): number {
  const normalized = filePath.toLowerCase();
  const segments = normalized.split("/");
  const depth = segments.length - 1;
  let score = normalized.includes("/") ? 50 : 10;
  for (const segment of segments.slice(0, -1)) {
    if (goalTokens.has(segment)) {
      score += 100;
    }
    for (const token of goalTokens) {
      if (token.length >= 4 && segment.includes(token)) {
        score += 25;
      }
    }
  }
  return score + depth;
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3),
  );
}

async function readIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

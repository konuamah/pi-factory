// Verification cwd/detection helpers — extracted from verification.ts.

import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { VerificationCwdCandidate, VerificationEvidence, VerificationCwdResolution } from "./verification.js";
import { pathExists } from "./fs-utils.js";
import { resolveFactorySkills } from "../skills/index.js";

export async function resolveVerificationCwd(
  executionCwd: string,
  configuredCwd?: string,
): Promise<{ cwd: string; resolution: VerificationCwdResolution }> {
  if (typeof configuredCwd === "string" && configuredCwd.trim()) {
    return {
      cwd: path.resolve(executionCwd, configuredCwd),
      resolution: "configured",
    };
  }

  if ((await detectEcosystemMarkers(executionCwd)).length > 0) {
    return {
      cwd: executionCwd,
      resolution: "root-package",
    };
  }

  const nestedProjectRoots = await findNestedProjectRoots(executionCwd, 3);
  if (nestedProjectRoots.length === 1) {
    return {
      cwd: nestedProjectRoots[0]!,
      resolution: "inferred-single-package",
    };
  }

  return {
    cwd: executionCwd,
    resolution: "default-root",
  };
}

export async function findNestedProjectRoots(root: string, maxDepth: number): Promise<string[]> {
  const results: string[] = [];
  await walk(root, 0);
  return results.sort();

  async function walk(current: string, depth: number): Promise<void> {
    if (depth > maxDepth) {
      return;
    }

    if (depth > 0 && (await detectEcosystemMarkers(current)).length > 0) {
      results.push(current);
      return;
    }

    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (shouldSkipDirectory(entry.name)) {
        continue;
      }
      await walk(path.join(current, entry.name), depth + 1);
    }
  }
}

export async function readPackageScripts(targetCwd: string): Promise<string[]> {
  const pkg = await readPackageJson(targetCwd);
  return Object.keys(readPackageScriptCommands(pkg)).sort();
}

export function readPackageScriptCommands(packageJson: Record<string, unknown> | undefined): Record<string, string> {
  const rawScripts = packageJson?.scripts;
  if (!rawScripts || typeof rawScripts !== "object" || Array.isArray(rawScripts)) {
    return {};
  }
  const scripts: Record<string, string> = {};
  for (const [name, command] of Object.entries(rawScripts)) {
    if (typeof command === "string" && command.trim()) {
      scripts[name] = command.trim();
    }
  }
  return scripts;
}

export function readPackageDependencyVersions(packageJson: Record<string, unknown> | undefined): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = packageJson?.[section];
    if (!deps || typeof deps !== "object" || Array.isArray(deps)) {
      continue;
    }
    for (const [name, version] of Object.entries(deps)) {
      if (typeof version === "string" && version.trim()) {
        versions[name] = version.trim();
      }
    }
  }
  return versions;
}

export async function detectEcosystemMarkers(targetCwd: string): Promise<string[]> {
  const markers = [
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "pyproject.toml",
    "requirements.txt",
    "setup.py",
    "Cargo.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "gradlew",
    "docker-compose.yml",
    "docker-compose.yaml",
    "Dockerfile",
  ];
  const found: string[] = [];
  for (const marker of markers) {
    if (await pathExists(path.join(targetCwd, marker))) {
      found.push(marker);
    }
  }
  return found;
}

export async function detectDependencyMarkers(targetCwd: string): Promise<string[]> {
  const markers = ["node_modules", ".venv", "venv", "vendor", "target", ".gradle", "build"];
  const found: string[] = [];
  for (const marker of markers) {
    if (await pathExists(path.join(targetCwd, marker))) {
      found.push(marker);
    }
  }
  return found;
}

export function expectedDependencyMarkers(ecosystemMarkers: string[]): string[] {
  const expected: string[] = [];
  if (ecosystemMarkers.includes("package.json")) {
    expected.push("node_modules");
  }
  if (
    ecosystemMarkers.includes("pyproject.toml")
    || ecosystemMarkers.includes("requirements.txt")
    || ecosystemMarkers.includes("setup.py")
  ) {
    expected.push(".venv");
  }
  return expected;
}

const ECOSYSTEM_COMMANDS: Record<string, string[]> = {
  "requirements.txt": ["python -m pip install -r requirements.txt", "pip install -r requirements.txt", "python -m pytest", "pytest"],
  "pyproject.toml": ["python -m pip install -e .", "pip install -e .", "python -m pytest", "pytest"],
  "setup.py": ["python -m pip install -e .", "pip install -e .", "python -m pytest", "pytest"],
  "Cargo.toml": ["cargo check", "cargo test", "cargo build"],
  "go.mod": ["go test ./...", "go vet ./...", "go build ./..."],
  "pom.xml": ["mvn test", "mvn verify", "mvn package"],
  "gradlew": ["./gradlew test", "./gradlew build"],
  "build.gradle": ["gradle test", "gradle build"],
  "build.gradle.kts": ["gradle test", "gradle build"],
};

export async function discoverAllowedCommands(
  targetCwd: string,
  scripts: string[],
  ecosystemMarkers: string[],
  scriptCommands: Record<string, string>,
  dependencyVersions: Record<string, string>,
  detectedPackageManager?: "npm" | "pnpm" | "yarn",
  staleScripts: VerificationCwdCandidate["staleScripts"] = [],
): Promise<string[]> {
  const commands: string[] = [];
  const packageManager = detectedPackageManager ?? await detectPackageManager(targetCwd);
  const staleScriptNames = new Set(staleScripts.map((script) => script.script));

  for (const script of scripts) {
    if (staleScriptNames.has(script)) {
      continue;
    }
    commands.push(`${packageManager} run ${script}`);
  }
  if (scripts.includes("test")) {
    commands.push(`${packageManager} test`);
  }

  if (ecosystemMarkers.includes("package.json")) {
    if (scripts.includes("install:all")) {
      commands.push(`${packageManager} run install:all`);
    }
    if (scripts.includes("setup")) {
      commands.push(`${packageManager} run setup`);
    }
    commands.push(...staleScripts.map((script) => script.replacementCommand).filter((command): command is string => Boolean(command)));
    if (isDependencyPresent(dependencyVersions, "eslint") && !staleScripts.some((script) => script.replacementCommand)) {
      commands.push(`${packageManager} exec eslint src`);
    }
    if (await hasAnyLockfile(targetCwd)) {
      commands.push(packageManager === "npm" && await pathExists(path.join(targetCwd, "package-lock.json")) ? "npm ci" : `${packageManager} install`);
      commands.push(`${packageManager} install`);
    }
  }

  for (const marker of ecosystemMarkers) {
    const markerCommands = ECOSYSTEM_COMMANDS[marker];
    if (markerCommands) {
      commands.push(...markerCommands);
    }
  }

  return uniqueStrings(commands);
}

export function detectStalePackageScripts(
  scriptCommands: Record<string, string>,
  dependencyVersions: Record<string, string>,
  packageManager: "npm" | "pnpm" | "yarn",
): VerificationCwdCandidate["staleScripts"] {
  const staleScripts: VerificationCwdCandidate["staleScripts"] = [];
  const nextMajor = parseMajorVersion(dependencyVersions.next);
  const lintScript = scriptCommands.lint;
  if (lintScript && nextMajor !== undefined && nextMajor >= 16 && /^next\s+lint(?:\s|$)/i.test(lintScript)) {
    staleScripts.push({
      script: "lint",
      command: lintScript,
      reason: "Next.js 16 removed the next lint command; use ESLint directly.",
      replacementCommand: isDependencyPresent(dependencyVersions, "eslint") ? `${packageManager} exec eslint src` : undefined,
    });
  }
  return staleScripts;
}

export function parseMajorVersion(version: string | undefined): number | undefined {
  if (!version) return undefined;
  const match = version.match(/(\d+)/);
  if (!match) return undefined;
  const major = Number.parseInt(match[1], 10);
  return Number.isFinite(major) ? major : undefined;
}

export function isDependencyPresent(dependencyVersions: Record<string, string>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(dependencyVersions, name);
}

export async function detectPackageManager(root: string): Promise<"npm" | "pnpm" | "yarn"> {
  if (await pathExists(path.join(root, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (await pathExists(path.join(root, "yarn.lock"))) {
    return "yarn";
  }
  return "npm";
}

export async function hasAnyLockfile(root: string): Promise<boolean> {
  return (await pathExists(path.join(root, "package-lock.json")))
    || (await pathExists(path.join(root, "pnpm-lock.yaml")))
    || (await pathExists(path.join(root, "yarn.lock")));
}

export function isSetupLikeCommand(command: string): boolean {
  return /\b(install|setup|ci|sync|restore)\b/i.test(command);
}

export async function readPackageJson(targetCwd: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await fs.readFile(path.join(targetCwd, "package.json"), "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function dedupePaths(paths: string[]): string[] {
  return [...new Set(paths.map((value) => path.normalize(value)))];
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))].sort();
}

export function normalizeRelative(from: string, to: string): string {
  const relative = path.relative(from, to).replace(/\\/g, "/");
  return relative || ".";
}

export function resolveVerificationPlanningSkill(goal: string, evidence: VerificationEvidence): {
  id: string;
  version: string;
  mode: "verification" | "repair";
  selectionReasons: string[];
} {
  const selection = resolveFactorySkills({
    goal,
    stage: "verification",
    taskKinds: ["verification", "repo-interpretation"],
    languages: ["TypeScript", "JavaScript"],
    affectedFiles: evidence.candidateCwds.map((candidate) => candidate.relativePath === "." ? "package.json" : `${candidate.relativePath}/package.json`),
    requiredCapabilities: ["verification-root-selection", "verification-command-selection"],
    availableTools: ["read", "grep", "find", "ls"],
    constitutionAreas: [1, 2, 3, 18, 73, 76],
  });
  const match = selection.selected[0];

  return {
    id: match?.skill.id ?? "verification-planning",
    version: match?.skill.version ?? "1.0.0",
    mode: "verification",
    selectionReasons: match?.reasons ?? ["Default verification planning skill selected."],
  };
}

export function shouldSkipDirectory(name: string): boolean {
  return name === ".git" || name === ".factory" || name === ".worktrees" || name === "node_modules";
}



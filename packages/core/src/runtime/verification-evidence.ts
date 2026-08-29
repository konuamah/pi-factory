// Verification evidence gathering + deterministic planning — extracted from
// verification.ts.

import path from "node:path";
import { appendFactoryRunEvent } from "../runs/store.js";
import { loadConstitutionConflicts } from "./phase-plumbing.js";
import { resolveVerificationCwd, findNestedProjectRoots, readPackageScripts, readPackageScriptCommands, readPackageDependencyVersions, detectEcosystemMarkers, detectPackageManager, detectStalePackageScripts, discoverAllowedCommands, dedupePaths, normalizeRelative, expectedDependencyMarkers, detectDependencyMarkers, readPackageJson, isSetupLikeCommand } from "./verification-discovery.js";
import { explainCommandSelection } from "./verification-plan-helpers.js";
import { pathExists } from "./fs-utils.js";
import { uniqueStrings } from "./verification-discovery.js";
import { determineResolutionFromEvidence } from "./verification-plan-helpers.js";
import { resolveFactorySkills } from "../skills/index.js";
import type { VerificationEvidence, VerificationCwdCandidate, VerificationPlan, VerificationCommandConfig, VerificationCommandDecision } from "./verification.js";

export async function discoverVerificationEvidence(
  executionCwd: string,
  commands: VerificationCommandConfig,
): Promise<VerificationEvidence> {
  const rootScripts = await readPackageScripts(executionCwd);
  const nestedPackageRoots = await findNestedProjectRoots(executionCwd, 3);
  const candidateRoots = dedupePaths([
    executionCwd,
    ...(typeof commands.cwd === "string" && commands.cwd.trim() ? [path.resolve(executionCwd, commands.cwd)] : []),
    ...nestedPackageRoots,
  ]);

  const candidateCwds = [] as VerificationEvidence["candidateCwds"];
  for (const candidatePath of candidateRoots) {
    const packageJson = await readPackageJson(candidatePath);
    const relativePath = normalizeRelative(executionCwd, candidatePath);
    const scriptCommands = readPackageScriptCommands(packageJson);
    const scripts = Object.keys(scriptCommands).sort();
    const dependencyVersions = readPackageDependencyVersions(packageJson);
    const ecosystemMarkers = await detectEcosystemMarkers(candidatePath);
    const packageManager = ecosystemMarkers.includes("package.json") ? await detectPackageManager(candidatePath) : undefined;
    const staleScripts = packageManager ? detectStalePackageScripts(scriptCommands, dependencyVersions, packageManager) : [];
    const dependencyMarkers = await detectDependencyMarkers(candidatePath);
    const missingDependencyMarkers = expectedDependencyMarkers(ecosystemMarkers)
      .filter((marker) => !dependencyMarkers.includes(marker));
    const allowedCommands = await discoverAllowedCommands(candidatePath, scripts, ecosystemMarkers, scriptCommands, dependencyVersions, packageManager, staleScripts);
    candidateCwds.push({
      path: candidatePath,
      relativePath,
      reason:
        candidatePath === executionCwd
          ? "execution-root"
          : typeof commands.cwd === "string" && path.resolve(executionCwd, commands.cwd) === candidatePath
            ? "configured-command-cwd"
            : "nested-package-root",
      packageName: typeof packageJson?.name === "string" ? packageJson.name : undefined,
      scripts,
      scriptCommands,
      packageManager,
      dependencyVersions,
      staleScripts,
      hasNodeModules: await pathExists(path.join(candidatePath, "node_modules")),
      ecosystemMarkers,
      dependencyMarkers,
      missingDependencyMarkers,
      allowedCommands,
    });
  }
  const configuredCommandValues = Object.values(commands).filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
  const allowedCommands = uniqueStrings([
    ...configuredCommandValues,
    ...candidateCwds.flatMap((candidate) => candidate.allowedCommands),
  ]);

  return {
    rootCwd: executionCwd,
    configuredCwd: typeof commands.cwd === "string" && commands.cwd.trim() ? commands.cwd : undefined,
    candidateCwds,
    configuredCommands: commands,
    allowedCommands,
    rootScripts,
  };
}

export async function buildDeterministicVerificationPlan(
  evidence: VerificationEvidence,
  selectedSkill: { id: string; version: string; mode: "verification" | "repair"; selectionReasons: string[] },
): Promise<VerificationPlan> {
  const chosenCandidate = chooseDeterministicVerificationCandidate(evidence);
  const resolved = chosenCandidate
    ? {
        cwd: chosenCandidate.path,
        resolution: determineResolutionFromEvidence(evidence, chosenCandidate.path),
      }
    : await resolveVerificationCwd(evidence.rootCwd, evidence.configuredCwd);
  const selectedCommands = withDependencySetupCommand(
    filterCommandsForCandidate(evidence.configuredCommands, chosenCandidate),
    evidence,
    chosenCandidate,
  );

  return {
    cwd: resolved.cwd,
    cwdResolution: resolved.resolution,
    commands: selectedCommands,
    selectionSource: evidence.configuredCwd ? "configured" : "deterministic",
    rationale: evidence.configuredCwd
      ? `Using configured commands.cwd (${evidence.configuredCwd}).`
      : chosenCandidate?.scripts.length
        ? `Using ${chosenCandidate.relativePath} because it looks like the most likely runnable package root.`
        : "Using deterministic verification root fallback.",
    skill: selectedSkill,
    evidence: {
      ...evidence,
      selectedCandidate: chosenCandidate,
      commandDecisions: explainCommandSelection(evidence.configuredCommands, selectedCommands, chosenCandidate ?? evidence.rootScripts),
    },
  };
}

export function filterCommandsForCandidate(
  commands: VerificationCommandConfig,
  candidate?: VerificationCwdCandidate,
): VerificationCommandConfig {
  const selected: VerificationCommandConfig = {};

  for (const [name, command] of Object.entries(commands)) {
    if (name === "cwd" || !command) {
      continue;
    }
    if (name === "setup") {
      selected.setup = normalizeCommandForCandidate(command, name, candidate);
      continue;
    }
    const normalized = normalizeCommandForCandidate(command, name, candidate);
    if (normalized) {
      selected[name as keyof VerificationCommandConfig] = normalized;
    }
  }

  return selected;
}

export function chooseDeterministicVerificationCandidate(evidence: VerificationEvidence): VerificationCwdCandidate | undefined {
  if (evidence.configuredCwd) {
    const configuredPath = path.normalize(path.resolve(evidence.rootCwd, evidence.configuredCwd));
    return evidence.candidateCwds.find((candidate) => path.normalize(candidate.path) === configuredPath);
  }

  const scored = evidence.candidateCwds.map((candidate) => ({
    candidate,
    score: scoreVerificationCandidate(evidence.configuredCommands, candidate, evidence.rootCwd),
  })).sort((a, b) => b.score - a.score || a.candidate.relativePath.localeCompare(b.candidate.relativePath));

  return scored[0]?.score && scored[0].score > 0 ? scored[0].candidate : undefined;
}

export function scoreVerificationCandidate(
  commands: VerificationCommandConfig,
  candidate: VerificationCwdCandidate,
  rootCwd: string,
): number {
  let score = 0;
  const isRoot = path.normalize(candidate.path) === path.normalize(rootCwd);
  if (candidate.scripts.length > 0) score += 20;
  if (candidate.ecosystemMarkers.includes("package.json")) score += 10;
  if (candidate.ecosystemMarkers.some((marker) => marker === "docker-compose.yml" || marker === "docker-compose.yaml")) score += 1;
  if (!isRoot && candidate.scripts.length > 0) score += 8;

  for (const [name, command] of Object.entries(commands)) {
    if (name === "cwd" || !command) continue;
    const parsedScript = parsePackageScriptCommand(command);
    if (parsedScript) {
      if (normalizeCommandForCandidate(command, name, candidate)) {
        score += name === "setup" ? 4 : candidate.staleScripts.some((stale) => stale.script === parsedScript.script) ? 10 : 12;
      }
    } else if (candidate.allowedCommands.includes(command)) {
      score += 8;
    } else {
      score += 2;
    }
  }

  if (!isRoot && candidate.scripts.length === 0) score -= 3;
  return score;
}

export function withDependencySetupCommand(
  selectedCommands: VerificationCommandConfig,
  evidence: VerificationEvidence,
  chosenCandidate?: VerificationEvidence["candidateCwds"][number],
): VerificationCommandConfig {
  if (selectedCommands.setup || !shouldRunDependencySetup(selectedCommands, evidence, chosenCandidate)) {
    return selectedCommands;
  }
  const setupCommand = firstSetupCommand(evidence, chosenCandidate);
  if (!setupCommand) {
    return selectedCommands;
  }
  return { setup: setupCommand, ...selectedCommands };
}

export function shouldRunDependencySetup(
  selectedCommands: VerificationCommandConfig,
  evidence: VerificationEvidence,
  chosenCandidate?: VerificationEvidence["candidateCwds"][number],
): boolean {
  const runnableCommands = Object.entries(selectedCommands)
    .filter(([name, command]) => name !== "cwd" && name !== "setup" && Boolean(command));
  if (runnableCommands.length === 0) {
    return false;
  }

  const evidenceBackedCommandSelected = runnableCommands.some(([, command]) =>
    typeof command === "string" && evidence.allowedCommands.includes(command)
  );
  if (!evidenceBackedCommandSelected) {
    return false;
  }

  return (chosenCandidate ? [chosenCandidate] : evidence.candidateCwds)
    .some((candidate) => candidate.missingDependencyMarkers.length > 0);
}

export function firstSetupCommand(
  evidence: VerificationEvidence,
  chosenCandidate?: VerificationCwdCandidate,
): string | undefined {
  const configuredSetup = evidence.configuredCommands.setup;
  if (configuredSetup) {
    const normalizedSetup = normalizeCommandForCandidate(configuredSetup, "setup", chosenCandidate);
    if (normalizedSetup) return normalizedSetup;
  }
  const candidates = chosenCandidate ? [chosenCandidate] : evidence.candidateCwds;
  return candidates
    .flatMap((candidate) => candidate.allowedCommands)
    .find((command) => isSetupLikeCommand(command));
}

export function normalizeCommandForCandidate(
  command: string,
  commandName: string,
  candidate?: VerificationCwdCandidate,
): string | undefined {
  if (!candidate) {
    return command;
  }

  const parsedScript = parsePackageScriptCommand(command);
  if (parsedScript) {
    const script = parsedScript.script === "test" && commandName === "test" ? "test" : parsedScript.script;
    const stale = candidate.staleScripts.find((item) => item.script === script);
    if (stale) {
      return stale.replacementCommand;
    }
    if (!candidate.scripts.includes(script)) {
      if (candidate.scripts.length === 0 && candidate.ecosystemMarkers.includes("package.json")) {
        return command;
      }
      return undefined;
    }
    return candidate.allowedCommands.find((allowed) => packageCommandRunsScript(allowed, script)) ?? command;
  }

  if (candidate.allowedCommands.includes(command)) {
    return command;
  }

  return command;
}

export function parsePackageScriptCommand(command: string): { manager: "npm" | "pnpm" | "yarn"; script: string } | undefined {
  const match = command.trim().match(/^(npm|pnpm|yarn)\s+(?:(run)\s+)?([a-z0-9:_-]+)$/i);
  if (!match) return undefined;
  const manager = match[1]!.toLowerCase() as "npm" | "pnpm" | "yarn";
  const script = match[3]!.toLowerCase();
  if (!match[2] && manager === "npm" && script !== "test") {
    return undefined;
  }
  return { manager, script };
}

export function packageCommandRunsScript(command: string, script: string): boolean {
  return parsePackageScriptCommand(command)?.script === script;
}


import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { AgentExecutor } from "./interfaces.js";
import { initializeFactorySkills, resolveFactorySkills } from "../skills/index.js";
import { pathExists } from "./fs-utils.js";
import { resolveVerificationCwd, readPackageScripts, readPackageScriptCommands, readPackageDependencyVersions, detectEcosystemMarkers, detectPackageManager, detectStalePackageScripts, discoverAllowedCommands, findNestedProjectRoots, readPackageJson, dedupePaths, normalizeRelative, expectedDependencyMarkers, detectDependencyMarkers, uniqueStrings, parseMajorVersion, isDependencyPresent, resolveVerificationPlanningSkill, isSetupLikeCommand } from "./verification-discovery.js";
import { explainCommandSelection, buildVerificationPlannerPrompt, parseVerificationPlan, sanitizeVerificationPlan, validateSelectedCommands, determineResolutionFromEvidence } from "./verification-plan-helpers.js";

const execAsync = promisify(exec);

export interface VerificationCommandResult {
  name: string;
  command: string;
  status: "passed" | "failed" | "missing";
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

export interface VerificationRunResult {
  cwd: string;
  cwdResolution: VerificationCwdResolution;
  commands: VerificationCommandResult[];
  overallStatus: "passed" | "failed" | "incomplete";
}

export type VerificationCwdResolution = "configured" | "root-package" | "inferred-single-package" | "default-root";

export interface VerificationCommandConfig {
  cwd?: string;
  setup?: string;
  lint?: string;
  typecheck?: string;
  test?: string;
  build?: string;
}

export interface StructuredVerificationCommands {
  cwd?: string;
  setup?: string;
  lint?: string;
  typecheck?: string;
  test?: string;
  build?: string;
  checks?: Record<string, { description?: string; command: string; timeout?: number }>;
}

export function normalizeVerificationCommands(
  commands: StructuredVerificationCommands,
): VerificationCommandConfig {
  const { checks, ...standard } = commands;
  const normalized: VerificationCommandConfig = {};
  for (const [name, command] of Object.entries(standard)) {
    if (typeof command === "string" && command.trim()) {
      normalized[name as keyof VerificationCommandConfig] = command;
    }
  }
  for (const [name, check] of Object.entries(checks ?? {})) {
    if (typeof check?.command !== "string" || !check.command.trim()) continue;
    // Preserve the first check per standard role; all named checks are handled below.
    const role = name.toLowerCase().includes("lint") ? "lint"
      : name.toLowerCase().includes("type") ? "typecheck"
        : name.toLowerCase().includes("test") ? "test"
          : name.toLowerCase().includes("build") ? "build" : undefined;
    if (role && !normalized[role]) normalized[role] = check.command;
    if (!role && !normalized.test) normalized.test = check.command;
  }
  return normalized;
}

export interface VerificationPlan {
  cwd: string;
  cwdResolution: VerificationCwdResolution;
  commands: VerificationCommandConfig;
  selectionSource: "configured" | "ai" | "deterministic";
  rationale?: string;
  skill: {
    id: string;
    version: string;
    mode: "verification" | "repair";
    selectionReasons: string[];
  };
  evidence: VerificationEvidence & {
    selectedCandidate?: VerificationEvidence["candidateCwds"][number];
    commandDecisions: VerificationCommandDecision[];
  };
}

export interface VerificationCommandDecision {
  name: string;
  configured: boolean;
  selected: boolean;
  command?: string;
  reason: string;
}

export interface VerificationEvidence {
  rootCwd: string;
  configuredCwd?: string;
  candidateCwds: VerificationCwdCandidate[];
  configuredCommands: VerificationCommandConfig;
  allowedCommands: string[];
  rootScripts: string[];
}

export interface VerificationCwdCandidate {
  path: string;
  relativePath: string;
  reason: string;
  packageName?: string;
  scripts: string[];
  scriptCommands: Record<string, string>;
  packageManager?: "npm" | "pnpm" | "yarn";
  dependencyVersions: Record<string, string>;
  staleScripts: Array<{
    script: string;
    command: string;
    reason: string;
    replacementCommand?: string;
  }>;
  hasNodeModules: boolean;
  ecosystemMarkers: string[];
  dependencyMarkers: string[];
  missingDependencyMarkers: string[];
  allowedCommands: string[];
}

export class VerificationPlanningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationPlanningError";
  }
}

export async function planVerificationExecution(input: {
  cwd: string;
  goal: string;
  commands: VerificationCommandConfig;
  constitutionContext?: string;
  executor?: AgentExecutor;
  model?: {
    provider?: string;
    model: string;
  };
  runId?: string;
  allowDeterministicFallback?: boolean;
}): Promise<VerificationPlan> {
  await initializeFactorySkills(input.cwd);
  const evidence = await discoverVerificationEvidence(input.cwd, input.commands);
  const selectedSkill = resolveVerificationPlanningSkill(input.goal, evidence);

  if (!input.executor) {
    if (input.allowDeterministicFallback) {
      return buildDeterministicVerificationPlan(evidence, selectedSkill);
    }
    throw new VerificationPlanningError("VERIFICATION_PLANNER_MISSING_EXECUTOR: Verification planning requires an LLM executor. No deterministic fallback is allowed.");
  }

  const result = await input.executor.execute({
    executionId: `${input.runId ?? "verification"}-verification-plan`,
    cwd: input.cwd,
    prompt: buildVerificationPlannerPrompt(input.goal, evidence, input.constitutionContext),
    model: input.model,
    tools: ["read", "grep", "find", "ls"],
    metadata: {
      role: "planner",
      stage: "verification-planning",
      runId: input.runId,
    },
  });
  const parsed = parseVerificationPlan(result.outputText);
  if (!parsed) {
    throw new VerificationPlanningError("VERIFICATION_PLANNER_INVALID_JSON: Verification planner returned invalid structured JSON.");
  }
  return sanitizeVerificationPlan(parsed, evidence, selectedSkill);
}

export async function runVerificationCommands(input: {
  cwd: string;
  commands: VerificationCommandConfig;
  env?: Record<string, string>;
}): Promise<VerificationRunResult> {
  const resolved = await resolveVerificationCwd(input.cwd, input.commands.cwd);

  if (process.env.FACTORY_PI_FORCE_VERIFY_FAIL === "1") {
    return {
      cwd: resolved.cwd,
      cwdResolution: resolved.resolution,
      commands: [
        {
          name: "forced-failure",
          command: "FACTORY_PI_FORCE_VERIFY_FAIL=1",
          status: "failed",
          exitCode: 1,
          stderr: "Verification failure forced by environment",
        },
      ],
      overallStatus: "failed",
    };
  }

  const results: VerificationCommandResult[] = [];

  for (const [name, command] of Object.entries(input.commands)) {
    if (name === "cwd") {
      continue;
    }
    if (!command) {
      results.push({
        name,
        command: "",
        status: "missing",
      });
      continue;
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: resolved.cwd,
        windowsHide: true,
        env: input.env ? { ...process.env, ...input.env } : process.env,
      });
      results.push({
        name,
        command,
        status: "passed",
        exitCode: 0,
        stdout,
        stderr,
      });
    } catch (error) {
      const execError = error as Error & {
        code?: number;
        stdout?: string;
        stderr?: string;
      };
      results.push({
        name,
        command,
        status: "failed",
        exitCode: typeof execError.code === "number" ? execError.code : undefined,
        stdout: execError.stdout,
        stderr: execError.stderr,
      });
    }
  }

  const hasFailed = results.some((result) => result.status === "failed");
  const hasMissing = results.some((result) => result.status === "missing");

  return {
    cwd: resolved.cwd,
    cwdResolution: resolved.resolution,
    commands: results,
    overallStatus: hasFailed ? "failed" : hasMissing ? "incomplete" : "passed",
  };
}

async function discoverVerificationEvidence(
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

async function buildDeterministicVerificationPlan(
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

function filterCommandsForCandidate(
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

function chooseDeterministicVerificationCandidate(evidence: VerificationEvidence): VerificationCwdCandidate | undefined {
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

function scoreVerificationCandidate(
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

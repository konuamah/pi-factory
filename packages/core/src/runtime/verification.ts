import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { AgentExecutionInput, AgentExecutor } from "./interfaces.js";
import { initializeFactorySkills, resolveFactorySkills } from "../skills/index.js";

const execAsync = promisify(exec);

export interface VerificationCommandResult {
  name: string;
  command: string;
  status: "passed" | "failed" | "missing" | "timed-out";
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  timeoutMs?: number;
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
  [name: string]: string | undefined;
}

export interface StructuredVerificationCommands {
  cwd?: string;
  setup?: string;
  lint?: string;
  typecheck?: string;
  test?: string;
  build?: string;
  checks?: Record<string, { description?: string; command: string; timeout?: number }>;
  [name: string]: string | Record<string, { description?: string; command: string; timeout?: number }> | undefined;
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
    normalized[name] = check.command;
  }
  return normalized;
}

export interface VerificationPlan {
  cwd: string;
  cwdResolution: VerificationCwdResolution;
  commands: VerificationCommandConfig;
  timeouts?: Record<string, number>;
  selectionSource: "configured" | "ai" | "deterministic";
  rationale?: string;
  /** Raw LLM output for debugging; present when an executor produced the plan. */
  plannerOutputText?: string;
  plannerRepairOutputText?: string;
  plannerUsedFallback?: boolean;
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
  changedFiles?: string[];
  candidateCwds: Array<{
    path: string;
    relativePath: string;
    reason: string;
    packageName?: string;
    scripts: string[];
    hasNodeModules: boolean;
    ecosystemMarkers: string[];
    dependencyMarkers: string[];
    missingDependencyMarkers: string[];
    allowedCommands: string[];
  }>;
  configuredCommands: VerificationCommandConfig;
  allowedCommands: string[];
  rootScripts: string[];
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
  timeouts?: Record<string, number>;
  constitutionContext?: string;
  executor?: AgentExecutor;
  model?: {
    provider?: string;
    model: string;
  };
  limits?: AgentExecutionInput["limits"];
  runId?: string;
  changedFiles?: string[];
  allowDeterministicFallback?: boolean;
}): Promise<VerificationPlan> {
  await initializeFactorySkills(input.cwd);
  const evidence = await discoverVerificationEvidence(input.cwd, input.commands, input.changedFiles);
  const selectedSkill = resolveVerificationPlanningSkill(input.goal, evidence);

  if (!input.executor) {
    if (input.allowDeterministicFallback) {
      return buildDeterministicVerificationPlan(evidence, selectedSkill, input.timeouts);
    }
    throw new VerificationPlanningError("VERIFICATION_PLANNER_MISSING_EXECUTOR: Verification planning requires an LLM executor. No deterministic fallback is allowed.");
  }

  const result = await input.executor.execute({
    executionId: `${input.runId ?? "verification"}-verification-plan`,
    cwd: input.cwd,
    prompt: buildVerificationPlannerPrompt(input.goal, evidence, input.constitutionContext),
    model: input.model,
    tools: ["read", "grep", "find", "ls"],
    limits: input.limits,
    metadata: {
      role: "planner",
      stage: "verification-planning",
      runId: input.runId,
    },
  });
  let parsed = parseVerificationPlan(result.outputText);
  let repairOutputText: string | undefined;
  if (!parsed) {
    // LLM repair pass: feed its own output back and demand JSON only.
    const repair = await input.executor.execute({
      executionId: `${input.runId ?? "verification"}-verification-plan-repair`,
      cwd: input.cwd,
      prompt: [
        "Your previous response was not valid JSON, so it was rejected.",
        "Convert your plan into JSON and respond with JSON only — no prose, no markdown, no code fences.",
        'Required shape: {"cwd":"<candidate path>","commands":{"<stage>":"<command>"},"rationale":"short reason"}',
        "cwd must be one of the candidate paths; commands must come from the allowed list.",
        "",
        "Your previous response:",
        result.outputText.slice(0, 4000),
      ].join("\n\n"),
      model: input.model,
      tools: [],
      limits: input.limits,
      metadata: { role: "planner", stage: "verification-planning-repair", runId: input.runId },
    });
    repairOutputText = repair.outputText;
    parsed = parseVerificationPlan(repair.outputText);
  }
  if (!parsed) {
    if (input.allowDeterministicFallback) {
      const plan = buildDeterministicVerificationPlan(evidence, selectedSkill, input.timeouts);
      return { ...plan, plannerOutputText: result.outputText, plannerRepairOutputText: repairOutputText, plannerUsedFallback: true };
    }
    throw new VerificationPlanningError(`VERIFICATION_PLANNER_INVALID_JSON: Verification planner returned invalid structured JSON after one repair attempt. Raw output (first 800 chars): ${result.outputText.slice(0, 800)}`);
  }
  return { ...sanitizeVerificationPlan(parsed, evidence, selectedSkill, input.timeouts), plannerOutputText: result.outputText, plannerRepairOutputText: repairOutputText };
}

export async function runVerificationCommands(input: {
  cwd: string;
  commands: VerificationCommandConfig;
  timeouts?: Record<string, number>;
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
        timeout: input.timeouts?.[name],
        env: input.env ? { ...process.env, ...input.env } : process.env,
      });
      results.push({
        name,
        command,
        status: "passed",
        exitCode: 0,
        stdout,
        stderr,
        ...(input.timeouts?.[name] ? { timeoutMs: input.timeouts[name] } : {}),
      });
    } catch (error) {
      const execError = error as Error & {
        code?: number;
        stdout?: string;
        stderr?: string;
        killed?: boolean;
        signal?: NodeJS.Signals;
      };
      const timeoutMs = input.timeouts?.[name];
      const timedOut = Boolean(timeoutMs) && execError.killed === true && execError.signal === "SIGTERM";
      results.push({
        name,
        command,
        status: timedOut ? "timed-out" : "failed",
        exitCode: typeof execError.code === "number" ? execError.code : undefined,
        stdout: execError.stdout,
        stderr: timedOut ? `Verification command timed out after ${timeoutMs}ms` : execError.stderr,
        ...(timeoutMs ? { timeoutMs } : {}),
      });
    }
  }

  const hasFailed = results.some((result) => result.status === "failed" || result.status === "timed-out");
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
  changedFiles: string[] = [],
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
    const scripts = packageJson && typeof packageJson.scripts === "object" && packageJson.scripts
      ? Object.keys(packageJson.scripts).sort()
      : [];
    const ecosystemMarkers = await detectEcosystemMarkers(candidatePath);
    const dependencyMarkers = await detectDependencyMarkers(candidatePath);
    const missingDependencyMarkers = expectedDependencyMarkers(ecosystemMarkers)
      .filter((marker) => !dependencyMarkers.includes(marker));
    const allowedCommands = await discoverAllowedCommands(candidatePath, scripts, ecosystemMarkers);
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
      hasNodeModules: await exists(path.join(candidatePath, "node_modules")),
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
    changedFiles,
    candidateCwds,
    configuredCommands: commands,
    allowedCommands,
    rootScripts,
  };
}

async function buildDeterministicVerificationPlan(
  evidence: VerificationEvidence,
  selectedSkill: { id: string; version: string; mode: "verification" | "repair"; selectionReasons: string[] },
  timeouts: Record<string, number> = {},
): Promise<VerificationPlan> {
  const resolved = await resolveVerificationCwd(evidence.rootCwd, evidence.configuredCwd);
  const chosenCandidate = evidence.candidateCwds.find((candidate) => path.normalize(candidate.path) === path.normalize(resolved.cwd));
  const selectedCommands = withDependencySetupCommand(
    filterCommandsForCandidate(evidence.configuredCommands, chosenCandidate?.scripts ?? evidence.rootScripts),
    evidence,
    chosenCandidate,
  );

  return {
    cwd: resolved.cwd,
    cwdResolution: resolved.resolution,
    commands: selectedCommands,
    timeouts: pickCommandTimeouts(timeouts, selectedCommands),
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
      commandDecisions: explainCommandSelection(evidence.configuredCommands, selectedCommands, chosenCandidate?.scripts ?? evidence.rootScripts),
    },
  };
}

function filterCommandsForCandidate(
  commands: VerificationCommandConfig,
  packageScripts: string[],
): VerificationCommandConfig {
  const selected: VerificationCommandConfig = {};

  for (const [name, command] of Object.entries(commands)) {
    if (name === "cwd" || !command) {
      continue;
    }
    if (name === "setup") {
      selected.setup = command;
      continue;
    }
    if (packageScripts.length === 0 || commandLikelyExistsForScript(command, name, packageScripts)) {
      selected[name as keyof VerificationCommandConfig] = command;
    }
  }

  return selected;
}

function withDependencySetupCommand(
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

function shouldRunDependencySetup(
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

function firstSetupCommand(
  evidence: VerificationEvidence,
  chosenCandidate?: VerificationEvidence["candidateCwds"][number],
): string | undefined {
  const configuredSetup = evidence.configuredCommands.setup;
  if (configuredSetup && evidence.allowedCommands.includes(configuredSetup)) {
    return configuredSetup;
  }
  const candidates = chosenCandidate ? [chosenCandidate] : evidence.candidateCwds;
  return candidates
    .flatMap((candidate) => candidate.allowedCommands)
    .find((command) => isSetupLikeCommand(command));
}

function commandLikelyExistsForScript(command: string, scriptName: string, packageScripts: string[]): boolean {
  const normalized = command.trim().toLowerCase();
  if (/^(pnpm|npm|yarn)\s+(run\s+)?[a-z0-9:_-]+$/i.test(normalized)) {
    return packageScripts.includes(extractPackageScriptName(command) ?? scriptName);
  }
  return true;
}

function extractPackageScriptName(command: string): string | undefined {
  const match = command.trim().match(/^(?:pnpm|npm|yarn)\s+(?:run\s+)?([a-z0-9:_-]+)$/i);
  return match?.[1];
}

function explainCommandSelection(
  commands: VerificationCommandConfig,
  selectedCommands: VerificationCommandConfig,
  packageScripts: string[],
): VerificationCommandDecision[] {
  const decisions: VerificationCommandDecision[] = [];
  for (const name of uniqueStrings([...Object.keys(commands), ...Object.keys(selectedCommands)])) {
    if (name === "cwd") {
      continue;
    }
    const configured = commands[name];
    const selected = selectedCommands[name];
    if (!configured) {
      decisions.push({
        name,
        configured: false,
        selected: Boolean(selected),
        ...(selected ? { command: selected } : {}),
        reason: selected
          ? "Discovered setup command selected because verification packages are missing dependencies."
          : "No command configured for this stage.",
      });
      continue;
    }
    if (selected) {
      decisions.push({
        name,
        configured: true,
        selected: true,
        command: configured,
        reason: name === "setup" || packageScripts.length === 0
          ? "Configured command selected."
          : packageScripts.includes(extractPackageScriptName(configured) ?? name)
            ? `Configured command selected because package script '${extractPackageScriptName(configured) ?? name}' exists.`
          : "Configured command selected.",
      });
      continue;
    }
    decisions.push({
      name,
      configured: true,
      selected: false,
      command: configured,
      reason: packageScripts.length > 0 && /^(pnpm|npm|yarn)\s+(run\s+)?[a-z0-9:_-]+$/i.test(configured.trim())
        ? `Skipped because package script '${extractPackageScriptName(configured) ?? name}' was not found in the selected package.`
        : "Configured command was omitted by verification planning.",
    });
  }
  return decisions;
}

function buildVerificationPlannerPrompt(
  goal: string,
  evidence: VerificationEvidence,
  constitutionContext?: string,
): string {
  return [
    `Goal: ${goal}`,
    "Choose the most appropriate verification working directory and commands for this repository.",
    "You are the verification planner. Deterministic code only collected evidence; you must decide from the allowlisted evidence.",
    "Prefer the weakest valid plan that matches the repository's real structure and the actual changed files. Omit checks for untouched areas unless the change is high-risk or cross-cutting.",
    "Include setup/install when the selected cwd has missing dependency markers and a setup command is available.",
    "Configured commands are preferred check names and policy hints. Allowed commands may also include repo-discovered scripts that were not configured.",
    "If you select a configured command, keep its configured key name. Do not rename configured checks.",
    "Fail-safe rule: only choose commands from allowedCommands or configured Factory commands. Do not invent shell commands.",
    constitutionContext ? `Project guidance context:\n${constitutionContext}` : undefined,
    `Changed files: ${JSON.stringify(evidence.changedFiles ?? [], null, 2)}`,
    `Configured commands: ${JSON.stringify(evidence.configuredCommands, null, 2)}`,
    `Allowed commands: ${JSON.stringify(evidence.allowedCommands, null, 2)}`,
    `Verification candidates: ${JSON.stringify(evidence.candidateCwds, null, 2)}`,
    "Return JSON only with shape:",
    '{"cwd":"<candidate path>","commands":{"setup":"...","lint":"...","build":"...","build-frontend":"..."},"rationale":"short reason"}',
    "Only include commands that should actually run for this repo. Omit missing/non-authoritative stages.",
  ].filter(Boolean).join("\n\n");
}

function parseVerificationPlan(outputText: string): {
  cwd?: string;
  commands?: VerificationCommandConfig;
  rationale?: string;
} | undefined {
  const fenced = outputText.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const raw = (fenced ?? outputText).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return undefined;
  }
  try {
    return JSON.parse(raw.slice(start, end + 1)) as {
      cwd?: string;
      commands?: VerificationCommandConfig;
      rationale?: string;
    };
  } catch {
    return undefined;
  }
}

function sanitizeVerificationPlan(
  parsed: { cwd?: string; commands?: VerificationCommandConfig; rationale?: string },
  evidence: VerificationEvidence,
  selectedSkill: { id: string; version: string; mode: "verification" | "repair"; selectionReasons: string[] },
  timeouts: Record<string, number> = {},
): VerificationPlan {
  const allowedCwds = new Set(evidence.candidateCwds.map((candidate) => path.normalize(candidate.path)));
  if (typeof parsed.cwd !== "string" || !allowedCwds.has(path.normalize(parsed.cwd))) {
    throw new VerificationPlanningError(`VERIFICATION_PLANNER_INVALID_CWD: Verification planner selected an unknown cwd: ${String(parsed.cwd ?? "")}`);
  }
  const chosenCwd = parsed.cwd;
  const chosenCandidate = evidence.candidateCwds.find((candidate) => path.normalize(candidate.path) === path.normalize(chosenCwd));
  const commands = validateSelectedCommands(parsed.commands, evidence, chosenCandidate);
  return {
    cwd: chosenCwd,
    cwdResolution: determineResolutionFromEvidence(evidence, chosenCwd),
    commands,
    timeouts: pickCommandTimeouts(timeouts, commands),
    selectionSource: "ai",
    rationale: typeof parsed.rationale === "string" && parsed.rationale.trim() ? parsed.rationale.trim() : undefined,
    skill: selectedSkill,
    evidence: {
      ...evidence,
      selectedCandidate: chosenCandidate,
      commandDecisions: explainCommandSelection(evidence.configuredCommands, commands, chosenCandidate?.scripts ?? []),
    },
  };
}

function pickCommandTimeouts(timeouts: Record<string, number>, commands: VerificationCommandConfig): Record<string, number> {
  const selected: Record<string, number> = {};
  for (const name of Object.keys(commands)) {
    if (typeof timeouts[name] === "number") {
      selected[name] = timeouts[name];
    }
  }
  return selected;
}

function validateSelectedCommands(
  selected: VerificationCommandConfig | undefined,
  evidence: VerificationEvidence,
  chosenCandidate?: VerificationEvidence["candidateCwds"][number],
): VerificationCommandConfig {
  if (!selected || Object.keys(selected).filter((name) => name !== "cwd").length === 0) {
    throw new VerificationPlanningError("VERIFICATION_PLANNER_EMPTY_COMMANDS: Verification planner selected no commands.");
  }
  const result: VerificationCommandConfig = {};
  for (const name of Object.keys(selected)) {
    if (name === "cwd") {
      continue;
    }
    const requested = selected?.[name];
    if (!requested) {
      continue;
    }
    if (!evidence.allowedCommands.includes(requested)) {
      throw new VerificationPlanningError(`VERIFICATION_PLANNER_INVALID_COMMAND: Verification planner selected non-authoritative command for ${name}: ${requested}`);
    }
    const configuredMatches = Object.entries(evidence.configuredCommands)
      .filter(([configuredName, configuredCommand]) => configuredName !== "cwd" && configuredName !== "setup" && configuredCommand === requested);
    if (configuredMatches.length === 1 && configuredMatches[0][0] !== name) {
      const configuredName = configuredMatches[0][0];
      throw new VerificationPlanningError(`VERIFICATION_PLANNER_INVALID_COMMAND_NAME: Verification planner selected configured command '${configuredName}' as '${name}'.`);
    }
    result[name] = requested;
  }

  const needsSetup = shouldRunDependencySetup(result, evidence, chosenCandidate);
  if (needsSetup && !result.setup) {
    throw new VerificationPlanningError(
      `VERIFICATION_PLANNER_SETUP_REQUIRED: Selected verification cwd has missing dependency markers (${chosenCandidate?.missingDependencyMarkers.join(", ") || "unknown"}), but planner did not select a setup command.`
    );
  }
  if (needsSetup && result.setup && !isSetupLikeCommand(result.setup)) {
    throw new VerificationPlanningError(`VERIFICATION_PLANNER_INVALID_SETUP: Selected setup command is not a setup/install command: ${result.setup}`);
  }
  if (Object.keys(result).length === 0) {
    throw new VerificationPlanningError("VERIFICATION_PLANNER_EMPTY_COMMANDS: Verification planner selected no valid commands.");
  }
  return result;
}

function determineResolutionFromEvidence(
  evidence: VerificationEvidence,
  cwd: string,
): VerificationCwdResolution {
  if (evidence.configuredCwd && path.normalize(path.resolve(evidence.rootCwd, evidence.configuredCwd)) === path.normalize(cwd)) {
    return "configured";
  }
  if (path.normalize(evidence.rootCwd) === path.normalize(cwd)) {
    const rootCandidate = evidence.candidateCwds.find((candidate) => path.normalize(candidate.path) === path.normalize(cwd));
    return rootCandidate && (rootCandidate.scripts.length > 0 || rootCandidate.ecosystemMarkers.length > 0) ? "root-package" : "default-root";
  }
  return "inferred-single-package";
}

async function resolveVerificationCwd(
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

async function findNestedProjectRoots(root: string, maxDepth: number): Promise<string[]> {
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

async function readPackageScripts(targetCwd: string): Promise<string[]> {
  const pkg = await readPackageJson(targetCwd);
  if (!pkg || typeof pkg.scripts !== "object" || !pkg.scripts) {
    return [];
  }
  return Object.keys(pkg.scripts).sort();
}

async function detectEcosystemMarkers(targetCwd: string): Promise<string[]> {
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
    if (await exists(path.join(targetCwd, marker))) {
      found.push(marker);
    }
  }
  return found;
}

async function detectDependencyMarkers(targetCwd: string): Promise<string[]> {
  const markers = ["node_modules", ".venv", "venv", "vendor", "target", ".gradle", "build"];
  const found: string[] = [];
  for (const marker of markers) {
    if (await exists(path.join(targetCwd, marker))) {
      found.push(marker);
    }
  }
  return found;
}

function expectedDependencyMarkers(ecosystemMarkers: string[]): string[] {
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

async function discoverAllowedCommands(targetCwd: string, scripts: string[], ecosystemMarkers: string[]): Promise<string[]> {
  const commands: string[] = [];
  const packageManager = await detectPackageManager(targetCwd);

  for (const script of scripts) {
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
    if (await hasAnyLockfile(targetCwd)) {
      commands.push(packageManager === "npm" && await exists(path.join(targetCwd, "package-lock.json")) ? "npm ci" : `${packageManager} install`);
      commands.push(`${packageManager} install`);
    }
  }

  if (ecosystemMarkers.includes("requirements.txt")) {
    commands.push("python -m pip install -r requirements.txt", "pip install -r requirements.txt");
  }
  if (ecosystemMarkers.includes("pyproject.toml") || ecosystemMarkers.includes("setup.py")) {
    commands.push("python -m pip install -e .", "pip install -e .");
  }
  if (ecosystemMarkers.includes("pyproject.toml") || ecosystemMarkers.includes("requirements.txt") || ecosystemMarkers.includes("setup.py")) {
    commands.push("python -m pytest", "pytest");
  }

  if (ecosystemMarkers.includes("Cargo.toml")) {
    commands.push("cargo check", "cargo test", "cargo build");
  }

  if (ecosystemMarkers.includes("go.mod")) {
    commands.push("go test ./...", "go vet ./...", "go build ./...");
  }

  if (ecosystemMarkers.includes("pom.xml")) {
    commands.push("mvn test", "mvn verify", "mvn package");
  }

  if (ecosystemMarkers.includes("gradlew")) {
    commands.push("./gradlew test", "./gradlew build");
  } else if (ecosystemMarkers.includes("build.gradle") || ecosystemMarkers.includes("build.gradle.kts")) {
    commands.push("gradle test", "gradle build");
  }

  return uniqueStrings(commands);
}

async function detectPackageManager(root: string): Promise<"npm" | "pnpm" | "yarn"> {
  if (await exists(path.join(root, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (await exists(path.join(root, "yarn.lock"))) {
    return "yarn";
  }
  return "npm";
}

async function hasAnyLockfile(root: string): Promise<boolean> {
  return (await exists(path.join(root, "package-lock.json")))
    || (await exists(path.join(root, "pnpm-lock.yaml")))
    || (await exists(path.join(root, "yarn.lock")));
}

function isSetupLikeCommand(command: string): boolean {
  return /\b(install|setup|ci|sync|restore)\b/i.test(command);
}

async function readPackageJson(targetCwd: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await fs.readFile(path.join(targetCwd, "package.json"), "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function dedupePaths(paths: string[]): string[] {
  return [...new Set(paths.map((value) => path.normalize(value)))];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))].sort();
}

function normalizeRelative(from: string, to: string): string {
  const relative = path.relative(from, to).replace(/\\/g, "/");
  return relative || ".";
}

function resolveVerificationPlanningSkill(goal: string, evidence: VerificationEvidence): {
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

function shouldSkipDirectory(name: string): boolean {
  return name === ".git" || name === ".factory" || name === ".worktrees" || name === "node_modules";
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

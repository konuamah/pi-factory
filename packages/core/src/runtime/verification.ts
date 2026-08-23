import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { AgentExecutor } from "./interfaces.js";
import { initializeFactorySkills, resolveFactorySkills } from "../skills/index.js";

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
  candidateCwds: Array<{
    path: string;
    relativePath: string;
    reason: string;
    packageName?: string;
    scripts: string[];
  }>;
  configuredCommands: VerificationCommandConfig;
  rootScripts: string[];
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
}): Promise<VerificationPlan> {
  await initializeFactorySkills(input.cwd);
  const evidence = await discoverVerificationEvidence(input.cwd, input.commands);
  const selectedSkill = resolveVerificationPlanningSkill(input.goal, evidence);
  const deterministicPlan = await buildDeterministicVerificationPlan(evidence, selectedSkill);

  if (!input.executor) {
    return deterministicPlan;
  }

  try {
    const result = await input.executor.execute({
      executionId: `${input.runId ?? "verification"}-verification-plan`,
      cwd: input.cwd,
      prompt: buildVerificationPlannerPrompt(input.goal, evidence, deterministicPlan, input.constitutionContext),
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
      return deterministicPlan;
    }
    return sanitizeVerificationPlan(parsed, evidence, deterministicPlan, selectedSkill);
  } catch {
    return deterministicPlan;
  }
}

export async function runVerificationCommands(input: {
  cwd: string;
  commands: VerificationCommandConfig;
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
  const nestedPackageRoots = await findNestedPackageRoots(executionCwd, 3);
  const candidateRoots = dedupePaths([
    executionCwd,
    ...(typeof commands.cwd === "string" && commands.cwd.trim() ? [path.resolve(executionCwd, commands.cwd)] : []),
    ...nestedPackageRoots,
  ]);

  const candidateCwds = [] as VerificationEvidence["candidateCwds"];
  for (const candidatePath of candidateRoots) {
    const packageJson = await readPackageJson(candidatePath);
    const relativePath = normalizeRelative(executionCwd, candidatePath);
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
      scripts: packageJson && typeof packageJson.scripts === "object" && packageJson.scripts
        ? Object.keys(packageJson.scripts).sort()
        : [],
    });
  }

  return {
    rootCwd: executionCwd,
    configuredCwd: typeof commands.cwd === "string" && commands.cwd.trim() ? commands.cwd : undefined,
    candidateCwds,
    configuredCommands: commands,
    rootScripts,
  };
}

async function buildDeterministicVerificationPlan(
  evidence: VerificationEvidence,
  selectedSkill: { id: string; version: string; mode: "verification" | "repair"; selectionReasons: string[] },
): Promise<VerificationPlan> {
  const resolved = await resolveVerificationCwd(evidence.rootCwd, evidence.configuredCwd);
  const chosenCandidate = evidence.candidateCwds.find((candidate) => path.normalize(candidate.path) === path.normalize(resolved.cwd));
  const selectedCommands = filterCommandsForCandidate(evidence.configuredCommands, chosenCandidate?.scripts ?? evidence.rootScripts);

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

function commandLikelyExistsForScript(command: string, scriptName: string, packageScripts: string[]): boolean {
  const normalized = command.trim().toLowerCase();
  if (/^(pnpm|npm|yarn)\s+(run\s+)?[a-z0-9:_-]+$/i.test(normalized)) {
    return packageScripts.includes(scriptName);
  }
  return true;
}

function explainCommandSelection(
  commands: VerificationCommandConfig,
  selectedCommands: VerificationCommandConfig,
  packageScripts: string[],
): VerificationCommandDecision[] {
  const decisions: VerificationCommandDecision[] = [];
  for (const name of ["setup", "lint", "typecheck", "test", "build"] as const) {
    const configured = commands[name];
    const selected = selectedCommands[name];
    if (!configured) {
      decisions.push({ name, configured: false, selected: false, reason: "No command configured for this stage." });
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
          : packageScripts.includes(name)
            ? `Configured command selected because package script '${name}' exists.`
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
        ? `Skipped because package script '${name}' was not found in the selected package.`
        : "Configured command was omitted by verification planning.",
    });
  }
  return decisions;
}

function buildVerificationPlannerPrompt(
  goal: string,
  evidence: VerificationEvidence,
  deterministicPlan: VerificationPlan,
  constitutionContext?: string,
): string {
  return [
    `Goal: ${goal}`,
    "Choose the most appropriate verification working directory and which configured verification commands should actually run for this repository.",
    "Prefer the weakest valid plan that matches the repository's real structure. Ignore transient/generated workspace content.",
    constitutionContext ? `Project guidance context:\n${constitutionContext}` : undefined,
    `Configured commands: ${JSON.stringify(evidence.configuredCommands, null, 2)}`,
    `Verification candidates: ${JSON.stringify(evidence.candidateCwds, null, 2)}`,
    `Selected skill: ${deterministicPlan.skill.id}@${deterministicPlan.skill.version} (${deterministicPlan.skill.mode})`,
    `Skill selection reasons: ${deterministicPlan.skill.selectionReasons.join("; ")}`,
    `Deterministic fallback: ${JSON.stringify(deterministicPlan, null, 2)}`,
    "Return JSON only with shape:",
    '{"cwd":"<candidate path>","commands":{"setup":"...","lint":"...","build":"..."},"rationale":"short reason"}',
    "Only include commands that should actually run for this repo. Omit missing/non-authoritative script stages instead of inventing them.",
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
  deterministicPlan: VerificationPlan,
  selectedSkill: { id: string; version: string; mode: "verification" | "repair"; selectionReasons: string[] },
): VerificationPlan {
  const allowedCwds = new Set(evidence.candidateCwds.map((candidate) => path.normalize(candidate.path)));
  const chosenCwd = typeof parsed.cwd === "string" && allowedCwds.has(path.normalize(parsed.cwd))
    ? parsed.cwd
    : deterministicPlan.cwd;
  const chosenCandidate = evidence.candidateCwds.find((candidate) => path.normalize(candidate.path) === path.normalize(chosenCwd));
  const sanitizedCommands = sanitizeCommands(parsed.commands, evidence.configuredCommands, chosenCandidate?.scripts ?? []);
  const commands = Object.keys(sanitizedCommands).length > 0 ? sanitizedCommands : deterministicPlan.commands;
  return {
    cwd: chosenCwd,
    cwdResolution: determineResolutionFromEvidence(evidence, chosenCwd),
    commands,
    selectionSource: "ai",
    rationale: typeof parsed.rationale === "string" && parsed.rationale.trim() ? parsed.rationale.trim() : deterministicPlan.rationale,
    skill: selectedSkill,
    evidence: {
      ...evidence,
      selectedCandidate: chosenCandidate,
      commandDecisions: explainCommandSelection(evidence.configuredCommands, commands, chosenCandidate?.scripts ?? []),
    },
  };
}

function sanitizeCommands(
  selected: VerificationCommandConfig | undefined,
  configured: VerificationCommandConfig,
  packageScripts: string[],
): VerificationCommandConfig {
  const result: VerificationCommandConfig = {};
  for (const name of ["setup", "lint", "typecheck", "test", "build"] as const) {
    const requested = selected?.[name];
    const configuredValue = configured[name];
    if (!configuredValue) {
      continue;
    }
    if (requested !== configuredValue) {
      continue;
    }
    if (name === "setup" || packageScripts.length === 0 || commandLikelyExistsForScript(configuredValue, name, packageScripts)) {
      result[name] = configuredValue;
    }
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
    return rootCandidate?.scripts.length ? "root-package" : "default-root";
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

  if (await exists(path.join(executionCwd, "package.json"))) {
    return {
      cwd: executionCwd,
      resolution: "root-package",
    };
  }

  const nestedPackageRoots = await findNestedPackageRoots(executionCwd, 3);
  if (nestedPackageRoots.length === 1) {
    return {
      cwd: nestedPackageRoots[0]!,
      resolution: "inferred-single-package",
    };
  }

  return {
    cwd: executionCwd,
    resolution: "default-root",
  };
}

async function findNestedPackageRoots(root: string, maxDepth: number): Promise<string[]> {
  const results: string[] = [];
  await walk(root, 0);
  return results.sort();

  async function walk(current: string, depth: number): Promise<void> {
    if (depth > maxDepth) {
      return;
    }

    if (depth > 0 && await exists(path.join(current, "package.json"))) {
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

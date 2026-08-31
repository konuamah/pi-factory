import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { AgentExecutor, AgentExecutionInput, AgentExecutionResult } from "./interfaces.js";
import { initializeFactorySkills, resolveFactorySkills } from "../skills/index.js";
import { pathExists } from "./fs-utils.js";
import { resolveVerificationCwd, readPackageScripts, readPackageScriptCommands, readPackageDependencyVersions, detectEcosystemMarkers, detectPackageManager, detectStalePackageScripts, discoverAllowedCommands, findNestedProjectRoots, readPackageJson, dedupePaths, normalizeRelative, expectedDependencyMarkers, detectDependencyMarkers, uniqueStrings, parseMajorVersion, isDependencyPresent, resolveVerificationPlanningSkill, isSetupLikeCommand } from "./verification-discovery.js";
import { discoverVerificationEvidence, buildDeterministicVerificationPlan, filterCommandsForCandidate, chooseDeterministicVerificationCandidate, scoreVerificationCandidate, shouldRunDependencySetup, firstSetupCommand, parsePackageScriptCommand, packageCommandRunsScript, normalizeCommandForCandidate, withDependencySetupCommand } from "./verification-evidence.js";
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
  constructor(
    message: string,
    readonly execution?: Pick<AgentExecutionResult, "status" | "errorMessage" | "outputText">,
  ) {
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
  limits?: AgentExecutionInput["limits"];
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
    limits: input.limits,
    metadata: {
      role: "planner",
      stage: "verification-planning",
      runId: input.runId,
    },
  });
  const parsed = parseVerificationPlan(result.outputText);
  if (!parsed) {
    throw new VerificationPlanningError(
      "VERIFICATION_PLANNER_INVALID_JSON: Verification planner returned invalid structured JSON.",
      {
        status: result.status,
        errorMessage: result.errorMessage,
        outputText: result.outputText,
      },
    );
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

  if (results.length === 0) {
    results.push({
      name: "automated-checks",
      command: "",
      status: "missing",
      stderr: "No automated verification commands were configured or discovered for this workspace.",
    });
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

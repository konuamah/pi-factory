// Verification plan/prompt helpers — extracted from verification.ts.

import { resolveFactorySkills } from "../skills/index.js";
import { VerificationPlanningError } from "./verification.js";
import { normalizeCommandForCandidate, parsePackageScriptCommand, shouldRunDependencySetup, firstSetupCommand, packageCommandRunsScript, withDependencySetupCommand } from "./verification-evidence.js";
import { isSetupLikeCommand } from "./verification-discovery.js";
import type { VerificationEvidence, VerificationCwdCandidate, VerificationPlan, VerificationCommandConfig, VerificationCommandDecision, VerificationCwdResolution } from "./verification.js";
import path from "node:path";

export function explainCommandSelection(
  commands: VerificationCommandConfig,
  selectedCommands: VerificationCommandConfig,
  candidateOrPackageScripts?: VerificationCwdCandidate | string[],
): VerificationCommandDecision[] {
  const decisions: VerificationCommandDecision[] = [];
  const packageScripts = Array.isArray(candidateOrPackageScripts)
    ? candidateOrPackageScripts
    : candidateOrPackageScripts?.scripts ?? [];
  const staleScripts = Array.isArray(candidateOrPackageScripts)
    ? []
    : candidateOrPackageScripts?.staleScripts ?? [];
  for (const name of ["setup", "lint", "typecheck", "test", "build"] as const) {
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
        command: selected,
        reason: name === "setup" || packageScripts.length === 0
          ? selected === configured ? "Configured command selected." : `Configured command adapted to '${selected}' for the selected package root.`
          : packageScripts.includes(name)
            && staleScripts.some((stale) => stale.script === name)
            ? `Configured command adapted to '${selected}' because package script '${name}' is stale for this package.`
            : packageScripts.includes(name)
            ? selected === configured
              ? `Configured command selected because package script '${name}' exists.`
              : `Configured command adapted to '${selected}' because package script '${name}' exists in the selected root.`
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

export function buildVerificationPlannerPrompt(
  goal: string,
  evidence: VerificationEvidence,
  constitutionContext?: string,
): string {
  return [
    `Goal: ${goal}`,
    "Choose the most appropriate verification working directory and commands for this repository.",
    "You are the verification planner. Deterministic code only collected evidence; you must decide from the allowlisted evidence.",
    "Prefer the weakest valid plan that matches the repository's real structure. Include setup/install when the selected cwd has missing dependency markers and a setup command is available.",
    "Configured commands are user intent, not proof that the repo root or package manager is correct.",
    "If configured package-script commands conflict with candidate evidence, choose the equivalent allowed command for the selected candidate's package manager.",
    "Reason over script bodies and dependency versions. If evidence marks a script as stale, do not choose that package script; choose its replacementCommand when present.",
    "Do not choose a command unless it is valid for the cwd you select.",
    "Fail-safe rule: only choose commands from allowedCommands. Do not invent shell commands.",
    constitutionContext ? `Project guidance context:\n${constitutionContext}` : undefined,
    `Configured commands: ${JSON.stringify(evidence.configuredCommands, null, 2)}`,
    `Allowed commands: ${JSON.stringify(evidence.allowedCommands, null, 2)}`,
    `Verification candidates: ${JSON.stringify(evidence.candidateCwds, null, 2)}`,
    "Return JSON only with shape:",
    '{"cwd":"<candidate path>","commands":{"setup":"...","lint":"...","build":"..."},"rationale":"short reason"}',
    "Only include commands that should actually run for this repo. Omit missing/non-authoritative stages.",
  ].filter(Boolean).join("\n\n");
}

export function parseVerificationPlan(outputText: string): {
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

export function sanitizeVerificationPlan(
  parsed: { cwd?: string; commands?: VerificationCommandConfig; rationale?: string },
  evidence: VerificationEvidence,
  selectedSkill: { id: string; version: string; mode: "verification" | "repair"; selectionReasons: string[] },
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
    selectionSource: "ai",
    rationale: typeof parsed.rationale === "string" && parsed.rationale.trim() ? parsed.rationale.trim() : undefined,
    skill: selectedSkill,
    evidence: {
      ...evidence,
      selectedCandidate: chosenCandidate,
      commandDecisions: explainCommandSelection(evidence.configuredCommands, commands, chosenCandidate),
    },
  };
}

export function validateSelectedCommands(
  selected: VerificationCommandConfig | undefined,
  evidence: VerificationEvidence,
  chosenCandidate?: VerificationCwdCandidate,
): VerificationCommandConfig {
  if (!selected || Object.keys(selected).filter((name) => name !== "cwd").length === 0) {
    throw new VerificationPlanningError("VERIFICATION_PLANNER_EMPTY_COMMANDS: Verification planner selected no commands.");
  }
  const result: VerificationCommandConfig = {};
  for (const name of ["setup", "lint", "typecheck", "test", "build"] as const) {
    const requested = selected?.[name];
    if (!requested) {
      continue;
    }
    const candidateAllows = chosenCandidate?.allowedCommands.includes(requested) ?? false;
    const normalizedConfiguredCommand = normalizeCommandForCandidate(requested, name, chosenCandidate);
    const configuredAllows = Object.values(evidence.configuredCommands).includes(requested)
      && (!parsePackageScriptCommand(requested) || normalizedConfiguredCommand === requested);
    if (!candidateAllows && !configuredAllows) {
      throw new VerificationPlanningError(`VERIFICATION_PLANNER_INVALID_COMMAND: Verification planner selected non-authoritative command for ${name}: ${requested}`);
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

export function determineResolutionFromEvidence(
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


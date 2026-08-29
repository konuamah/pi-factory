// Dependency remediation helpers — extracted from dependencies.ts.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathExists } from "./fs-utils.js";

export const SHELL_BUILTINS = new Set([
  "cd", "export", "source", ".", "alias", "unalias",
  "echo", "printf", "read", "test", "true", "false",
  "shift", "set", "unset", "eval", "exec", "return",
  "exit", "trap", "wait", "kill", "jobs", "bg", "fg",
  "hash", "type", "command", "builtin",
]);


const ENVIRONMENT_ALTERNATIVES: Record<string, string[]> = {
  python: ["python3"],
  pip: ["pip3"],
};

// Safe automatic replacements. Factory applies these only after user approval.

const SAFE_REMEDIATIONS: Record<string, string[]> = {
  pip: ["pip3"],
  python: ["python3"],
  mvn: ["./mvnw"],
  gradle: ["./gradlew"],
};

import { extractExecutable } from "./dependencies.js";
import type { PreflightResult, DependencyHydrationRemediationCandidate, DependencyHydrationCommand } from "./dependencies.js";

const execFileAsync = promisify(execFile);
const commandExists = async (command: string): Promise<boolean> => {
  try {
    await execFileAsync(command, ["--version"], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
};

export async function buildRemediationCandidate(
  step: DependencyHydrationCommand,
  executable: string,
): Promise<DependencyHydrationRemediationCandidate | undefined> {
  const replacement = await findSafeReplacement(executable);
  if (!replacement) return undefined;
  const remediatedCommand = replaceExecutableInCommand(step.command, executable, replacement);
  return {
    executable,
    replacement,
    originalCommand: step.command,
    remediatedCommand: remediatedCommand.trim(),
    stepName: step.name,
    reason: `${executable} is unavailable; ${replacement} was found in PATH.`,
    confidence: "HIGH",
    temporary: true,
  };
}

export async function findAlternatives(executable: string): Promise<string[]> {
  const known = ENVIRONMENT_ALTERNATIVES[executable] ?? [];
  const found: string[] = [];
  for (const alt of known) {
    if (await commandExists(alt)) found.push(alt);
  }
  return found;
}

export async function remediateSetupCommands(
  steps: DependencyHydrationCommand[],
): Promise<DependencyHydrationRemediationCandidate | undefined> {
  for (const step of steps) {
    const executable = extractExecutable(step.command);
    if (!executable || SHELL_BUILTINS.has(executable)) continue;
    if (executable.startsWith("./") || executable.startsWith("../") || executable.includes("/")) continue;
    const found = await commandExists(executable);
    if (!found) {
      const replacement = await findSafeReplacement(executable);
      if (replacement) {
        const remediatedCommand = replaceExecutableInCommand(step.command, executable, replacement);
        return {
          executable,
          replacement,
          originalCommand: step.command,
          remediatedCommand,
          stepName: step.name,
          reason: `${executable} is unavailable; ${replacement} was found in PATH.`,
          confidence: "HIGH",
          temporary: true,
        };
      }
    }
  }
  return undefined;
}

export function replaceExecutableInCommand(command: string, executable: string, replacement: string): string {
  // Find the executable in the command string, skipping leading 'cd' segments.
  const segments = command.split(/(\s*&&\s*|\s*;\s*|\s*\|\s*)/);
  const execPattern = new RegExp(["^", "\\s*", escapeRegExp(executable), "\\s"].join(""));
  return segments.map((seg) => {
    // Only replace in non-separator segments (actual commands)
    if (/^\s*[;&|]+\s*$/.test(seg)) return seg;
    return seg.replace(execPattern, `${replacement} `);
  }).join("");
}

export function applyRemediation(
  steps: DependencyHydrationCommand[],
  remediation: DependencyHydrationRemediationCandidate,
): DependencyHydrationCommand[] {
  return steps.map((step) => ({
    ...step,
    command: step.name === remediation.stepName
      ? remediation.remediatedCommand
      : step.command,
  }));
}

export async function findSafeReplacement(executable: string): Promise<string | undefined> {
  const candidates = SAFE_REMEDIATIONS[executable] ?? [];
  for (const candidate of candidates) {
    // Relative paths (./mvnw, ./gradlew) are checked against workspace; bare names (pip3, python3) against PATH.
    if (candidate.startsWith("./") || candidate.startsWith("../")) {
      // wrapper scripts must exist in the workspace; caller provides workspace
      // via commandExists shell probe, which also resolves relative paths
      if (await commandExists(candidate)) return candidate;
    } else {
      if (await commandExists(candidate)) return candidate;
    }
  }
  return undefined;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildExecutionRemediationCandidate(
  step: DependencyHydrationCommand,
  command: string,
  error: unknown,
  cwd: string,
): DependencyHydrationRemediationCandidate | undefined {
  const details = error as { stderr?: string; stdout?: string };
  const output = `${details.stderr ?? ""}\n${details.stdout ?? ""}`;
  if (!/externally-managed-environment|PEP 668/i.test(output)) return undefined;
  const executable = extractExecutable(command);
  if (executable !== "pip" && executable !== "pip3") return undefined;
  const replacement = ".venv/bin/python -m pip";
  const remediatedCommand = command.replace(
    new RegExp(["\\\\b", escapeRegExp(executable), "\\\\b"].join("")),
    replacement,
  );
  const venvCommand = remediatedCommand.includes("&&")
    ? remediatedCommand.replace(/^(.*?&&\\s*)/, "$1python3 -m venv .venv && ")
    : `python3 -m venv .venv && ${remediatedCommand}`;
  return {
    executable,
    replacement,
    originalCommand: command,
    remediatedCommand: venvCommand,
    stepName: step.name,
    reason: "The Python environment is externally managed; install into a workspace-local virtual environment instead.",
    confidence: "HIGH",
    temporary: true,
    category: "isolated-environment",
  };
}

export function truncate(value: string | undefined): string | undefined {
  if (!value) return value;
  return value.length > 4000 ? `${value.slice(0, 4000)}\n[truncated]` : value;
}


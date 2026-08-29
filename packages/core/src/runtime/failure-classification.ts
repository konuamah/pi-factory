import type { VerificationCommandResult, VerificationPlan, VerificationRunResult } from "./verification.js";

export type FailureCategory =
  | "missing-executable"
  | "invalid-command"
  | "missing-dependency"
  | "environment-policy"
  | "real-code-failure"
  | "baseline-unrelated"
  | "harness/config"
  | "unknown";

export interface CommandFailureClassification {
  commandName: string;
  category: FailureCategory;
  reason: string;
  retryable: boolean;
  suggestedAction: "repair" | "prepare-environment" | "diagnose" | "ignore" | "blocker";
}

export interface VerificationFailureClassification {
  kind: FailureCategory;
  reason: string;
  retryable: boolean;
  suggestedPhase: string;
  /** New: per-command breakdown */
  perCommand: CommandFailureClassification[];
}

/**
 * Classify each failed command independently.
 */
export function classifyVerificationFailures(input: {
  plan: VerificationPlan;
  result: VerificationRunResult;
  changedFiles?: string[];
}): CommandFailureClassification[] {
  const failed = input.result.commands.filter((command) => command.status === "failed");
  return failed.map((command) => classifySingleCommand(command, input.result.cwd, input.changedFiles));
}

/**
 * Aggregate per-command classifications into one combined result.
 * Preserves backward compatibility with existing code.
 */
export function classifyVerificationFailure(input: {
  plan: VerificationPlan;
  result: VerificationRunResult;
  changedFiles?: string[];
}): VerificationFailureClassification | undefined {
  if (input.result.overallStatus !== "failed") {
    return undefined;
  }

  const perCommand = classifyVerificationFailures(input);

  if (perCommand.length === 0) {
    return {
      kind: "unknown",
      reason: "Verification reported failure without failed command details.",
      retryable: true,
      suggestedPhase: "verification",
      perCommand: [],
    };
  }

  // Aggregate: highest priority category wins
  const priority: FailureCategory[] = [
    "harness/config",
    "invalid-command",
    "environment-policy",
    "missing-executable",
    "missing-dependency",
    "real-code-failure",
    "baseline-unrelated",
    "unknown",
  ];
  const best = perCommand
    .filter((c) => !["baseline-unrelated", "unknown"].includes(c.category))
    .sort((a, b) => priority.indexOf(a.category) - priority.indexOf(b.category))[0];

  const kind = best?.category ?? perCommand[0]?.category ?? "unknown";
  const retryable = perCommand.some((c) => c.retryable && c.category !== "baseline-unrelated");
  const suggestedPhase = suggestedPhaseForCategory(kind);

  return {
    kind,
    reason: perCommand.map((c) => `${c.commandName}: ${c.reason}`).join("; "),
    retryable,
    suggestedPhase,
    perCommand,
  };
}

function classifySingleCommand(
  command: VerificationCommandResult,
  cwd: string,
  changedFiles?: string[],
): CommandFailureClassification {
  const text = `${command.stderr ?? ""}\n${command.stdout ?? ""}`.toLowerCase();

  // Forced failures from harness
  if (command.name === "forced-failure" || /FACTORY_PI_FORCE_VERIFY_FAIL/.test(command.command)) {
    return {
      commandName: command.name,
      category: "harness/config",
      reason: "Failure forced by the harness environment.",
      retryable: true,
      suggestedAction: "blocker",
    };
  }

  // Exit code 127 = command not found
  if (looksLikeMissingCommand(command)) {
    return {
      commandName: command.name,
      category: "missing-executable",
      reason: `Command not available: ${command.command.split(/\s+/)[0]}`,
      retryable: true,
      suggestedAction: "prepare-environment",
    };
  }

  // Permission / policy failures
  if (/externally-managed-environment|PEP 668|permission denied|EACCES/.test(text)) {
    return {
      commandName: command.name,
      category: "environment-policy",
      reason: extractFirstLine(text),
      retryable: true,
      suggestedAction: "prepare-environment",
    };
  }

  // Missing dependencies
  if (/module not found|cannot find module|no such module|ModuleNotFoundError|ImportError/.test(text)) {
    return {
      commandName: command.name,
      category: "missing-dependency",
      reason: extractFirstLine(text),
      retryable: true,
      suggestedAction: "prepare-environment",
    };
  }

  // Harness / workspace mismatch
  if (looksLikeHarnessMismatch(command)) {
    return {
      commandName: command.name,
      category: "harness/config",
      reason: "Verification appears to be running in the wrong workspace or without required project files.",
      retryable: true,
      suggestedAction: "diagnose",
    };
  }

  // Invalid command (e.g. next lint unsupported, unknown script)
  if (looksLikeInvalidCommand(command)) {
    return {
      commandName: command.name,
      category: "invalid-command",
      reason: extractFirstLine(text),
      retryable: true,
      suggestedAction: "diagnose",
    };
  }

  // Real code failure (TypeScript errors, test failures, lint errors on code)
  if (looksLikeCodeFailure(command)) {
    // Check if failure is unrelated to changes (baseline)
    if (changedFiles && changedFiles.length > 0) {
      const failureFiles = extractReferencedFiles(command, cwd);
      const hasRelatedFailure = failureFiles.some((failureFile) =>
        changedFiles.some((changedFile) => filesReferToSamePath(failureFile, changedFile))
      );
      if (failureFiles.length > 0 && !hasRelatedFailure) {
        return {
          commandName: command.name,
          category: "baseline-unrelated",
          reason: `Failure outside implemented files: ${failureFiles.slice(0, 3).join(", ")}`,
          retryable: false,
          suggestedAction: "ignore",
        };
      }
    }
    return {
      commandName: command.name,
      category: "real-code-failure",
      reason: extractFirstLine(text),
      retryable: true,
      suggestedAction: "repair",
    };
  }

  return {
    commandName: command.name,
    category: "unknown",
    reason: `Verification command failed (exit ${command.exitCode ?? "?"}): ${command.command}`,
    retryable: true,
    suggestedAction: "diagnose",
  };
}

// --- pattern matchers ---

function looksLikeMissingCommand(command: VerificationCommandResult): boolean {
  const text = `${command.stderr ?? ""}\n${command.stdout ?? ""}`.toLowerCase();
  return command.exitCode === 127
    || /not recognized as an internal or external command/.test(text)
    || /command not found/.test(text)
    || /missing script/.test(text)
    || /npm error missing script/.test(text)
    || /could not determine executable to run/.test(text);
}

function looksLikeHarnessMismatch(command: VerificationCommandResult): boolean {
  const text = `${command.stderr ?? ""}\n${command.stdout ?? ""}`.toLowerCase();
  return /no such file or directory/.test(text)
    || /could not read package\.json/.test(text)
    || /enoent/.test(text);
}

function looksLikeInvalidCommand(command: VerificationCommandResult): boolean {
  const text = `${command.stderr ?? ""}\n${command.stdout ?? ""}`.toLowerCase();
  return /invalid project directory/.test(text)
    || /unsupported command/.test(text)
    || /unknown option/.test(text)
    || /no such command/.test(text);
}

function looksLikeCodeFailure(command: VerificationCommandResult): boolean {
  const text = `${command.stderr ?? ""}\n${command.stdout ?? ""}`.toLowerCase();
  if (command.exitCode && command.exitCode > 0 && command.exitCode !== 127) {
    return true;
  }
  return /TS\d{4}/.test(text)
    || /type error/.test(text)
    || /eslint error/.test(text)
    || /lint error/.test(text)
    || /FAILED/.test(text)
    || /\d+:\d+\s+error/.test(text)
    || /error\s+\d+/.test(text);
}

function suggestedPhaseForCategory(category: FailureCategory): string {
  switch (category) {
    case "harness/config": return "verification-planning";
    case "invalid-command": return "verification-planning";
    case "missing-executable": return "verification-planning";
    case "missing-dependency": return "verification-planning";
    case "environment-policy": return "verification-planning";
    case "real-code-failure": return "verification";
    case "baseline-unrelated": return "verification";
    case "unknown": return "verification";
  }
}

function extractFirstLine(text: string): string {
  const lines = text.trim().split("\n").filter(Boolean);
  return lines[0]?.slice(0, 200) ?? "Verification command failed.";
}

function extractReferencedFiles(command: VerificationCommandResult, cwd: string): string[] {
  const text = `${command.stdout ?? ""}\n${command.stderr ?? ""}`;
  const files = new Set<string>();
  const escapedCwd = escapeRegExp(cwd.replace(/\\/g, "/"));
  const absolutePattern = new RegExp(`${escapedCwd}/([^:\\n]+?\\.(?:js|jsx|ts|tsx|mjs|cjs))(?:[:\\n]|$)`, "g");
  for (const match of text.replace(/\\/g, "/").matchAll(absolutePattern)) {
    if (match[1]) {
      files.add(match[1]);
    }
  }

  const relativePattern = /(?:^|\n)\s*((?:\.\/)?(?:src|app|hooks|components|pages|lib|utils|server|services|docs)\/[^:\n]+?\.(?:js|jsx|ts|tsx|mjs|cjs))(?:[:\n]|$)/g;
  for (const match of text.replace(/\\/g, "/").matchAll(relativePattern)) {
    if (match[1]) {
      files.add(match[1].replace(/^\.\//, ""));
    }
  }
  return [...files];
}

function filesReferToSamePath(left: string, right: string): boolean {
  const a = normalizePathForComparison(left);
  const b = normalizePathForComparison(right);
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function normalizePathForComparison(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

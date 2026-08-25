import type { VerificationCommandResult, VerificationPlan, VerificationRunResult } from "./verification.js";

export type VerificationFailureKind = "harness/config" | "repo script/config" | "baseline/unrelated" | "real code failure" | "unknown";

export interface VerificationFailureClassification {
  kind: VerificationFailureKind;
  reason: string;
  retryable: boolean;
  suggestedPhase: string;
}

export function classifyVerificationFailure(input: {
  plan: VerificationPlan;
  result: VerificationRunResult;
  changedFiles?: string[];
}): VerificationFailureClassification | undefined {
  if (input.result.overallStatus !== "failed") {
    return undefined;
  }

  const failed = input.result.commands.filter((command) => command.status === "failed");
  if (failed.length === 0) {
    return {
      kind: "unknown",
      reason: "Verification reported failure without failed command details.",
      retryable: true,
      suggestedPhase: "verification",
    };
  }

  if (failed.some((command) => command.name === "forced-failure" || /FACTORY_PI_FORCE_VERIFY_FAIL/.test(command.command))) {
    return {
      kind: "harness/config",
      reason: "Verification failure was forced by the harness environment.",
      retryable: true,
      suggestedPhase: "verification",
    };
  }

  const missingCommands = failed.filter((command) => looksLikeMissingCommand(command));
  if (missingCommands.length > 0) {
    return {
      kind: "repo script/config",
      reason: `Verification command could not be executed: ${missingCommands.map((command) => command.name).join(", ")}.`,
      retryable: true,
      suggestedPhase: "verification-planning",
    };
  }

  const likelyHarnessMismatch = failed.find((command) => looksLikeHarnessMismatch(command));
  if (likelyHarnessMismatch) {
    return {
      kind: "harness/config",
      reason: `Verification appears to be running in the wrong workspace or without required project files (${likelyHarnessMismatch.name}).`,
      retryable: true,
      suggestedPhase: "verification-planning",
    };
  }

  const failedScripts = failed.filter((command) => isDeclaredScriptCommand(command.command));
  if (failedScripts.length > 0) {
    const changedFiles = normalizePathSet(input.changedFiles ?? []);
    if (changedFiles.size > 0) {
      const failureFiles = normalizePathSet(
        failedScripts.flatMap((command) => extractReferencedFiles(command, input.result.cwd)),
      );
      const intersectsChangedFiles = [...failureFiles].some((file) => changedFiles.has(file));
      if (failureFiles.size > 0 && !intersectsChangedFiles) {
        return {
          kind: "baseline/unrelated",
          reason: `Repository verification failed outside the implemented files: ${[...failureFiles].slice(0, 5).join(", ")}.`,
          retryable: false,
          suggestedPhase: "verification",
        };
      }
    }
    return {
      kind: "real code failure",
      reason: `Repository verification script failed: ${failedScripts.map((command) => command.name).join(", ")}.`,
      retryable: true,
      suggestedPhase: "verification",
    };
  }

  return {
    kind: "unknown",
    reason: `Verification failed in ${input.result.cwd}.`,
    retryable: true,
    suggestedPhase: "verification",
  };
}

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
    || /cannot find module/.test(text)
    || /could not read package\.json/.test(text)
    || /enoent/.test(text)
    || /tsconfig\.json/.test(text) && /not found/.test(text);
}

function isDeclaredScriptCommand(command: string): boolean {
  return /^(pnpm|npm|yarn)\s+(run\s+)?[a-z0-9:_-]+$/i.test(command.trim());
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

  const relativePattern = /(?:^|\n)\s*((?:\.\/)?(?:src|app|hooks|components|pages|lib|utils|server|services|slammservices|docs)\/[^:\n]+?\.(?:js|jsx|ts|tsx|mjs|cjs))(?:[:\n]|$)/g;
  for (const match of text.replace(/\\/g, "/").matchAll(relativePattern)) {
    if (match[1]) {
      files.add(match[1].replace(/^\.\//, ""));
    }
  }
  return [...files];
}

function normalizePathSet(files: string[]): Set<string> {
  return new Set(
    files
      .map((file) => file.replace(/\\/g, "/").replace(/^\.\//, "").trim())
      .filter(Boolean),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

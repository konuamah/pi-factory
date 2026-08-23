import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  ArtifactRequirement,
  CommandRequirement,
  ProviderVerificationResult,
  VerificationProvider,
  VerificationProviderContext,
} from "../types.js";

const execAsync = promisify(exec);

export const commandProvider: VerificationProvider = {
  type: "COMMAND",
  async verify(requirement, context): Promise<ProviderVerificationResult> {
    const command = requirement as CommandRequirement;
    const cwd = command.cwd ? path.resolve(context.cwd, command.cwd) : context.cwd;
    const evidenceId = `EV-${++evidenceCounter}`;
    try {
      const { stdout, stderr } = await execAsync(command.command, {
        cwd,
        windowsHide: true,
        timeout: 120_000,
      });
      context.evidence[evidenceId] = {
        kind: "command-result",
        command: command.command,
        exitCode: 0,
        stdout: truncate(stdout),
        stderr: truncate(stderr),
      };
      return {
        requirementId: requirement.id,
        status: "PASS",
        evidence: [{ id: evidenceId, kind: "command-result" }],
      };
    } catch (error) {
      const execError = error as Error & { code?: number; stdout?: string; stderr?: string };
      context.evidence[evidenceId] = {
        kind: "command-result",
        command: command.command,
        exitCode: execError.code,
        stdout: truncate(execError.stdout ?? ""),
        stderr: truncate(execError.stderr ?? String(error)),
      };
      return {
        requirementId: requirement.id,
        status: "FAIL",
        evidence: [{ id: evidenceId, kind: "command-result" }],
        reason: `Command failed with exit code ${execError.code ?? "unknown"}`,
      };
    }
  },
};

export const artifactProvider: VerificationProvider = {
  type: "ARTIFACT",
  async verify(requirement, context): Promise<ProviderVerificationResult> {
    const artifact = requirement as ArtifactRequirement;
    const evidenceId = `EV-${++evidenceCounter}`;
    const targetPath = artifact.path ? path.resolve(context.cwd, artifact.path) : undefined;

    let exists = false;
    if (targetPath) {
      exists = await fileExists(targetPath);
    } else if (artifact.pattern) {
      exists = await patternExists(context.cwd, artifact.pattern);
    }

    context.evidence[evidenceId] = {
      kind: "artifact-check",
      path: targetPath ?? artifact.pattern,
      exists,
      mustExist: artifact.mustExist,
    };

    if (artifact.mustExist && !exists) {
      return {
        requirementId: requirement.id,
        status: "FAIL",
        evidence: [{ id: evidenceId, kind: "artifact-check" }],
        reason: `Expected artifact does not exist: ${artifact.path ?? artifact.pattern}`,
      };
    }
    if (!artifact.mustExist && exists) {
      return {
        requirementId: requirement.id,
        status: "FAIL",
        evidence: [{ id: evidenceId, kind: "artifact-check" }],
        reason: `Unexpected artifact exists: ${artifact.path ?? artifact.pattern}`,
      };
    }
    return {
      requirementId: requirement.id,
      status: "PASS",
      evidence: [{ id: evidenceId, kind: "artifact-check" }],
    };
  },
};

let evidenceCounter = 0;

function truncate(value: string, maxLength = 2000): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function patternExists(root: string, pattern: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(root, { recursive: true });
    const normalizedPattern = pattern.replace(/\\/g, "/").replace(/^\*\*?\//, "").replace(/\/\*\*$/, "");
    return entries.some((entry) => entry.toString().includes(normalizedPattern));
  } catch {
    return false;
  }
}

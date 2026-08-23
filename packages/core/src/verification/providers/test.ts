import { exec } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type {
  ProviderVerificationResult,
  TestRequirement,
  VerificationProvider,
  VerificationProviderContext,
} from "../types.js";

const execAsync = promisify(exec);

export const testProvider: VerificationProvider = {
  type: "TEST",
  async verify(requirement, context): Promise<ProviderVerificationResult> {
    const test = requirement as TestRequirement;
    if (!test.command) {
      return {
        requirementId: requirement.id,
        status: "BLOCKED",
        evidence: [],
        reason: "Test requirement has no command; cannot verify.",
      };
    }
    const evidenceId = `EV-${++testCounter}`;
    const cwd = test.cwd ? path.resolve(context.cwd, test.cwd) : context.cwd;
    try {
      const { stdout, stderr } = await execAsync(test.command, {
        cwd,
        windowsHide: true,
        timeout: 180_000,
      });
      const passed = countPassed(stdout, test.selector);
      context.evidence[evidenceId] = {
        kind: "test-result",
        command: test.command,
        selector: test.selector,
        exitCode: 0,
        passed,
        minimumPassed: test.minimumPassed,
        stdout: stdout.slice(0, 2000),
        stderr: stderr.slice(0, 2000),
      };
      if (test.minimumPassed !== undefined && passed < test.minimumPassed) {
        return {
          requirementId: requirement.id,
          status: "FAIL",
          evidence: [{ id: evidenceId, kind: "test-result" }],
          reason: `Only ${passed} tests passed; expected at least ${test.minimumPassed}.`,
        };
      }
      return {
        requirementId: requirement.id,
        status: "PASS",
        evidence: [{ id: evidenceId, kind: "test-result" }],
      };
    } catch (error) {
      const execError = error as Error & { code?: number; stdout?: string; stderr?: string };
      context.evidence[evidenceId] = {
        kind: "test-result",
        command: test.command,
        selector: test.selector,
        exitCode: execError.code,
        stdout: (execError.stdout ?? "").slice(0, 2000),
        stderr: (execError.stderr ?? String(error)).slice(0, 2000),
      };
      return {
        requirementId: requirement.id,
        status: "FAIL",
        evidence: [{ id: evidenceId, kind: "test-result" }],
        reason: `Test command failed with exit code ${execError.code ?? "unknown"}.`,
      };
    }
  },
};

let testCounter = 0;

function countPassed(stdout: string, selector?: string): number {
  if (!selector) {
    return stdout.includes("fail") ? 0 : 1;
  }
  const lines = stdout.split(/\r?\n/).filter((line) => line.includes(selector));
  return lines.filter((line) => /pass|ok|✓/.test(line)).length;
}

import { exec } from "node:child_process";
import { promisify } from "node:util";

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
  commands: VerificationCommandResult[];
  overallStatus: "passed" | "failed" | "incomplete";
}

export async function runVerificationCommands(input: {
  cwd: string;
  commands: {
    lint?: string;
    typecheck?: string;
    test?: string;
    build?: string;
  };
}): Promise<VerificationRunResult> {
  const results: VerificationCommandResult[] = [];

  for (const [name, command] of Object.entries(input.commands)) {
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
        cwd: input.cwd,
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
    commands: results,
    overallStatus: hasFailed ? "failed" : hasMissing ? "incomplete" : "passed",
  };
}

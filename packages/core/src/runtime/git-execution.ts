import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRecoveryPullRequest } from "../git/pull-request.js";
import { classifyEffects } from "./git-command-effects.js";
import { gitCommandArgv, parseGitAction } from "./git-command-parser.js";
import type { LandingAction, LandingExecutionResult, LandingPlan } from "./landing-types.js";

const execFileAsync = promisify(execFile);

export interface LandingStepResult {
  index: number;
  args: string[];
  status: "applied" | "blocked";
  exitCode?: number;
  stderr?: string;
}

export async function executeLandingPlan(input: {
  cwd: string;
  plan: LandingPlan;
  runId?: string;
  pr?: { enabled?: boolean; provider?: "github"; cli?: "gh"; draft?: boolean };
}): Promise<LandingExecutionResult & { steps: LandingStepResult[] }> {
  const steps: LandingStepResult[] = [];
  for (let index = 0; index < input.plan.actions.length; index += 1) {
    const action = input.plan.actions[index];
    if (action.kind === "pull-request") {
      const result = await createRecoveryPullRequest({
        cwd: input.cwd, sourceBranch: action.sourceBranch, targetBranch: action.targetBranch,
        runId: input.runId ?? "unknown", goal: action.title, reason: action.body,
        enabled: input.pr?.enabled, provider: input.pr?.provider ?? action.provider,
        cli: input.pr?.cli, draft: action.draft,
      });
      if (result.status === "created" || result.status === "existing") return { status: "pull-request", outcome: `pull-request-${result.status}`, reason: result.reason, steps };
      return { status: "blocked", outcome: "pull-request-failed", reason: result.reason, steps };
    }
    const parsed = parseGitAction({ args: action.step.args });
    if (!parsed.ok) return { status: "blocked", outcome: "unsafe-plan", reason: parsed.reason, steps };
    const argv = gitCommandArgv(parsed.command);
    classifyEffects(parsed.command, { repoRoot: input.cwd });
    try {
      await execFileAsync("git", argv, { cwd: input.cwd, windowsHide: true });
      steps.push({ index, args: argv, status: "applied" });
    } catch (error) {
      const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : String(error);
      await abortGitOperation(input.cwd, parsed.command.command);
      steps.push({ index, args: argv, status: "blocked", stderr });
      return { status: "blocked", outcome: /conflict/i.test(stderr) ? `${parsed.command.command}-conflict` : "unknown", reason: stderr, steps };
    }
  }
  return { status: "landed", outcome: "landed", steps };
}

async function abortGitOperation(cwd: string, command: string): Promise<void> {
  const abort = command === "cherry-pick" || command === "rebase" || command === "merge" ? [command, "--abort"] : undefined;
  if (!abort) return;
  try { await execFileAsync("git", abort, { cwd, windowsHide: true }); } catch { /* cleanup is best effort */ }
}

export function actionArgs(action: LandingAction): string[] | undefined {
  return action.kind === "git" ? action.step.args : undefined;
}

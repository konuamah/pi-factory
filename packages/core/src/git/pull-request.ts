import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RecoveryPullRequestInput {
  cwd: string;
  sourceBranch: string;
  targetBranch: string;
  runId: string;
  goal: string;
  reason: string;
  candidateSha?: string;
  enabled?: boolean;
  provider?: "github";
  cli?: "gh";
  draft?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface RecoveryPullRequestResult {
  status: "created" | "existing" | "skipped" | "failed";
  url?: string;
  sourceBranch: string;
  targetBranch: string;
  reason: string;
}

/**
 * Publish a valid candidate as a GitHub pull request.
 *
 * Authentication is delegated to the user's authenticated `gh` installation.
 * Factory never reads, stores, or prints GitHub credentials or tokens.
 */
export async function createRecoveryPullRequest(
  input: RecoveryPullRequestInput,
): Promise<RecoveryPullRequestResult> {
  const base = {
    sourceBranch: input.sourceBranch,
    targetBranch: input.targetBranch,
  };
  if (input.enabled === false) {
    return { ...base, status: "skipped", reason: "Pull request fallback is disabled by configuration." };
  }
  if (input.provider && input.provider !== "github") {
    return { ...base, status: "failed", reason: `Unsupported pull request provider: ${input.provider}` };
  }
  if (input.cli && input.cli !== "gh") {
    return { ...base, status: "failed", reason: `Unsupported pull request CLI: ${input.cli}` };
  }
  if (!input.sourceBranch || !input.targetBranch) {
    return { ...base, status: "failed", reason: "A source branch and target branch are required to create a pull request." };
  }

  try {
    let pushed = false;
    try {
      await execFileAsync("git", ["push", "--set-upstream", "origin", input.sourceBranch], {
        cwd: input.cwd,
        windowsHide: true,
        env: pushEnv(input.env),
      });
      pushed = true;
    } catch (pushError) {
      // Fail fast with an actionable reason; the candidate commit and branch
      // remain preserved locally and blocked runs keep their worktree.
      return {
        ...base,
        status: "failed",
        reason: `Candidate branch was not pushed: ${classifyPushFailure(pushError)} The candidate${input.candidateSha ? ` commit ${input.candidateSha}` : ""} is preserved locally on branch '${input.sourceBranch}'.`,
      };
    }

    const existing = await findExistingPullRequest(input);
    if (existing) {
      return { ...base, status: "existing", url: existing, reason: "A pull request already exists for the candidate branch." };
    }

    const title = `Factory: ${compactTitle(input.goal)}`;
    const body = [
      "## Factory candidate",
      "",
      `This pull request was opened automatically because Factory could not safely land the approved candidate directly into \`${input.targetBranch}\`.`,
      "",
      `- Factory run: \`${input.runId}\``,
      `- Candidate branch: \`${input.sourceBranch}\``,
      ...(input.candidateSha ? [`- Candidate commit: \`${input.candidateSha}\``] : []),
      `- Landing reason: ${input.reason}`,
      "",
      "Please review the candidate and merge it through the repository's normal GitHub review process.",
    ].join("\n");
    const args = [
      "pr",
      "create",
      "--base",
      input.targetBranch,
      "--head",
      input.sourceBranch,
      "--title",
      title,
      "--body",
      body,
    ];
    if (input.draft) args.push("--draft");

    try {
      const { stdout } = await execFileAsync("gh", args, {
        cwd: input.cwd,
        windowsHide: true,
        env: input.env,
      });
      const url = stdout.trim().split(/\s+/).find((value) => /^https:\/\/github\.com\//.test(value));
      if (!url) {
        return { ...base, status: "failed", reason: "GitHub CLI created no detectable pull request URL." };
      }
      return { ...base, status: "created", url, reason: "Candidate branch pushed and pull request created." };
    } catch (prError) {
      return {
        ...base,
        status: "failed",
        reason: pushed
          ? `Candidate branch '${input.sourceBranch}' was pushed to origin, but pull request creation failed: ${classifyGhFailure(prError)}`
          : `Pull request creation failed: ${classifyGhFailure(prError)}`,
      };
    }
  } catch (error) {
    return {
      ...base,
      status: "failed",
      reason: `Could not publish candidate pull request: ${redactCredentialLikeText(formatError(error))}`,
    };
  }
}

/**
 * Headless push: never hang waiting for a credential prompt. Callers may
 * override by setting GIT_TERMINAL_PROMPT in their own env.
 */
function pushEnv(userEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...(userEnv ?? process.env),
    GIT_TERMINAL_PROMPT: userEnv?.GIT_TERMINAL_PROMPT ?? "0",
  };
}

function classifyPushFailure(error: unknown): string {
  const raw = formatError(error);
  if (/no configured push destination|does not appear to be a git repository|not a git repository|no such remote/i.test(raw)) {
    return "No git remote is configured for this repository. Add one (for example 'git remote add origin ...') to enable pull request recovery, merge the candidate manually, or set git.pullRequest.enabled: false.";
  }
  if (/authentication|permission|denied|403|could not read from remote/i.test(raw)) {
    return "The remote rejected the push (missing credentials or permissions).";
  }
  if (/fetch first|non-fast-forward/i.test(raw)) {
    return "The remote branch diverged; fetch and reconcile before pushing.";
  }
  return redactCredentialLikeText(raw);
}

function classifyGhFailure(error: unknown): string {
  const raw = formatError(error);
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ENOENT" || /spawn gh/i.test(raw)) {
    return "the GitHub CLI (gh) is not installed. Install it from https://cli.github.com, run 'gh auth login', then retry, or merge the pushed branch manually.";
  }
  if (/gh auth login|not logged in|authentication|unauthorized|401/i.test(raw)) {
    return "gh is not authenticated. Run 'gh auth login', then retry; the candidate branch is already pushed.";
  }
  if (/not a github|gitlab|bitbucket/i.test(raw)) {
    return "the remote is not a GitHub repository, so gh cannot open a pull request there. Merge the pushed branch with your host's own review flow.";
  }
  return redactCredentialLikeText(raw);
}

async function findExistingPullRequest(input: RecoveryPullRequestInput): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["pr", "list", "--head", input.sourceBranch, "--base", input.targetBranch, "--state", "open", "--json", "url", "--jq", ".[0].url"],
      { cwd: input.cwd, windowsHide: true, env: input.env },
    );
    const url = stdout.trim();
    return /^https:\/\/github\.com\//.test(url) ? url : undefined;
  } catch {
    return undefined;
  }
}

function compactTitle(goal: string): string {
  const title = goal
    .replace(/^.*?\/(?:[^/\\]+[\\/])*/, "")
    .replace(/\s+/g, " ")
    .trim();
  return (title || "approved Factory candidate").slice(0, 95);
}

function formatError(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const value = error as { message?: unknown; stderr?: unknown };
  return [value.message, value.stderr]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(": ") || String(error);
}

function redactCredentialLikeText(value: string): string {
  return value
    .replace(/gho_[A-Za-z0-9_-]+/g, "gho_[REDACTED]")
    .replace(/github_pat_[A-Za-z0-9_-]+/g, "github_pat_[REDACTED]")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]");
}

export type GitCommand = {
  command: "merge" | "rebase" | "cherry-pick" | "checkout" | "switch" | "branch" | "reset" | "restore" | "commit" | "fetch" | "push" | "update-ref" | "rev-parse" | "diff" | "status" | "log" | "show";
  args: string[];
};

export type ParseResult<T> = { ok: true; command: T } | { ok: false; reason: string };

const commands = new Set<GitCommand["command"]>([
  "merge", "rebase", "cherry-pick", "checkout", "switch", "branch", "reset", "restore",
  "commit", "fetch", "push", "update-ref", "rev-parse", "diff", "status", "log", "show",
]);
const externalArgs = ["--exec", "-c", "--upload-pack", "--receive-pack", "--config-env"];
const unsafeChars = /[;&|`$\0\n]/;

export function parseGitAction(input: { args: string[] }): ParseResult<GitCommand> {
  const args = input.args;
  if (!Array.isArray(args) || args.length === 0) return { ok: false, reason: "Git command argv is empty" };
  if (args.length > 64) return { ok: false, reason: "Git command argv exceeds 64 arguments" };
  for (const arg of args) {
    if (externalArgs.some((prefix) => arg.startsWith(prefix))) {
      return { ok: false, reason: `Argument enables external execution: ${arg}` };
    }
    if (unsafeChars.test(arg) || arg.split("/").includes("..")) {
      return { ok: false, reason: "Path argument escapes worktree" };
    }
  }
  const [verb, ...rest] = args;
  if (!commands.has(verb as GitCommand["command"])) return { ok: false, reason: `Unsupported git command: ${verb}` };
  return { ok: true, command: { command: verb as GitCommand["command"], args: rest } };
}

export function gitCommandArgv(command: GitCommand): string[] {
  return [command.command, ...command.args];
}

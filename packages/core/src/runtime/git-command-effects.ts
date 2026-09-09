import type { GitCommand } from "./git-command-parser.js";

export interface GitEffects {
  modifiesWorktree: boolean;
  modifiesIndex: boolean;
  createsCommit: boolean;
  movesLocalRefs: boolean;
  modifiesRemoteRefs: boolean;
  mayDiscardChanges: boolean;
  mayOverwriteRef: boolean;
  invokesExternalProcess: boolean;
  modifiesGitConfig: boolean;
  affectedRefs: string[];
  affectedPaths: string[];
  remotes: string[];
}

const empty = (): GitEffects => ({
  modifiesWorktree: false, modifiesIndex: false, createsCommit: false, movesLocalRefs: false,
  modifiesRemoteRefs: false, mayDiscardChanges: false, mayOverwriteRef: false,
  invokesExternalProcess: false, modifiesGitConfig: false, affectedRefs: [], affectedPaths: [], remotes: [],
});

export function classifyEffects(command: GitCommand, _ctx: { repoRoot: string }): GitEffects {
  const e = empty();
  const a = command.args;
  const positional = a.filter((arg) => !arg.startsWith("-"));
  switch (command.command) {
    case "merge": e.modifiesWorktree = e.modifiesIndex = e.createsCommit = e.movesLocalRefs = true; e.affectedRefs = positional; break;
    case "rebase": e.modifiesWorktree = e.modifiesIndex = e.movesLocalRefs = true; e.affectedRefs = positional; break;
    case "cherry-pick": e.modifiesWorktree = e.modifiesIndex = e.createsCommit = e.movesLocalRefs = true; e.affectedRefs = positional; e.mayOverwriteRef = positional.length > 1; break;
    case "checkout": case "switch": e.modifiesWorktree = true; e.affectedRefs = positional; break;
    case "branch": e.movesLocalRefs = true; e.affectedRefs = positional; break;
    case "reset": e.movesLocalRefs = true; e.modifiesIndex = true; e.modifiesWorktree = a.includes("--hard"); e.mayDiscardChanges = a.includes("--hard"); e.affectedRefs = positional; break;
    case "restore": e.modifiesWorktree = a.includes("--worktree") || !a.includes("--staged"); e.modifiesIndex = a.includes("--staged"); e.mayDiscardChanges = a.includes("--worktree") || a.includes("--source"); e.affectedPaths = positional; break;
    case "commit": e.modifiesIndex = e.createsCommit = e.movesLocalRefs = true; break;
    case "fetch": e.movesLocalRefs = true; e.remotes = positional.slice(0, 1); break;
    case "push": e.modifiesRemoteRefs = true; e.remotes = positional.slice(0, 1); e.mayOverwriteRef = a.some((arg) => arg === "--force" || arg === "-f" || arg.startsWith("--force-with-lease")); break;
    case "update-ref": e.movesLocalRefs = true; e.mayOverwriteRef = true; e.affectedRefs = positional; break;
    case "diff": case "status": case "log": case "show": case "rev-parse": break;
  }
  return e;
}

# Pull Request Recovery

Factory uses model judgment to choose a landing strategy. Deterministic code only enforces safety invariants such as valid candidate refs and avoiding unsafe checkout mutations.

When a candidate cannot be landed directly, Factory uses the configured GitHub pull request recovery path:

1. Preserve the candidate branch and commit SHA.
2. Push the candidate branch with `git push`.
3. Use the authenticated `gh` CLI to find an existing open PR or create one.
4. Write the result to `final-merge.json`, `summary.json`, `events.jsonl`, and the run view.
5. Keep the run `BLOCKED / merge-blocked` until a human merges the PR.

A PR-created run is not an implementation failure and is not reported as completed. It is a recoverable delivery state.

## Configuration

```yaml
git:
  baseBranch: main
  pullRequest:
    enabled: true
    provider: github
    cli: gh
    draft: false
```

Factory delegates authentication to the user's `gh` installation. It does not read, store, or print GitHub tokens.

Check authentication before running a task:

```bash
gh auth status
git remote -v
```

## If GitHub is not configured

PR recovery is a best-effort delivery path, not a hard dependency. If it cannot run, Factory says exactly what is missing and the candidate is never lost:

| Situation | What the run reports | Recovery |
| --- | --- | --- |
| No git remote configured | `No git remote is configured...` plus the preserved local branch/SHA | `git remote add origin ...` and retry, or merge the branch manually |
| Push rejected (credentials/permissions) | `The remote rejected the push...` | Fix credentials, then retry with the preserved branch/SHA |
| `gh` not installed | `the GitHub CLI (gh) is not installed...` | Install gh, `gh auth login`, retry — the branch is already pushed |
| `gh` not authenticated | `gh is not authenticated. Run 'gh auth login'...` | Authenticate and retry; the pushed branch is reusable |
| Remote is not GitHub | `the remote is not a GitHub repository...` | Merge the pushed branch with your host's own review flow |
| PR recovery disabled in config | `Pull request fallback is disabled by configuration.` | Land directly after fixing the blocker, or merge the candidate manually |

Pushes run with `GIT_TERMINAL_PROMPT=0`, so a missing credential can never hang the run waiting for an interactive prompt.

In every case the run stays `BLOCKED / merge-blocked`, the worktree and candidate branch are preserved, and `/factory resume` can retry once the blocker is fixed.

## Run artifacts

`final-merge.json` contains:

- `status`: normally `blocked` until the PR is merged;
- `outcome`: `pull-request-created`, `pull-request-existing`, or `pull-request-failed`;
- `candidateBranch` and `candidateSha`;
- `pullRequest.status`, `pullRequest.url`, source/target branches, and the exact reason;
- `recoveryHint` for the next human action.

Use:

```text
/factory show <run-id>
/factory logs <run-id>
```

When a PR exists, review the URL and merge it using the repository's normal GitHub review process. If PR creation fails, fix the reported authentication, remote, or permission issue and retry using the preserved branch and SHA.

## Safety boundary

Factory must not force a merge through dirty overlapping files, unresolved conflicts, missing candidate commits, or unavailable GitHub delivery. “Merging should never fail” means the candidate is never silently lost: Factory lands it directly, repairs/retries it, or publishes it as a PR. It must not mean bypassing repository protection or human review.

# Worktrees And Dependencies

Use this when a user asks whether Factory runs need worktrees, why dependency setup is slow, or how to make many agent workspaces cheaper.

## Base Branch Resolution

Factory targets a concrete base branch for worktrees, verification diffing, landing, and pull-request recovery. The default is `main`, and an explicit branch is always respected.

To target the branch that is checked out in the project root at run start, use the `@current` sentinel (quoted, because `@` is a reserved YAML character):

```yaml
git:
  baseBranch: "@current"
  pullRequest:
    baseBranch: "@current"
project:
  baseBranch: "@current"
```

Behavior:

- The config loader resolves `@current` once per load with `git branch --show-current` in the project root, before validation. All three fields (`git.baseBranch`, `project.baseBranch`, `git.pullRequest.baseBranch`) resolve to the same branch.
- The resolved name is snapshotted in each run's `effective-config.json`, so a run remains inspectable even if you switch branches later.
- Detached HEAD or a non-git directory is a hard error at config load: Factory refuses to start rather than silently targeting the wrong branch.
- `@current` must never survive into the effective config; direct `validateEffectiveConfig` callers are rejected loudly.
- Verification impact filtering diffs `origin/<base>` first and falls back to the local branch, so a local-only branch still gets impact-filtered verification.

Reproducibility note: branch-dependent behavior is session-specific. If you need deterministic runs, use an explicit `baseBranch` instead.

## Worktree Policy

Factory does not require every run to use a worktree. The project config controls this:

```yaml
git:
  allowWorktrees: true
```

`true` keeps run and task work isolated. `false` runs in place.

## Dependency Hydration

Factory keeps worktree source/index state isolated, but dependency downloads and compiler caches can be shared safely.

```yaml
dependencies:
  enabled: true
  hydrate: auto
  cacheRoot: C:/Users/<user>/.factory/cache
```

Purpose:
Provide shared cache environment variables to agent workspaces. The dependency-strategy model may select the workspace, package manager, and setup command from Factory evidence; Factory executes that choice under hard timeouts and preflights verification executables.

Inputs:
- `.factory/config.yaml` `commands.setup`
- dependency manifests and lockfiles
- `dependencies.enabled`
- `dependencies.hydrate`: `auto`, `always`, or `never`
- `dependencies.cacheRoot`

Permissions:
- Uses the existing Factory setup command.
- Requires shell execution only when hydration actually runs.

Confirmation:
Changing dependency policy or cache root is a Factory config write and should be approved when Concierge proposes it.

Command route:
- Broad setup recommendation: `/factory setup`
- Readiness check: `/factory doctor`
- Direct config path: `.factory/config.yaml`

Builder agents receive explicit bootstrap instructions. They should inspect the repository, try the lightest readiness check, use repository wrappers and lockfiles, and avoid lockfile upgrades or system-wide installs.

### One Worktree Per Run

Factory now uses a single worktree for the entire run. All stages — discovery, planning, implementation, verification, and review — share one worktree. Dependencies installed by the builder remain available during verification. Tasks execute sequentially to avoid conflicts in the shared workspace.

Related source:
- `packages/core/src/runtime/dependencies.ts`
- `packages/core/src/runtime/controller.ts`

## Language-Neutral Rule

Hydration is not tied to one language or framework. Factory does not infer a framework-specific installer as the source of truth. It runs the repository's configured `commands.setup` and provides shared cache environment variables for common ecosystems:

- Node package managers: npm, pnpm, yarn, bun
- Python package managers: uv, pip
- Rust: cargo with optional sccache
- Other projects: still use `commands.setup`; unsupported cache variables are harmless.

Factory uses dependency files such as `package.json`, `pnpm-lock.yaml`, `pyproject.toml`, `uv.lock`, `requirements.txt`, `Cargo.lock`, `go.mod`, and Gradle/Maven files when computing the hydration key.

Do not symlink one shared `node_modules`, `.venv`, or writable dependency directory across worktrees. Share immutable package downloads and compiler caches; keep installed workspace state local.

Setup strategy is model-owned when an executor is available, with an evidence-backed deterministic fallback. Factory never trusts an invented workspace or command: it validates the model result, enforces setup limits, and records the selected strategy.

`commands.setup` may be a single shell command or an ordered list of setup steps:

```yaml
commands:
  setup:
    - name: install-frontend
      command: cd frontend/app && npm install
    - name: install-api
      command: cd api && pip install -r requirements.txt
```

Factory runs each setup step in order under `dependencySetupTimeoutMs` and `dependencySetupMaxBufferBytes`. Before blocking verification, it checks every command's executable. Missing dependencies produce a recoverable blocked state with the failing command and a resume path; they do not become a misleading success.

### Blocked by missing dependencies

Install the missing dependency or revise the setup command, then resume the run. `verification.json` is authoritative for verification status, and cleanup can prune old dependency cache entries as well as stale run/worktree state.

## Hydration Modes

- `auto`: run setup only when the workspace marker is missing or stale.
- `always`: run setup every time before work.
- `never`: do not run setup automatically.

The local marker lives under `.factory/dependencies/` inside the workspace. If dependency manifests, lockfiles, platform, runtime, or any setup command changes, the key changes and Factory hydrates again.

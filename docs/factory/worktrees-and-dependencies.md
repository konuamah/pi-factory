# Worktrees And Dependencies

Use this when a user asks whether Factory runs need worktrees, why dependency setup is slow, or how to make many agent workspaces cheaper.

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
Provide shared cache environment variables to agent workspaces. Repository environment preparation is delegated to the agent, which inspects project instructions and runs the appropriate setup only when needed. Harness-controlled verification remains separate.

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

Setup recommendation is deterministic when repository evidence is clear. If setup evidence is missing or ambiguous, `/factory setup` uses the Pi SDK executor as a standby recommendation path; the selected Pi-visible model proposes a command and the user approves it before config is written. Hydration itself only runs the approved/configured command and never substitutes tools automatically.

`commands.setup` may be a single shell command or an ordered list of setup steps:

```yaml
commands:
  setup:
    - name: install-frontend
      command: cd frontend/app && npm install
    - name: install-api
      command: cd api && pip install -r requirements.txt
```

Factory runs each setup step in order. Before execution it checks for missing tools and, when a safe alternative exists, asks for approval to use it temporarily (for example `pip` to `pip3`); project config is not changed. If a setup command then hits a known environment policy that can be safely isolated, Factory may offer a worktree-local remediation such as a virtual environment. If a step fails and no approved remediation applies, the run fails during dependency hydration with the failing step name and command. Malformed setup entries fail during config validation instead of falling through to runtime.

## Hydration Modes

- `auto`: run setup only when the workspace marker is missing or stale.
- `always`: run setup every time before work.
- `never`: do not run setup automatically.

The local marker lives under `.factory/dependencies/` inside the workspace. If dependency manifests, lockfiles, platform, runtime, or any setup command changes, the key changes and Factory hydrates again.

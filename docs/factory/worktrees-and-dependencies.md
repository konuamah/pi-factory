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
Run the configured `commands.setup` before agents, command tasks, and verification when the workspace needs dependency preparation.

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
- Broad setup: `/factory setup`
- Readiness check: `/factory doctor`
- Direct config path: `.factory/config.yaml`

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

## Hydration Modes

- `auto`: run setup only when the workspace marker is missing or stale.
- `always`: run setup every time before work.
- `never`: do not run setup automatically.

The local marker lives under `.factory/dependencies/` inside the workspace. If dependency manifests, lockfiles, platform, runtime, or setup command change, the key changes and Factory hydrates again.

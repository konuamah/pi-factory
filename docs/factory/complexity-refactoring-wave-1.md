# Complexity Refactoring Wave 1 — Verification Command Discovery

> Status: implemented on `refactor/verification-command-discovery` (commit `a09b822`). Keep this as the reference for how the complexity-refactoring waves run.

## Why this wave exists

Factory's `verification.ts` is an entry point and had one of the messiest pure functions: `discoverAllowedCommands` mapped ecosystem markers to verification commands via an 8-branch `if` chain. It was a clean first refactor target because it is private (single caller), has no I/O surprises, and is one clear marker → commands mapping.

## Scope of Wave 1

- `packages/core/src/runtime/verification.ts` — extract ecosystem command mapping into a lookup table.
- `tests/verification-engine.test.mjs` — add a characterization test that pins the deterministic command set.

Explicit non-goals for this wave: no behavior changes, no public API changes, no new dependencies, no changes to the `package.json`/stale-script logic, no touching the other hotspots.

## Scorecard

| Function | Before | After |
| --- | ---: | ---: |
| `discoverAllowedCommands` complexity (naive branch scan) | 22 | 12 |
| `discoverAllowedCommands` LOC | 70 | 40 |
| Branch blocks in the marker chain | 8 | 1 lookup loop |

### What changed

The marker chain:

```ts
if (ecosystemMarkers.includes("requirements.txt")) { ... }
if (ecosystemMarkers.includes("pyproject.toml") || ...) { ... }
if (ecosystemMarkers.includes("Cargo.toml")) { ... }
// ... 5 more
```

became a table plus one loop:

```ts
const ECOSYSTEM_COMMANDS: Record<string, string[]> = {
  "requirements.txt": ["python -m pip install -r requirements.txt", "pip install -r requirements.txt", "python -m pytest", "pytest"],
  "pyproject.toml": ["python -m pip install -e .", "pip install -e .", "python -m pytest", "pytest"],
  "setup.py": ["python -m pip install -e .", "pip install -e .", "python -m pytest", "pytest"],
  "Cargo.toml": ["cargo check", "cargo test", "cargo build"],
  "go.mod": ["go test ./...", "go vet ./...", "go build ./..."],
  "pom.xml": ["mvn test", "mvn verify", "mvn package"],
  "gradlew": ["./gradlew test", "./gradlew build"],
  "build.gradle": ["gradle test", "gradle build"],
  "build.gradle.kts": ["gradle test", "gradle build"],
};
// ...
for (const marker of ecosystemMarkers) {
  const markerCommands = ECOSYSTEM_COMMANDS[marker];
  if (markerCommands) commands.push(...markerCommands);
}
```

Behavior is preserved exactly: the original pushed per-marker commands in fixed order, but `uniqueStrings(commands)` sorts and dedupes at the end, so output order and duplicates were never observable. The only real precedence (`gradlew` wins over `build.gradle*`) is preserved by the table since a directory has one file or the other.

### The pytest near-miss

The first table version dropped the `pytest` commands. The original pushed `python -m pytest` / `pytest` for any of `pyproject.toml | requirements.txt | setup.py`; a naive per-marker table would only keep the pip-install lines. No existing test covered it.

Fix: the characterization test `deterministic allowedCommands include pytest for python markers` pins the exact command set through the public path (`planVerificationExecution` with `allowDeterministicFallback`). It fails if pytest is dropped — verified by temporarily removing the pytest lines (test went red), then restoring them.

## Verification

```
Tests:
✓ verification-engine.test.mjs — 12/12 (incl. new characterization test)
✓ full suite — 254 pass / 12 fail, identical failure set to baseline (pre-existing
  environment failures: no pip/pip3 on this machine, live-SDK auth tests)

Lint:      no eslint config in repo
Typecheck: ✓ tsc -b clean
Public API changes: none
Behavior changes: none intended; pytest commands were verified preserved
```

## How to reproduce

```bash
git checkout refactor/verification-command-discovery
npm run build
node --test tests/verification-engine.test.mjs
```

## Next waves (not yet done)

Ranked by risk × complexity, from the baseline hotspot scan:

| Wave | Target | Complexity | Notes |
| --- | --- | ---: | --- |
| 2 | `withProvider` (`config/merge.ts`) | 95 | provider matrix → lookup table |
| 3 | `parseSimpleWorkflowYaml` (`workflows/registry.ts`) | 78 | parser state branching |
| 4 | `validateSetupRecommendation` (`setup/recommend-validate.ts`) | 97 | needs tests first |
| 5 | `runFactoryControllerInner` (`runtime/controller.ts`) | 108 / 1715 LOC | last: needs real tests before touching |

Rule: one hotspot per wave, tests + typecheck + lint before and after, before/after complexity scorecard, small commit. Do not point a wave at the whole repository.

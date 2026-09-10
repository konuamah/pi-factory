# Permissions And Safety

## Stage tool negotiation

Stages may declare `allowedTools` and `denyTools`. Factory negotiates the
selected skills' requested tools against that policy, the resolved capability
policy, and the Pi/provider inventory before creating a session. `denyTools`
always wins. Unknown or unavailable tools are denied with a recovery path; no
missing inventory is interpreted as “all tools available”.

The same negotiation result is supplied to the executor and runtime gate, so a
denied tool remains visible to the model with its reason and recovery guidance.
The selected skill is retained. A missing required capability blocks the stage
without internally ending the run.

Factory Concierge is an operator, not just a help page. It may edit Factory-owned files and run Factory commands, but it must protect user work.

## May Act Directly

Act directly when the user clearly asks for the exact change:

- enable dashboard
- set dashboard port
- add a named skill
- create a described workflow
- set an existing workflow as default
- repair stale model names using the detected Pi default

## Ask First

Ask before:

- deleting workflows, skills, or config
- replacing an existing workflow
- broad model/provider routing changes
- enabling deploy/production capabilities
- running destructive shell commands
- editing non-Factory application code
- committing, pushing, or merging

## Files In Scope

Factory-owned/project-agent files include:

- `.factory/config.yaml`
- `factory.yaml`
- `.pi/settings.json` for package install references
- `.pi/extensions/factory/index.ts` only for legacy project-local extension installs
- `.pi/skills/**/SKILL.md`
- `.agents/skills/**/SKILL.md`
- `skills/**/SKILL.md`
- `CONSTITUTION.md` through constitution flow unless explicitly requested

## Verification

After changes:

- run `/factory doctor` or equivalent validation
- inspect effective config for changed settings
- report files changed and current readiness

Never revert unrelated user changes.

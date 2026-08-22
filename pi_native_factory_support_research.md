# Research: Running the Same Software Factory Natively Inside Pi

**Research date:** 22 August 2026  
**Target:** Pi coding harness (`pi`)  
**Goal:** Determine whether the same Claude-native Factory design can be implemented **inside Pi as the user-facing harness**, while preserving the deterministic Factory runtime, Codebase Constitution, DAG execution, Git worktrees, verification, repair, review, human approval, and resume/recovery.

---

# 1. Executive conclusion

## Verdict: YES — Pi can support the same Factory architecture

The Factory should **not** treat Pi as merely another worker launched from Claude Code.

Instead, Pi can be a first-class user-facing harness:

```text
Developer
   │
   ▼
Pi
   │
   ▼
/factory "add organization invitations"
   │
   ▼
Pi Factory Extension
   │
   ▼
Shared Factory Runtime
   │
   ├── Constitution Engine
   ├── Workflow Engine
   ├── DAG Scheduler
   ├── State Engine
   ├── Git/Worktree Engine
   ├── Verification Engine
   ├── Repair Controller
   ├── Review Controller
   └── Approval Controller
   │
   ▼
Pi Agent Sessions
   │
   ├── planner
   ├── builders
   ├── repair
   ├── reviewer
   └── constitution reasoner
```

Pi exposes enough extension and SDK primitives to implement this cleanly:

- TypeScript extensions;
- custom slash commands;
- custom tools;
- lifecycle/tool interception;
- interactive TUI prompts and confirmation;
- status/widgets;
- persistent Pi sessions;
- project-local skills;
- Agent Skills compatibility;
- programmatic agent sessions through the Pi SDK;
- per-session working directory;
- per-session model selection;
- tool allowlists;
- custom system/context loading;
- event subscriptions;
- session abort/cancellation;
- SDK and RPC integration modes;
- Pi package distribution.

The major architectural principle stays unchanged:

> **The model performs intelligent work. Factory controls deterministic process.**

Pi does not need to provide Factory's scheduler, workflow state, worktree lifecycle, retries, verification truth, or approval state.

Those remain Factory responsibilities.

---

# 2. What “the same setup inside Pi” means

The target experience should be:

```text
pi
```

then:

```text
/factory setup
```

and later:

```text
/factory add organization invitations
```

plus:

```text
/factory status
/factory resume
/factory cancel
/factory doctor
/factory logs
```

The user should not need a separate public `factory` CLI.

Pi is the shell.

Factory is the deterministic engineering runtime behind it.

---

# 3. Why Pi is a good fit

Pi describes itself as a minimal coding harness designed to be extended rather than to provide every workflow itself.

That is actually a good architectural match for Factory.

Factory already wants to own:

```text
workflow
state
DAG
Git
worktrees
verification
repair limits
approvals
resume
repository knowledge
```

Pi can provide:

```text
interactive coding harness
model sessions
tools
skills
extension UI
slash commands
model/provider access
agent event streams
```

This keeps responsibilities clear.

---

# 4. Pi capabilities relevant to Factory

## 4.1 TypeScript extensions

Pi extensions can:

- register commands;
- register tools;
- subscribe to lifecycle events;
- intercept tool calls;
- block tool calls;
- prompt users;
- render status;
- render widgets;
- append session entries;
- communicate over an event bus.

Project-local extension location:

```text
.pi/extensions/
```

A Factory extension can therefore register:

```text
/factory
```

directly.

This is better than implementing `/factory` as only a prompt template because `/factory` needs to invoke deterministic software, show progress, handle approval, and manage cancellation.

---

# 5. The Pi-native `/factory` entry point

Recommended project layout:

```text
.pi/
├── extensions/
│   └── factory/
│       └── index.ts
│
├── skills/
│   └── factory/
│       └── SKILL.md
│
└── settings.json
```

The extension should own the Pi-specific UI adapter only.

Conceptually:

```ts
export default function factoryExtension(pi: ExtensionAPI) {
  pi.registerCommand("factory", {
    description: "Run the software factory",
    handler: async (args, ctx) => {
      await factoryGateway.handle({
        request: args,
        cwd: ctx.cwd,
        ui: new PiFactoryUI(ctx.ui),
      });
    },
  });
}
```

The extension should **not** contain the DAG scheduler itself.

Use:

```text
Pi Extension
    ↓
Factory Gateway
    ↓
Factory Core
```

not:

```text
Pi Extension
    ↓
all Factory logic mixed into one extension
```

---

# 6. Recommended architecture

```text
┌──────────────────────────────────────────────────────────┐
│                         PI                               │
│                                                          │
│ /factory setup                                           │
│ /factory <goal>                                          │
│ /factory status                                          │
│ /factory resume                                          │
│ /factory cancel                                          │
└───────────────────────────┬──────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────┐
│                PI FACTORY EXTENSION                      │
│                                                          │
│ registerCommand("factory")                               │
│ UI adapter                                               │
│ approval dialogs                                         │
│ progress widgets                                         │
│ cancellation bridge                                      │
└───────────────────────────┬──────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────┐
│                  SHARED FACTORY CORE                     │
│                                                          │
│ Constitution Engine                                      │
│ Workflow Compiler                                        │
│ DAG Scheduler                                            │
│ Runtime State                                            │
│ Git / Worktrees                                          │
│ Command Execution                                        │
│ Verification                                             │
│ Repair Limits                                            │
│ Review                                                   │
│ Approval State                                           │
│ Resume / Recovery                                        │
└───────────────┬──────────────────────────┬───────────────┘
                │                          │
                ▼                          ▼
┌─────────────────────────┐    ┌───────────────────────────┐
│     PiAgentExecutor     │    │      Local Processes      │
│                         │    │                           │
│ createAgentSession()    │    │ git                       │
│ ModelRuntime            │    │ lint                      │
│ ResourceLoader          │    │ typecheck                 │
│ tools                   │    │ tests                     │
│ cwd                     │    │ build                     │
└──────────────┬──────────┘    └───────────────────────────┘
               │
               ▼
       independent Pi agents
```

---

# 7. Critical design decision: do not depend on Pi built-in subagents

Pi deliberately keeps its core minimal.

That is not a blocker.

Factory should create its own independent Pi agent sessions through the Pi SDK.

Example conceptual worker launch:

```ts
const { session } = await createAgentSession({
  cwd: worktreePath,
  model: selectedModel,
  tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
  sessionManager: SessionManager.inMemory(worktreePath),
});

await session.prompt(workerPrompt);
```

The Factory scheduler can create several sessions concurrently:

```text
Factory DAG Scheduler
      │
      ├── Pi session: database
      ├── Pi session: API
      └── Pi session: UI
```

Each gets its own:

```text
cwd = its Git worktree
```

Therefore the correct abstraction is:

```text
Factory owns multi-agent orchestration.
Pi supplies programmable agent sessions.
```

Do not make a community subagent extension foundational to Factory.

Community packages may be useful experimentally, but the deterministic product should not outsource its core scheduling semantics to them.

---

# 8. Pi Agent SDK support

Pi's SDK provides the capabilities Factory needs for a `PiAgentExecutor`.

Relevant APIs include:

```text
createAgentSession()
createAgentSessionRuntime()
AgentSession
SessionManager
ModelRuntime
DefaultResourceLoader
defineTool()
```

An `AgentSession` supports:

```text
prompt()
steer()
followUp()
subscribe()
setModel()
setThinkingLevel()
abort()
dispose()
```

That is enough for Factory to:

- start a worker;
- stream its progress;
- cancel it;
- set its model;
- isolate its context;
- choose its tools;
- bind it to a worktree.

---

# 9. Implement a PiAgentExecutor

The shared Factory core should continue to depend on an interface.

```ts
interface AgentExecutor {
  execute(input: AgentExecutionInput): Promise<AgentExecutionResult>;
  cancel(executionId: string): Promise<void>;
}
```

Then provide:

```text
ClaudeAgentExecutor
PiAgentExecutor
FakeAgentExecutor
```

Conceptually:

```ts
class PiAgentExecutor implements AgentExecutor {
  async execute(input: AgentExecutionInput) {
    const { session } = await createAgentSession({
      cwd: input.cwd,
      model: await this.resolveModel(input.model),
      tools: input.tools,
      sessionManager: SessionManager.inMemory(input.cwd),
      resourceLoader: await this.createResourceLoader(input),
    });

    // subscribe to Pi events
    // capture output
    // enforce Factory timeout
    // map completion into AgentExecutionResult

    await session.prompt(input.prompt);

    return this.collectResult(session);
  }

  async cancel(executionId: string) {
    await this.sessions.get(executionId)?.abort();
  }
}
```

Factory should still enforce its own:

```text
timeout
retry count
run state
node state
allowed transitions
```

Pi session state does not replace Factory state.

---

# 10. Model routing inside Pi

Pi's SDK exposes model selection through `ModelRuntime` and per-session models.

Factory can therefore retain role-based routing:

```yaml
models:
  planner:
    provider: anthropic
    model: claude-opus-4-5

  builder:
    provider: anthropic
    model: claude-sonnet-4-5

  reviewer:
    provider: anthropic
    model: claude-opus-4-5

  repair:
    provider: anthropic
    model: claude-sonnet-4-5
```

Pi can also support other configured providers/models.

This creates a useful future architecture:

```text
Factory role
   │
   ▼
logical model selection
   │
   ▼
Harness executor
   │
   ▼
Pi ModelRuntime
```

Keep provider/model details outside the DAG engine.

---

# 11. Pi skills and Factory skills

Pi supports Agent Skills.

Project-local locations include:

```text
.pi/skills/
.agents/skills/
```

Pi can also load skills from Claude Code directories through settings.

This means Factory knowledge assets can be shared across harnesses.

Recommended approach:

```text
.agents/skills/
├── factory/
│   └── SKILL.md
└── codebase-constitution/
    └── SKILL.md
```

Then configure both harnesses to see those shared skills where possible.

This is better than duplicating identical skill content into:

```text
.claude/skills/
.pi/skills/
```

unless harness-specific behavior requires it.

---

# 12. Keep the Factory skill harness-neutral

Separate universal process instructions from Pi-specific mechanics.

Example:

```text
skills/factory/SKILL.md

# Factory behavior
- user intent
- workflow meaning
- approval semantics
- Constitution semantics
- state meaning

## Pi adapter
- invoke /factory extension
- Pi-specific UI behavior
- Pi resource paths

## Claude adapter
- Claude-specific bridge behavior
```

The Factory runtime remains the source of deterministic truth.

---

# 13. Codebase Constitution inside Pi

The Constitution design carries over almost unchanged.

Pi can read:

```text
CONSTITUTION.md
```

and Factory's Constitution Engine can still perform:

```text
git ls-files
rg
file inspection
hashing
change detection
impact routing
targeted refresh
drift detection
```

The Constitution reasoner can itself be a Pi agent session.

Architecture:

```text
Factory Constitution Engine
      │
      ├── deterministic scanner
      │
      ├── Git change detector
      │
      ├── evidence router
      │
      └── Pi reasoning session
               │
               ▼
       interpretation/classification
```

The same status model remains:

```text
DEFINED
INFERRED
NOT_DEFINED
NOT_APPLICABLE
UNCERTAIN
```

The same authority order remains:

```text
1. Current user instruction
2. Explicit human repository instructions
3. Enforced configuration / executable CI behavior
4. Current source behavior / repeated conventions
5. Generated Constitution inference
6. Generic best practice
```

Only the reasoning executor changes from a Claude-specific session to a Pi session.

---

# 14. Context injection in Pi

Pi's `DefaultResourceLoader` can provide:

```text
skills
extensions
prompt templates
context files
AGENTS.md
```

Factory can build each worker's context using:

```text
Agent Operating Summary
+
task-relevant Constitution areas
+
task goal
+
allowed scope
+
dependency results
+
relevant plan
```

Do not load the entire 120-area Constitution into every worker.

Use the same Context Selector from the Factory design.

---

# 15. Worker isolation

Factory should continue to own Git worktrees.

Example:

```text
.factory/worktrees/<run-id>/database
.factory/worktrees/<run-id>/api
.factory/worktrees/<run-id>/ui
```

Each Pi session gets:

```ts
cwd: worktreePath
```

This is directly supported by `createAgentSession()`.

Therefore:

```text
Pi session isolation
+
Factory Git worktree isolation
```

fit naturally together.

---

# 16. Tool permissions

Pi supports explicit session tool selection.

Factory can create role-specific tool sets.

## Planner

```text
read
grep
find
ls
```

## Builder

```text
read
write
edit
bash
grep
find
ls
```

## Reviewer

```text
read
grep
find
ls
```

## Constitution reasoner

```text
read
grep
find
ls
```

The Factory runtime should still place a command-policy layer around dangerous shell operations.

Do not assume a tool allowlist alone is the full security model.

---

# 17. Extension-level safety interception

Pi extensions can intercept tool calls.

This can add a second layer of protection for the interactive Pi session.

For example:

```text
block or require confirmation:
git push --force
rm -rf
sudo
npm publish
production deployment
destructive database commands
```

However:

```text
Pi extension safety
```

should complement:

```text
Factory command policy
```

not replace it.

Factory child sessions should be restricted at creation time as well.

---

# 18. Human approval UI

Pi extension UI supports:

```text
confirm
select
input
editor
notify
setStatus
setWidget
```

That maps directly to Factory's human gates.

Example:

```text
Factory candidate ready

✓ Constitution refreshed
✓ lint
✓ typecheck
✓ tests
✓ build
✓ reviewer pass

Commit:
9c6d0ab

[Approve merge]
[Request changes]
[Reject]
```

The Pi extension sends the decision back into the Factory runtime.

Approval remains tied to the candidate Git SHA.

---

# 19. Progress UI

Pi is actually well suited for Factory progress.

Possible UI:

```text
Factory fac_01J...

Constitution
✓ current

Planning
✓ 4 tasks

Implementation
✓ database
◉ API
✓ UI
○ tests

Integration
○ waiting

Verification
○ waiting

Review
○ waiting
```

Use Pi extension status/widgets for concise live state.

Do not stream every worker transcript into the primary interactive session by default.

Workers should log to Factory run artifacts.

---

# 20. Persistence

Pi has session persistence, but Factory should **not** use Pi session files as the authoritative workflow database.

Keep:

```text
.factory/runs/<run-id>/
├── state.json
├── events.jsonl
├── plan.json
├── review.json
├── constitution-refresh.json
├── tasks/
├── commands/
└── logs/
```

Pi sessions are agent execution artifacts.

Factory state remains authoritative for:

```text
node readiness
retry counts
worker commit
integration SHA
approval SHA
verification results
resume
cancellation
```

This preserves the deterministic boundary.

---

# 21. Resume inside Pi

The user experience can remain:

```text
/factory resume
```

The extension asks Factory to:

```text
load run state
reconcile Git branches/worktrees
check active/abandoned Pi sessions
inspect Constitution state
recover interrupted nodes
continue from a safe checkpoint
```

It should not depend on reopening the original interactive Pi conversation.

---

# 22. Cancellation inside Pi

User:

```text
/factory cancel
```

Flow:

```text
Pi extension
   ↓
FactoryRuntime.cancel()
   ↓
abort active Pi AgentSessions
terminate active local processes
preserve completed commits
persist cancellation event
mark run CANCELLED
```

`AgentSession.abort()` gives Factory a programmatic cancellation hook for active Pi workers.

---

# 23. Verification remains outside Pi reasoning

Exactly as in the Claude design:

```text
Pi agent modifies code
       ↓
Factory runs real commands
       ↓
exit code determines truth
```

Use:

```text
lint
typecheck
test
build
```

Factory captures:

```text
command
exit code
stdout
stderr
duration
```

Never ask a Pi agent:

```text
"Did the tests pass?"
```

when the process can answer deterministically.

---

# 24. Repair loop inside Pi

The repair agent can be another Pi SDK session bound to the integration worktree.

```text
VERIFY FAILS
    │
    ▼
Factory captures failure
    │
    ▼
Pi repair session
    │
    ▼
edits integration worktree
    │
    ▼
Factory verifies again
```

Hard limit:

```text
attempt 1
attempt 2
attempt 3
→ NEEDS_HUMAN
```

Pi does not own the retry counter.

Factory does.

---

# 25. Reviewer inside Pi

The reviewer can be a read-only Pi AgentSession.

Inputs:

```text
original request
approved plan
combined diff
verification result
relevant Constitution
drift findings
candidate SHA
```

Tools:

```text
read
grep
find
ls
```

No write/edit tools.

Reviewer output should remain structured and schema-validated by Factory.

---

# 26. Pi extension vs prompt template vs skill

Use each for the right role.

## Extension

Use for:

```text
/factory
runtime invocation
status UI
approval dialogs
cancel
resume
custom Factory tools
```

## Skill

Use for:

```text
Factory conceptual instructions
repository workflows
Constitution reasoning guidance
role-specific procedures
```

## Prompt template

Use only for lightweight shortcuts.

Do **not** make a prompt template the authoritative Factory controller.

---

# 27. Pi Package distribution

Once stable, package the Pi adapter as a Pi package.

Conceptual package:

```text
factory-pi/
├── package.json
├── extensions/
│   └── factory/
│       └── index.ts
├── skills/
│   └── factory/
│       └── SKILL.md
└── README.md
```

The package can declare Pi resources through its package metadata.

This creates a clean installation/distribution path without turning Factory into a public CLI product.

---

# 28. Shared multi-harness Factory architecture

The strongest long-term design is not:

```text
Claude Factory
```

and separately:

```text
Pi Factory
```

Instead build:

```text
                    Shared Factory Core
                           │
             ┌─────────────┴─────────────┐
             │                           │
             ▼                           ▼
       Claude Adapter                 Pi Adapter
             │                           │
             ▼                           ▼
        Claude Code                      Pi
```

And:

```text
                    AgentExecutor
                         │
              ┌──────────┴──────────┐
              │                     │
              ▼                     ▼
    ClaudeAgentExecutor       PiAgentExecutor
```

The same:

```text
Constitution Engine
DAG Scheduler
State Engine
Git Engine
Verification Engine
Repair Controller
Approval Engine
```

is reused.

---

# 29. Recommended repository structure

```text
factory/
├── packages/
│   ├── core/
│   │   └── src/
│   │       ├── workflow/
│   │       ├── scheduler/
│   │       ├── runtime/
│   │       ├── git/
│   │       ├── state/
│   │       ├── verification/
│   │       ├── approval/
│   │       └── constitution/
│   │
│   ├── schemas/
│   │   └── src/
│   │
│   ├── executors/
│   │   ├── fake/
│   │   ├── claude/
│   │   └── pi/
│   │
│   ├── adapters/
│   │   ├── claude-code/
│   │   └── pi/
│   │
│   └── shared-skills/
│       ├── factory/
│       └── codebase-constitution/
│
└── tests/
```

Pi adapter:

```text
packages/adapters/pi/
├── src/
│   ├── extension.ts
│   ├── ui.ts
│   ├── gateway.ts
│   ├── approvals.ts
│   └── progress.ts
└── package.json
```

Pi executor:

```text
packages/executors/pi/
├── src/
│   ├── executor.ts
│   ├── models.ts
│   ├── resources.ts
│   ├── events.ts
│   ├── tools.ts
│   └── result.ts
└── package.json
```

---

# 30. Harness adapter interface

Create an explicit user-harness boundary.

```ts
interface FactoryHarnessAdapter {
  start(): Promise<void>;

  showProgress(event: FactoryProgressEvent): Promise<void>;

  requestApproval(
    gate: ApprovalGate
  ): Promise<ApprovalDecision>;

  requestInput(
    request: HumanInputRequest
  ): Promise<HumanInputResult>;

  notify(message: FactoryNotification): Promise<void>;
}
```

Implement:

```text
ClaudeCodeHarnessAdapter
PiHarnessAdapter
```

This stops the Factory core from depending on either UI.

---

# 31. Pi adapter command design

Recommended command behavior:

```text
/factory
```

Show summary/help.

```text
/factory setup
```

Initialize Factory and Constitution.

```text
/factory <goal>
```

Start run.

```text
/factory status
```

Show current run.

```text
/factory status <run-id>
```

Show specific run.

```text
/factory resume
```

Resume latest recoverable run.

```text
/factory cancel
```

Cancel active run.

```text
/factory doctor
```

Check installation/repository/runtime.

```text
/factory logs
```

Show recent Factory events.

This remains one command namespace rather than adding many unrelated Pi commands.

---

# 32. Setup experience inside Pi

Target:

```text
/factory setup
```

Pi extension opens interactive setup.

Flow:

```text
Environment preflight
       ↓
Repository discovery
       ↓
Full Constitution scan
       ↓
Detect project commands
       ↓
Model/provider strategy
       ↓
Autonomy policy
       ↓
Repair policy
       ↓
Git/worktree validation
       ↓
Factory validation
       ↓
Small proof run
```

Pi's TUI select/input/confirm APIs are sufficient to create a strong setup wizard.

---

# 33. Example setup UI

```text
Factory Setup

Environment
✓ Git
✓ Pi
✓ Node.js
✓ repository
✓ worktree support

Repository
TypeScript / Next.js
pnpm
Vitest
ESLint

Constitution
○ first scan required

Models
Planner     Claude Opus
Builder     Claude Sonnet
Repair      Claude Sonnet
Reviewer    Claude Opus

Autonomy
Safe
Final merge requires approval

Repair
Maximum 3 attempts

[Create Factory setup]
```

---

# 34. Use Pi project trust correctly

Pi project-local extensions and resources are trusted-code capabilities.

A project-level Factory extension can execute code with the user's system permissions.

Therefore Factory should:

- make its extension source auditable;
- avoid hidden shell behavior;
- preserve explicit command policies;
- not treat Pi project trust as a sandbox;
- keep worktree isolation separate from security isolation.

Git worktrees are concurrency isolation, not security isolation.

---

# 35. Pi RPC mode

Pi also provides RPC mode.

That is useful if Factory were written in a different language or if subprocess isolation were desirable.

Conceptual:

```text
Factory process
   │ JSONL
   ▼
pi --mode rpc
```

However, because Factory is already planned in TypeScript/Node.js, the Pi SDK is the cleaner primary integration.

Recommended:

```text
TypeScript Factory
→ Pi SDK
```

Use RPC only where process isolation or cross-language integration is specifically beneficial.

---

# 36. Pi SDK vs Pi interactive session

Keep this distinction clear:

```text
Primary Pi interactive session
```

is the user experience.

Factory-created:

```text
Pi AgentSessions
```

are controlled workers.

Do not attempt to make the user's primary conversation itself execute every DAG worker serially.

The UI session coordinates.

The Factory runtime launches worker sessions.

---

# 37. Do we need MCP for Pi?

No.

Pi can be extended directly through TypeScript extensions and its SDK.

For the Pi implementation, the cleanest path is:

```text
Pi Extension
   ↓
import/call Factory Runtime directly
```

MCP can remain an optional interoperability mechanism elsewhere.

Do not add MCP merely to make the Pi adapter work.

---

# 38. Do we need pi-subagents?

No.

Factory should implement its own multi-agent scheduling using the Pi SDK.

Possible community subagent packages demonstrate that Pi can be extended in that direction, but Factory already has its own stronger deterministic orchestration model.

Use:

```text
Factory DAG → multiple createAgentSession()
```

rather than:

```text
Factory → community subagent package → unknown scheduler semantics
```

---

# 39. Do we need Pi's session persistence for workers?

Not necessarily.

For most worker nodes:

```text
SessionManager.inMemory(worktreePath)
```

may be enough because Factory itself persists authoritative execution state.

Persistent Pi sessions can be enabled when:

- debugging;
- preserving a difficult repair conversation;
- detailed audit is desired;
- a human needs to inspect an agent session.

Make that a policy, not a requirement.

---

# 40. Compatibility matrix

| Factory requirement | Pi support | Implementation |
|---|---:|---|
| `/factory` command | Excellent | Extension `registerCommand()` |
| `/factory setup` wizard | Excellent | Extension UI select/input/confirm |
| Live progress | Excellent | `setStatus`, `setWidget`, notifications |
| Codebase Constitution | Excellent | Shared Factory subsystem |
| Repository scanner | Excellent | Git/rg/Node/local tools |
| Specialized agents | Excellent | Pi SDK AgentSessions |
| Parallel workers | Excellent | Factory launches concurrent AgentSessions |
| Worktree-specific cwd | Excellent | `createAgentSession({ cwd })` |
| Model routing | Excellent | `ModelRuntime` + per-session model |
| Tool restrictions | Good/Excellent | per-session tool allowlists + Factory policy |
| Read-only reviewer | Excellent | omit write/edit/bash or tightly restrict |
| Agent cancellation | Excellent | `AgentSession.abort()` |
| Event streaming | Excellent | `session.subscribe()` |
| Skills | Excellent | Agent Skills support |
| Shared Claude/Pi skills | Good/Excellent | Pi supports custom skill paths |
| Context files | Excellent | ResourceLoader / AGENTS.md |
| Workflow DAG | Factory-owned | unchanged |
| State machine | Factory-owned | unchanged |
| Git worktrees | Factory-owned | unchanged |
| Deterministic verification | Factory-owned | unchanged |
| Bounded repair | Factory-owned | unchanged |
| SHA-bound approval | Factory-owned | Pi UI supplies decision |
| Resume/recovery | Factory-owned | unchanged |
| No public Factory CLI | Excellent | Pi extension is entry point |
| Package distribution | Excellent | Pi Package |

---

# 41. What changes from the Claude-native design

Only the harness-specific surfaces change.

## Claude version

```text
Claude Code
   ↓
Factory skill/plugin
   ↓
Factory Runtime
   ↓
Claude Agent Executor
```

## Pi version

```text
Pi
   ↓
Factory TypeScript Extension
   ↓
Factory Runtime
   ↓
Pi Agent Executor
```

Everything below those adapters should be shared.

---

# 42. What does NOT change

These should remain identical:

```text
CONSTITUTION.md
factory.yaml
.factory/config.yaml

workflow compiler
DAG scheduler
task graph
state machine
events
Git worktrees
integration branch
merge ordering
verification
repair limits
drift detection
review schema
approval SHA
resume/recovery
cancellation semantics
```

This is important.

Do not fork the whole Factory architecture just because the harness changes.

---

# 43. Build order for Pi support

## Phase 1 — Pi extension shell

Build:

```text
/factory
/factory setup
/factory status
```

with fake runtime responses.

Goal:

```text
prove the Pi-native UX
```

## Phase 2 — Shared Factory core

Connect the Pi extension to:

```text
FactoryRuntime
StateStore
EventStore
```

## Phase 3 — PiAgentExecutor

Implement:

```text
createAgentSession
model selection
cwd isolation
tool policy
event capture
abort
structured result
```

## Phase 4 — Git worktrees

Prove multiple Pi sessions can edit isolated worktrees concurrently.

## Phase 5 — Constitution

Run:

```text
first scan
incremental refresh
context selection
drift detection
```

through Pi.

## Phase 6 — Full DAG

Connect:

```text
plan
parallel implementation
integration
verification
repair
review
approval
merge
```

## Phase 7 — Recovery

Test:

```text
Pi closes
Factory process interrupted
worker interrupted
verification interrupted
approval waiting
```

and resume through:

```text
/factory resume
```

## Phase 8 — Pi package

Package the adapter for project/global installation.

---

# 44. Minimal Pi-specific dependencies

The shared Factory core still uses its normal dependencies.

Pi-specific package:

```text
@earendil-works/pi-coding-agent
@earendil-works/pi-ai
typebox
```

Optional Pi TUI imports may use:

```text
@earendil-works/pi-tui
```

The Factory core can still use:

```text
TypeScript
Node.js
Zod
YAML
Execa
ULID
Vitest
Git
ripgrep
```

---

# 45. Important architecture refinement

Once Pi support is added, rename concepts that are too Claude-specific.

Instead of:

```text
Claude performs intelligent work.
Factory controls deterministic process.
```

the implementation-level principle can become:

> **The coding harness/model performs intelligent work. Factory controls deterministic process.**

Product-specific documentation can still say Claude or Pi where appropriate.

Core interfaces should say:

```text
AgentExecutor
HarnessAdapter
ModelRef
AgentExecution
```

not:

```text
ClaudeExecutor everywhere
ClaudeRun everywhere
ClaudeTask everywhere
```

That will prevent unnecessary coupling.

---

# 46. Recommended first prototype

Do not start with the entire Factory.

Build one vertical slice inside Pi:

```text
/factory "add a test for X"
        ↓
Pi extension
        ↓
Factory creates one worktree
        ↓
PiAgentExecutor creates one agent session
        ↓
worker edits worktree
        ↓
Factory runs test
        ↓
Factory commits
        ↓
Pi asks for approval
        ↓
Factory merges
```

Then add:

```text
Constitution
parallel workers
DAG
repair
review
resume
```

This proves the Pi integration boundary before adding system complexity.

---

# 47. Recommended second prototype

Once the one-worker flow works:

```text
/factory "implement small feature"
        ↓
Constitution refresh
        ↓
planner Pi session
        ↓
3-task DAG
        ↓
2 parallel Pi builder sessions
        ↓
1 dependent Pi builder session
        ↓
integration
        ↓
verification
        ↓
reviewer Pi session
        ↓
human approval
```

If this works reliably, the architecture is validated.

---

# 48. Final recommendation

Proceed with Pi as a **first-class Factory harness**.

Do not build a separate Pi-specific Factory.

Build:

```text
ONE FACTORY CORE
        │
        ├── Claude Code adapter
        └── Pi adapter
```

and:

```text
ONE AGENT EXECUTOR INTERFACE
        │
        ├── ClaudeAgentExecutor
        └── PiAgentExecutor
```

For Pi specifically:

```text
Pi TUI
   ↓
project-local TypeScript Factory extension
   ↓
shared Factory runtime
   ↓
Pi SDK AgentSessions
```

This is a strong fit with Pi's current architecture because Pi intentionally exposes extension and SDK primitives rather than forcing one orchestration model.

---

# 49. Final verdict

```text
CAN FACTORY LIVE INSIDE PI?
YES.

CAN /factory BE A REAL PI COMMAND?
YES.

CAN PI RUN THE PLANNER/BUILDERS/REPAIR/REVIEWER?
YES.

CAN EACH WORKER USE A SEPARATE GIT WORKTREE?
YES.

CAN FACTORY SELECT DIFFERENT MODELS PER ROLE?
YES.

CAN PI SHOW FACTORY PROGRESS AND APPROVAL UI?
YES.

CAN THE CODEBASE CONSTITUTION WORK UNCHANGED?
YES, with a Pi reasoning executor.

DO WE NEED PI CORE TO HAVE BUILT-IN SUBAGENTS?
NO.

DO WE NEED A PUBLIC FACTORY CLI?
NO.

DO WE NEED TO DUPLICATE THE FACTORY CORE?
NO.
```

The recommended design is:

```text
PI = user-facing harness
FACTORY = deterministic orchestrator
PI SDK = intelligent worker runtime
CONSTITUTION = persistent repository knowledge
GIT = isolation/checkpoint layer
COMMANDS = verification truth
HUMAN = final authority
```

---

# 50. Sources checked

Official Pi documentation consulted for this research:

- Pi documentation home: https://pi.dev/docs/latest
- Extensions: https://pi.dev/docs/latest/extensions
- Skills: https://pi.dev/docs/latest/skills
- SDK: https://pi.dev/docs/latest/sdk
- RPC mode: https://pi.dev/docs/latest/rpc
- Prompt templates: https://pi.dev/docs/latest/prompt-templates
- Settings: https://pi.dev/docs/latest/settings
- Pi Packages: https://pi.dev/docs/latest/packages

The research also checked current community examples to confirm that extensions, skills, multi-agent patterns, and Pi package distribution are being used in practice. The architecture above intentionally depends on **official Pi extension/SDK primitives**, not on a community subagent package.

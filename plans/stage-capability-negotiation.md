# Stage Capability Negotiation

## 1. Goal

Replace per-stage hard-coded tool lists with one generic negotiation layer. A
stage receives only tools that survive every applicable constraint:

```text
skill request
  ∩ stage policy
  ∩ role defaults
  ∩ project/workflow/autonomy safety policy
  ∩ confirmed provider availability
```

The result is passed to the executor, rendered in model context, and reused by
the runtime gate. A denied tool is never silently removed from the explanation:
the model receives the tool name, denial category, detail, and recovery path.

This must support built-in tools, MCP/provider tools, Graphify-like skills, and
future skills without vendor-specific branches.

## 2. Current problems

- Stages use hard-coded `read`, `grep`, `find`, and `ls` lists.
- Builder and repair stages union role tools with granted capabilities, so the
  executor can receive tools that policy did not grant.
- `WorkflowStage` has no stage-level tool allow/deny policy.
- Skill `allowedTools` is used during eligibility filtering but is not reliably
  passed to the runtime gate.
- Unmapped tools default to allow in the capability gate.
- Pi tool discovery currently throws when requested tools are unavailable.
- The model does not receive a single, structured negotiation result with
  recovery guidance.

Relevant implementation areas:

- `packages/core/src/capabilities/`
- `packages/core/src/runtime/skills.ts`
- `packages/core/src/skills/loader.ts`
- `packages/core/src/workflows/registry.ts`
- `packages/executors/pi/src/sdk-factory.ts`
- `packages/executors/pi/src/tool-gate.ts`
- `packages/executors/pi/src/executor.ts`
- `packages/core/src/context/compiler.ts`

## 3. Explicit semantics

### 3.1 Requests

- A skill with `permissions.allowedTools` requests exactly those tools.
- A selected skill without `allowedTools` makes no additional tool request.
- If no selected skill requests tools, the stage requests its role defaults. This
  preserves the existing default behavior without making an empty skill request
  mean “grant nothing.”
- `WorkflowStage.requiredCapabilities` remains a capability request for the
  existing safety resolver. It is not a tool allowlist.

### 3.2 Stage policy

- `allowedTools` is an optional stage allowlist. When absent, role defaults are
  the stage allowlist.
- `denyTools` is an optional denylist.
- `denyTools` always wins when a tool appears in both lists.
- A tool requested by a skill but excluded by the stage produces a `stage`
  denial. The skill is retained so the model can understand why it cannot use
  it; it is never silently dropped.

### 3.3 Provider inventory

Negotiation must happen after a provider exposes a preflight inventory and before
the session is created:

```text
describeTools() → negotiateStageCapabilities() → create(session, grantedTools)
```

The inventory must distinguish:

- `available`: tools the provider can create for this session;
- `unavailable`: known tools the provider does not expose;
- `unknown`: names with no registered provider.

An unavailable inventory is not equivalent to “all tools available.” Empty or
missing availability produces explicit `pi` or `provider` denials. There is no
fallback to role tools and no catch-all “all known tools” fallback.

### 3.4 Unknown and MCP tools

Unknown tools are classified as `unknown-tool`, not `pi`. Provider-backed tools
must be registered by provider namespace and included in the provider inventory.
No tool is default-allowed merely because it is unmapped from the built-in
capability table.

## 4. Data model

### 4.1 Workflow schema

Add to `WorkflowStage`:

```ts
allowedTools?: string[];
denyTools?: string[];
```

Parse both fields in the workflow YAML loader and propagate them through
`PlannerTask` and every stage execution input.

### 4.2 Negotiation result

Create `packages/core/src/capabilities/negotiation.ts`:

```ts
type DenialReason =
  | "stage"
  | "safety"
  | "role-default"
  | "pi"
  | "provider"
  | "unknown-tool";

interface ToolDenial {
  tool: string;
  reason: DenialReason;
  detail: string;
  recovery: string;
}

interface NegotiatedCapabilities {
  requestedTools: string[];
  stageAllowed: string[];
  stageDenied: string[];
  safetyGranted: string[];
  providerAvailable: string[];
  granted: string[];
  denied: ToolDenial[];
}
```

`negotiateStageCapabilities` is pure. It accepts the already-resolved safety
result and a provider inventory; it does not call Pi, mutate workflow state, or
silently repair invalid input.

The algorithm is:

1. Collect unique skill-requested tools.
2. If no skill requests tools, use role defaults as the request.
3. Resolve the stage allowlist: explicit `allowedTools`, otherwise role defaults.
4. Remove `denyTools`; deny always wins.
5. Deny requested tools outside the stage allowlist as `stage`.
6. Map known tools to capabilities and apply the existing safety result.
7. Deny unknown tools as `unknown-tool`.
8. Deny known provider tools absent from the inventory as `pi` or `provider`.
9. Return the remaining names in stable request order as `granted`.

No input produces an implicit grant. No unavailable provider is treated as
available.

## 5. Provider preflight contract

Add the smallest provider-neutral inventory contract needed by the Pi adapter:

```ts
interface ToolInventory {
  available: string[];
  unavailable: string[];
  unknown: string[];
}

interface PiToolProvider {
  describeTools(input: PiSessionFactoryInput): ToolInventory;
}
```

The Pi session factory exposes this preflight operation before session creation.
The existing SDK tool factories remain responsible for creating actual tools.
The factory must verify that every name in `granted` was created; a mismatch
returns a structured provider diagnostic and keeps the run active or blocked.

Do not implement availability by first passing the negotiated list into the
factory. That is too late to be a negotiation input.

If an older provider cannot describe its inventory, return a provider-unavailable
diagnostic and block the affected stage with recovery. Do not assume all tools
exist.

## 6. Runtime behavior

### 6.1 Central execution boundary

Create one small stage execution helper or execution context that owns:

1. selected skills;
2. safety resolution;
3. provider preflight;
4. negotiation;
5. compiled negotiation context;
6. executor `tools: negotiated.granted`;
7. gate metadata.

Migrate stage boundaries through this helper instead of independently editing
every literal tool list. Internal model calls that are not stage agents may use
their own explicit read-only policy and must not accidentally inherit builder
tools.

### 6.2 Model-visible denial

The context compiler adds a `Capability negotiation` section containing:

- granted tools;
- denied tools;
- denial reason and detail;
- recovery guidance.

The runtime gate returns a structured tool result with the same information:

```text
Capability unavailable: <tool>
Reason: <reason> — <detail>
Recovery: <recovery>
```

The gate receives the negotiation result explicitly. Events and diagnostics may
also record it, but events alone do not satisfy model visibility.

### 6.3 Blocked stages and run lifetime

If a required skill or required tool cannot be granted:

- preserve the selected skill and its denial;
- emit a structured `capability.negotiation_blocked` result;
- keep the run active or blocked with the recovery path recorded;
- allow continuation only after an explicit user decision or an explicit,
  workflow-authorized model terminal decision.

Negotiation must never end a run because of a missing handler, fallback,
unavailable provider, exhausted retry, or ambiguous recovery result.

Recovery must not silently change autonomy, project policy, or workflow policy.
Those changes require the normal explicit authorization path.

## 7. Implementation sequence

### Step 1: Schema and parser

Modify:

- `packages/schemas/src/config.ts`
- `packages/core/src/workflows/registry.ts`
- `packages/core/src/runtime/planner.ts`

Add and propagate `allowedTools` and `denyTools`. Test YAML parsing and planner
propagation.

### Step 2: Provider inventory

Modify:

- `packages/executors/pi/src/types.ts`
- `packages/executors/pi/src/sdk-factory.ts`
- Pi adapter/session-factory callers

Add preflight inventory before session creation. Replace throwing missing-tool
logic with structured inventory and diagnostics. Do not add an availability
fallback.

### Step 3: Pure negotiation

Create `packages/core/src/capabilities/negotiation.ts` and re-export it from
`packages/core/src/capabilities/index.ts`.

Add tests for:

- all constraints granting a tool;
- stage allowlist denial;
- denylist winning over allowlist;
- safety denial;
- missing Pi/provider tool;
- unknown tool;
- empty skill requests using role defaults;
- multiple skills with stable deduplication;
- required tool unavailable without silently dropping the skill.

### Step 4: Central stage execution context

Add the shared helper/context and migrate discovery first. It must pass the same
negotiation result to context compilation, executor tools, metadata, and the
runtime gate.

Prove discovery end to end before migrating verification, interview, planning,
implementation, repair, landing, and integration stages.

### Step 5: Gate and context

Modify:

- `packages/core/src/capabilities/gate.ts`
- `packages/executors/pi/src/tool-gate.ts`
- `packages/executors/pi/src/executor.ts`
- `packages/core/src/context/compiler.ts`

Wire selected skills and negotiation metadata into the gate. Add an integration
test that invokes a denied tool and asserts the model-visible structured result,
not merely an emitted event.

### Step 6: Skill loader and policy wiring

Confirm the canonical skill metadata format in
`packages/core/src/skills/loader.ts`. Support only the documented source format;
do not invent a second body-level permissions syntax without a parser contract.

Pass selected skills to the gate. Do not filter or drop skills solely because a
requested tool is denied.

### Step 7: Migrate remaining stages

Replace hard-coded tool arrays and role-tool unions at the central execution
boundary. Keep internal read-only planner/diagnostic calls explicitly scoped.
Search for remaining `tools: [...]`, `roleTools(`, and capability-to-tool unions
after migration.

### Step 8: Documentation and operational guidance

Update:

- `docs/factory/permissions-and-safety.md`
- `docs/factory/workflow-authoring.md`
- `docs/factory/concepts.md`
- `AGENTS.md`
- `.pi/skills/factory-concierge/SKILL.md`
- `skills/factory-concierge/SKILL.md`
- `learnings.md`

Document policy semantics, provider preflight, blocked-stage recovery, and the
fact that missing capability never silently ends a run.

## 8. Testing and verification

Focused tests:

- workflow parser and planner propagation;
- pure negotiation;
- provider inventory and unavailable-provider behavior;
- capability gate structured denials;
- model-visible Pi executor denial;
- discovery end-to-end negotiation;
- remaining stage migrations.

Required assertions:

- no unavailable tool is passed to the executor;
- no unknown tool is default-allowed;
- no selected skill disappears because one tool is denied;
- a denied required tool creates a blocked/actionable result;
- the run remains active or blocked rather than terminating internally;
- the gate and context show the same denial reason and recovery;
- provider inventory is obtained before negotiation;
- no fallback converts missing availability into “all tools available.”

Run the focused tests first, then:

```text
npm run typecheck
npm run build
node scripts/complexity-guard.mjs
node --test tests/**/*.test.mjs
```

If the repository has unrelated baseline failures, report them separately from
failures introduced by this change; do not mark the plan complete based only on
the command exit status.

## 9. Out of scope

- Graphify-specific code paths or vendor adapters.
- A new capability DSL.
- Automatic changes to autonomy, project policy, or workflow policy.
- Visual redesign of the TUI gate.
- Skill marketplace or discovery commands.
- Treating `WorkflowDefinition.capabilityPolicy` as parsed until its parser is
  explicitly added in this or a follow-up plan. If workflow policy is an input
  to negotiation, its source must be wired before implementation is complete.

## 10. Definition of done

- `WorkflowStage.allowedTools` and `denyTools` parse and reach stage execution.
- Provider availability is known before negotiation and has no unsafe fallback.
- The pure negotiator returns a stable granted list and explicit denials.
- Deny precedence and empty-request semantics are tested.
- Unknown and provider tools are classified distinctly and never default-allowed.
- Selected skills remain visible when tools are denied.
- Every migrated stage passes only `negotiated.granted` to the executor.
- The gate and compiled context expose identical denial details and recovery.
- Missing capability leaves the run active or blocked; it does not internally end
  the run.
- Focused tests, typecheck, build, and full tests pass, with baseline failures
  reported separately.
- Documentation, `AGENTS.md`, operational skills, and `learnings.md` are updated
  in the same implementation change.

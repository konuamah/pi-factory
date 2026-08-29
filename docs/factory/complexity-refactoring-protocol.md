# Complexity Refactoring Protocol

> Status: active operating protocol. Read this before running any complexity-refactoring wave. Wave ledger: see [complexity-refactoring-wave-1.md](complexity-refactoring-wave-1.md).

For a huge messy codebase, do **not** point this skill at the whole repository and say "refactor everything." That is the fastest way to create a giant risky diff.

Treat cyclomatic complexity as a **hotspot detector**, then refactor the codebase in controlled waves.

## 1. Freeze behavior before improving structure

Your first goal is not clean code. It is knowing whether you broke something.

Run the existing tests, record the current result, and add characterization tests around important code that has weak coverage. For ugly legacy functions, tests can simply document what the function currently does — even if that behavior is strange.

Then create a baseline such as:

```text
Tests: 1,842 passing
Lint: passing
Typecheck: passing
Build: passing

Complexity:
> 20: 43 functions
15-20: 87 functions
10-15: 211 functions
```

Now you have something measurable.

## 2. Scan the whole repository, but don't refactor the whole repository

Use the complexity skill initially in **report-only mode**.

You want something roughly like:

```text
Find cyclomatic complexity across the repository.

Do not modify code.

Return:
- top 50 most complex functions
- file
- function name
- complexity
- lines of code
- test coverage if available
- obvious code smell
- recommended refactoring technique

Respect existing project lint/complexity configuration.
```

This gives you a map.

The important distinction is:

```text
SCAN broadly
        ↓
PRIORITIZE
        ↓
REFACTOR narrowly
```

Not:

```text
SCAN → REFACTOR EVERYTHING
```

## 3. Prioritize hotspots by risk, not complexity alone

A complexity score of 40 in forgotten migration code may matter less than complexity 14 in your checkout/auth/core API path.

A better priority score is something like:

```text
priority =
    complexity
    × change frequency
    × business importance
    × bug frequency
    × lack of tests
```

So your first targets should generally be code that is both **messy and frequently touched**.

Think of the repo as:

```text
                    HIGH CHANGE
                        │
       Refactor soon    │    REFACTOR FIRST
                        │
LOW COMPLEXITY ─────────┼───────── HIGH COMPLEXITY
                        │
       Ignore mostly    │    Refactor eventually
                        │
                    LOW CHANGE
```

That alone can save you weeks of pointless cleanup.

## 4. Refactor one hotspot at a time

For each function, give the agent a very constrained job.

For example:

```text
Use the cyclomatic-complexity skill on:

src/orders/processOrder.ts

Goals:
- preserve external behavior
- do not change public APIs
- do not introduce new dependencies
- reduce cyclomatic complexity
- improve naming
- remove obvious duplication where directly related
- prefer small named functions over clever expressions

Before modifying anything:
1. identify existing tests
2. report current complexity
3. explain the main sources of branching

Then refactor.

Afterwards:
1. run relevant tests
2. run typecheck/lint
3. report complexity before/after
4. summarize structural changes
```

This gives the AI **boundaries**. That matters a lot with AI refactoring.

## 5. Use a predictable refactoring order

For ugly AI-generated code, attack complexity in this order.

**Nested conditionals → guard clauses**

Instead of:

```python
if user:
    if user.active:
        if user.subscription:
            process(user)
```

move toward:

```python
if not user:
    return

if not user.active:
    return

if not user.subscription:
    return

process(user)
```

Then look for **large branches → extracted functions**:

```text
process_order()
    validate_order()
    calculate_pricing()
    resolve_shipping()
    authorize_payment()
    persist_order()
```

Then **repeated branching → lookup/strategy tables**.

Instead of:

```javascript
if (type === "admin") ...
else if (type === "editor") ...
else if (type === "viewer") ...
else if ...
```

you may eventually have:

```javascript
const handlers = {
  admin: handleAdmin,
  editor: handleEditor,
  viewer: handleViewer,
};
```

Then use **named predicates** when conditions are unreadable:

```javascript
if (
  user &&
  user.active &&
  !user.suspended &&
  user.plan !== "free" &&
  account.status === "ready"
)
```

becomes something closer to:

```javascript
if (canProcessAccount(user, account)) {
```

## 6. Don't mix every cleanup goal into the same pass

Your codebase probably has several separate problems:

```text
Cyclomatic complexity
Duplication / non-DRY code
Huge files
Poor boundaries
Bad naming
Dead code
Wrong abstractions
Inconsistent error handling
Weak types
Circular dependencies
Missing tests
```

Cyclomatic complexity addresses **one dimension**.

Run separate cleanup waves:

```text
Wave 1
Safety / tests

Wave 2
Cyclomatic complexity

Wave 3
Duplication

Wave 4
Large modules / architecture boundaries

Wave 5
Types and contracts

Wave 6
Dead code and cleanup
```

Don't tell the model:

```text
Make this whole area clean, DRY, SOLID, performant,
well architected and simple.
```

That creates huge unpredictable refactors.

## 7. Put limits on the AI

For a large codebase, enforce rules such as:

```text
Maximum 1-3 related files per refactor
Maximum ~300 changed lines unless necessary
No public API changes
No dependency changes without justification
No database/schema changes
No behavior changes
Existing tests must pass
New extracted functions require meaningful names
Do not suppress complexity warnings
Do not reduce complexity using ternary tricks
```

This prevents the metric from being gamed.

You especially want to avoid transformations like:

```javascript
return a ? b ? c : d : e ? f : g;
```

It may technically alter how some tools count complexity while making the code much worse.

## 8. Give every refactor a scorecard

Finish each batch with something like:

| Function            | Before | After |
| ------------------- | -----: | ----: |
| `processOrder`      |     31 |     8 |
| `calculateDiscount` |     17 |     5 |
| `validateCheckout`  |     21 |     7 |

And also:

```text
Tests:
✓ unit tests
✓ integration tests

Lint:
✓

Typecheck:
✓

Public API changes:
none

Behavior changes:
none intended
```

That makes AI refactoring much easier to review.

## One change to the overall strategy: DRY is dangerous

Don't aim for:

> "Make the repository DRY."

DRY can become dangerous in a large messy system because the AI may combine code that **looks similar but represents different business concepts**.

Instead use:

> **Remove duplication only when the duplicated code represents the same concept and is expected to change for the same reason.**

Sometimes duplication is safer than the wrong abstraction.

## A practical repo-wide workflow

```text
                    ┌─────────────┐
                    │ Entire repo │
                    └──────┬──────┘
                           │
                     complexity scan
                           │
                           ▼
                    ┌─────────────┐
                    │ Hotspot list│
                    └──────┬──────┘
                           │
                  rank by risk/churn
                           │
                           ▼
                   ┌───────────────┐
                   │ Select hotspot│
                   └───────┬───────┘
                           │
                    tests sufficient?
                     /           \
                   no             yes
                   │               │
             add tests             │
                   └───────┬───────┘
                           ▼
                       refactor
                           │
                           ▼
                 test/lint/typecheck
                           │
                           ▼
                  complexity report
                           │
                           ▼
                       small PR
                           │
                           ▼
                      next hotspot
```

Make **small commits**:

```text
refactor(parser): extract token validation

refactor(parser): simplify parse-state branching

refactor(parser): extract error recovery strategy
```

rather than:

```text
refactor entire parser
```

## The first thing to do in a new codebase

Take **one representative messy subsystem**, not your easiest one and not your most dangerous one.

Something around 5–20 files is ideal.

Run a complexity inventory on it and choose the top **3–5 functions**.

Refactor those.

That gives you a chance to learn whether the skill produces code that fits **your architecture and coding style** before unleashing it across the repository.

Once the process works, automate the loop:

```text
Current complexity baseline
        ↓
New PR
        ↓
Did modified code introduce
new high-complexity functions?
        ↓
      yes → fail/warn
      no  → continue
```

That is much more valuable than cleaning the repository once, because it stops the slop from coming back.

## The stack

```text
1. Tests / characterization tests
2. Complexity scanner
3. Hotspot ranking
4. Cyclomatic-complexity skill
5. Small refactors
6. Tests + lint + typecheck
7. Before/after complexity report
8. Small commits/PRs
9. Complexity guard in CI
10. Repeat
```

If the codebase is **really** large, build a **repo-refactoring protocol for your AI agent**: a single `AGENTS.md`/Claude instruction that tells it exactly how to scan, choose hotspots, test, refactor, verify, and commit so you can systematically clean the codebase instead of manually prompting every file.

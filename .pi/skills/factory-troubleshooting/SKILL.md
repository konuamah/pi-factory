---
name: factory-troubleshooting
description: Diagnose Factory failures, blocked runs, logs, plans, and readiness problems.
---

# Factory Troubleshooting

Use this when the user says something failed, broke, is blocked, timed out, produced no changes, has bad logs, or needs diagnosis.

Start with `/factory status`, `/factory list`, `/factory show <run-id>`, `/factory logs <run-id>`, and `/factory plan` depending on the symptom.

Run summaries may show a short deterministic `title` for display and keep the full user prompt as `goal`. Use `title` to identify a run in lists, but inspect `goal` when exact user intent matters.

Planner task titles should use the same compact title for status/log readability. If failed task artifacts show the full pasted prompt in every title, diagnose that as Factory metadata noise; the full prompt belongs in `goal`, prompts, and audit artifacts.

Live runs, `/factory logs <run-id>`, and `/factory show <run-id>` include concise tool activity lines for reads, searches, writes/edits, and shell commands. Check those lines first when users ask what Factory is doing or what it touched; open raw `*-execution.json` artifacts only when the compact activity trail is not enough.

For discovery failures, inspect the execution artifact. `implementationSurface: "missing"` is valid for empty or greenfield repos and should not be treated as a crash.

For model timeouts or executor watchdog aborts, explain that Factory's runtime limit stopped a quiet SDK turn. Distinguish the timeout types: `model-idle-timeout` (no SDK activity for `modelIdleTimeoutMs`), `tool-timeout` (a single tool exceeded `toolTimeoutMs`), `turn-timeout` (the whole turn exceeded `turnTimeoutMs`), and `run-timeout` (the whole run exceeded the shared `runTimeoutMs` deadline). Recommend tuning `runtime.limits.modelIdleTimeoutMs` or choosing a faster role model only after checking whether the role emitted text or tool events. Note `modelTimeoutMs`/`totalRunTimeoutMs` are deprecated aliases for `modelIdleTimeoutMs`/`turnTimeoutMs`.

Final run output and `/factory show <run-id>` should show the latest `task.failed` reason, builder status, and builder execution path. If users only see `implementation-failed`, inspect events for the more specific failure reason.

For a completed Builder run with no file changes, distinguish the outcome from events: `CONTRACT_NOOP` (behavior already satisfied — Builder stopped without forced edits), `CONTRACT_BLOCKED` (missing file or un-runnable contract), or an unexplained no-change (Factory retries once, then fails). `contract-noop` and `contract-blocked` end the run `BLOCKED` with phase `implementation-blocked` and are not resumable into implementation; the Builder's reason is in the summary `recoveryHint`, and a `task.contract_noop` / `task.contract_blocked` / `task.no_changes_retrying` event is recorded. Inspect those before tuning models or timeouts.

For merge-blocked runs, inspect landing artifacts first. The landing strategy is model-selected; deterministic checks only enforce Git safety invariants. A valid candidate should not be abandoned: when GitHub PR recovery is enabled, Factory pushes the candidate branch and opens or reuses a PR through the user's authenticated `gh` CLI. Incomplete or baseline-unrelated verification does not by itself abandon a candidate. Inspect `final-merge.json` for `pullRequest.status`, `pullRequest.url`, `targetHeadAfter`, and `postLandingVerification`. If a run stalls after `landing.plan_selected`, a `final-merge.json` with `status: landed` means Git landing succeeded and the remaining issue is post-landing verification or finalization, not merge policy.

Post-landing verification runs against the landed target checkout (`mergeCwd`), not the pre-landing worktree. When it fails only on debt already classified `baseline-unrelated` + `ignore` + non-retryable, Factory does not launch a repair agent: the commit already landed, so a repair session would be wasted work. That shows as `landing.post_verification_repair_skipped` in events and `repairAttempted: false` with a `failed` status in `final-merge.json`. Real failures that were not pre-classified as ignorable baseline debt still repair.

For stale verification commands, use repository evidence to choose an adapted check rather than blindly running configured commands over generated output.

For interview runs that fail after answers were skipped, inspect `interview-decisions.json`, `decisions.jsonl`, and `planner-execution.json`. Skipped questions should show `skipped: true` and `A<N>: [skipped]`; a proper negative path fails as `Planning failed: Interview answers were skipped and planning needs clarification: ...`. If a run instead fails before planning with `Decision required ... no requestDecision handler is configured`, that is a missing decision handler, not a skip problem.

For slow or overly broad final review, inspect `reviewer-execution.json`, `completed-tasks.json`, `plan.json`, and `verification.json` together. Final review now builds a scoped packet from the changed files, candidate diff, direct imports/dependencies, plan contract, and verification result. Tiny low-risk changes may skip the LLM reviewer entirely: look for `review.deterministic` in events and a positive deterministic `reviewer-execution.json`. If the LLM reviewer still ran, the usual reasons are multiple changed files, a truncated diff, a high-risk file path, incomplete verification, or a non-goal violation. Since final approval is a post-review gate, a run ending in `review-unavailable` means Factory refused to open final approval because neither deterministic review nor a reviewer executor produced review evidence — configure a reviewer model/executor or shrink the candidate to a deterministic-review-eligible trivial diff before rerunning.

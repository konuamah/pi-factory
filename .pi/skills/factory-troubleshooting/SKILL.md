---
name: factory-troubleshooting
description: Diagnose Factory failures, blocked runs, logs, plans, and readiness problems.
---

# Factory Troubleshooting

Use this when the user says something failed, broke, is blocked, timed out, produced no changes, has bad logs, or needs diagnosis.

Start with `/factory status`, `/factory list`, `/factory show <run-id>`, `/factory logs <run-id>`, and `/factory plan` depending on the symptom.

Run summaries may show a short deterministic `title` for display and keep the full user prompt as `goal`. Use `title` to identify a run in lists, but inspect `goal` when exact user intent matters.

Planner task titles should use the same compact title for status/log readability. If failed task artifacts show the full pasted prompt in every title, diagnose that as Factory metadata noise; the full prompt belongs in `goal`, prompts, and audit artifacts.

For discovery failures, inspect the execution artifact. `implementationSurface: "missing"` is valid for empty or greenfield repos and should not be treated as a crash.

For model timeouts or executor watchdog aborts, explain that Factory's runtime limit stopped a quiet SDK turn. Recommend tuning `runtime.limits.modelTimeoutMs` or choosing a faster role model only after checking whether the role emitted text or tool events.

Final run output and `/factory show <run-id>` should show the latest `task.failed` reason, builder status, and builder execution path. If users only see `implementation-failed`, inspect events for the more specific failure reason.

For merge-blocked runs, inspect landing artifacts first. Dirty files block only when they overlap landing files or prevent safely switching to the target branch. Incomplete verification does not by itself block required landing.

For stale verification commands, use repository evidence to choose an adapted check rather than blindly running configured commands over generated output.

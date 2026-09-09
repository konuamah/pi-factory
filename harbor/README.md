# Harbor Quality Testing

This directory is the local Harbor home for `pi-factory`.

What is set up here:

- `tasks/factory-smoke` is a tiny end-to-end Harbor task that proves the local Harbor install, task structure, and verifier wiring are healthy.
- `npm run harbor:task:smoke:config` validates the task definition without launching a real agent run.
- `npm run harbor:task:init` wraps `harbor init` with `PYTHONIOENCODING=utf-8`, which avoids the Windows `cp1252` crash we observed when Harbor prints a Unicode checkmark after scaffold creation.

Why this exists:

- We want a real quality-testing lane for Factory.
- Harbor is best used as an eval harness around real tasks, agents, and verifiers.
- The smoke task keeps the plumbing honest before we invest in stronger benchmarks like `add a navbar`, `fix verification failure`, or `repair a broken build`.

Installed Codex skills from Harbor:

- `create-task`
- `create-adapter`
- `harbor-exec`

Useful commands:

```bash
npm run harbor:version
npm run harbor:task:smoke:config
npm run harbor:task:init -- local/my-new-task --task --output-dir harbor/tasks
```

When we design the proper workflow, the next likely move is to add a task set under `harbor/tasks/` that mirrors real Factory situations:

- UI feature work like `add a navbar`
- verification repair
- failure classification
- end-to-end run quality against saved artifacts

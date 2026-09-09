# local/factory-smoke

This is the starter Harbor task for the `pi-factory` repository.

It is intentionally small. The goal is to prove that Harbor is installed, the task layout is valid, the verifier can run, and artifacts are collected.

Success condition:

- the agent creates `artifacts/factory-quality-summary.json`
- the JSON uses the expected shape and values

This is not the final benchmark. It is the seed task we can now expand into real feature requests and repair tasks.

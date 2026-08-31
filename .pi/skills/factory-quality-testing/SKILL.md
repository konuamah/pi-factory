---
name: factory-quality-testing
description: Use Harbor tasks, benchmarks, and graders for Factory quality evaluation.
---

# Factory Quality Testing

Use this when the user asks to quality-test Factory, run Harbor tasks, benchmark orchestration, compare runs, or evaluate task quality.

Harbor is for repeated eval tasks with deterministic verifiers, not a replacement for ordinary repo tests. The starter task is `harbor/tasks/factory-smoke`.

For the approved Factory orchestration benchmark, use Harbor plus scripted interviews, Oracle-vs-agent separation, and the six-pillar scorer. Benchmark runs should preserve artifacts so discovery, planning, implementation, repair, verification, approval, landing, and scoring can be inspected.

Use normal repo tests for implementation correctness, and Harbor/benchmark tasks for repeated behavior evaluation.

---
name: factory-model-routing
description: Diagnose and configure Pi-visible Factory role model routing.
---

# Factory Model Routing

Use this when the user asks about models, providers, role routing, Pi auth, missing models, or model readiness.

Factory model-routing roles are only `discovery`, `planner`, `builder`, `reviewer`, `repair`, and `landing`. There is no `interviewer` role; an interview workflow stage should use one of the real model roles, normally `planner`. Broad setup should assign Pi-visible models for every role when Pi exposes a usable model.

`/factory doctor` is the readiness gate for model routing and Pi-visible availability. `/factory models` is the deeper inspection view for defaults, per-role routing, task-type routing, and unavailable provider/model pairs.

Do not treat built-in fallback names as ready when Pi does not expose them. If provider/model routing is missing or unavailable during a broad setup request, recommend `/factory setup` so role models can be written together with the rest of config.

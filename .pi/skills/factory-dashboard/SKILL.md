---
name: factory-dashboard
description: Configure, start, inspect, and troubleshoot the Factory dashboard.
---

# Factory Dashboard

Use this when the user asks about the dashboard, run UI, status pages, ports, hosting, or opening/stopping the dashboard.

Dashboard config lives in `.factory/config.yaml` under `dashboard`. Typical settings are `enabled`, `port`, `host`, and `autoOpen`.

Use `/factory dashboard status` for read-only inspection and `/factory dashboard start` when the user wants the local dashboard running. Starting a service requires approval unless the user explicitly asked for it.

Verify dashboard changes with `/factory doctor` or `/factory dashboard status`.

Dashboard run lists should display the short deterministic run `title` when present and keep the full `goal` available in details.

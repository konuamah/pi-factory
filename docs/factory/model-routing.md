# Model Routing

Use this when models fail, defaults are unclear, or the user wants custom model behavior.

## Sources

Factory should prefer models configured in Pi before built-in defaults. Useful sources include:

- Pi default provider/model
- Pi model stores
- enabled provider models
- project Factory model config
- built-in planner/builder/reviewer/repair fallback names

## Inspect

Use `/factory doctor` as the readiness gate. It now fails when Factory cannot resolve a model for a role/task path or when the resolved provider/model pair is not visible in Pi.

Use `/factory models` as the deeper inspection view.

When the user asks Factory Concierge to set up Factory or make a project ready, Concierge should run setup so Pi-visible role models are written into `.factory/config.yaml`. `/factory models` is for inspection after that, not the default broad setup action.

Run:

```text
/factory models
```

Check:

- effective model per role
- provider names
- task type routing
- unavailable model errors
- doctor readiness failures for `model-routing` and `model-availability`

## Fixes

If a configured model is unavailable, replace it with the detected Pi default.

If `/factory doctor` reports a missing or stale model, fix it in `.factory/config.yaml` after inspecting `/factory models`.

If only one strong Pi model is configured, it is acceptable to use it for all roles.

If the user wants specialization:

- planner: strongest reasoning model
- builder: fast implementation model
- reviewer: strongest review/risk model
- repair: fast implementation or debugging model

## Avoid

- Do not invent provider names.
- Do not silently keep stale unavailable models.
- Do not recommend models not visible in Pi unless the user is manually adding them.

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

Run:

```text
/factory models
```

Check:

- effective model per role
- provider names
- task type routing
- unavailable model errors

## Fixes

If a configured model is unavailable, replace it with the detected Pi default.

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

# pi-factory

Initial scaffold for a Pi-native Factory with project-authoritative configuration.

## Current focus

- config schemas
- config precedence merge
- project discovery
- effective config loading
- project setup scaffolding

## Precedence

```text
built-ins < global defaults < project config < run overrides
```

## Config files

Project files are intended to be YAML:

- `factory.yaml`
- `.factory/config.yaml`
- `CONSTITUTION.md`

The loader accepts JSON or YAML content.

## Setup scaffolding

Core now includes an initializer that can create:

- `CONSTITUTION.md`
- `factory.yaml`
- `.factory/config.yaml`
- `.factory/runs/`

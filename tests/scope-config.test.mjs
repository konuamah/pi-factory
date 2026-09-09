import test from "node:test";
import assert from "node:assert/strict";
import { mergeConfigLayers } from "../packages/core/dist/config/merge.js";
import { builtInDefaults } from "../packages/core/dist/config/defaults.js";

const builtIns = builtInDefaults;

test("scope config defaults to warn/warn when absent", () => {
  const config = mergeConfigLayers({ builtIns });
  assert.equal(config.scope.verification, "warn");
  assert.equal(config.scope.landing, "warn");
});

test("scope config project overrides defaults", () => {
  const config = mergeConfigLayers({
    builtIns,
    project: { scope: { verification: "block", landing: "block" } },
  });
  assert.equal(config.scope.verification, "block");
  assert.equal(config.scope.landing, "block");
});

test("scope config runOverrides take precedence over project", () => {
  const config = mergeConfigLayers({
    builtIns,
    project: { scope: { verification: "block" } },
    runOverrides: { scope: { verification: "warn" } },
  });
  assert.equal(config.scope.verification, "warn");
  assert.equal(config.scope.landing, "warn");
});

test("scope config partial project leaves other side at default", () => {
  const config = mergeConfigLayers({
    builtIns,
    project: { scope: { verification: "block" } },
  });
  assert.equal(config.scope.verification, "block");
  assert.equal(config.scope.landing, "warn");
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { runFactoryDoctor, validateFactorySetup } from "../packages/core/dist/index.js";

const execFile = promisify(execFileCb);

async function withDoctorRepo(options, fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-factory-doctor-"));
  const agentDir = path.join(root, "agent");
  const repoDir = path.join(root, "repo");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(repoDir, { recursive: true });

  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await initGitRepo(repoDir);
    await fs.mkdir(path.join(repoDir, ".factory", "runs"), { recursive: true });
    await fs.writeFile(path.join(repoDir, "CONSTITUTION.md"), "# Constitution\n", "utf8");
    await fs.writeFile(path.join(repoDir, "factory.yaml"), "{}\n", "utf8");
    await fs.writeFile(
      path.join(repoDir, ".factory", "config.yaml"),
      JSON.stringify(buildProjectConfig(options.config ?? {}), null, 2),
      "utf8",
    );

    if (options.agentSettings) {
      await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify(options.agentSettings, null, 2), "utf8");
    }
    if (options.agentAuth) {
      await fs.writeFile(path.join(agentDir, "auth.json"), JSON.stringify(options.agentAuth, null, 2), "utf8");
    }
    if (options.modelsStore) {
      await fs.writeFile(path.join(agentDir, "models-store.json"), JSON.stringify(options.modelsStore, null, 2), "utf8");
    }
    if (options.commandCodeModels) {
      await fs.writeFile(path.join(agentDir, "commandcode-models.json"), JSON.stringify(options.commandCodeModels, null, 2), "utf8");
    }
    if (options.modelsJson) {
      await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify(options.modelsJson, null, 2), "utf8");
    }

    await execFile("git", ["add", "."], { cwd: repoDir });
    await execFile("git", ["commit", "-m", "init"], { cwd: repoDir });
    await execFile("git", ["branch", "-M", "main"], { cwd: repoDir });

    await fn({ repoDir, agentDir });
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

function buildProjectConfig(overrides) {
  return {
    project: {
      baseBranch: "main",
    },
    commands: {
      lint: 'node -e ""',
      typecheck: 'node -e ""',
      test: 'node -e ""',
      build: 'node -e ""',
    },
    runtime: {
      maxParallelAgents: 1,
    },
    git: {
      allowWorktrees: false,
    },
    repair: {
      enabled: false,
    },
    approval: {
      finalMerge: "required",
    },
    ...overrides,
  };
}

async function initGitRepo(root) {
  await execFile("git", ["init"], { cwd: root });
  await execFile("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFile("git", ["config", "user.name", "Test User"], { cwd: root });
}

test("factory doctor passes when all roles resolve and every resolved model is Pi-visible", async () => {
  await withDoctorRepo(
    {
      config: {
        models: {
          discovery: { provider: "openai-codex", model: "gpt-5.4-mini" },
          planner: { provider: "openai-codex", model: "gpt-5.4-mini" },
          builder: { provider: "openai-codex", model: "gpt-5.4-mini" },
          reviewer: { provider: "openai-codex", model: "gpt-5.4-mini" },
          repair: { provider: "openai-codex", model: "gpt-5.4-mini" },
          landing: { provider: "openai-codex", model: "gpt-5.4-mini" },
        },
        taskTypes: {
          docs: {},
        },
      },
      agentSettings: {
        defaultProvider: "openai-codex",
        defaultModel: "gpt-5.4-mini",
      },
    },
    async ({ repoDir }) => {
      const result = await runFactoryDoctor(repoDir);
      assert.ok(result.checks.some((check) => check.name === "model-routing" && check.ok));
      assert.ok(result.checks.some((check) => check.name === "model-availability" && check.ok));
      assert.equal(result.checks.some((check) => !check.ok), false);
    },
  );
});

test("factory doctor fails model-routing when a role default is null with no task-type override", async () => {
  await withDoctorRepo(
    {
      config: {
        models: {
          builder: null,
        },
      },
      agentSettings: {
        defaultProvider: "openai-codex",
        defaultModel: "gpt-5.4-mini",
      },
    },
    async ({ repoDir }) => {
      const result = await runFactoryDoctor(repoDir);
      const failure = result.checks.find((check) => check.name === "model-routing" && !check.ok);
      assert.ok(failure);
      assert.match(failure.detail, /role=builder/);
      assert.match(failure.detail, /taskType=general/);
      assert.match(failure.detail, /models\.builder/);
      assert.match(failure.detail, /\/factory models/);
    },
  );
});

test("factory doctor fails model-routing for configured task types that still cannot resolve a role", async () => {
  await withDoctorRepo(
    {
      config: {
        models: {
          reviewer: null,
        },
        taskTypes: {
          migration: {
            routing: {
              builder: { provider: "openai-codex", model: "gpt-5.4-mini" },
            },
          },
        },
      },
      agentSettings: {
        defaultProvider: "openai-codex",
        defaultModel: "gpt-5.4-mini",
      },
    },
    async ({ repoDir }) => {
      const result = await runFactoryDoctor(repoDir);
      const failures = result.checks.filter((check) => check.name === "model-routing" && !check.ok);
      assert.ok(failures.some((check) => /role=reviewer/.test(check.detail) && /taskType=migration/.test(check.detail)));
    },
  );
});

test("factory doctor fails model-availability when a resolved model is not present in Pi inventory", async () => {
  await withDoctorRepo(
    {
      config: {
        models: {
          discovery: { provider: "openai-codex", model: "gpt-5.4-mini" },
          planner: { provider: "openai-codex", model: "gpt-5.4-mini" },
          builder: { provider: "openai-codex", model: "gpt-5.4-mini" },
          reviewer: { provider: "openai-codex", model: "gpt-5.4-mini" },
          repair: { provider: "openai-codex", model: "gpt-5.4-mini" },
          landing: { provider: "openai-codex", model: "gpt-5.4-mini" },
        },
      },
      agentSettings: {
        defaultProvider: "openai-codex",
        defaultModel: "gpt-5.4",
      },
    },
    async ({ repoDir }) => {
      const result = await runFactoryDoctor(repoDir);
      const failure = result.checks.find((check) => check.name === "model-availability" && !check.ok);
      assert.ok(failure);
      assert.match(failure.detail, /role=discovery/);
      assert.match(failure.detail, /taskType=general/);
      assert.match(failure.detail, /configured source=role-default/);
      assert.match(failure.detail, /missing model key=openai-codex:gpt-5\.4-mini/);
      assert.match(failure.detail, /\/factory models/);

      const validation = await validateFactorySetup(repoDir);
      assert.equal(validation.readiness, "NOT_READY");
      assert.ok(validation.checks.some((check) => check.name === "doctor:model-availability" && !check.ok));
    },
  );
});

test("validateFactorySetup is NOT_READY when constitution is missing", async () => {
  await withDoctorRepo(
    {
      config: {
        models: {
          discovery: { provider: "openai-codex", model: "gpt-5.4-mini" },
          planner: { provider: "openai-codex", model: "gpt-5.4-mini" },
          builder: { provider: "openai-codex", model: "gpt-5.4-mini" },
          reviewer: { provider: "openai-codex", model: "gpt-5.4-mini" },
          repair: { provider: "openai-codex", model: "gpt-5.4-mini" },
          landing: { provider: "openai-codex", model: "gpt-5.4-mini" },
        },
      },
      agentSettings: {
        defaultProvider: "openai-codex",
        defaultModel: "gpt-5.4-mini",
      },
    },
    async ({ repoDir }) => {
      await fs.rm(path.join(repoDir, "CONSTITUTION.md"), { force: true });

      const validation = await validateFactorySetup(repoDir);
      assert.equal(validation.readiness, "NOT_READY");
      assert.ok(validation.checks.some((check) => check.name === "constitution" && !check.ok));
    },
  );
});

test("factory doctor passes when one visible Pi model is reused across all roles", async () => {
  await withDoctorRepo(
    {
      config: {
        models: {
          discovery: { provider: "commandcode", model: "claude-sonnet-5" },
          planner: { provider: "commandcode", model: "claude-sonnet-5" },
          builder: { provider: "commandcode", model: "claude-sonnet-5" },
          reviewer: { provider: "commandcode", model: "claude-sonnet-5" },
          repair: { provider: "commandcode", model: "claude-sonnet-5" },
          landing: { provider: "commandcode", model: "claude-sonnet-5" },
        },
        taskTypes: {
          refactor: {},
          docs: {},
        },
      },
      agentAuth: {
        commandcode: { type: "api_key" },
      },
      commandCodeModels: {
        models: [{ id: "claude-sonnet-5" }],
      },
    },
    async ({ repoDir }) => {
      const result = await runFactoryDoctor(repoDir);
      assert.ok(result.checks.some((check) => check.name === "model-routing" && check.ok));
      assert.ok(result.checks.some((check) => check.name === "model-availability" && check.ok));
      assert.equal(result.checks.some((check) => !check.ok), false);
    },
  );
});

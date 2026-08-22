import fs from "node:fs/promises";
import path from "node:path";
import { discoverFactoryProject } from "../project/discovery.js";
import { createFactoryRun, appendFactoryRunEvent, updateFactoryRunState } from "../runs/store.js";
import { loadEffectiveConfig } from "../config/loader.js";

export interface InitializeFactoryProjectOptions {
  cwd: string;
  force?: boolean;
}

export interface InitializeFactoryProjectResult {
  root: string;
  created: string[];
  skipped: string[];
  runId: string;
  runDir: string;
}

export async function initializeFactoryProject(
  options: InitializeFactoryProjectOptions,
): Promise<InitializeFactoryProjectResult> {
  const discovered = await discoverFactoryProject(options.cwd);
  const root = discovered.paths.gitRoot ?? options.cwd;
  const created: string[] = [];
  const skipped: string[] = [];

  await fs.mkdir(path.join(root, ".factory", "runs"), { recursive: true });
  await fs.mkdir(path.join(root, ".factory", "constitution"), { recursive: true });

  await ensureFile({
    filePath: path.join(root, "CONSTITUTION.md"),
    content: defaultConstitutionTemplate(),
    force: options.force,
    created,
    skipped,
  });

  await ensureFile({
    filePath: path.join(root, "factory.yaml"),
    content: defaultWorkflowTemplate(),
    force: options.force,
    created,
    skipped,
  });

  await ensureFile({
    filePath: path.join(root, ".factory", "config.yaml"),
    content: defaultProjectConfigTemplate(),
    force: options.force,
    created,
    skipped,
  });

  const loaded = await loadEffectiveConfig({ cwd: root });
  const run = await createFactoryRun({
    runsDir: path.join(root, ".factory", "runs"),
    initialPhase: "setup",
    effectiveConfig: loaded.effectiveConfig,
  });

  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "setup.files_prepared",
    data: {
      created,
      skipped,
    },
  });

  await updateFactoryRunState({
    statePath: run.statePath,
    patch: {
      status: "COMPLETED",
      phase: "setup-complete",
    },
  });

  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "setup.completed",
    data: {
      runId: run.runId,
    },
  });

  return { root, created, skipped, runId: run.runId, runDir: run.runDir };
}

async function ensureFile(input: {
  filePath: string;
  content: string;
  force?: boolean;
  created: string[];
  skipped: string[];
}): Promise<void> {
  await fs.mkdir(path.dirname(input.filePath), { recursive: true });

  const exists = await pathExists(input.filePath);
  if (exists && !input.force) {
    input.skipped.push(input.filePath);
    return;
  }

  await fs.writeFile(input.filePath, input.content, "utf8");
  input.created.push(input.filePath);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function defaultConstitutionTemplate(): string {
  return `# CONSTITUTION\n\n## Purpose\nDescribe how this repository actually works.\n\n## Architecture\n- Add authoritative architecture notes here.\n\n## Commands\n- setup:\n- lint:\n- typecheck:\n- test:\n- build:\n\n## Conventions\n- Add coding and review conventions here.\n`;
}

function defaultWorkflowTemplate(): string {
  return `stages:\n  - name: plan\n  - name: build\n    dependsOn: [plan]\n  - name: verify\n    dependsOn: [build]\n  - name: approval\n    dependsOn: [verify]\n  - name: merge\n    dependsOn: [approval]\n`;
}

function defaultProjectConfigTemplate(): string {
  return `project:\n  baseBranch: main\n\ncommands:\n  setup: pnpm install\n  lint: pnpm lint\n  typecheck: pnpm typecheck\n  test: pnpm test\n  build: pnpm build\n\nruntime:\n  maxParallelAgents: 4\n\nrepair:\n  enabled: true\n  maxAttempts: 3\n\napproval:\n  finalMerge: required\n`;
}

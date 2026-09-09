import fs from "node:fs/promises";
import path from "node:path";
import type { ModelRole, ModelSelection } from "@factory/schemas";
import { discoverFactoryProject } from "../project/discovery.js";
import { createFactoryRun, appendFactoryRunEvent, updateFactoryRunState } from "../runs/store.js";
import { loadEffectiveConfig } from "../config/loader.js";
import { detectPiModelConfiguration, type PiModelConfigurationStatus } from "./pi-models.js";

export type FactoryWorkflowPreset = "balanced" | "fast" | "safe";

export interface InitializeFactoryProjectOptions {
  cwd: string;
  force?: boolean;
  setup?: {
    workflowPreset?: FactoryWorkflowPreset;
    modelAssignments?: Partial<Record<ModelRole, ModelSelection>>;
    reconfigure?: boolean;
  };
}

export interface InitializeFactoryProjectResult {
  root: string;
  created: string[];
  skipped: string[];
  runId: string;
  runDir: string;
  piModelConfiguration: PiModelConfigurationStatus;
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
    content: defaultWorkflowTemplate(options.setup?.workflowPreset),
    force: options.force || options.setup?.reconfigure,
    created,
    skipped,
  });

  await ensureFile({
    filePath: path.join(root, ".factory", "config.yaml"),
    content: defaultProjectConfigTemplate(options.setup?.modelAssignments),
    force: options.force || options.setup?.reconfigure,
    created,
    skipped,
  });

  const loaded = await loadEffectiveConfig({ cwd: root });
  const piModelConfiguration = await detectPiModelConfiguration(root);
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
      piModelConfiguration: {
        hasModelSelection: piModelConfiguration.hasModelSelection,
        hasAuth: piModelConfiguration.hasAuth,
        defaultProvider: piModelConfiguration.defaultProvider,
        defaultModel: piModelConfiguration.defaultModel,
        enabledModels: piModelConfiguration.enabledModels.length,
        authProviders: piModelConfiguration.authProviders.length,
        customModelCount: piModelConfiguration.customModelCount,
      },
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

  return { root, created, skipped, runId: run.runId, runDir: run.runDir, piModelConfiguration };
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

export function defaultConstitutionTemplate(): string {
  return `# CONSTITUTION\n\n## Purpose\nDescribe how this repository actually works.\n\n## Architecture\n- Add authoritative architecture notes here.\n\n## Commands\n- setup:\n- lint:\n- typecheck:\n- test:\n- build:\n\n## Conventions\n- Add coding and review conventions here.\n`;
}

export function defaultWorkflowTemplate(preset: FactoryWorkflowPreset = "balanced"): string {
  if (preset === "fast") {
    return `defaultWorkflowId: default-dev\nworkflows:\n  - id: default-dev\n    name: Fast Development\n    stages:\n      - name: discover\n        type: agent\n        role: discovery\n      - name: plan\n        type: agent\n        role: planner\n        dependsOn: [discover]\n      - name: build\n        type: agent\n        role: builder\n        dependsOn: [plan]\n      - name: review\n        type: agent\n        role: reviewer\n        dependsOn: [build]\n      - name: acceptance\n        type: acceptance\n        dependsOn: [review]\n      - name: landing\n        dependsOn: [acceptance]\n`;
  }

  if (preset === "safe") {
    return `defaultWorkflowId: default-dev\nworkflows:\n  - id: default-dev\n    name: Safe Development\n    stages:\n      - name: discover\n        type: agent\n        role: discovery\n      - name: plan\n        type: agent\n        role: planner\n        dependsOn: [discover]\n      - name: build\n        type: agent\n        role: builder\n        dependsOn: [plan]\n      - name: verify\n        type: command\n        dependsOn: [build]\n      - name: review\n        type: agent\n        role: reviewer\n        dependsOn: [verify]\n      - name: acceptance\n        type: acceptance\n        dependsOn: [review]\n      - name: landing\n        dependsOn: [acceptance]\n`;
  }

  return `defaultWorkflowId: default-dev\nworkflows:\n  - id: default-dev\n    name: Balanced Development\n    stages:\n      - name: discover\n        type: agent\n        role: discovery\n      - name: plan\n        type: agent\n        role: planner\n        dependsOn: [discover]\n      - name: build\n        type: agent\n        role: builder\n        dependsOn: [plan]\n      - name: verify\n        type: command\n        dependsOn: [build]\n      - name: review\n        type: agent\n        role: reviewer\n        dependsOn: [verify]\n      - name: acceptance\n        type: acceptance\n        dependsOn: [review]\n      - name: landing\n        dependsOn: [acceptance]\n`;
}

export function defaultProjectConfigTemplate(modelAssignments?: Partial<Record<ModelRole, ModelSelection>>): string {
  const modelBlock = renderModelAssignments(modelAssignments);
  return `project:\n  baseBranch: main\n\ncommands:\n  setup: pnpm install\n  lint: pnpm lint\n  typecheck: pnpm typecheck\n  test: pnpm test\n  build: pnpm build\n${modelBlock}\nruntime:\n  maxParallelAgents: 4\n\ndependencies:\n  enabled: true\n  hydrate: auto\n\nconstitution:\n  enabled: false\n\nrepair:\n  enabled: true\n  maxAttempts: 3\n\napproval:\n  finalMerge: required\n`;
}

function renderModelAssignments(modelAssignments?: Partial<Record<ModelRole, ModelSelection>>): string {
  const orderedRoles: ModelRole[] = ["discovery", "planner", "builder", "reviewer", "repair", "landing"];
  const lines = orderedRoles.flatMap((role) => {
    const selection = modelAssignments?.[role];
    if (!selection?.model) {
      return [];
    }
    return [
      `  ${role}:`,
      ...(selection.provider ? [`    provider: ${selection.provider}`] : []),
      `    model: ${selection.model}`,
    ];
  });

  if (lines.length === 0) {
    return "\n";
  }

  return `\nmodels:\n${lines.join("\n")}\n\n`;
}

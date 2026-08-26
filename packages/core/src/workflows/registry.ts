import fs from "node:fs/promises";
import path from "node:path";
import type {
  EffectiveFactoryConfig,
  ModelSelection,
  WorkflowConfig,
  WorkflowDefinition,
  WorkflowStage,
  WorkflowRegistry,
} from "@factory/schemas";

export const DEFAULT_WORKFLOW_ID = "default-dev";

export function defaultWorkflowDefinition(): WorkflowDefinition {
  return {
    id: DEFAULT_WORKFLOW_ID,
    name: "Default Development",
    description: "Discover, plan, implement, verify, and approve changes.",
    stages: [
      { name: "discover", type: "agent", role: "discovery" },
      { name: "plan", type: "agent", role: "planner", dependsOn: ["discover"] },
      { name: "implementation", type: "agent", role: "builder", dependsOn: ["plan"] },
      { name: "verification", type: "command", commands: ["lint", "typecheck", "test", "build"], dependsOn: ["implementation"] },
      { name: "approval", type: "approval", dependsOn: ["verification"] },
    ],
  };
}

export function normalizeWorkflowConfig(input?: WorkflowConfig): WorkflowConfig {
  if (!input) {
    return {
      defaultWorkflowId: DEFAULT_WORKFLOW_ID,
      workflows: [defaultWorkflowDefinition()],
    };
  }

  // Legacy: single stages array becomes the default workflow.
  return {
    defaultWorkflowId: input.defaultWorkflowId ?? DEFAULT_WORKFLOW_ID,
    workflows: input.workflows ?? [defaultWorkflowDefinition()],
  };
}

export function resolveWorkflowDefinition(
  config: EffectiveFactoryConfig,
  requestedWorkflowId?: string,
): WorkflowDefinition | undefined {
  const registry = normalizeWorkflowConfig(config.workflow);
  const workflows = registry.workflows ?? [];
  const targetId = requestedWorkflowId ?? registry.defaultWorkflowId ?? DEFAULT_WORKFLOW_ID;
  return workflows.find((workflow) => workflow.id === targetId) ?? workflows[0];
}

export function workflowRegistryToConfig(registry: WorkflowRegistry): WorkflowConfig {
  return {
    defaultWorkflowId: registry.defaultWorkflowId ?? DEFAULT_WORKFLOW_ID,
    workflows: registry.workflows ?? [defaultWorkflowDefinition()],
  };
}

export async function readWorkflowRegistry(cwd: string): Promise<WorkflowRegistry> {
  const workflowPath = path.join(cwd, "factory.yaml");
  try {
    const raw = await fs.readFile(workflowPath, "utf8");
    const parsed = parseYamlLike<WorkflowConfig>(raw);
    const normalized = normalizeWorkflowConfig(parsed);
    return {
      defaultWorkflowId: normalized.defaultWorkflowId ?? DEFAULT_WORKFLOW_ID,
      workflows: normalized.workflows ?? [defaultWorkflowDefinition()],
    };
  } catch {
    return {
      defaultWorkflowId: DEFAULT_WORKFLOW_ID,
      workflows: [defaultWorkflowDefinition()],
    };
  }
}

export async function writeWorkflowRegistry(cwd: string, registry: WorkflowRegistry): Promise<string> {
  const workflowPath = path.join(cwd, "factory.yaml");
  const config = workflowRegistryToConfig(registry);
  const body = [
    "# Factory workflows",
    "# Each workflow is a reusable way of running work. Use /factory workflow to manage them.",
    "",
    `defaultWorkflowId: ${config.defaultWorkflowId ?? DEFAULT_WORKFLOW_ID}`,
    "workflows:",
    ...flattenWorkflows(config.workflows ?? [defaultWorkflowDefinition()]),
  ].join("\n");
  await fs.writeFile(workflowPath, body, "utf8");
  return workflowPath;
}

function flattenWorkflows(workflows: WorkflowDefinition[]): string[] {
  const lines: string[] = [];
  for (const workflow of workflows) {
    lines.push(`  - id: ${workflow.id}`);
    lines.push(`    name: ${JSON.stringify(workflow.name)}`);
    if (workflow.description) {
      lines.push(`    description: ${JSON.stringify(workflow.description)}`);
    }
    lines.push("    stages:");
    for (const stage of workflow.stages) {
      lines.push(`      - name: ${stage.name}`);
      if (stage.description) lines.push(`        description: ${JSON.stringify(stage.description)}`);
      if (stage.type) lines.push(`        type: ${stage.type}`);
      if (stage.role) lines.push(`        role: ${stage.role}`);
      if (stage.dependsOn?.length) lines.push(`        dependsOn: [${stage.dependsOn.join(", ")}]`);
      if (stage.commands?.length) lines.push(`        commands: [${stage.commands.map((c) => `"${c.replace(/"/g, '\\"')}"`).join(", ")}]`);
      if (stage.requiresApproval !== undefined) lines.push(`        requiresApproval: ${stage.requiresApproval}`);
      if (stage.taskType) lines.push(`        taskType: ${stage.taskType}`);
      if (stage.model) lines.push(`        model: ${JSON.stringify(stage.model)}`);
      if (stage.skills && hasSkillPolicy(stage.skills)) {
        lines.push("        skills:");
        if (stage.skills.require?.length) lines.push(`          require: [${stage.skills.require.join(", ")}]`);
        if (stage.skills.prefer?.length) lines.push(`          prefer: [${stage.skills.prefer.join(", ")}]`);
        if (stage.skills.exclude?.length) lines.push(`          exclude: [${stage.skills.exclude.join(", ")}]`);
      }
    }
  }
  return lines;
}

function parseYamlLike<T>(raw: string): T {
  const trimmed = raw.trim();
  if (!trimmed) return {} as T;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed) as T;
  }
  // Basic YAML subset parser for workflow registry files.
  return parseSimpleWorkflowYaml(raw) as unknown as T;
}

function parseSimpleWorkflowYaml(raw: string): WorkflowConfig {
  const lines = raw.split(/\r?\n/);
  const workflows: WorkflowDefinition[] = [];
  let defaultWorkflowId: string | undefined;
  let currentWorkflow: WorkflowDefinition | undefined;
  let currentStage: WorkflowStage | undefined;

  const parseValue = (value: string): string | boolean | string[] | Record<string, unknown> => {
    const trimmedValue = value.trim();
    if (trimmedValue.startsWith("[") && trimmedValue.endsWith("]")) {
      return trimmedValue
        .slice(1, -1)
        .split(",")
        .map((part) => part.trim().replace(/^["']|["']$/g, "").replace(/\\"/g, "\""))
        .filter(Boolean);
    }
    if (trimmedValue.startsWith("{") && trimmedValue.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmedValue);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Fall through to treating the value as a plain string.
      }
    }
    if (trimmedValue === "true") return true;
    if (trimmedValue === "false") return false;
    return trimmedValue.replace(/^["']|["']$/g, "").replace(/\\"/g, "\"");
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;

    if (indent === 0 && /^defaultWorkflowId:/.test(trimmed)) {
      defaultWorkflowId = String(parseValue(trimmed.slice("defaultWorkflowId:".length)));
      continue;
    }

    if (indent === 0 && /^workflows:/.test(trimmed)) {
      continue;
    }

    if (indent === 2 && /^- id:/.test(trimmed)) {
      currentWorkflow = {
        id: String(parseValue(trimmed.slice("- id:".length))),
        name: currentWorkflow?.name ?? "",
        stages: [],
      };
      workflows.push(currentWorkflow);
      continue;
    }

    if (currentWorkflow && indent === 4 && /^name:/.test(trimmed)) {
      currentWorkflow.name = String(parseValue(trimmed.slice("name:".length)));
      continue;
    }

    if (currentWorkflow && indent === 4 && /^description:/.test(trimmed)) {
      currentWorkflow.description = String(parseValue(trimmed.slice("description:".length)));
      continue;
    }

    if (currentWorkflow && indent === 4 && /^stages:/.test(trimmed)) {
      continue;
    }

    if (currentWorkflow && indent === 6 && /^- name:/.test(trimmed)) {
      currentStage = {
        name: String(parseValue(trimmed.slice("- name:".length))),
      };
      currentWorkflow.stages.push(currentStage);
      continue;
    }

    if (currentStage && indent === 8 && /^type:/.test(trimmed)) {
      currentStage.type = String(parseValue(trimmed.slice("type:".length))) as WorkflowStage["type"];
      continue;
    }

    if (currentStage && indent === 8 && /^description:/.test(trimmed)) {
      currentStage.description = String(parseValue(trimmed.slice("description:".length)));
      continue;
    }

    if (currentStage && indent === 8 && /^role:/.test(trimmed)) {
      currentStage.role = String(parseValue(trimmed.slice("role:".length))) as WorkflowStage["role"];
      continue;
    }

    if (currentStage && indent === 8 && /^dependsOn:/.test(trimmed)) {
      const value = parseValue(trimmed.slice("dependsOn:".length));
      currentStage.dependsOn = Array.isArray(value) ? value : [];
      continue;
    }

    if (currentStage && indent === 8 && /^commands:/.test(trimmed)) {
      const value = parseValue(trimmed.slice("commands:".length));
      currentStage.commands = Array.isArray(value) ? value : [];
      continue;
    }

    if (currentStage && indent === 8 && /^requiresApproval:/.test(trimmed)) {
      currentStage.requiresApproval = parseValue(trimmed.slice("requiresApproval:".length)) === true;
      continue;
    }

    if (currentStage && indent === 8 && /^requiredCapabilities:/.test(trimmed)) {
      const value = parseValue(trimmed.slice("requiredCapabilities:".length));
      currentStage.requiredCapabilities = Array.isArray(value) ? value as WorkflowStage["requiredCapabilities"] : [];
      continue;
    }

    if (currentStage && indent === 8 && /^taskType:/.test(trimmed)) {
      currentStage.taskType = String(parseValue(trimmed.slice("taskType:".length)));
      continue;
    }

    if (currentStage && indent === 8 && /^model:/.test(trimmed)) {
      const value = parseValue(trimmed.slice("model:".length));
      if (value && typeof value === "object" && !Array.isArray(value) && typeof value.model === "string") {
        currentStage.model = {
          ...(typeof value.provider === "string" ? { provider: value.provider } : {}),
          model: value.model,
        } satisfies ModelSelection;
      } else {
        currentStage.model = { model: String(value) };
      }
      continue;
    }

    if (currentStage && indent === 8 && /^skills:/.test(trimmed)) {
      currentStage.skills = {};
      continue;
    }

    if (currentStage?.skills && indent === 10 && /^require:/.test(trimmed)) {
      const value = parseValue(trimmed.slice("require:".length));
      currentStage.skills.require = Array.isArray(value) ? value : [];
      continue;
    }

    if (currentStage?.skills && indent === 10 && /^prefer:/.test(trimmed)) {
      const value = parseValue(trimmed.slice("prefer:".length));
      currentStage.skills.prefer = Array.isArray(value) ? value : [];
      continue;
    }

    if (currentStage?.skills && indent === 10 && /^exclude:/.test(trimmed)) {
      const value = parseValue(trimmed.slice("exclude:".length));
      currentStage.skills.exclude = Array.isArray(value) ? value : [];
      continue;
    }
  }

  return {
    defaultWorkflowId,
    workflows,
  };
}

function hasSkillPolicy(skills: WorkflowStage["skills"]): boolean {
  return Boolean(skills?.require?.length || skills?.prefer?.length || skills?.exclude?.length);
}

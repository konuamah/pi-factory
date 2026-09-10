import fs from "node:fs/promises";
import path from "node:path";
import type {
  EffectiveFactoryConfig,
  ModelSelection,
  WorkflowConfig,
  WorkflowDefinition,
  WorkflowStage,
  WorkflowStageSkillPolicy,
  WorkflowRegistry,
} from "@factory/schemas";

export const DEFAULT_WORKFLOW_ID = "default-dev";

export type WorkflowValidationIssue = {
  code: "unknown-depends-on" | "cycle" | "unreachable-stage" | "approval-without-review";
  workflowId: string;
  stage: string;
  detail: string;
};

export function validateWorkflowDependencies(workflow: WorkflowDefinition): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = [];
  const byName = new Map(workflow.stages.map((stage) => [stage.name, stage]));
  for (const stage of workflow.stages) {
    for (const dependency of stage.dependsOn ?? []) {
      if (!byName.has(dependency)) {
        issues.push({ code: "unknown-depends-on", workflowId: workflow.id, stage: stage.name, detail: `dependsOn references unknown stage '${dependency}'` });
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string, stack: string[]) => {
    if (visited.has(name) || !byName.has(name)) return;
    if (visiting.has(name)) {
      issues.push({ code: "cycle", workflowId: workflow.id, stage: name, detail: `dependency cycle: ${[...stack, name].join(" -> ")}` });
      return;
    }
    visiting.add(name);
    for (const dependency of byName.get(name)?.dependsOn ?? []) visit(dependency, [...stack, name]);
    visiting.delete(name);
    visited.add(name);
  };
  for (const stage of workflow.stages) visit(stage.name, []);

  const reachable = new Set(workflow.stages.filter((stage) => !(stage.dependsOn?.length)).map((stage) => stage.name));
  let changed = true;
  while (changed) {
    changed = false;
    for (const stage of workflow.stages) {
      if (!reachable.has(stage.name) && (stage.dependsOn ?? []).some((dependency) => reachable.has(dependency))) {
        reachable.add(stage.name);
        changed = true;
      }
    }
  }
  for (const stage of workflow.stages) {
    if (!reachable.has(stage.name)) issues.push({ code: "unreachable-stage", workflowId: workflow.id, stage: stage.name, detail: "stage is not reachable from any workflow root" });
  }

  const reviewerNames = new Set(workflow.stages.filter((stage) => stage.role === "reviewer").map((stage) => stage.name));
  const dependsOnReviewer = (name: string, seen = new Set<string>()): boolean => {
    if (seen.has(name)) return false;
    seen.add(name);
    return reviewerNames.has(name) || (byName.get(name)?.dependsOn ?? []).some((dependency) => dependsOnReviewer(dependency, seen));
  };
  for (const stage of workflow.stages) {
    if (stage.type === "acceptance" || stage.type === "approval") {
      if (!(stage.dependsOn ?? []).some((dependency) => dependsOnReviewer(dependency))) {
        issues.push({ code: "approval-without-review", workflowId: workflow.id, stage: stage.name, detail: `${stage.type} must depend (directly or transitively) on a reviewer stage (role === 'reviewer')` });
      }
    }
  }
  return issues;
}

function validateWorkflows(workflows: WorkflowDefinition[]): void {
  const issues = workflows.flatMap(validateWorkflowDependencies);
  if (issues.length > 0) throw new Error(`Invalid workflow dependencies:\n${issues.map((issue) => `[${issue.code}] ${issue.workflowId}/${issue.stage}: ${issue.detail}`).join("\n")}`);
}

export function defaultWorkflowDefinition(): WorkflowDefinition {
  return {
    id: DEFAULT_WORKFLOW_ID,
    name: "Default Development",
    description: "Discover, plan, implement, verify, review, land, and accept changes.",
    stages: [
      { name: "discover", type: "agent", role: "discovery" },
      { name: "plan", type: "agent", role: "planner", dependsOn: ["discover"] },
      { name: "implementation", type: "agent", role: "builder", dependsOn: ["plan"] },
      { name: "verification", type: "command", commands: ["lint", "typecheck", "test", "build"], dependsOn: ["implementation"] },
      { name: "review", type: "agent", role: "reviewer", dependsOn: ["verification"] },
      { name: "acceptance", type: "acceptance", dependsOn: ["review"] },
    ],
  };
}

export function normalizeWorkflowConfig(input?: WorkflowConfig): WorkflowConfig {
  if (!input) {
    const config = {
      defaultWorkflowId: DEFAULT_WORKFLOW_ID,
      workflows: [defaultWorkflowDefinition()],
    };
    validateWorkflows(config.workflows);
    return config;
  }

  // Legacy: single stages array becomes the default workflow.
  const config = {
    defaultWorkflowId: input.defaultWorkflowId ?? DEFAULT_WORKFLOW_ID,
    workflows: input.workflows ?? [defaultWorkflowDefinition()],
  };
  validateWorkflows(config.workflows);
  return config;
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
      if (stage.allowedTools?.length) lines.push(`        allowedTools: [${stage.allowedTools.join(", ")}]`);
      if (stage.denyTools?.length) lines.push(`        denyTools: [${stage.denyTools.join(", ")}]`);
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

  const listValue = (value: string): string[] => {
    const parsed = parseValue(value);
    return Array.isArray(parsed) ? parsed : [];
  };

  const assignStage = (key: string, value: string) => {
    if (!currentStage) return;
    const parsed = parseValue(value);
    switch (key) {
      case "type":
        currentStage.type = String(parsed) as WorkflowStage["type"];
        break;
      case "description":
        currentStage.description = String(parsed);
        break;
      case "role":
        currentStage.role = String(parsed) as WorkflowStage["role"];
        break;
      case "dependsOn":
        currentStage.dependsOn = listValue(value);
        break;
      case "commands":
        currentStage.commands = listValue(value);
        break;
      case "requiresApproval":
        currentStage.requiresApproval = parsed === true;
        break;
      case "requiredCapabilities":
        currentStage.requiredCapabilities = listValue(value) as WorkflowStage["requiredCapabilities"];
        break;
      case "allowedTools":
        currentStage.allowedTools = listValue(value);
        break;
      case "denyTools":
        currentStage.denyTools = listValue(value);
        break;
      case "taskType":
        currentStage.taskType = String(parsed);
        break;
      case "model":
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.model === "string") {
          currentStage.model = {
            ...(typeof parsed.provider === "string" ? { provider: parsed.provider } : {}),
            model: parsed.model,
          } satisfies ModelSelection;
        } else {
          currentStage.model = { model: String(parsed) };
        }
        break;
    }
  };

  const assignSkill = (key: keyof WorkflowStageSkillPolicy, value: string) => {
    if (!currentStage?.skills) return;
    currentStage.skills[key] = listValue(value);
  };

  const STAGE_FIELDS: Record<string, (value: string) => void> = {
    type: (v) => assignStage("type", v),
    description: (v) => assignStage("description", v),
    role: (v) => assignStage("role", v),
    dependsOn: (v) => assignStage("dependsOn", v),
    commands: (v) => assignStage("commands", v),
    requiresApproval: (v) => assignStage("requiresApproval", v),
    requiredCapabilities: (v) => assignStage("requiredCapabilities", v),
    allowedTools: (v) => assignStage("allowedTools", v),
    denyTools: (v) => assignStage("denyTools", v),
    taskType: (v) => assignStage("taskType", v),
    model: (v) => assignStage("model", v),
  };
  const SKILL_FIELDS: Record<string, (value: string) => void> = {
    require: (v) => assignSkill("require", v),
    prefer: (v) => assignSkill("prefer", v),
    exclude: (v) => assignSkill("exclude", v),
  };

  const STAGE_FIELD_KEYS = Object.keys(STAGE_FIELDS);
  const SKILL_FIELD_KEYS = Object.keys(SKILL_FIELDS);

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

    if (currentStage && indent === 8) {
      const field = STAGE_FIELD_KEYS.find((key) => new RegExp(`^${key}:`).test(trimmed));
      if (field) {
        STAGE_FIELDS[field](trimmed.slice(field.length + 1));
        continue;
      }
    }

    if (currentStage?.skills && indent === 10) {
      const field = SKILL_FIELD_KEYS.find((key) => new RegExp(`^${key}:`).test(trimmed));
      if (field) {
        SKILL_FIELDS[field](trimmed.slice(field.length + 1));
        continue;
      }
    }

    if (currentStage && indent === 8 && /^skills:/.test(trimmed)) {
      currentStage.skills = {};
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

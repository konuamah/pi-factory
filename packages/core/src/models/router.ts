import type { EffectiveFactoryConfig, ModelRole, ModelSelection, TaskTypeDefinition } from "@factory/schemas";

export class ModelRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelRoutingError";
  }
}

export class ModelProviderResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelProviderResolutionError";
  }
}

export type TaskTypeSource = "run-override" | "node-override" | "classifier" | "default";

export interface TaskTypeSelection {
  id: string;
  source: TaskTypeSource;
  confidence?: number;
  reasons: string[];
}

export type ModelSource = "node-override" | "run-override" | "task-type" | "role-default";

export interface ResolvedModel {
  model: ModelSelection;
  source: ModelSource;
  taskType?: string;
}

export function classifyTaskType(goal: string, config: EffectiveFactoryConfig): TaskTypeSelection {
  const definitions = config.taskTypes ?? {};
  const typeIds = Object.keys(definitions);
  if (typeIds.length === 0) {
    return { id: "general", source: "default", confidence: 1, reasons: ["No user-defined task types configured."] };
  }

  const goalTokens = tokenize(goal);
  const scored: Array<{ id: string; score: number; reasons: string[] }> = [];

  for (const id of typeIds) {
    const definition = definitions[id]!;
    const reasons: string[] = [];
    let score = 0;

    for (const keyword of definition.match?.keywords ?? []) {
      const kw = keyword.toLowerCase();
      if (goal.toLowerCase().includes(kw)) {
        score += 3;
        reasons.push(`goal contains '${keyword}'`);
      }
      if (goalTokens.has(kw)) {
        score += 2;
        reasons.push(`goal token '${keyword}'`);
      }
    }

    if (score > 0) {
      scored.push({ id, score, reasons });
    }
  }

  if (scored.length === 0) {
    return { id: "general", source: "default", confidence: 0.2, reasons: ["No task type keyword matched the goal."] };
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored[0]!;
  return {
    id: top.id,
    source: "classifier",
    confidence: Math.min(1, top.score / 10),
    reasons: top.reasons,
  };
}

export function resolveModelForRole(input: {
  role: ModelRole;
  taskType: string;
  config: EffectiveFactoryConfig;
  nodeModel?: ModelSelection;
  runModelOverride?: ModelSelection;
}): ResolvedModel {
  // 1. Explicit node model override wins over everything.
  if (input.nodeModel?.model) {
    return { model: input.nodeModel, source: "node-override", taskType: input.taskType };
  }

  // 2. Explicit run override.
  if (input.runModelOverride?.model) {
    return { model: input.runModelOverride, source: "run-override", taskType: input.taskType };
  }

  // 3. Task-type routing.
  const taskTypeDefinition = input.config.taskTypes?.[input.taskType];
  const taskTypeRoute = taskTypeDefinition?.routing?.[input.role];
  if (taskTypeRoute?.model) {
    return {
      model: { model: taskTypeRoute.model, ...(taskTypeRoute.provider ? { provider: taskTypeRoute.provider } : {}) },
      source: "task-type",
      taskType: input.taskType,
    };
  }

  // 4. Role default.
  const roleDefault = input.config.models?.[input.role];
  if (roleDefault?.model) {
    return { model: roleDefault, source: "role-default", taskType: input.taskType };
  }

  // Fail loud.
  throw new ModelRoutingError(
    `No model configured for role '${input.role}' under task type '${input.taskType}'. ` +
    `Set taskTypes.${input.taskType}.routing.${input.role} or models.${input.role}.`,
  );
}

export function preflightModelRouting(input: {
  taskTypes: string[];
  roles: ModelRole[];
  config: EffectiveFactoryConfig;
  nodeModels?: Record<string, Partial<Record<ModelRole, ModelSelection>>>;
  runOverrides?: Partial<Record<ModelRole, ModelSelection>>;
}): Array<{ taskType: string; role: ModelRole; error: string }> {
  const errors: Array<{ taskType: string; role: ModelRole; error: string }> = [];
  for (const taskType of input.taskTypes) {
    for (const role of input.roles) {
      try {
        resolveModelForRole({
          role,
          taskType,
          config: input.config,
          nodeModel: input.nodeModels?.[taskType]?.[role],
          runModelOverride: input.runOverrides?.[role],
        });
      } catch (error) {
        if (error instanceof ModelRoutingError) {
          errors.push({ taskType, role, error: error.message });
        }
      }
    }
  }
  return errors;
}

export function taskTypeMatchPaths(taskTypes: Record<string, TaskTypeDefinition>, changedFiles: string[]): string | undefined {
  for (const [id, definition] of Object.entries(taskTypes)) {
    const paths = definition.match?.paths ?? [];
    if (paths.length === 0) {
      continue;
    }
    if (changedFiles.some((file) => paths.some((pattern) => pathMatches(pattern, file)))) {
      return id;
    }
  }
  return undefined;
}

function pathMatches(pattern: string, file: string): boolean {
  const normalizedPattern = pattern.replace(/\\/g, "/").replace(/\/$/, "");
  const normalizedFile = file.replace(/\\/g, "/");
  if (normalizedPattern === normalizedFile) {
    return true;
  }
  if (normalizedPattern.endsWith("/**")) {
    return normalizedFile.startsWith(normalizedPattern.slice(0, -3));
  }
  if (normalizedPattern.endsWith("/*")) {
    return normalizedFile.startsWith(normalizedPattern.slice(0, -2)) && !normalizedFile.slice(normalizedPattern.slice(0, -2).length).includes("/");
  }
  if (normalizedPattern.includes("*")) {
    const escaped = normalizedPattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(normalizedFile);
  }
  return normalizedFile.startsWith(`${normalizedPattern}/`);
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3),
  );
}

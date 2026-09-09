// Workflow helper functions — extracted from gateway-workflow.ts.

import { readWorkflowRegistry } from "@factory/core";
import { renderLines } from "./gateway-render.js";
import type { FactoryPiCommandContext } from "./types.js";
import { detectPiModelConfiguration } from "@factory/core";
import type { ModelSelection, WorkflowNodeType, WorkflowStage, ModelRole } from "@factory/schemas";

export async function collectWorkflowStages(
  ctx: FactoryPiCommandContext,
  options: {
    workflowName: string;
    modelOptions: ModelSelection[];
    piDefault?: ModelSelection;
  },
): Promise<WorkflowStage[]> {
  const stages: WorkflowStage[] = [];

  while (true) {
    renderLines(ctx, workflowPreviewLines(stages, options));
    const addChoice = await ctx.ui.select?.(
      stages.length === 0 ? "Add the first workflow step?" : "Add another workflow step?",
      stages.length === 0 ? ["Add step", "Cancel"] : ["Add step", "Finish workflow"],
    );
    if (addChoice !== "Add step") break;

    const rawName = await ctx.ui.input?.("Workflow step name", "e.g. plan, build, verify, approval");
    const name = slugifyWorkflowPart(rawName ?? "");
    if (!name) {
      ctx.ui.notify("Step name is required", "warning");
      continue;
    }

    const description = (await ctx.ui.input?.(
      "What should this step accomplish?",
      "e.g. plan the change, update code, run frontend checks, review risk",
    ))?.trim();

    const typeChoice = await ctx.ui.select?.("What kind of step is this?", [
      "AI step — ask a model to plan, build, review, or repair",
      "Interview step — ask the user questions before planning",
      "Command step — run saved project checks like lint, typecheck, test, or build",
      "Acceptance step — make the final user decision",
      "Task graph step — split larger work into smaller sub-tasks",
    ]);
    const type = workflowNodeTypeFromChoice(typeChoice);
    const previous = stages.at(-1)?.name;
    const stage: WorkflowStage = {
      name,
      type,
      ...(description ? { description } : {}),
      dependsOn: previous ? [previous] : [],
    };

    if (type === "agent" || type === "interview") {
      const roleChoice = await ctx.ui.select?.("AI role for this step", [
        ...(type === "interview" ? ["planner — interview and planning decisions"] : []),
        "builder — implementation work",
        "discovery — read-only repo understanding before planning",
        ...(type === "agent" ? ["planner — planning and repo reasoning"] : []),
        "reviewer — review and risk spotting",
        "repair — fix failed checks",
        "Use workflow default role — rely on this step name and purpose",
      ]);
      const role = workflowRoleFromChoice(roleChoice);
      if (role) stage.role = role;
      if (type === "interview" && !stage.role) stage.role = "planner";

      const model = await selectWorkflowStageModel(ctx, options.modelOptions);
      if (model) stage.model = model;

      const requiredSkills = splitWorkflowCommands(await ctx.ui.input?.("Required skills for this step", "optional, comma-separated, e.g. grilling") ?? "");
      const preferredSkills = splitWorkflowCommands(await ctx.ui.input?.("Preferred skills for this step", "optional, comma-separated, e.g. repo-interpretation") ?? "");
      if (requiredSkills.length || preferredSkills.length) {
        stage.skills = {
          ...(requiredSkills.length ? { require: requiredSkills } : {}),
          ...(preferredSkills.length ? { prefer: preferredSkills } : {}),
        };
      }
    }

    if (type === "command") {
      const rawCommands = await ctx.ui.input?.(
        "Project commands for this step",
        "comma-separated command ids or shell commands, e.g. lint, typecheck, npm test",
      );
      const commands = splitWorkflowCommands(rawCommands ?? "");
      if (commands.length > 0) {
        stage.commands = commands;
      }
    }

    if (type === "acceptance") {
      stage.requiresApproval = true;
    }

    stages.push(stage);
    renderLines(ctx, workflowPreviewLines(stages, options));
  }

  return stages;
}

export async function selectWorkflowStageModel(
  ctx: FactoryPiCommandContext,
  modelOptions: ModelSelection[],
): Promise<ModelSelection | undefined> {
  const choiceOptions = [
    "Use workflow role default",
    ...(modelOptions.length > 0 ? modelOptions.map((model) => `Choose ${formatModelSelection(model)}`) : []),
    "Enter provider/model manually",
    "No stage model override",
  ];
  const choice = await ctx.ui.select?.("Model for this agent node", choiceOptions);

  if (!choice || choice === "Use workflow role default" || choice === "No stage model override") {
    return undefined;
  }

  if (choice === "Enter provider/model manually") {
    const provider = (await ctx.ui.input?.("Model provider", "e.g. openai-codex, anthropic, openai"))?.trim();
    const model = (await ctx.ui.input?.("Model name", "e.g. gpt-5, claude-sonnet-4-20250514"))?.trim();
    return model ? { ...(provider ? { provider } : {}), model } : undefined;
  }

  const label = choice.replace(/^Choose\s+/, "");
  return modelOptions.find((model) => formatModelSelection(model) === label);
}

export function workflowPreviewLines(
  stages: WorkflowStage[],
  options: {
    workflowName: string;
    modelOptions: ModelSelection[];
    piDefault?: ModelSelection;
  },
): string[] {
  const latest = stages.at(-1);
  return [
    "Factory workflow builder",
    `Workflow: ${options.workflowName} | models: ${options.modelOptions.length || "none"}`,
    options.piDefault ? `Default: ${formatModelSelection(options.piDefault)}` : "Default: not configured",
    `Preview: ${renderWorkflowStepChain(stages)}`,
    ...(latest
      ? [
          `Latest: ${renderWorkflowStepPreview(latest)}`,
          ...(latest.description ? [`Purpose: ${truncatePreviewLine(latest.description, 92)}`] : []),
        ]
      : ["Next: add steps such as plan -> build -> verify -> review -> acceptance."]),
    "Command step = run checks like lint, typecheck, test, or build.",
  ];
}

export function renderWorkflowStepChain(stages: WorkflowStage[]): string {
  if (stages.length === 0) {
    return "(empty)";
  }
  const names = stages.map((stage) => stage.name);
  const chain = names.length > 5
    ? [...names.slice(0, 2), "...", ...names.slice(-2)].join(" -> ")
    : names.join(" -> ");
  return truncatePreviewLine(chain, 100);
}

export function renderWorkflowStepPreview(stage: WorkflowStage): string {
  const type = stage.type ?? "agent";
  const role = stage.role ?? (type === "agent" || type === "interview" ? "workflow default" : undefined);
  const model = stage.model ? formatModelSelection(stage.model) : undefined;
  const commands = stage.commands?.length ? stage.commands.join(", ") : undefined;
  const skills = stage.skills?.require?.length ? `requires ${stage.skills.require.join(", ")}` : stage.skills?.prefer?.length ? `prefers ${stage.skills.prefer.join(", ")}` : undefined;
  const summary = [stage.name, type, role, model, commands, skills].filter(Boolean).join(" | ");
  return truncatePreviewLine(summary, 100);
}

export function truncatePreviewLine(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function workflowModelOptions(pi: Awaited<ReturnType<typeof detectPiModelConfiguration>> | undefined): ModelSelection[] {
  const models: ModelSelection[] = [];
  const seen = new Set<string>();
  const add = (model?: ModelSelection): void => {
    if (!model?.model) return;
    const key = `${model.provider ?? ""}/${model.model}`;
    if (seen.has(key)) return;
    seen.add(key);
    models.push(model);
  };

  if (pi?.defaultProvider && pi.defaultModel) {
    add({ provider: pi.defaultProvider, model: pi.defaultModel });
  }
  for (const model of pi?.configuredModels ?? []) {
    add(model);
  }
  return models;
}

export function formatModelSelection(model: ModelSelection): string {
  return model.provider ? `${model.provider}/${model.model}` : model.model;
}

export function slugifyWorkflowPart(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function workflowNodeTypeFromChoice(choice: string | undefined): WorkflowNodeType {
  if (choice?.startsWith("Interview step")) return "interview";
  if (choice?.startsWith("Command step")) return "command";
  if (choice?.startsWith("Acceptance step")) return "acceptance";
  if (choice?.startsWith("Task graph step")) return "task-graph";
  return "agent";
}

export function workflowRoleFromChoice(choice: string | undefined): ModelRole | undefined {
  if (choice?.startsWith("discovery")) return "discovery";
  if (choice?.startsWith("planner")) return "planner";
  if (choice?.startsWith("reviewer")) return "reviewer";
  if (choice?.startsWith("repair")) return "repair";
  if (choice?.startsWith("builder")) return "builder";
  return undefined;
}

export function splitWorkflowCommands(value: string): string[] {
  return value.split(",").map((command) => command.trim()).filter(Boolean);
}

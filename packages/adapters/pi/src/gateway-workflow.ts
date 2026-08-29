// Workflow command handlers — extracted from gateway.ts.

import { readWorkflowRegistry, writeWorkflowRegistry, resolveWorkflowDefinition, normalizeWorkflowConfig, defaultWorkflowDefinition } from "@factory/core";
import { renderLines, renderIntro } from "./gateway-render.js";
import { detectPiModelConfiguration } from "@factory/core";
import type { ModelSelection, WorkflowNodeType, WorkflowStage, ModelRole } from "@factory/schemas";
import type { FactoryPiCommandContext } from "./types.js";
import { collectWorkflowStages, selectWorkflowStageModel, workflowPreviewLines, renderWorkflowStepChain, renderWorkflowStepPreview, truncatePreviewLine, workflowModelOptions, formatModelSelection, slugifyWorkflowPart, workflowNodeTypeFromChoice, workflowRoleFromChoice, splitWorkflowCommands } from "./gateway-workflow-helpers.js";

export async function handleWorkflow(rest: string[], ctx: FactoryPiCommandContext): Promise<void> {
  const action = rest[0] ?? "list";
  const arg = rest[1];

  renderIntro(ctx, [
    "Factory workflow manager.",
    "I’ll read the project’s saved workflows and run the requested workflow action.",
  ]);

  const registry = await readWorkflowRegistry(ctx.cwd);

  if (action === "list") {
    renderLines(ctx, [
      "Factory workflows",
      `default: ${registry.defaultWorkflowId ?? "none"}`,
      "",
      ...registry.workflows.map((workflow) => {
        const marker = workflow.id === registry.defaultWorkflowId ? "*" : " ";
        return `${marker} ${workflow.id}: ${workflow.name} (${workflow.stages.map((stage) => stage.name).join(" → ")})`;
      }),
    ]);
    ctx.ui.notify(`Factory has ${registry.workflows.length} workflow(s)`, "info");
    return;
  }

  if (action === "set-default") {
    if (!arg) {
      ctx.ui.notify("Provide a workflow id to set as default", "warning");
      return;
    }
    const target = registry.workflows.find((workflow) => workflow.id === arg);
    if (!target) {
      ctx.ui.notify(`No workflow with id '${arg}'`, "error");
      return;
    }
    registry.defaultWorkflowId = target.id;
    await writeWorkflowRegistry(ctx.cwd, registry);
    renderLines(ctx, ["Factory workflow", `default: ${target.id}: ${target.name}`]);
    ctx.ui.notify(`Default workflow set to ${target.name}`, "info");
    return;
  }

  if (action === "show") {
    if (!arg) {
      ctx.ui.notify("Provide a workflow id to show", "warning");
      return;
    }
    const target = registry.workflows.find((workflow) => workflow.id === arg);
    if (!target) {
      ctx.ui.notify(`No workflow with id '${arg}'`, "error");
      return;
    }
    renderLines(ctx, [
      `Factory workflow: ${target.id}`,
      `name: ${target.name}`,
      target.description ? `description: ${target.description}` : "description: none",
      `stages: ${target.stages.length}`,
      "",
      ...target.stages.map((stage) => {
        const depends = stage.dependsOn?.length ? ` (after: ${stage.dependsOn.join(", ")})` : "";
        return `- ${stage.name} [${stage.type ?? "agent"}]${depends}`;
      }),
    ]);
    return;
  }

  if (action === "clone") {
    if (!arg) {
      ctx.ui.notify("Provide a workflow id to clone", "warning");
      return;
    }
    const source = registry.workflows.find((workflow) => workflow.id === arg);
    if (!source) {
      ctx.ui.notify(`No workflow with id '${arg}'`, "error");
      return;
    }
    const newId = `${source.id}-copy-${Date.now().toString().slice(-4)}`;
    registry.workflows.push({
      ...source,
      id: newId,
      name: `${source.name} (copy)`,
      stages: source.stages.map((stage) => ({ ...stage })),
    });
    await writeWorkflowRegistry(ctx.cwd, registry);
    renderLines(ctx, ["Factory workflow cloned", `new id: ${newId}`]);
    ctx.ui.notify(`Cloned ${source.name} as ${newId}`, "info");
    return;
  }

  if (action === "delete") {
    if (!arg) {
      ctx.ui.notify("Provide a workflow id to delete", "warning");
      return;
    }
    const target = registry.workflows.find((workflow) => workflow.id === arg);
    if (!target) {
      ctx.ui.notify(`No workflow with id '${arg}'`, "error");
      return;
    }
    if (registry.defaultWorkflowId === target.id) {
      ctx.ui.notify("Cannot delete the default workflow", "error");
      return;
    }
    registry.workflows = registry.workflows.filter((workflow) => workflow.id !== arg);
    await writeWorkflowRegistry(ctx.cwd, registry);
    renderLines(ctx, ["Factory workflow deleted", `id: ${arg}`]);
    ctx.ui.notify(`Deleted workflow ${arg}`, "info");
    return;
  }

  if (action === "create") {
    await handleWorkflowCreate(ctx, registry);
    return;
  }

  ctx.ui.notify("Unknown workflow action. Use list|create|show|edit|clone|delete|set-default", "warning");
}

export async function handleWorkflowCreate(ctx: FactoryPiCommandContext, registry: Awaited<ReturnType<typeof readWorkflowRegistry>>): Promise<void> {
  if (!ctx.ui.input) {
    renderLines(ctx, ["Factory workflow create", "Interactive input is not available in this shell."]);
    ctx.ui.notify("Interactive input unavailable", "warning");
    return;
  }

  const name = await ctx.ui.input("Factory workflow name", "Workflow name (e.g. High Risk Change)");
  if (!name?.trim()) {
    ctx.ui.notify("Workflow creation cancelled", "info");
    return;
  }

  const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "workflow";
  const description = (await ctx.ui.input("Factory workflow description", "Optional short description")) ?? undefined;

  let stages: WorkflowStage[];
  let setAsDefault = false;

  if (ctx.ui.select) {
    renderLines(ctx, [
      "Factory workflow create",
      "Scanning Pi providers before workflow design...",
      "You can keep role defaults, or set a model on individual agent nodes.",
    ]);
    const pi = await detectPiModelConfiguration(ctx.cwd).catch(() => undefined);
    const modelOptions = workflowModelOptions(pi);
    const providerCount = new Set(modelOptions.map((model) => model.provider).filter(Boolean)).size;
    renderLines(ctx, [
      "Factory workflow create",
      `Pi providers found: ${providerCount || "none"}`,
      `Models found: ${modelOptions.length || "none"}`,
      pi?.defaultProvider && pi.defaultModel ? `Pi default: ${pi.defaultProvider}/${pi.defaultModel}` : "Pi default: not configured",
      "",
      "Next, add workflow steps. Advanced model overrides are optional for AI steps.",
    ]);

    stages = await collectWorkflowStages(ctx, {
      workflowName: name.trim(),
      modelOptions,
      piDefault: pi?.defaultProvider && pi.defaultModel ? { provider: pi.defaultProvider, model: pi.defaultModel } : undefined,
    });
    const defaultChoice = await ctx.ui.select("Use this workflow as the Factory default?", ["No", "Yes"]);
    setAsDefault = defaultChoice === "Yes";
  } else {
    const stageNames: string[] = [];
    let nextName: string | undefined;
    do {
      nextName = await ctx.ui.input("Add workflow step", "Step name, or blank to finish");
      if (nextName?.trim()) {
        stageNames.push(slugifyWorkflowPart(nextName.trim()));
      }
    } while (nextName?.trim());

    stages = stageNames.map((stageName, index) => ({
      name: stageName,
      dependsOn: index > 0 ? [stageNames[index - 1]!] : [],
      type: index === stageNames.length - 1 ? ("approval" as const) : ("agent" as const),
    }));
  }

  if (stages.length === 0) {
    ctx.ui.notify("Workflow needs at least one step", "error");
    return;
  }

  registry.workflows.push({
    id,
    name: name.trim(),
    description: description?.trim() || undefined,
    stages,
  });
  if (setAsDefault) {
    registry.defaultWorkflowId = id;
  }
  await writeWorkflowRegistry(ctx.cwd, registry);
  renderLines(ctx, [
    "Factory workflow created",
    `id: ${id}`,
    `name: ${name.trim()}`,
    `default: ${setAsDefault ? "yes" : "no"}`,
    `steps: ${stages.length}`,
    "",
    ...stages.map((stage) => {
      const role = stage.role ? ` role=${stage.role}` : "";
      const model = stage.model ? ` model=${formatModelSelection(stage.model)}` : "";
      const commands = stage.commands?.length ? ` commands=${stage.commands.join(", ")}` : "";
      const depends = stage.dependsOn?.length ? ` after=${stage.dependsOn.join(", ")}` : "";
      const description = stage.description ? ` — ${stage.description}` : "";
      return `- ${stage.name} [${stage.type ?? "agent"}]${role}${model}${commands}${depends}${description}`;
    }),
  ]);
  ctx.ui.notify(`Workflow ${name.trim()} created`, "info");
}

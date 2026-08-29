// Capabilities + models command handlers — extracted from gateway.ts.

import { initializeCapabilitySystem, listRegisteredCapabilities, getRegisteredCapability, checkExecutability, loadEffectiveConfig, discoverFactoryProject, classifyTaskType, resolveModelForRole, preflightModelRouting, taskTypeMatchPaths, readModelLedger } from "@factory/core";
import { renderLines, renderIntro, clearFactoryWidget } from "./gateway-render.js";
import type { FactoryPiCommandContext } from "./types.js";

export async function handleCapabilities(rest: string[], ctx: FactoryPiCommandContext): Promise<void> {
  const action = rest[0] ?? "list";
  const arg = rest[1];

  renderIntro(ctx, [
    "Factory capabilities.",
    "I’ll inspect registered capabilities, validate custom definitions, and report executability.",
  ]);

  const project = await discoverFactoryProject(ctx.cwd).catch(() => undefined);
  const report = await initializeCapabilitySystem(project?.paths.gitRoot ?? ctx.cwd);

  if (action === "list") {
    const capabilities = listRegisteredCapabilities();
    renderLines(ctx, [
      "Factory capabilities",
      `registered: ${capabilities.length}`,
      `custom discovered: ${report.registered.length}`,
      `skipped: ${report.skipped.length}`,
      `collisions: ${report.collisions.length}`,
      "",
      ...capabilities.map((capability) => {
        const source = capability.source === "BUILTIN" ? "built-in" : capability.source.toLowerCase();
        return `- ${capability.id} [${capability.effect}] (${source})`;
      }),
    ]);
    ctx.ui.notify(`Factory has ${capabilities.length} registered capability(ies)`, "info");
    return;
  }

  if (action === "show") {
    if (!arg) {
      ctx.ui.notify("Provide a capability id to show", "warning");
      return;
    }
    const capability = getRegisteredCapability(arg);
    if (!capability) {
      ctx.ui.notify(`No registered capability '${arg}'`, "error");
      return;
    }
    const executability = checkExecutability({ capabilityId: arg });
    renderLines(ctx, [
      `Factory capability: ${capability.id}`,
      `description: ${capability.description}`,
      `effect: ${capability.effect}`,
      `source: ${capability.source}`,
      capability.filePath ? `file: ${capability.filePath}` : "file: built-in",
      capability.input ? `input: ${JSON.stringify(capability.input)}` : "input: none",
      capability.output ? `output: ${JSON.stringify(capability.output)}` : "output: none",
      "",
      `executability: ${executability.status}`,
      `reason: ${executability.reason}`,
    ]);
    return;
  }

  if (action === "validate") {
    const projectDir = project ? `${project.paths.gitRoot ?? ctx.cwd}/.factory/capabilities` : "(no project)";
    renderLines(ctx, [
      "Factory capability validation",
      `scanning: ${projectDir}`,
      `custom registered: ${report.registered.length}`,
      "",
      ...report.skipped.map((item) => `invalid: ${item.id ?? "(unnamed)"} (${item.filePath})\n  ${item.errors.join("; ")}`),
      ...report.collisions.map((item) => `collision: ${item.id} — ${item.reason}`),
      report.skipped.length === 0 && report.collisions.length === 0 ? "All custom capabilities are valid." : "",
    ]);
    ctx.ui.notify(report.skipped.length === 0 ? "Capabilities valid" : "Some capabilities failed validation", report.skipped.length === 0 ? "info" : "warning");
    return;
  }

  ctx.ui.notify("Unknown capabilities action. Use list|show|validate", "warning");
}

export async function handleModels(rest: string[], ctx: FactoryPiCommandContext): Promise<void> {
  renderIntro(ctx, [
    "Factory model routing.",
    "I’ll show the effective model per role and per user-defined task type, and flag any routing holes.",
  ]);

  const loaded = await loadEffectiveConfig({ cwd: ctx.cwd });
  const taskTypes = loaded.effectiveConfig.taskTypes ?? {};
  const roles = ["discovery", "planner", "builder", "reviewer", "repair"] as const;

  const lines: string[] = ["Factory model routing", ""];
  lines.push("Role defaults");
  for (const role of roles) {
    const model = loaded.effectiveConfig.models[role];
    lines.push(`  ${role}: ${model?.model ?? "MISSING ⚠"}${model?.provider ? ` (${model.provider})` : ""}`);
  }

  lines.push("");
  lines.push("Task types");
  const typeIds = Object.keys(taskTypes);
  if (typeIds.length === 0) {
    lines.push("  (none configured — goals classify to 'general')");
  }
  for (const typeId of typeIds) {
    lines.push(`  ${typeId}`);
    for (const role of roles) {
      try {
        const resolved = resolveModelForRole({ role, taskType: typeId, config: loaded.effectiveConfig });
        lines.push(`    ${role}: ${resolved.model.model} (${resolved.source})`);
      } catch {
        lines.push(`    ${role}: MISSING ⚠`);
      }
    }
  }

  const classifier = classifyTaskType("docs", loaded.effectiveConfig);
  lines.push("");
  lines.push(`Example classifier (goal 'docs'): ${classifier.id} (${classifier.source})`);

  renderLines(ctx, lines);
  ctx.ui.notify("Factory model routing shown", "info");
}


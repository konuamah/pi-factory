// Setup-customize per-section handlers — extracted from gateway-setup.ts.

import { discoverFactoryProject, detectPiModelConfiguration, planFactorySetup, applyFactorySetup, runConstitutionScan, loadEffectiveConfig, validateFactorySetup } from "@factory/core";
import { renderLines, renderIntro, FACTORY_WIDGET_ID } from "./gateway-render.js";
import { mountFactoryStreamingWidget } from "./streaming-panel.js";
import { createRequiredConstitutionExecutor } from "./gateway.js";
import type { SetupCustomizeArgs } from "./gateway-setup.js";
import type { FactoryPiCommandContext } from "./types.js";

export async function customizeWorkflow({ uiCtx, current }: SetupCustomizeArgs): Promise<void> {
  const choice = await uiCtx.ui.select?.("Workflow preset", ["Balanced", "Fast", "Safe"]);
  if (!choice) return;
  const preset = choice.toLowerCase().split(" ")[0] as import("@factory/schemas").WorkflowPreset;
  const curWf = current.workflow?.value as { workflowId?: string } | undefined;
  current.workflow = { value: { kind: "preset", preset, workflowId: curWf?.workflowId ?? "default-dev" }, reason: `User chose ${preset}` };
}

export async function customizeModels({ ctx, uiCtx, current }: SetupCustomizeArgs): Promise<void> {
  for (const role of ["discovery", "planner", "builder", "reviewer", "repair"] as const) {
    const cur = current.models?.[role]?.value;
    const curLabel = cur ? `${cur.provider ? `${cur.provider}/` : ""}${cur.model}` : "unset";
    const choice = await uiCtx.ui.select?.(`Model for ${role} (now: ${curLabel})`, [
      ...ctx.availableModels.map((m) => `${m.provider ? `${m.provider}/` : ""}${m.model}`),
      "Keep current",
      "Skip / unset",
    ]);
    if (!choice || choice === "Keep current") continue;
    if (choice === "Skip / unset") { if (current.models) delete current.models[role]; continue; }
    const [provider, ...rest] = choice.split("/");
    const model = rest.length ? rest.join("/") : provider;
    const prov = rest.length ? provider : undefined;
    current.models = current.models ?? {};
    const matched = ctx.availableModels.find((m) => `${m.provider ?? ""}:${m.model}` === `${prov ?? ""}:${model}`);
    if (!matched && !choice.includes("/")) {
      // Single model id like "opus" — pick first match
      const byModel = ctx.availableModels.find((m) => m.model === choice);
      if (byModel) { current.models[role] = { value: byModel, reason: `User chose ${choice}` }; continue; }
    }
    const sel = matched ?? { provider: prov, model: model! };
    current.models[role] = { value: sel, reason: `User chose ${choice}` };
  }
}

export async function customizeCommands({ ctx, uiCtx, current, localAnswers }: SetupCustomizeArgs): Promise<void> {
  for (const field of ["setup", "lint", "typecheck", "test", "build"] as const) {
    const cur = current.commands?.[field];
    const curLabel = cur ? `${cur.value} [${cur.source}]` : "unset";
    const discovered = (ctx.discoveredCommands as Record<string, string | undefined>)[field];
    const options = [
      ...(discovered ? [`Use discovered — ${discovered}`] : []),
      "Enter custom command",
      "Keep current",
      "Clear",
    ];
    const choice = await uiCtx.ui.select?.(`Command: ${field} (now: ${curLabel})`, options);
    if (!choice || choice === "Keep current") continue;
    if (choice === "Clear") { if (current.commands) delete current.commands[field]; continue; }
    if (choice.startsWith("Use discovered")) {
      if (discovered) { current.commands = current.commands ?? {}; current.commands[field] = { value: discovered, reason: `User kept discovered ${field}`, source: "DISCOVERED", confidence: "HIGH" }; }
      continue;
    }
    const custom = await uiCtx.ui.input?.(`Custom ${field} command`, "e.g. pnpm test:integration");
    if (!custom?.trim()) continue;
    const val = custom.trim();
    const isDiscovered = Object.values(ctx.discoveredCommands).includes(val);
    current.commands = current.commands ?? {};
    current.commands[field] = {
      value: val,
      reason: isDiscovered ? `User kept discovered: ${val}` : `User custom: ${val}`,
      source: isDiscovered ? "DISCOVERED" : "AI_SUGGESTED",
      confidence: isDiscovered ? "HIGH" : "MEDIUM",
      ...(isDiscovered ? {} : { requiresConfirmation: true as const }),
    };
    if (!isDiscovered) localAnswers[`confirm:${field}`] = "yes"; // user just confirmed by entering it in Customize
  }
}

export async function customizeRuntime({ uiCtx, current, localAnswers }: SetupCustomizeArgs): Promise<void> {
  const cur = String(current.runtime?.maxParallelAgents?.value ?? 2);
  const val = await uiCtx.ui.input?.("Max parallel agents (1-16)", cur);
  if (!val?.trim()) return;
  const n = Number.parseInt(val.trim(), 10);
  if (Number.isFinite(n) && n >= 1 && n <= 16) { current.runtime = current.runtime ?? {}; current.runtime.maxParallelAgents = { value: n, reason: "User chose parallel workers", source: "DEFAULT", confidence: "HIGH" }; localAnswers["runtime:maxParallelAgents"] = String(n); }
}

export async function customizeGitWorktrees({ ctx, uiCtx, current, localAnswers }: SetupCustomizeArgs): Promise<void> {
  const bb = await uiCtx.ui.input?.("Base branch", current.git?.baseBranch?.value ?? ctx.effective?.git.baseBranch ?? "main");
  if (bb?.trim()) { current.git = current.git ?? {}; current.git.baseBranch = { value: bb.trim(), reason: "User chose base branch", source: "DEFAULT", confidence: "HIGH" }; localAnswers["git:baseBranch"] = bb.trim(); }
  const aw = await uiCtx.ui.select?.("Allow worktrees?", ["Yes", "No", "Keep current"]);
  if (aw && aw !== "Keep current") { current.git = current.git ?? {}; current.git.allowWorktrees = { value: aw === "Yes", reason: "User chose worktree policy", source: "DEFAULT", confidence: "HIGH" }; }
}

export async function customizeDependencies({ ctx, uiCtx, current }: SetupCustomizeArgs): Promise<void> {
  const enabled = await uiCtx.ui.select?.("Hydrate dependencies before work?", ["Enabled", "Disabled", "Keep current"]);
  if (enabled && enabled !== "Keep current") {
    current.dependencies = current.dependencies ?? {};
    current.dependencies.enabled = { value: enabled === "Enabled", reason: "User chose dependency hydration policy", source: "DEFAULT", confidence: "HIGH" };
  }
  const hydrate = await uiCtx.ui.select?.("Hydration mode", ["auto", "always", "never", "Keep current"]);
  if (hydrate && hydrate !== "Keep current") {
    current.dependencies = current.dependencies ?? {};
    current.dependencies.hydrate = { value: hydrate as import("@factory/schemas").DependencyHydrationMode, reason: "User chose dependency hydration mode", source: "DEFAULT", confidence: "HIGH" };
  }
  const cacheRoot = await uiCtx.ui.input?.("Shared dependency cache root", current.dependencies?.cacheRoot?.value ?? ctx.effective?.dependencies.cacheRoot ?? "");
  if (cacheRoot?.trim()) {
    current.dependencies = current.dependencies ?? {};
    current.dependencies.cacheRoot = { value: cacheRoot.trim(), reason: "User chose shared dependency cache root", source: "DEFAULT", confidence: "HIGH" };
  }
}

export async function customizeRepair({ uiCtx, current, localAnswers }: SetupCustomizeArgs): Promise<void> {
  const en = await uiCtx.ui.select?.("Enable repair?", ["Enabled", "Disabled", "Keep current"]);
  if (en && en !== "Keep current") { current.repair = current.repair ?? {}; current.repair.enabled = { value: en === "Enabled", reason: "User chose repair policy", source: "DEFAULT", confidence: "HIGH" }; localAnswers["repair:enabled"] = String(en === "Enabled"); }
  const ma = await uiCtx.ui.input?.("Max repair attempts (0-10)", String(current.repair?.maxAttempts?.value ?? 3));
  if (ma?.trim()) { const n = Number.parseInt(ma.trim(), 10); if (Number.isFinite(n) && n >= 0 && n <= 10) { current.repair = current.repair ?? {}; current.repair.maxAttempts = { value: n, reason: "User chose maxAttempts", source: "DEFAULT", confidence: "HIGH" }; localAnswers["repair:maxAttempts"] = String(n); } }
}

export async function customizeApproval({ uiCtx, current, localAnswers }: SetupCustomizeArgs): Promise<void> {
  const choice = await uiCtx.ui.select?.("Final merge", ["Ask for approval (required)", "Auto-merge (not-required)", "Keep current"]);
  if (!choice || choice === "Keep current") return;
  const v = choice.startsWith("Ask") ? "required" as const : "not-required" as const;
  current.approval = current.approval ?? {}; current.approval.finalMerge = { value: v, reason: "User chose merge policy", source: "DEFAULT", confidence: "HIGH" }; localAnswers["approval:finalMerge"] = v;
}

export async function customizeCapabilities({ uiCtx, current }: SetupCustomizeArgs): Promise<void> {
  const curAllow = current.capabilities?.allow?.join(", ") || "none";
  const curDeny = current.capabilities?.deny?.join(", ") || "none";
  const want = await uiCtx.ui.select?.(`Capabilities (allow: ${curAllow} / deny: ${curDeny})`, ["Edit allow", "Edit deny", "Keep current"]);
  if (want === "Edit allow") {
    const val = await uiCtx.ui.input?.("Allow capabilities (comma-separated)", curAllow);
    if (val !== undefined) { const ids = val.split(",").map((s) => s.trim()).filter(Boolean) as import("@factory/schemas").Capability[]; current.capabilities = current.capabilities ?? {}; (current.capabilities as Record<string, unknown>).allow = ids; }
  } else if (want === "Edit deny") {
    const val = await uiCtx.ui.input?.("Deny capabilities (comma-separated)", curDeny);
    if (val !== undefined) { const ids = val.split(",").map((s) => s.trim()).filter(Boolean) as import("@factory/schemas").Capability[]; current.capabilities = current.capabilities ?? {}; (current.capabilities as Record<string, unknown>).deny = ids; }
  }
}

export async function customizeTaskRouting({ uiCtx, current }: SetupCustomizeArgs): Promise<void> {
  const val = await uiCtx.ui.input?.("Task type IDs (comma-separated, e.g. database-migration)", current.taskTypes?.map((t) => t.id).join(", ") ?? "");
  if (val === undefined) return;
  const ids = val.split(",").map((s) => s.trim()).filter(Boolean);
  current.taskTypes = ids.map((id) => ({ id, reason: "User chose task types", source: "DEFAULT" as const, confidence: "MEDIUM" as const }));
}

export async function customizeConstitution({ uiCtx, current }: SetupCustomizeArgs): Promise<void> {
  const choice = await uiCtx.ui.select?.("Constitution", ["GENERATE", "REFRESH", "KEEP"]);
  if (choice) current.constitution = choice as import("@factory/schemas").ConstitutionRecommendation;
}

export function hasClearDeterministicSetup(context: import("@factory/schemas").FactorySetupContext): boolean {
  const setup = context.discoveredCommands.setup?.trim();
  const managers = context.repository.packageManagers;
  if (!setup || managers.length !== 1) return false;
  return true;
}

export async function recommendSetupWithPiSdk(
  ctx: FactoryPiCommandContext,
  context: import("@factory/schemas").FactorySetupContext,
  panel: ReturnType<typeof mountFactoryStreamingWidget>,
  hasExistingSetup: boolean,
  force: boolean,
  recommend: (input: { cwd: string; context: import("@factory/schemas").FactorySetupContext; executor: import("@factory/core").AgentExecutor; onEvent?: (text: string) => void }) => Promise<import("@factory/schemas").FactorySetupRecommendation>,
): Promise<import("@factory/schemas").FactorySetupRecommendation> {
  const executor = await createOptionalSetupExecutor(ctx, (text) => panel.appendStream(text));
  if (!executor) {
    const isDestructive = hasExistingSetup && !force;
    const msg = isDestructive
      ? "FACTORY_SETUP_REQUIRES_PI_EXECUTOR: Setup evidence is missing or ambiguous and existing setup is protected. Re-run /factory setup with auth or use --force for destructive reset."
      : "FACTORY_SETUP_REQUIRES_PI_EXECUTOR: Setup evidence is missing or ambiguous. Configure Pi auth and re-run /factory setup, or add commands.setup manually. No fallback recommendation will be used.";
    panel.append(msg);
    throw new Error(msg);
  }
  panel.setStatus("streaming");
  panel.append("Setup evidence is missing or ambiguous; asking the Pi SDK LLM for a recommendation...");
  return recommend({ cwd: ctx.cwd, context, executor, onEvent: (text) => panel.append(text) });
}

export async function createOptionalSetupExecutor(
  ctx: FactoryPiCommandContext,
  onEvent?: (executionId: string, event: { type: string; text?: string; data?: Record<string, unknown> }) => void,
): Promise<import("@factory/core").AgentExecutor> {
  const pi = await detectPiModelConfiguration(ctx.cwd);
  if (!pi.hasAuth) {
    throw new Error("FACTORY_SETUP_REQUIRES_PI_EXECUTOR: pi.hasAuth is false — no auth.json or provider mismatch. Configure auth and re-run /factory setup.");
  }
  const piExecutors = await import("@factory/executor-pi");
  const factory = (piExecutors as unknown as { createPiSdkSessionFactory: (opts: unknown) => unknown }).createPiSdkSessionFactory({ packageName: process.env.FACTORY_PI_SDK_PACKAGE });
  const { PiAgentExecutor } = piExecutors as unknown as { PiAgentExecutor: new (opts: unknown) => import("@factory/core").AgentExecutor };
  return new PiAgentExecutor({ sessionFactory: factory, onEvent });
}

export async function runLegacySetupFlow(plan: import("@factory/core").FactorySetupPlan, ctx: FactoryPiCommandContext, force: boolean, project: Awaited<ReturnType<typeof discoverFactoryProject>>): Promise<void> {
  renderLines(ctx, [
    "Factory setup",
    `mode: ${plan.mode}`,
    `repository maturity: ${plan.profile.maturity}`,
    `languages: ${plan.profile.languages.join(", ") || "none"}`,
    `package managers: ${plan.profile.packageManagers.join(", ") || "none"}`,
    `frameworks: ${plan.profile.frameworks.join(", ") || "none"}`,
    `monorepo: ${plan.profile.structure.monorepo ? "yes" : "no"}`,
    `CI: ${plan.profile.ci.providers.join(", ") || "none"}`,
    `previous runs: ${plan.profile.factory.runsCount}`,
  ]);
  const answers: Record<string, string> = {};
  if (ctx.ui.select) {
    const choice = await ctx.ui.select("Workflow preset", ["Balanced", "Fast", "Safe"]);
    answers["workflow-preset"] = (choice ?? "Balanced").toLowerCase();
  } else { answers["workflow-preset"] = "balanced"; }
  if (ctx.ui.confirm) {
    const generate = await ctx.ui.confirm("Generate constitution now?", "Create a repository-specific CONSTITUTION.md, or write a minimal stub?");
    answers["constitution"] = generate ? "generate" : "stub";
  } else { answers["constitution"] = "stub"; }
  const finalPlan = await planFactorySetup({ cwd: ctx.cwd, answers, force });
  renderLines(ctx, ["Factory setup plan", ...finalPlan.diffs.map((d) => `  ${d.file.replace(project.paths.gitRoot ?? ctx.cwd, ".")}${d.changes.includes("create file") ? " (+create)" : d.changes.includes("content changes") ? " (~update)" : " (unchanged)"}`)]);
  if (ctx.ui.confirm) { const apply = await ctx.ui.confirm("Apply Factory setup?", "Preview shown above. Write these files?"); if (!apply) { ctx.ui.notify("Factory setup not applied", "info"); return; } }
  const written = await applyFactorySetup(finalPlan);
  if (answers["constitution"] === "generate") { try { renderLines(ctx, ["Factory setup", "phase: constitution-refresh"]); const executor = await createRequiredConstitutionExecutor(); await runConstitutionScan({ cwd: ctx.cwd, constitutionExecutor: executor }); } catch { ctx.ui.notify("Constitution generation failed; stub remains", "warning"); } }
  const loaded = await loadEffectiveConfig({ cwd: ctx.cwd });
  const validation = await validateFactorySetup(ctx.cwd);
  const pi = await detectPiModelConfiguration(ctx.cwd);
  renderLines(ctx, ["Factory setup complete", `mode: ${finalPlan.mode}`, `files written: ${written.length}`, `readiness: ${validation.readiness}`, "", `workflow preset: ${answers["workflow-preset"]}`, `base branch: ${loaded.effectiveConfig.git.baseBranch}`, "", `pi auth configured: ${pi.hasAuth ? "yes" : "no"}`, `pi default model: ${pi.defaultProvider && pi.defaultModel ? `${pi.defaultProvider}/${pi.defaultModel}` : "none"}`, ...(!pi.hasModelSelection ? ["  hint: configure a Pi default model in ~/.pi/agent/settings.json"] : []), ...(!pi.hasAuth ? ["  hint: use /login before generating a constitution or running model-backed flows"] : []),]);
  ctx.ui.notify(`Factory setup complete — ${validation.readiness}`, (validation.readiness === "READY" || validation.readiness === "READY_WITH_WARNINGS") ? "info" : "warning");
}



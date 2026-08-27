import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { builtInDefaults } from "../config/defaults.js";
import { loadEffectiveConfig } from "../config/loader.js";
import { discoverFactoryProject } from "../project/discovery.js";
import { initializeCapabilitySystem, listRegisteredCapabilities } from "../capabilities/index.js";
import { discoverSkillFiles, parseSkillFile, skillFileToContract } from "../skills/loader.js";
import { inspectRepositoryForSetup } from "./profile.js";
import { collectVisiblePiModels, detectPiModelConfiguration } from "./pi-models.js";
import type { FactorySetupContext, SkillSummary } from "@factory/schemas";
import type { Capability } from "@factory/schemas";
import type { ModelSelection } from "@factory/schemas";

export async function buildFactorySetupContext(cwd: string): Promise<FactorySetupContext> {
  const profile = await inspectRepositoryForSetup(cwd);
  const project = await discoverFactoryProject(cwd);
  const gitRoot = project.paths.gitRoot ?? cwd;

  // Raw provenance layers — do not flatten.
  const rawGlobalText = await readRawIfExists(path.join(os.homedir(), ".factory", "config.yaml"));
  const rawProjectText = project.paths.projectConfigPath ? await readRawIfExists(project.paths.projectConfigPath) : undefined;
  const rawWorkflowText = project.paths.workflowPath ? await readRawIfExists(project.paths.workflowPath) : undefined;

  const globalConfig = rawGlobalText ? parseConfigContent(rawGlobalText) : undefined;
  const projectConfig = rawProjectText ? parseConfigContent(rawProjectText) : undefined;
  const workflows = rawWorkflowText ? parseWorkflowContent(rawWorkflowText) : undefined;

  let effective: FactorySetupContext["effective"];
  try {
    const loaded = await loadEffectiveConfig({ cwd });
    effective = loaded.effectiveConfig;
  } catch {}

  // Available models — from built-ins plus pi auth
  const pi = await detectPiModelConfiguration(gitRoot).catch(() => undefined);
  const availableModels = collectAvailableModels(pi);

  // Available capabilities — builtin + discovered custom
  await initializeCapabilitySystem(gitRoot).catch(() => {});
  const availableCapabilities = listRegisteredCapabilities().map((c) => c.id as Capability);

  // Available skills — builtin registry + project skills
  const availableSkills = await collectAvailableSkills(gitRoot);

  // profile.commands.install may be __install (inferred npm install etc.) when no explicit setup script
  const inferredInstall = (profile.commands as Record<string, string | undefined>).__install ?? profile.commands.install;
  const discoveredCommands: FactorySetupContext["discoveredCommands"] = {
    setup: inferredInstall,
    lint: profile.commands.lint,
    typecheck: profile.commands.typecheck,
    test: profile.commands.test,
    build: profile.commands.build,
  };

  return {
    repository: profile as unknown as FactorySetupContext["repository"],
    existing: {
      builtIn: builtInDefaults,
      ...(globalConfig ? { global: globalConfig } : {}),
      ...(projectConfig ? { project: projectConfig } : {}),
      ...(workflows ? { workflows } : {}),
      constitutionExists: Boolean(project.paths.constitutionPath),
      ...(rawGlobalText ? { rawGlobalText } : {}),
      ...(rawProjectText ? { rawProjectText } : {}),
      ...(rawWorkflowText ? { rawWorkflowText } : {}),
    },
    ...(effective ? { effective } : {}),
    availableModels,
    availableSkills,
    availableCapabilities,
    discoveredCommands,
  };
}

function collectAvailableModels(pi: Awaited<ReturnType<typeof detectPiModelConfiguration>> | undefined): ModelSelection[] {
  const models = collectVisiblePiModels(pi);
  const seen = new Set<string>();

  for (const model of models) {
    seen.add(`${model.provider ?? ""}:${model.model}`);
  }

  const add = (m?: ModelSelection): void => {
    if (!m?.model) return;
    const key = `${m.provider ?? ""}:${m.model}`;
    if (seen.has(key)) return;
    seen.add(key);
    models.push(m);
  };

  // Keep built-ins last; configured Pi models should be preferred.
  for (const role of ["discovery", "planner", "builder", "reviewer", "repair"] as const) {
    add(builtInDefaults.models[role]);
  }

  return models;
}

async function collectAvailableSkills(gitRoot: string): Promise<SkillSummary[]> {
  const ids = new Set<string>();
  const summaries: SkillSummary[] = [];

  // Hardcoded factory stage skills (registered at runtime but not yet discovered via files)
  const builtInIds = ["repo-interpretation", "architecture-planning", "implementation-task", "acceptance-review", "failure-triage", "verification-repair", "verification-planning", "factory-concierge"];
  for (const id of builtInIds) {
    ids.add(id);
    summaries.push({ id });
  }

  // Bring-your-own skills from common agent locations.
  for (const root of skillSearchRoots(gitRoot)) {
    const files = await discoverSkillFiles(root).catch(() => []);
    for (const file of files) {
      const parsed = await parseSkillFile(file);
      if (!parsed) continue;
      const contract = skillFileToContract(parsed);
      if (!ids.has(contract.id)) {
        ids.add(contract.id);
        summaries.push({ id: contract.id, description: contract.description });
      }
    }
  }

  // Also include factory-setup itself so AI may recommend keeping it
  if (!ids.has("factory-setup")) {
    ids.add("factory-setup");
    summaries.push({ id: "factory-setup", description: "Recommend Factory configuration for a repository." });
  }

  return summaries.sort((a, b) => a.id.localeCompare(b.id));
}

function skillSearchRoots(gitRoot: string): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".agents", "skills"),
    path.join(home, ".codex", "skills"),
    path.join(home, ".claude", "skills"),
    path.join(home, ".warp", "skills"),
    path.join(home, ".cursor", "skills"),
    path.join(home, ".gemini", "skills"),
    path.join(home, ".gemini", "config", "skills"),
    path.join(home, ".copilot", "skills"),
    path.join(home, ".github", "skills"),
    path.join(home, ".opencode", "skills"),
    path.join(home, ".factory", "skills"),
    path.join(gitRoot, ".agents", "skills"),
    path.join(gitRoot, ".codex", "skills"),
    path.join(gitRoot, ".claude", "skills"),
    path.join(gitRoot, ".warp", "skills"),
    path.join(gitRoot, ".cursor", "skills"),
    path.join(gitRoot, ".gemini", "skills"),
    path.join(gitRoot, ".gemini", "config", "skills"),
    path.join(gitRoot, ".copilot", "skills"),
    path.join(gitRoot, ".github", "skills"),
    path.join(gitRoot, ".opencode", "skills"),
    path.join(gitRoot, ".factory", "skills"),
    path.join(gitRoot, ".pi", "skills"),
    path.join(gitRoot, "github", "skills"),
    path.join(gitRoot, "copilot", "skills"),
    path.join(gitRoot, "skills"),
  ];
}

async function readRawIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function parseConfigContent<T>(raw: string): T | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      return undefined;
    }
  }
  try {
    return parseYaml(trimmed) as T;
  } catch {
    return undefined;
  }
}

function parseWorkflowContent(raw: string): import("@factory/schemas").WorkflowDefinition[] | undefined {
  try {
    const parsed = parseConfigContent<{ workflows?: import("@factory/schemas").WorkflowDefinition[] }>(raw);
    return parsed?.workflows;
  } catch {
    return undefined;
  }
}

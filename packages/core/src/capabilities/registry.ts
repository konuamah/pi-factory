import type { CapabilityDefinition, CapabilitySource, RegisteredCapability } from "@factory/schemas";
import { initializeCapabilityProviders } from "./providers.js";
import { discoverCapabilities, type DiscoveryReport } from "./discovery.js";

const registry = new Map<string, RegisteredCapability>();
const sourceRank: Record<CapabilitySource, number> = {
  BUILTIN: 0,
  GLOBAL: 1,
  PROJECT: 2,
  RUN: 3,
};

export function registerCapability(
  definition: CapabilityDefinition,
  source: CapabilitySource,
  filePath?: string,
): { registered: boolean; replaced?: RegisteredCapability; reason?: string } {
  const existing = registry.get(definition.id);
  if (existing && sourceRank[source] <= sourceRank[existing.source]) {
    return {
      registered: false,
      replaced: existing,
      reason: `existing ${existing.source} definition takes precedence over ${source}.`,
    };
  }
  const entry: RegisteredCapability = {
    id: definition.id,
    description: definition.description,
    effect: definition.effect,
    ...(definition.input ? { input: definition.input } : {}),
    ...(definition.output ? { output: definition.output } : {}),
    source,
    ...(filePath ? { filePath } : {}),
  };
  registry.set(definition.id, entry);
  return { registered: true, replaced: existing };
}

export function listRegisteredCapabilities(): RegisteredCapability[] {
  return [...registry.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function getRegisteredCapability(id: string): RegisteredCapability | undefined {
  return registry.get(id);
}

export function clearCapabilityRegistry(): void {
  registry.clear();
}

let initialized = false;

export async function initializeCapabilitySystem(projectRoot?: string): Promise<DiscoveryReport> {
  if (initialized && !projectRoot) {
    return { discovered: [], registered: [], skipped: [], collisions: [] };
  }
  initialized = true;
  registerBuiltinCapabilities();
  initializeCapabilityProviders();
  return discoverCapabilities(projectRoot);
}

export function registerBuiltinCapabilities(): void {
  const builtins: CapabilityDefinition[] = [
    { id: "repo.read", description: "Read repository files and structure.", effect: "read" },
    { id: "repo.write", description: "Modify repository files.", effect: "write" },
    { id: "shell.execute", description: "Execute shell commands.", effect: "write" },
    { id: "git.inspect", description: "Inspect git history and state.", effect: "read" },
    { id: "git.commit", description: "Create git commits.", effect: "write" },
    { id: "git.push", description: "Push branches to remotes.", effect: "write" },
    { id: "ci.read", description: "Read CI status and logs.", effect: "read" },
    { id: "ci.trigger", description: "Trigger CI runs.", effect: "write" },
    { id: "pr.read", description: "Read pull request details.", effect: "read" },
    { id: "pr.comment", description: "Comment on pull requests.", effect: "write" },
    { id: "pr.merge", description: "Merge pull requests.", effect: "destructive" },
    { id: "deploy.staging", description: "Deploy to a staging environment.", effect: "write" },
    { id: "deploy.production", description: "Deploy to production.", effect: "destructive" },
  ];
  for (const definition of builtins) {
    registerCapability(definition, "BUILTIN");
  }
}

export * from "./gate.js";
export * from "./tool-map.js";
export * from "./registry.js";
export * from "./discovery.js";
export * from "./validation.js";
export * from "./providers.js";
export * from "./executability.js";
export * from "./negotiation.js";
import type { Capability, CapabilityPolicy } from "@factory/schemas";

export type AutonomyLevel = "low" | "medium" | "high";

export interface EffectiveCapabilities {
  requested: Capability[];
  granted: Capability[];
  denied: Capability[];
  needsApproval: Capability[];
}

export interface CapabilityResolutionInput {
  requested: Capability[];
  autonomy?: AutonomyLevel;
  projectPolicy?: CapabilityPolicy;
  workflowPolicy?: CapabilityPolicy;
  nodePolicy?: CapabilityPolicy;
}

const AUTONOMY_CAPABILITIES: Record<AutonomyLevel, Capability[]> = {
  low: ["repo.read", "ci.read"],
  medium: ["repo.read", "repo.write", "shell.execute", "ci.read"],
  high: ["repo.read", "repo.write", "shell.execute", "git.commit", "git.push", "ci.read", "ci.trigger", "pr.comment"],
};

const ALWAYS_APPROVAL = new Set<Capability>(["deploy.production"]);

const VALID_CAPABILITIES: Capability[] = [
  "repo.read",
  "repo.write",
  "shell.execute",
  "git.commit",
  "git.push",
  "ci.read",
  "ci.trigger",
  "pr.comment",
  "deploy.staging",
  "deploy.production",
];

export function isCapability(value: string): value is Capability {
  return (VALID_CAPABILITIES as string[]).includes(value);
}

export function resolveEffectiveCapabilities(input: CapabilityResolutionInput): EffectiveCapabilities {
  const autonomy = normalizeAutonomy(input.autonomy);
  const autonomyGranted = new Set<Capability>(AUTONOMY_CAPABILITIES[autonomy]);
  const projectDeny = new Set<Capability>(input.projectPolicy?.deny ?? []);
  const projectAllow = new Set<Capability>(input.projectPolicy?.allow ?? []);
  const workflowDeny = new Set<Capability>(input.workflowPolicy?.deny ?? []);
  const workflowAllow = new Set<Capability>(input.workflowPolicy?.allow ?? []);
  const nodeDeny = new Set<Capability>(input.nodePolicy?.deny ?? []);
  const nodeAllow = new Set<Capability>(input.nodePolicy?.allow ?? []);

  const requested = dedupe(input.requested);
  const granted: Capability[] = [];
  const denied: Capability[] = [];
  const needsApproval: Capability[] = [];

  for (const capability of requested) {
    if (nodeDeny.has(capability) || workflowDeny.has(capability) || projectDeny.has(capability)) {
      denied.push(capability);
      continue;
    }

    const allowedByAutonomy = autonomyGranted.has(capability);
    const allowedByPolicy = nodeAllow.has(capability) || workflowAllow.has(capability) || projectAllow.has(capability);

    if (!allowedByAutonomy && !allowedByPolicy) {
      denied.push(capability);
      continue;
    }

    if (ALWAYS_APPROVAL.has(capability)) {
      needsApproval.push(capability);
    }
    granted.push(capability);
  }

  return { requested, granted, denied, needsApproval };
}

function normalizeAutonomy(value: AutonomyLevel | string | undefined): AutonomyLevel {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return "medium";
}

function dedupe(values: Capability[]): Capability[] {
  return [...new Set(values)];
}

export function capabilitiesToToolNames(capabilities: Capability[]): string[] {
  const tools = new Set<string>();
  if (capabilities.includes("repo.read")) {
    tools.add("read");
    tools.add("grep");
    tools.add("find");
    tools.add("ls");
  }
  if (capabilities.includes("repo.write")) {
    tools.add("write");
    tools.add("edit");
  }
  if (capabilities.includes("shell.execute")) {
    tools.add("bash");
  }
  return [...tools];
}

export function toolsToRequiredCapabilities(tools: string[]): Capability[] {
  const capabilities = new Set<Capability>();
  if (tools.some((tool) => ["read", "grep", "find", "ls"].includes(tool))) {
    capabilities.add("repo.read");
  }
  if (tools.some((tool) => ["write", "edit"].includes(tool))) {
    capabilities.add("repo.write");
  }
  if (tools.includes("bash")) {
    capabilities.add("shell.execute");
  }
  return [...capabilities];
}

export function defaultCapabilitiesForRole(role: string): Capability[] {
  switch (role) {
    case "planner":
    case "discovery":
    case "reviewer":
      return ["repo.read", "ci.read"];
    case "repair":
      return ["repo.read", "repo.write", "shell.execute", "ci.read"];
    case "builder":
    default:
      return ["repo.read", "repo.write", "shell.execute", "ci.read"];
  }
}

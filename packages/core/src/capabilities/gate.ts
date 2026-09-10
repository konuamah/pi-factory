import type { Capability, CapabilityPolicy } from "@factory/schemas";
import type { SkillContract } from "@factory/schemas";
import { toolToCapability } from "./tool-map.js";

export type ToolCallDecision =
  | { action: "allow" }
  | { action: "deny"; reason: string; capability?: string; rule: string }
  | { action: "require-approval"; capability: string; toolName: string; args: unknown };

export interface ToolCallContext {
  executionId: string;
  role?: string;
  taskId?: string;
  workflowId?: string;
  grantedCapabilities?: string[];
  deniedCapabilities?: string[];
  needsApproval?: string[];
  approvedCapabilities?: Set<string>;
  skills?: SkillContract[];
  negotiated?: { granted: string[]; denied: Array<{ tool: string; reason: string; detail: string; recovery: string }> };
  projectPolicy?: CapabilityPolicy;
  workflowPolicy?: CapabilityPolicy;
  nodePolicy?: CapabilityPolicy;
  cwd: string;
}

export interface ToolCallInput {
  toolName: string;
  args: Record<string, unknown>;
  context: ToolCallContext;
}

export interface ToolResourcePolicy {
  readScopes?: string[];
  writeScopes?: string[];
  forbiddenReadScopes?: string[];
  forbiddenWriteScopes?: string[];
  forbiddenCommands?: string[];
}

export function checkToolCall(input: ToolCallInput, resourcePolicy?: ToolResourcePolicy): ToolCallDecision {
  const { toolName, args, context } = input;
  const capability = toolToCapability(toolName);

  const negotiated = context.negotiated;
  if (negotiated && !negotiated.granted.includes(toolName)) {
    const denial = negotiated.denied.find((item) => item.tool === toolName);
    return {
      action: "deny",
      capability,
      rule: "capability-negotiation",
      reason: denial
        ? `Capability unavailable: ${toolName}\nReason: ${denial.reason} — ${denial.detail}\nRecovery: ${denial.recovery}`
        : `Capability unavailable: ${toolName}\nReason: not granted by capability negotiation\nRecovery: update the stage policy or provider inventory.`,
    };
  }

  // Unmapped tools are only safe after explicit negotiation has granted them.
  if (!capability) {
    return context.negotiated ? { action: "deny", rule: "unknown-tool", reason: `Tool '${toolName}' is not registered.` } : { action: "allow" };
  }

  const denied = new Set<string>([
    ...(context.deniedCapabilities ?? []),
    ...(context.nodePolicy?.deny ?? []),
    ...(context.workflowPolicy?.deny ?? []),
    ...(context.projectPolicy?.deny ?? []),
  ]);
  const granted = new Set<string>(context.grantedCapabilities ?? []);
  const needsApproval = new Set<string>(context.needsApproval ?? []);

  // 1. Hard deny wins.
  if (denied.has(capability)) {
    return {
      action: "deny",
      capability,
      rule: "capability-deny",
      reason: `Tool '${toolName}' requires capability '${capability}' which is denied for this node.`,
    };
  }

  // 2. Capability must be granted.
  if (!granted.has(capability)) {
    return {
      action: "deny",
      capability,
      rule: "capability-not-granted",
      reason: `Tool '${toolName}' requires capability '${capability}' which is not granted for this node.`,
    };
  }

  // 3. Skill permission check: if selected skills declare allowedTools, tool must be in union.
  const skillAllowed = evaluateSkillToolPermissions(toolName, context.skills);
  if (skillAllowed === "deny") {
    return {
      action: "deny",
      capability,
      rule: "skill-tool-denied",
      reason: `Tool '${toolName}' is not allowed by the selected skills for this node.`,
    };
  }

  // 4. Path/resource check.
  if (resourcePolicy) {
    const pathCheck = checkToolPath(toolName, args, resourcePolicy);
    if (pathCheck !== "ok") {
      return {
        action: "deny",
        capability,
        rule: "path-policy",
        reason: pathCheck,
      };
    }
  }

  // 5. Approval required.
  if (needsApproval.has(capability)) {
    if (context.approvedCapabilities?.has(capability)) {
      return { action: "allow" };
    }
    return {
      action: "require-approval",
      capability,
      toolName,
      args,
    };
  }

  return { action: "allow" };
}

function evaluateSkillToolPermissions(toolName: string, skills: SkillContract[] | undefined): "allow" | "deny" | "neutral" {
  if (!skills?.length) {
    return "neutral";
  }
  const declaring = skills.filter((skill) => skill.permissions?.allowedTools?.length);
  if (declaring.length === 0) {
    return "neutral";
  }
  const allowed = new Set(declaring.flatMap((skill) => skill.permissions?.allowedTools ?? []));
  return allowed.has(toolName) ? "allow" : "deny";
}

function checkToolPath(toolName: string, args: Record<string, unknown>, policy: ToolResourcePolicy): "ok" | string {
  if (toolName === "write" || toolName === "edit") {
    const targetPath = typeof args.path === "string" ? args.path : "";
    if (policy.forbiddenWriteScopes?.some((scope) => targetPath.startsWith(scope))) {
      return `Write to '${targetPath}' is forbidden by path policy (scope: ${policy.forbiddenWriteScopes.join(", ")}).`;
    }
    if (policy.writeScopes?.length && !policy.writeScopes.some((scope) => targetPath.startsWith(scope))) {
      return `Write to '${targetPath}' is outside allowed write scopes (${policy.writeScopes.join(", ")}).`;
    }
  }

  if (toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls") {
    const targetPath = typeof args.path === "string" ? args.path : (typeof args.pattern === "string" ? args.pattern : "");
    if (policy.forbiddenReadScopes?.some((scope) => pathMatchesScope(targetPath, scope))) {
      return `Read of '${targetPath}' is forbidden by path policy (scope: ${policy.forbiddenReadScopes.join(", ")}).`;
    }
    if (policy.readScopes?.length && !policy.readScopes.some((scope) => targetPath.startsWith(scope))) {
      return `Read of '${targetPath}' is outside allowed read scopes (${policy.readScopes.join(", ")}).`;
    }
  }

  if (toolName === "bash") {
    const command = typeof args.command === "string" ? args.command : "";
    if (policy.forbiddenCommands?.some((forbidden) => command.includes(forbidden))) {
      return `Bash command contains forbidden token '${command}' (forbidden: ${policy.forbiddenCommands.join(", ")}).`;
    }
  }

  return "ok";
}

export function buildResourcePolicyForContext(context: ToolCallContext): ToolResourcePolicy | undefined {
  const skills = context.skills ?? [];
  const readScopes = unique(skills.flatMap((skill) => skill.permissions?.readScopes ?? []));
  const writeScopes = unique(skills.flatMap((skill) => skill.permissions?.writeScopes ?? []));
  const forbiddenReadScopes = unique(skills.flatMap((skill) => skill.permissions?.forbiddenReadScopes ?? []));
  const forbiddenWriteScopes = unique(skills.flatMap((skill) => skill.permissions?.forbiddenWriteScopes ?? []));
  const forbiddenCommands = context.role === "reviewer" ? ["git push", "rm -rf", "git reset --hard"] : [];

  if (readScopes.length === 0 && writeScopes.length === 0 && forbiddenReadScopes.length === 0 && forbiddenWriteScopes.length === 0 && forbiddenCommands.length === 0) {
    return undefined;
  }

  return {
    ...(readScopes.length ? { readScopes } : {}),
    ...(writeScopes.length ? { writeScopes } : {}),
    ...(forbiddenReadScopes.length ? { forbiddenReadScopes } : {}),
    ...(forbiddenWriteScopes.length ? { forbiddenWriteScopes } : {}),
    ...(forbiddenCommands.length ? { forbiddenCommands } : {}),
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function pathMatchesScope(targetPath: string, scope: string): boolean {
  const normalizedTarget = normalizePathForPolicy(targetPath);
  const normalizedScope = normalizePathForPolicy(scope);
  if (!normalizedTarget || !normalizedScope) {
    return false;
  }
  if (normalizedScope.includes("/")) {
    return normalizedTarget === normalizedScope || normalizedTarget.startsWith(`${normalizedScope}/`);
  }
  return normalizedTarget.split("/").includes(normalizedScope);
}

function normalizePathForPolicy(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

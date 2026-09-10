import type { Capability } from "@factory/schemas";
import type { SkillContract } from "@factory/schemas";
import { capabilitiesToToolNames, defaultCapabilitiesForRole } from "./index.js";
import { toolToCapability } from "./tool-map.js";

export type DenialReason = "stage" | "safety" | "role-default" | "pi" | "provider" | "unknown-tool";

export interface ToolDenial {
  tool: string;
  reason: DenialReason;
  detail: string;
  recovery: string;
}

export interface ToolInventory {
  available: string[];
  unavailable: string[];
  unknown: string[];
}

export interface NegotiatedCapabilities {
  requestedTools: string[];
  stageAllowed: string[];
  stageDenied: string[];
  safetyGranted: string[];
  providerAvailable: string[];
  granted: string[];
  denied: ToolDenial[];
}

export interface NegotiateStageCapabilitiesInput {
  stage: { allowedTools?: string[]; denyTools?: string[]; role?: string };
  skills?: SkillContract[];
  safety: { granted: Capability[]; denied: Capability[] };
  provider: ToolInventory;
  roleDefaults?: string[];
}

export function negotiateStageCapabilities(input: NegotiateStageCapabilitiesInput): NegotiatedCapabilities {
  const roleDefaults = input.roleDefaults ?? capabilitiesToToolNames(defaultCapabilitiesForRole(input.stage.role ?? "builder"));
  const skillRequests = unique((input.skills ?? []).flatMap((skill) => skill.permissions?.allowedTools ?? []));
  const requestedTools = skillRequests.length > 0 ? skillRequests : [...roleDefaults];
  const stageAllowed = unique(input.stage.allowedTools ?? roleDefaults);
  const deniedByStage = new Set(input.stage.denyTools ?? []);
  const safetyGranted = new Set(input.safety.granted);
  const safetyDenied = new Set(input.safety.denied);
  const providerAvailable = unique(input.provider.available);
  const inventoryAvailable = new Set(providerAvailable);
  const inventoryUnavailable = new Set(input.provider.unavailable);
  const inventoryUnknown = new Set(input.provider.unknown);
  const denied: ToolDenial[] = [];
  const granted: string[] = [];
  const stageDenied: string[] = [];

  for (const tool of requestedTools) {
    if (deniedByStage.has(tool)) {
      stageDenied.push(tool);
      denied.push(denial(tool, "stage", `Tool '${tool}' is denied by the stage denyTools policy.`, "Remove it from denyTools or choose a different stage policy."));
      continue;
    }
    if (!stageAllowed.includes(tool)) {
      stageDenied.push(tool);
      denied.push(denial(tool, "stage", `Tool '${tool}' is not included in the stage allowedTools policy.`, "Add the tool to allowedTools or select a skill that does not require it."));
      continue;
    }
    const capability = toolToCapability(tool);
    if (!capability) {
      if (inventoryUnknown.has(tool)) {
        denied.push(denial(tool, "unknown-tool", `No provider is registered for tool '${tool}'.`, "Install or register the provider that owns this tool."));
      } else if (!inventoryAvailable.has(tool)) {
        denied.push(denial(tool, inventoryUnavailable.has(tool) ? "provider" : "pi", `The provider cannot create tool '${tool}' for this session.`, "Select an available tool or configure the provider before continuing."));
      } else {
        granted.push(tool);
      }
      continue;
    }
    if (safetyDenied.has(capability) || !safetyGranted.has(capability)) {
      denied.push(denial(tool, "safety", `Capability '${capability}' is not granted for this stage.`, "Change the authorized policy or remove the tool requirement."));
      continue;
    }
    if (!inventoryAvailable.has(tool)) {
      denied.push(denial(tool, inventoryUnavailable.has(tool) ? "provider" : "pi", `The provider cannot create tool '${tool}' for this session.`, "Select an available tool or configure the provider before continuing."));
      continue;
    }
    granted.push(tool);
  }

  return { requestedTools, stageAllowed, stageDenied, safetyGranted: [...safetyGranted], providerAvailable, granted, denied };
}

function denial(tool: string, reason: DenialReason, detail: string, recovery: string): ToolDenial {
  return { tool, reason, detail, recovery };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

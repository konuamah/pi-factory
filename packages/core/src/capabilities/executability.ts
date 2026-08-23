import type { CapabilityPolicy } from "@factory/schemas";
import { getRegisteredCapability } from "./registry.js";
import { getProvider } from "./providers.js";

export type ExecutabilityStatus =
  | "unknown"
  | "available-not-executable"
  | "executable";

export interface CapabilityExecutability {
  capabilityId: string;
  status: ExecutabilityStatus;
  reason: string;
  bindingExists: boolean;
  providerExists: boolean;
  policyAllows: boolean;
  runAuthorized: boolean;
}

export interface ExecutabilityInput {
  capabilityId: string;
  binding?: { provider: string; operation: string };
  policy?: CapabilityPolicy;
  runAuthorized?: boolean;
  approvalGranted?: boolean;
}

export function checkExecutability(input: ExecutabilityInput): CapabilityExecutability {
  const definition = getRegisteredCapability(input.capabilityId);
  if (!definition) {
    return {
      capabilityId: input.capabilityId,
      status: "unknown",
      reason: "Unknown capability: no definition is registered.",
      bindingExists: false,
      providerExists: false,
      policyAllows: true,
      runAuthorized: false,
    };
  }

  const bindingExists = Boolean(input.binding?.provider && input.binding?.operation);
  if (!bindingExists) {
    return {
      capabilityId: input.capabilityId,
      status: "available-not-executable",
      reason: "Capability available but not executable: no provider binding is configured.",
      bindingExists: false,
      providerExists: false,
      policyAllows: true,
      runAuthorized: false,
    };
  }

  const providerExists = Boolean(input.binding && getProvider(input.binding.provider));
  if (!providerExists) {
    return {
      capabilityId: input.capabilityId,
      status: "available-not-executable",
      reason: `Capability available but not executable: provider '${input.binding!.provider}' is not registered.`,
      bindingExists: true,
      providerExists: false,
      policyAllows: true,
      runAuthorized: false,
    };
  }

  const policy = input.policy;
  const denySet = new Set<string>(policy?.deny ?? []);
  const allowSet = new Set<string>(policy?.allow ?? []);
  const policyAllows = !denySet.has(input.capabilityId) && (allowSet.size === 0 || allowSet.has(input.capabilityId));
  if (!policyAllows) {
    return {
      capabilityId: input.capabilityId,
      status: "available-not-executable",
      reason: `Capability denied by policy.`,
      bindingExists: true,
      providerExists: true,
      policyAllows: false,
      runAuthorized: false,
    };
  }

  const runAuthorized = input.runAuthorized ?? true;
  if (!runAuthorized) {
    return {
      capabilityId: input.capabilityId,
      status: "available-not-executable",
      reason: "Capability denied for this run: not authorized.",
      bindingExists: true,
      providerExists: true,
      policyAllows: true,
      runAuthorized: false,
    };
  }

  return {
    capabilityId: input.capabilityId,
    status: "executable",
    reason: "Capability is defined, bound, provider-backed, policy-allowed, and run-authorized.",
    bindingExists: true,
    providerExists: true,
    policyAllows: true,
    runAuthorized: true,
  };
}

import type { Capability } from "@factory/schemas";

const TOOL_CAPABILITY_MAP: Record<string, Capability> = {
  read: "repo.read",
  grep: "repo.read",
  find: "repo.read",
  ls: "repo.read",
  write: "repo.write",
  edit: "repo.write",
  bash: "shell.execute",
};

export function toolToCapability(toolName: string): Capability | undefined {
  return TOOL_CAPABILITY_MAP[toolName];
}

export function capabilityToTools(capability: string): string[] {
  switch (capability) {
    case "repo.read":
      return ["read", "grep", "find", "ls"];
    case "repo.write":
      return ["write", "edit"];
    case "shell.execute":
      return ["bash"];
    default:
      return [];
  }
}

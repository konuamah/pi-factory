import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { CapabilityBinding, CapabilityProvider, ProviderOperation } from "@factory/schemas";

const execAsync = promisify(exec);

export type ProviderKind = "native" | "mcp" | "http" | "cli" | "plugin";

export interface CapabilityProviderRegistry {
  get(id: string): CapabilityProvider | undefined;
  register(provider: CapabilityProvider): void;
}

const providerRegistry = new Map<string, CapabilityProvider>();

export function registerProvider(provider: CapabilityProvider): void {
  providerRegistry.set(provider.id, provider);
}

export function getProvider(id: string): CapabilityProvider | undefined {
  return providerRegistry.get(id);
}

export function listProviders(): CapabilityProvider[] {
  return [...providerRegistry.values()];
}

export const nativeProvider: CapabilityProvider = {
  id: "native",
  async operations(): Promise<ProviderOperation[]> {
    return [
      { name: "shell", description: "Run a shell command." },
      { name: "stub", description: "Return a stub result (no side effects)." },
    ];
  },
  async execute(operation: string, input: unknown): Promise<unknown> {
    const args = (input ?? {}) as Record<string, unknown>;
    if (operation === "stub") {
      return { ok: true, operation, note: "Stub provider: no side effect performed." };
    }
    if (operation === "shell") {
      const command = typeof args.command === "string" ? args.command : "";
      if (!command) {
        throw new Error("native/shell binding requires a 'command' input.");
      }
      const { stdout, stderr } = await execAsync(command, { windowsHide: true });
      return { ok: true, operation, stdout, stderr };
    }
    throw new Error(`native provider has no operation '${operation}'.`);
  },
};

export function initializeCapabilityProviders(): void {
  registerProvider(nativeProvider);
}

export async function executeCapability(
  binding: CapabilityBinding,
  input: unknown,
): Promise<unknown> {
  const provider = getProvider(binding.provider);
  if (!provider) {
    throw new Error(`Provider '${binding.provider}' is not registered.`);
  }
  return provider.execute(binding.operation, input);
}

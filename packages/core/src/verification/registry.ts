import type { VerificationProvider } from "./types.js";

const providers = new Map<string, VerificationProvider>();

export function registerVerificationProvider(provider: VerificationProvider): void {
  providers.set(provider.type, provider);
}

export function getVerificationProvider(type: string): VerificationProvider | undefined {
  return providers.get(type);
}

export function listVerificationProviders(): VerificationProvider[] {
  return [...providers.values()];
}

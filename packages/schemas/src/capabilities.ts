export type CapabilityEffect = "read" | "write" | "destructive";

export type SimpleType = "string" | "number" | "boolean" | "string[]" | "number[]" | "object";

export interface CapabilityDefinition {
  id: string;
  description: string;
  effect: CapabilityEffect;
  input?: Record<string, SimpleType>;
  output?: Record<string, SimpleType>;
}

export type CapabilitySource = "BUILTIN" | "GLOBAL" | "PROJECT" | "RUN";

export interface RegisteredCapability {
  id: string;
  description: string;
  effect: CapabilityEffect;
  input?: Record<string, SimpleType>;
  output?: Record<string, SimpleType>;
  source: CapabilitySource;
  filePath?: string;
}

export interface CapabilityBinding {
  capabilityId: string;
  provider: string;
  operation: string;
  config?: Record<string, unknown>;
}

export interface ProviderOperation {
  name: string;
  description?: string;
  input?: Record<string, SimpleType>;
}

export interface CapabilityProvider {
  id: string;
  operations(): Promise<ProviderOperation[]>;
  execute(operation: string, input: unknown): Promise<unknown>;
}

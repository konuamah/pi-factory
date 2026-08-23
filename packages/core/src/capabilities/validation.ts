import type { CapabilityDefinition, CapabilityEffect, SimpleType } from "@factory/schemas";

export interface CapabilityValidationResult {
  valid: boolean;
  errors: string[];
}

const VALID_EFFECTS: CapabilityEffect[] = ["read", "write", "destructive"];
const VALID_TYPES: SimpleType[] = ["string", "number", "boolean", "string[]", "number[]", "object"];

export function validateCapabilityDefinition(value: unknown): CapabilityValidationResult {
  const errors: string[] = [];
  if (!value || typeof value !== "object") {
    return { valid: false, errors: ["Capability definition must be an object."] };
  }

  const definition = value as Partial<CapabilityDefinition>;

  if (typeof definition.id !== "string" || !definition.id.trim()) {
    errors.push("missing id");
  } else if (!/^[a-z0-9][a-z0-9._-]*$/.test(definition.id)) {
    errors.push(`invalid id '${definition.id}' (use lowercase letters, numbers, '.', '-', '_')`);
  }

  if (typeof definition.description !== "string" || !definition.description.trim()) {
    errors.push("missing description");
  }

  if (!definition.effect || !VALID_EFFECTS.includes(definition.effect)) {
    errors.push(`unknown effect '${String(definition.effect)}' (expected read, write, or destructive)`);
  }

  const inputErrors = validateSchema(definition.input, "input");
  const outputErrors = validateSchema(definition.output, "output");
  errors.push(...inputErrors, ...outputErrors);

  return { valid: errors.length === 0, errors };
}

export function validateCapabilityBinding(value: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!value || typeof value !== "object") {
    return { valid: false, errors: ["Binding must be an object."] };
  }
  const binding = value as { capabilityId?: unknown; provider?: unknown; operation?: unknown };
  if (typeof binding.capabilityId !== "string" || !binding.capabilityId.trim()) {
    errors.push("missing capabilityId");
  }
  if (typeof binding.provider !== "string" || !binding.provider.trim()) {
    errors.push("missing provider");
  }
  if (typeof binding.operation !== "string" || !binding.operation.trim()) {
    errors.push("missing operation");
  }
  return { valid: errors.length === 0, errors };
}

function validateSchema(schema: unknown, name: string): string[] {
  if (schema === undefined) {
    return [];
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return [`${name} must be a map of field name to type`];
  }
  const errors: string[] = [];
  for (const [field, type] of Object.entries(schema as Record<string, unknown>)) {
    if (typeof type !== "string" || !VALID_TYPES.includes(type as SimpleType)) {
      errors.push(`${name}.${field} has unsupported type '${String(type)}'`);
    }
  }
  return errors;
}

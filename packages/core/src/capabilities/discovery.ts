import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { CapabilityDefinition, CapabilitySource, RegisteredCapability } from "@factory/schemas";
import { registerCapability } from "./registry.js";
import { validateCapabilityDefinition } from "./validation.js";

export interface DiscoveryReport {
  discovered: RegisteredCapability[];
  registered: RegisteredCapability[];
  skipped: Array<{ id: string; errors: string[]; filePath: string }>;
  collisions: Array<{ id: string; reason: string }>;
}

export async function discoverCapabilities(projectRoot?: string): Promise<DiscoveryReport> {
  const report: DiscoveryReport = { discovered: [], registered: [], skipped: [], collisions: [] };

  const globalDir = path.join(os.homedir(), ".factory", "capabilities");
  const projectDir = projectRoot ? path.join(projectRoot, ".factory", "capabilities") : undefined;

  if (projectDir) {
    await loadDir(projectDir, "PROJECT", report);
  }
  await loadDir(globalDir, "GLOBAL", report);

  return report;
}

async function loadDir(dir: string, source: Exclude<CapabilitySource, "BUILTIN" | "RUN">, report: DiscoveryReport): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!/\.ya?ml$/i.test(entry)) {
      continue;
    }
    const filePath = path.join(dir, entry);
    const parsed = await parseCapabilityFile(filePath);
    if (!parsed) {
      continue;
    }
    report.discovered.push(parsed);
    const result = registerCapability(parsed, source, filePath);
    if (result.registered) {
      report.registered.push(parsed);
    } else if (result.reason) {
      report.collisions.push({ id: parsed.id, reason: result.reason });
    }
  }
}

export async function parseCapabilityFile(filePath: string): Promise<RegisteredCapability | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
  const parsed = parseCapabilityYaml(raw);
  if (!parsed) {
    return undefined;
  }
  const validation = validateCapabilityDefinition(parsed);
  if (!validation.valid) {
    return undefined;
  }
  return {
    id: parsed.id,
    description: parsed.description,
    effect: parsed.effect,
    ...(parsed.input ? { input: parsed.input } : {}),
    ...(parsed.output ? { output: parsed.output } : {}),
    source: sourceFromPath(filePath),
    filePath,
  };
}

function parseCapabilityYaml(raw: string): CapabilityDefinition | undefined {
  try {
    const parsed = parseYaml(raw) as Partial<CapabilityDefinition>;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    return {
      id: String(parsed.id ?? ""),
      description: String(parsed.description ?? ""),
      effect: parsed.effect as CapabilityDefinition["effect"],
      ...(parsed.input ? { input: parsed.input as CapabilityDefinition["input"] } : {}),
      ...(parsed.output ? { output: parsed.output as CapabilityDefinition["output"] } : {}),
    };
  } catch {
    return undefined;
  }
}

function sourceFromPath(filePath: string): CapabilitySource {
  return filePath.includes(os.homedir()) ? "GLOBAL" : "PROJECT";
}

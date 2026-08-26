import fs from "node:fs/promises";
import path from "node:path";
import type { SkillContract, SkillExecutionStage } from "@factory/schemas";

export interface ParsedSkillFile {
  name: string;
  description: string;
  body: string;
  metadata: Record<string, unknown>;
  allowedTools?: string[];
  path: string;
}

const SKILL_FILE_NAMES = ["SKILL.md", "skill.md"];

export async function discoverSkillDirectories(root: string): Promise<string[]> {
  const results: string[] = [];
  await walk(root, 0);
  return results.sort();

  async function walk(current: string, depth: number): Promise<void> {
    if (depth > 4) {
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (isIgnoredDirectory(entry.name)) {
        continue;
      }
      const dirPath = path.join(current, entry.name);
      const hasSkillFile = await hasSkillMd(dirPath);
      if (hasSkillFile) {
        results.push(dirPath);
        continue;
      }
      await walk(dirPath, depth + 1);
    }
  }
}

export async function discoverSkillFiles(root: string): Promise<string[]> {
  const dirs = await discoverSkillDirectories(root);
  const files: string[] = [];
  for (const dir of dirs) {
    for (const name of SKILL_FILE_NAMES) {
      const filePath = path.join(dir, name);
      if (await exists(filePath)) {
        files.push(filePath);
        break;
      }
    }
  }
  return files;
}

export function parseSkillContent(raw: string, sourcePath?: string): ParsedSkillFile | undefined {
  return parseSkillFileFromContent(raw, sourcePath);
}

export async function parseSkillFile(filePath: string): Promise<ParsedSkillFile | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
  return parseSkillContent(raw, filePath);
}

function parseSkillFileFromContent(raw: string, sourcePath?: string): ParsedSkillFile | undefined {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) {
    return undefined;
  }

  const frontmatterText = match[1]!;
  const body = (match[2] ?? "").trim();
  const frontmatter = parseSimpleFrontmatter(frontmatterText);

  const name = String(frontmatter.name ?? "").trim();
  const description = String(frontmatter.description ?? "").trim();
  if (!name || !description) {
    return undefined;
  }

  return {
    name,
    description,
    body,
    metadata: isRecord(frontmatter.metadata) ? frontmatter.metadata : {},
    allowedTools: typeof frontmatter["allowed-tools"] === "string"
      ? frontmatter["allowed-tools"].split(/\s+/).filter(Boolean)
      : undefined,
    path: sourcePath ?? "",
  };
}

export function skillFileToContract(parsed: ParsedSkillFile): SkillContract {
  const metadata = parsed.metadata;
  const provides = readStringArray(metadata.provides);
  const taskTypes = readStringArray(metadata.taskTypes);
  const constitutionAreas = readNumberArray(metadata.constitutionAreas);
  const stages = readStringArray(metadata.stages).filter(isSkillStage);
  const languages = readStringArray(metadata.languages);
  const frameworks = readStringArray(metadata.frameworks);
  const filePatterns = readStringArray(metadata.filePatterns);

  return {
    id: parsed.name,
    version: typeof metadata.version === "string" ? metadata.version : "1.0.0",
    description: parsed.description,
    body: parsed.body,
    provides: provides.length > 0 ? { capabilities: provides } : undefined,
    taskTypes: taskTypes.length > 0 ? taskTypes : undefined,
    filePatterns: filePatterns.length > 0 ? filePatterns : undefined,
    applicability: {
      ...(stages.length > 0 ? { stages } : {}),
      ...(languages.length > 0 ? { languages } : {}),
      ...(frameworks.length > 0 ? { frameworks } : {}),
      ...(constitutionAreas.length > 0 ? { constitutionAreas } : {}),
    },
    permissions: parsed.allowedTools?.length
      ? { allowedTools: parsed.allowedTools }
      : undefined,
    evidence: readRecord(metadata.evidence) as SkillContract["evidence"],
    validation: readRecord(metadata.validation) as SkillContract["validation"],
    outputs: readRecord(metadata.outputs) as SkillContract["outputs"],
  };
}

export function skillContractToPrompt(skill: SkillContract, body: string): string {
  return [
    `# Skill: ${skill.id}@${skill.version}`,
    skill.description,
    skill.provides?.capabilities?.length ? `Capabilities: ${skill.provides.capabilities.join(", ")}` : undefined,
    "",
    body,
  ].filter(Boolean).join("\n\n");
}

function parseSimpleFrontmatter(text: string): Record<string, unknown> {
  const lines = text.split(/\r?\n/);
  const result: Record<string, unknown> = {};
  // Stack of { indent, obj } used to place keys into the right nested object.
  const stack: Array<{ indent: number; obj: Record<string, unknown> }> = [{ indent: -1, obj: result }];

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) {
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    // List item under the current map.
    if (trimmed.startsWith("-")) {
      const value = parseFrontmatterScalar(trimmed.slice(1).trim());
      const current = stack[stack.length - 1]!;
      const parent = stack[stack.length - 2];
      if (Object.keys(current.obj).length === 0 && parent) {
        const lastKey = Object.keys(parent.obj)[Object.keys(parent.obj).length - 1];
        if (lastKey !== undefined) {
          // Convert the placeholder nested obj into an array and keep it as the current container.
          const arr = [value];
          parent.obj[lastKey] = arr;
          current.obj.__factoryList = arr;
        }
      } else if (current.obj.__factoryList && Array.isArray(current.obj.__factoryList)) {
        current.obj.__factoryList.push(value);
      } else {
        const lastKey = Object.keys(current.obj)[Object.keys(current.obj).length - 1];
        if (lastKey !== undefined) {
          const existing = current.obj[lastKey];
          if (Array.isArray(existing)) {
            existing.push(value);
          } else {
            current.obj[lastKey] = [existing, value];
          }
        }
      }
      continue;
    }

    const colon = trimmed.indexOf(":");
    if (colon < 0) {
      continue;
    }
    const key = trimmed.slice(0, colon).trim();
    const rawValue = trimmed.slice(colon + 1).trim();

    // Pop stack entries deeper than this indent.
    while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1]!;

    if (rawValue === "" ) {
      const nested: Record<string, unknown> = {};
      parent.obj[key] = nested;
      stack.push({ indent, obj: nested });
    } else {
      parent.obj[key] = parseFrontmatterScalar(rawValue);
    }
  }

  return result;
}

function parseFrontmatterScalar(value: string): unknown {
  if (!value) {
    return "";
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  const stripped = value.replace(/^["']|["']$/g, "");
  if (stripped.startsWith("[") && stripped.endsWith("]")) {
    return stripped.slice(1, -1).split(",").map((part) => part.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  }
  return stripped;
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string" && value.trim()) {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function readNumberArray(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
  }
  if (typeof value === "string" && value.trim()) {
    return value.split(",").map((item) => Number(item.trim())).filter((item) => Number.isFinite(item));
  }
  return [];
}

function isSkillStage(value: string): value is SkillExecutionStage {
  return value === "discover" || value === "plan" || value === "build" || value === "verification" || value === "review" || value === "repair";
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function hasSkillMd(dir: string): Promise<boolean> {
  for (const name of SKILL_FILE_NAMES) {
    if (await exists(path.join(dir, name))) {
      return true;
    }
  }
  return false;
}

function isIgnoredDirectory(name: string): boolean {
  return [".git", "node_modules", ".factory", ".worktrees", "worktrees", "dist", "build", ".next", "coverage"].includes(name);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

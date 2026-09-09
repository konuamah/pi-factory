import fs from "node:fs/promises";
import path from "node:path";

export interface ToolActivityLine {
  at?: number;
  line: string;
}

export async function readRunToolActivity(runDir: string, limit = 20): Promise<string[]> {
  const files = await executionArtifactFiles(runDir);
  const lines: ToolActivityLine[] = [];
  for (const file of files) {
    const artifact = await readJson<Record<string, unknown>>(file);
    const events = Array.isArray(artifact?.events) ? artifact.events : [];
    for (const event of events) {
      const formatted = formatToolEvent(event);
      if (formatted) {
        lines.push(formatted);
      }
    }
  }
  return lines
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
    .slice(-limit)
    .map((item) => item.line);
}

async function executionArtifactFiles(runDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(runDir);
    return entries
      .filter((entry) => /^(discovery|planner|reviewer)-execution\.json$/.test(entry)
        || /^builder-execution-.+\.json$/.test(entry)
        || /^repair-execution-\d+\.json$/.test(entry)
        || /^verification-planner-execution\.json$/.test(entry))
      .sort()
      .map((entry) => path.join(runDir, entry));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function formatToolEvent(event: unknown): ToolActivityLine | undefined {
  const item = event && typeof event === "object" ? event as { type?: unknown; at?: unknown; data?: Record<string, unknown> } : undefined;
  if (!item || (item.type !== "tool.started" && item.type !== "tool.completed")) {
    return undefined;
  }
  const data = item.data ?? {};
  const toolName = normalizeToolName(typeof data.toolName === "string" ? data.toolName : "tool");
  const task = typeof data.taskId === "string" ? ` ${data.taskId}` : "";
  const preview = typeof data.preview === "string" && data.preview ? `: ${data.preview}` : "";
  const elapsed = typeof data.elapsedMs === "number" ? ` (${data.elapsedMs}ms)` : "";
  const suffix = item.type === "tool.completed" ? ` done${elapsed}` : "";
  return {
    at: typeof item.at === "number" ? item.at : undefined,
    line: `${toolName}${task}${preview}${suffix}`,
  };
}

function normalizeToolName(toolName: string): string {
  const lower = toolName.toLowerCase();
  if (lower === "bash" || lower.includes("shell") || lower.includes("terminal")) return "bash";
  if (lower === "grep" || lower.includes("grep") || lower.includes("search")) return "grep";
  if (lower === "find" || lower.includes("find")) return "find";
  if (lower === "ls" || lower.includes("list") || lower.includes("directory")) return "ls";
  if (lower === "write" || lower.includes("write") || lower.includes("create")) return "write";
  if (lower === "edit" || lower.includes("edit") || lower.includes("patch")) return "edit";
  if (lower === "read" || lower.includes("read") || lower.includes("open")) return "read";
  return toolName;
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

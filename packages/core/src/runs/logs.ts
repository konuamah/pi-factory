import fs from "node:fs/promises";
import path from "node:path";
import { readLatestFactoryRunStatus } from "./status.js";

export interface FactoryRunLogsResult {
  runDir?: string;
  statePath?: string;
  eventsPath?: string;
  planPath?: string;
  verificationPath?: string;
  state?: Record<string, unknown>;
  events: string[];
}

export async function readLatestFactoryRunLogs(
  runsDir: string,
  options?: { limit?: number },
): Promise<FactoryRunLogsResult> {
  const latest = await readLatestFactoryRunStatus(runsDir);
  if (!latest.runDir) {
    return { events: [] };
  }

  const statePath = latest.statePath;
  const eventsPath = path.join(latest.runDir, "events.jsonl");
  const planPath = path.join(latest.runDir, "plan.json");
  const verificationPath = path.join(latest.runDir, "verification.json");

  const [state, events] = await Promise.all([
    readJsonFile(statePath),
    readJsonlTail(eventsPath, options?.limit ?? 20),
  ]);

  return {
    runDir: latest.runDir,
    statePath,
    eventsPath,
    planPath: (await exists(planPath)) ? planPath : undefined,
    verificationPath: (await exists(verificationPath)) ? verificationPath : undefined,
    state,
    events,
  };
}

async function readJsonFile(filePath?: string): Promise<Record<string, unknown> | undefined> {
  if (!filePath) return undefined;
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function readJsonlTail(filePath: string, limit: number): Promise<string[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

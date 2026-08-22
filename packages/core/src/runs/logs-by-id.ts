import fs from "node:fs/promises";
import path from "node:path";

export interface FactoryRunLogsByIdResult {
  runDir?: string;
  statePath?: string;
  eventsPath?: string;
  planPath?: string;
  verificationPath?: string;
  summaryPath?: string;
  repairExecutionPaths: string[];
  state?: Record<string, unknown>;
  events: string[];
}

export async function readFactoryRunLogs(
  runsDir: string,
  runId: string,
  options?: { limit?: number },
): Promise<FactoryRunLogsByIdResult> {
  const runDir = path.join(runsDir, runId);
  if (!(await exists(runDir))) {
    return { events: [], repairExecutionPaths: [] };
  }

  const statePath = path.join(runDir, "state.json");
  const eventsPath = path.join(runDir, "events.jsonl");
  const planPath = path.join(runDir, "plan.json");
  const verificationPath = path.join(runDir, "verification.json");
  const summaryPath = path.join(runDir, "summary.json");

  const [state, events] = await Promise.all([
    readJsonFile(statePath),
    readJsonlTail(eventsPath, options?.limit ?? 20),
  ]);

  return {
    runDir,
    statePath: (await exists(statePath)) ? statePath : undefined,
    eventsPath: (await exists(eventsPath)) ? eventsPath : undefined,
    planPath: (await exists(planPath)) ? planPath : undefined,
    verificationPath: (await exists(verificationPath)) ? verificationPath : undefined,
    summaryPath: (await exists(summaryPath)) ? summaryPath : undefined,
    repairExecutionPaths: await listRepairExecutionPaths(runDir),
    state,
    events,
  };
}

async function listRepairExecutionPaths(runDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(runDir);
    return entries
      .filter((entry) => /^repair-execution-\d+\.json$/.test(entry))
      .sort()
      .map((entry) => path.join(runDir, entry));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | undefined> {
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
    return raw.split(/\r?\n/).filter(Boolean).slice(-limit);
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

import fs from "node:fs/promises";
import path from "node:path";

export interface FactoryRunInspection {
  runDir?: string;
  statePath?: string;
  summaryPath?: string;
  state?: {
    runId?: string;
    status?: string;
    phase?: string;
    createdAt?: string;
    updatedAt?: string;
  };
  summary?: {
    runId?: string;
    goal?: string;
    title?: string;
    status?: string;
    phase?: string;
    approved?: boolean;
    taskPaths?: string[];
    verificationStatus?: string;
  };
}

export async function inspectFactoryRun(runsDir: string, runId: string): Promise<FactoryRunInspection> {
  const runDir = path.join(runsDir, runId);
  if (!(await exists(runDir))) {
    return {};
  }

  const statePath = path.join(runDir, "state.json");
  const summaryPath = path.join(runDir, "summary.json");

  const [state, summary] = await Promise.all([
    readJsonFile<FactoryRunInspection["state"]>(statePath),
    readJsonFile<FactoryRunInspection["summary"]>(summaryPath),
  ]);

  return {
    runDir,
    statePath: (await exists(statePath)) ? statePath : undefined,
    summaryPath: (await exists(summaryPath)) ? summaryPath : undefined,
    state,
    summary,
  };
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
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

import fs from "node:fs/promises";
import path from "node:path";

export interface FactoryRunShowResult {
  runDir?: string;
  state?: Record<string, unknown>;
  summary?: Record<string, unknown>;
  plan?: Record<string, unknown>;
  verification?: Record<string, unknown>;
}

export async function showFactoryRun(runsDir: string, runId: string): Promise<FactoryRunShowResult> {
  const runDir = path.join(runsDir, runId);
  if (!(await exists(runDir))) {
    return {};
  }

  const [state, summary, plan, verification] = await Promise.all([
    readJsonFile(path.join(runDir, "state.json")),
    readJsonFile(path.join(runDir, "summary.json")),
    readJsonFile(path.join(runDir, "plan.json")),
    readJsonFile(path.join(runDir, "verification.json")),
  ]);

  return {
    runDir,
    state,
    summary,
    plan,
    verification,
  };
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

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

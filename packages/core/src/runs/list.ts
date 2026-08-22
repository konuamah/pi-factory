import fs from "node:fs/promises";
import path from "node:path";

export interface FactoryRunListItem {
  runId: string;
  runDir: string;
  status?: string;
  phase?: string;
  goal?: string;
  updatedAt?: string;
}

export async function listFactoryRuns(runsDir: string): Promise<FactoryRunListItem[]> {
  try {
    const entries = await fs.readdir(runsDir, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();

    const items = await Promise.all(
      directories.map(async (runId) => {
        const runDir = path.join(runsDir, runId);
        const state = await readJsonFile<Record<string, unknown>>(path.join(runDir, "state.json"));
        const summary = await readJsonFile<Record<string, unknown>>(path.join(runDir, "summary.json"));

        return {
          runId,
          runDir,
          status: asString(state?.status) ?? asString(summary?.status),
          phase: asString(state?.phase) ?? asString(summary?.phase),
          goal: asString(summary?.goal),
          updatedAt: asString(state?.updatedAt),
        } satisfies FactoryRunListItem;
      }),
    );

    return items;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
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

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

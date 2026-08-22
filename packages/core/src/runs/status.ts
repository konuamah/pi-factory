import fs from "node:fs/promises";
import path from "node:path";
import type { FactoryRunState } from "./store.js";

export interface LatestFactoryRunStatus {
  runDir?: string;
  statePath?: string;
  state?: FactoryRunState;
}

export async function readLatestFactoryRunStatus(runsDir: string): Promise<LatestFactoryRunStatus> {
  try {
    const entries = await fs.readdir(runsDir, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();

    for (const directory of directories) {
      const runDir = path.join(runsDir, directory);
      const statePath = path.join(runDir, "state.json");

      try {
        const raw = await fs.readFile(statePath, "utf8");
        return {
          runDir,
          statePath,
          state: JSON.parse(raw) as FactoryRunState,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }

    return {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

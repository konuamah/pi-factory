import fs from "node:fs/promises";
import path from "node:path";
import { readLatestFactoryRunStatus } from "./status.js";

export interface LatestFactoryRunSummary {
  runDir?: string;
  summaryPath?: string;
  summary?: {
    runId?: string;
    goal?: string;
    status?: string;
    phase?: string;
    approved?: boolean;
    planPath?: string;
    taskPaths?: string[];
    verificationPath?: string;
    verificationStatus?: string;
  };
}

export async function readLatestFactoryRunSummary(runsDir: string): Promise<LatestFactoryRunSummary> {
  const latest = await readLatestFactoryRunStatus(runsDir);
  if (!latest.runDir) {
    return {};
  }

  const summaryPath = path.join(latest.runDir, "summary.json");
  try {
    const raw = await fs.readFile(summaryPath, "utf8");
    return {
      runDir: latest.runDir,
      summaryPath,
      summary: JSON.parse(raw) as LatestFactoryRunSummary["summary"],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        runDir: latest.runDir,
      };
    }
    throw error;
  }
}

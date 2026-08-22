import fs from "node:fs/promises";
import path from "node:path";
import { readLatestFactoryRunStatus } from "./status.js";
import { appendFactoryRunEvent, updateFactoryRunState } from "./store.js";

export interface ResumeFactoryRunResult {
  resumed: boolean;
  reason: string;
  runDir?: string;
  statePath?: string;
  eventsPath?: string;
  state?: {
    runId?: string;
    status?: string;
    phase?: string;
    createdAt?: string;
    updatedAt?: string;
  };
}

export async function resumeLatestFactoryRun(runsDir: string): Promise<ResumeFactoryRunResult> {
  const latest = await readLatestFactoryRunStatus(runsDir);
  if (!latest.runDir || !latest.statePath || !latest.state) {
    return {
      resumed: false,
      reason: "No run state found",
    };
  }

  const eventsPath = path.join(latest.runDir, "events.jsonl");
  const currentStatus = latest.state.status ?? "UNKNOWN";
  const currentPhase = latest.state.phase ?? "unknown";

  if (currentStatus === "COMPLETED") {
    return {
      resumed: false,
      reason: "Latest run is already completed",
      runDir: latest.runDir,
      statePath: latest.statePath,
      eventsPath,
      state: latest.state,
    };
  }

  if (currentStatus === "RUNNING" || currentStatus === "PENDING") {
    const next = await updateFactoryRunState({
      statePath: latest.statePath,
      patch: {
        status: "RUNNING",
        phase: `${currentPhase}-resumed`,
      },
    });

    await appendFactoryRunEvent(eventsPath, {
      timestamp: new Date().toISOString(),
      type: "run.resumed",
      data: {
        previousStatus: currentStatus,
        previousPhase: currentPhase,
      },
    });

    return {
      resumed: true,
      reason: "Latest in-progress run marked resumed",
      runDir: latest.runDir,
      statePath: latest.statePath,
      eventsPath,
      state: next,
    };
  }

  if (currentStatus === "CANCELLED" || currentStatus === "FAILED") {
    const next = await updateFactoryRunState({
      statePath: latest.statePath,
      patch: {
        status: "RUNNING",
        phase: `resume-from-${currentPhase}`,
      },
    });

    await appendFactoryRunEvent(eventsPath, {
      timestamp: new Date().toISOString(),
      type: "run.resume_requested",
      data: {
        previousStatus: currentStatus,
        previousPhase: currentPhase,
      },
    });

    return {
      resumed: true,
      reason: "Latest interrupted run re-opened",
      runDir: latest.runDir,
      statePath: latest.statePath,
      eventsPath,
      state: next,
    };
  }

  const fallbackState = await readState(latest.statePath);
  return {
    resumed: false,
    reason: `Unhandled run status: ${currentStatus}`,
    runDir: latest.runDir,
    statePath: latest.statePath,
    eventsPath,
    state: fallbackState,
  };
}

async function readState(filePath: string) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as ResumeFactoryRunResult["state"];
}

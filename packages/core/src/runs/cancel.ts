import path from "node:path";
import { readLatestFactoryRunStatus } from "./status.js";
import { appendFactoryRunEvent, updateFactoryRunState } from "./store.js";

export interface CancelFactoryRunResult {
  cancelled: boolean;
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

export async function cancelLatestFactoryRun(runsDir: string): Promise<CancelFactoryRunResult> {
  const latest = await readLatestFactoryRunStatus(runsDir);
  if (!latest.runDir || !latest.statePath || !latest.state) {
    return {
      cancelled: false,
      reason: "No run state found",
    };
  }

  const eventsPath = path.join(latest.runDir, "events.jsonl");
  const currentStatus = latest.state.status ?? "UNKNOWN";
  const currentPhase = latest.state.phase ?? "unknown";

  if (currentStatus === "COMPLETED") {
    return {
      cancelled: false,
      reason: "Latest run is already completed",
      runDir: latest.runDir,
      statePath: latest.statePath,
      eventsPath,
      state: latest.state,
    };
  }

  if (currentStatus === "CANCELLED") {
    return {
      cancelled: false,
      reason: "Latest run is already cancelled",
      runDir: latest.runDir,
      statePath: latest.statePath,
      eventsPath,
      state: latest.state,
    };
  }

  const next = await updateFactoryRunState({
    statePath: latest.statePath,
    patch: {
      status: "CANCELLED",
      phase: `cancelled-from-${currentPhase}`,
    },
  });

  await appendFactoryRunEvent(eventsPath, {
    timestamp: new Date().toISOString(),
    type: "run.cancelled",
    data: {
      previousStatus: currentStatus,
      previousPhase: currentPhase,
    },
  });

  return {
    cancelled: true,
    reason: "Latest run marked cancelled",
    runDir: latest.runDir,
    statePath: latest.statePath,
    eventsPath,
    state: next,
  };
}

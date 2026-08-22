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
  planDecision?: "approve" | "reject" | "revise";
  planFeedback?: string;
  implementationStarted?: boolean;
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

  const [state, parsedEvents] = await Promise.all([
    readJsonFile(statePath),
    readJsonlTail(eventsPath, options?.limit ?? 20),
  ]);
  const planSummary = summarizePlanEvents(parsedEvents);

  return {
    runDir,
    statePath: (await exists(statePath)) ? statePath : undefined,
    eventsPath: (await exists(eventsPath)) ? eventsPath : undefined,
    planPath: (await exists(planPath)) ? planPath : undefined,
    verificationPath: (await exists(verificationPath)) ? verificationPath : undefined,
    summaryPath: (await exists(summaryPath)) ? summaryPath : undefined,
    repairExecutionPaths: await listRepairExecutionPaths(runDir),
    state,
    events: parsedEvents.map(formatEventLine),
    planDecision: planSummary.decision,
    planFeedback: planSummary.feedback,
    implementationStarted: planSummary.implementationStarted,
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

async function readJsonlTail(
  filePath: string,
  limit: number,
): Promise<Array<{ timestamp?: string; type?: string; data?: Record<string, unknown> }>> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as { timestamp?: string; type?: string; data?: Record<string, unknown> };
        } catch {
          return { type: "raw", data: { line } };
        }
      })
      .slice(-limit);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function summarizePlanEvents(events: Array<{ type?: string; data?: Record<string, unknown> }>): {
  decision?: "approve" | "reject" | "revise";
  feedback?: string;
  implementationStarted: boolean;
} {
  let decision: "approve" | "reject" | "revise" | undefined;
  let feedback: string | undefined;
  let implementationStarted = false;

  for (const event of events) {
    if (event.type === "plan.approved") {
      decision = "approve";
      feedback = undefined;
    } else if (event.type === "plan.rejected") {
      decision = "reject";
      feedback = typeof event.data?.feedback === "string" ? event.data.feedback : undefined;
    } else if (event.type === "plan.revision_requested") {
      decision = "revise";
      feedback = typeof event.data?.feedback === "string" ? event.data.feedback : undefined;
    } else if (event.type === "implementation.batch_started" || event.type === "task.started") {
      implementationStarted = true;
    }
  }

  return { decision, feedback, implementationStarted };
}

function formatEventLine(event: { timestamp?: string; type?: string; data?: Record<string, unknown> }): string {
  const timestamp = event.timestamp ?? "unknown-time";
  const type = event.type ?? "unknown-event";
  if (type === "plan.approved") {
    return `${timestamp} plan approved`;
  }
  if (type === "plan.rejected") {
    return `${timestamp} plan rejected${typeof event.data?.feedback === "string" ? ` | feedback: ${event.data.feedback}` : ""}`;
  }
  if (type === "plan.revision_requested") {
    return `${timestamp} plan revision requested${typeof event.data?.feedback === "string" ? ` | feedback: ${event.data.feedback}` : ""}`;
  }
  if (type === "run.resumed" || type === "run.resume_requested") {
    return `${timestamp} ${type}${typeof event.data?.suggestedPhase === "string" ? ` | suggested phase: ${event.data.suggestedPhase}` : ""}${typeof event.data?.nextStatus === "string" ? ` | next status: ${event.data.nextStatus}` : ""}`;
  }
  return `${timestamp} ${type}${event.data ? ` | ${JSON.stringify(event.data)}` : ""}`;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

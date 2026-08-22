import fs from "node:fs/promises";
import path from "node:path";

export interface FactoryRunShowResult {
  runDir?: string;
  state?: Record<string, unknown>;
  summary?: Record<string, unknown>;
  plan?: Record<string, unknown>;
  plannerExecution?: Record<string, unknown>;
  repairExecutions?: Record<string, unknown>[];
  reviewerExecution?: Record<string, unknown>;
  verification?: Record<string, unknown>;
  planDecision?: "approve" | "reject" | "revise";
  planFeedback?: string;
  implementationStarted?: boolean;
}

export async function showFactoryRun(runsDir: string, runId: string): Promise<FactoryRunShowResult> {
  const runDir = path.join(runsDir, runId);
  if (!(await exists(runDir))) {
    return {};
  }

  const [state, summary, plan, plannerExecution, verification, repairExecutions, reviewerExecution, events] = await Promise.all([
    readJsonFile(path.join(runDir, "state.json")),
    readJsonFile(path.join(runDir, "summary.json")),
    readJsonFile(path.join(runDir, "plan.json")),
    readJsonFile(path.join(runDir, "planner-execution.json")),
    readJsonFile(path.join(runDir, "verification.json")),
    readRepairExecutions(runDir),
    readJsonFile(path.join(runDir, "reviewer-execution.json")),
    readJsonlFile(path.join(runDir, "events.jsonl")),
  ]);
  const planSummary = summarizePlanEvents(events);

  return {
    runDir,
    state,
    summary,
    plan,
    plannerExecution,
    repairExecutions,
    reviewerExecution,
    verification,
    planDecision: planSummary.decision,
    planFeedback: planSummary.feedback,
    implementationStarted: planSummary.implementationStarted,
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

async function readJsonlFile(filePath: string): Promise<Array<{ type?: string; data?: Record<string, unknown> }>> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type?: string; data?: Record<string, unknown> });
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

async function readRepairExecutions(runDir: string): Promise<Record<string, unknown>[]> {
  try {
    const entries = await fs.readdir(runDir);
    const files = entries.filter((entry) => /^repair-execution-\d+\.json$/.test(entry)).sort();
    const results: Record<string, unknown>[] = [];
    for (const file of files) {
      const item = await readJsonFile(path.join(runDir, file));
      if (item) {
        results.push(item);
      }
    }
    return results;
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

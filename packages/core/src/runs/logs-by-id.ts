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
  guidance?: {
    plannerInstructionFiles: string[];
    builderInstructionFiles: string[];
    repairInstructionFiles: string[];
    reviewerInstructionFiles: string[];
    plannerHasConstitution: boolean;
    builderHasConstitution: boolean;
    repairHasConstitution: boolean;
    reviewerHasConstitution: boolean;
    plannerUsedConstitution: boolean;
    builderUsedConstitution: boolean;
    repairUsedConstitution: boolean;
    reviewerUsedConstitution: boolean;
    plannerGuidanceChars: number;
    builderGuidanceChars: number;
    repairGuidanceChars: number;
    reviewerGuidanceChars: number;
  };
  integrationFailure?: {
    reason?: string;
    conflictingFiles: string[];
    mergeInProgress: boolean;
  };
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
  const guidance = summarizeGuidanceEvents(parsedEvents);
  const integrationFailure = summarizeIntegrationFailureEvents(parsedEvents);

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
    guidance,
    integrationFailure,
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

function summarizeGuidanceEvents(events: Array<{ type?: string; data?: Record<string, unknown> }>): FactoryRunLogsByIdResult["guidance"] {
  for (const event of events) {
    if (event.type !== "guidance.context_selected") {
      continue;
    }
    return {
      plannerInstructionFiles: stringArray(event.data?.plannerInstructionFiles),
      builderInstructionFiles: stringArray(event.data?.builderInstructionFiles),
      repairInstructionFiles: stringArray(event.data?.repairInstructionFiles),
      reviewerInstructionFiles: stringArray(event.data?.reviewerInstructionFiles),
      plannerHasConstitution: Boolean(event.data?.plannerHasConstitution),
      builderHasConstitution: Boolean(event.data?.builderHasConstitution),
      repairHasConstitution: Boolean(event.data?.repairHasConstitution),
      reviewerHasConstitution: Boolean(event.data?.reviewerHasConstitution),
      plannerUsedConstitution: Boolean(event.data?.plannerUsedConstitution),
      builderUsedConstitution: Boolean(event.data?.builderUsedConstitution),
      repairUsedConstitution: Boolean(event.data?.repairUsedConstitution),
      reviewerUsedConstitution: Boolean(event.data?.reviewerUsedConstitution),
      plannerGuidanceChars: numberValue(event.data?.plannerGuidanceChars),
      builderGuidanceChars: numberValue(event.data?.builderGuidanceChars),
      repairGuidanceChars: numberValue(event.data?.repairGuidanceChars),
      reviewerGuidanceChars: numberValue(event.data?.reviewerGuidanceChars),
    };
  }
  return undefined;
}

function summarizeIntegrationFailureEvents(events: Array<{ type?: string; data?: Record<string, unknown> }>): FactoryRunLogsByIdResult["integrationFailure"] {
  for (const event of events) {
    if (event.type !== "integration.failed") {
      continue;
    }
    return {
      reason: typeof event.data?.reason === "string" ? event.data.reason : undefined,
      conflictingFiles: stringArray(event.data?.conflictingFiles),
      mergeInProgress: Boolean(event.data?.mergeInProgress),
    };
  }
  return undefined;
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
  if (type === "guidance.context_selected") {
    const planner = stringArray(event.data?.plannerInstructionFiles);
    const builder = stringArray(event.data?.builderInstructionFiles);
    return `${timestamp} guidance selected | planner files: ${planner.join(", ") || "none"} | builder files: ${builder.join(", ") || "none"} | planner constitution used: ${Boolean(event.data?.plannerUsedConstitution) ? "yes" : "no"} | planner guidance chars: ${numberValue(event.data?.plannerGuidanceChars)}`;
  }
  if (type === "integration.failed") {
    const files = stringArray(event.data?.conflictingFiles);
    return `${timestamp} integration failed | reason: ${typeof event.data?.reason === "string" ? event.data.reason : "unknown"}${files.length > 0 ? ` | conflicts: ${files.join(", ")}` : ""}`;
  }
  if (type === "integration.repair_requested") {
    const files = stringArray(event.data?.conflictingFiles);
    return `${timestamp} integration repair requested | branch: ${typeof event.data?.branch === "string" ? event.data.branch : "unknown"}${files.length > 0 ? ` | conflicts: ${files.join(", ")}` : ""}`;
  }
  if (type === "integration.repair_completed") {
    return `${timestamp} integration repair completed | branch: ${typeof event.data?.branch === "string" ? event.data.branch : "unknown"}`;
  }
  if (type === "integration.repair_failed") {
    const files = stringArray(event.data?.conflictingFiles);
    return `${timestamp} integration repair failed | branch: ${typeof event.data?.branch === "string" ? event.data.branch : "unknown"}${files.length > 0 ? ` | conflicts: ${files.join(", ")}` : ""}`;
  }
  return `${timestamp} ${type}${event.data ? ` | ${JSON.stringify(event.data)}` : ""}`;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

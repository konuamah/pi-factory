import fs from "node:fs/promises";
import path from "node:path";
import { summarizeGuidanceEvents, type GuidanceSummary } from "./guidance.js";
import { readRunToolActivity } from "./tool-activity.js";

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
  toolActivity?: string[];
  planDecision?: "approve" | "reject" | "revise";
  planFeedback?: string;
  implementationStarted?: boolean;
  guidance?: GuidanceSummary;
  integrationFailure?: {
    reason?: string;
    conflictingFiles: string[];
    mergeInProgress: boolean;
  };
  verificationContext?: {
    cwd?: string;
    cwdResolution?: string;
    selectionSource?: string;
    rationale?: string;
    failureKind?: string;
    failureReason?: string;
    evidence?: Record<string, unknown>;
  };
  decisions?: Array<{
    type: "request" | "resolution";
    requestId?: string;
    question?: string;
    optionId?: string;
    feedback?: string;
  }>;
  interviewDecisions?: Array<{
    stage: string;
    role: string;
    question: string;
    optionId: string;
    answer?: string;
    questions?: Array<{
      index: number;
      prompt: string;
      options?: Array<{ id: string; label: string; description?: string }>;
      recommendation?: string;
      selectedOptionId?: string;
      selectedOptionLabel?: string;
      customAnswer?: string;
      finalAnswer: string;
    }>;
    decisionRequestId: string;
  }>;
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
  const verificationContext = summarizeVerificationEvents(parsedEvents);

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
    toolActivity: await readRunToolActivity(runDir, 12),
    planDecision: planSummary.decision,
    planFeedback: planSummary.feedback,
    implementationStarted: planSummary.implementationStarted,
    guidance,
    integrationFailure,
    verificationContext,
    decisions: await readRunDecisions(runDir),
    interviewDecisions: await readInterviewDecisions(runDir),
  };
}

async function readInterviewDecisions(runDir: string): Promise<NonNullable<FactoryRunLogsByIdResult["interviewDecisions"]>> {
  try {
    const raw = await fs.readFile(path.join(runDir, "interview-decisions.json"), "utf8");
    return JSON.parse(raw) as NonNullable<FactoryRunLogsByIdResult["interviewDecisions"]>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    return [];
  }
}

async function readRunDecisions(runDir: string): Promise<NonNullable<FactoryRunLogsByIdResult["decisions"]>> {
  try {
    const raw = await fs.readFile(path.join(runDir, "decisions.jsonl"), "utf8");
    return raw.split(/\r?\n/).filter(Boolean).map((line) => {
      const entry = JSON.parse(line) as { type: "request" | "resolution"; request?: { id?: string; question?: string }; result?: { requestId?: string; optionId?: string; feedback?: string } };
      if (entry.type === "request") {
        return { type: "request" as const, requestId: entry.request?.id, question: entry.request?.question };
      }
      return {
        type: "resolution" as const,
        requestId: entry.result?.requestId,
        optionId: entry.result?.optionId,
        feedback: entry.result?.feedback,
      };
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    return [];
  }
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

function summarizeVerificationEvents(events: Array<{ type?: string; data?: Record<string, unknown> }>): FactoryRunLogsByIdResult["verificationContext"] {
  for (const event of events) {
    if (event.type !== "verification.commands_detected") {
      continue;
    }
    return {
      cwd: typeof event.data?.verificationCwd === "string" ? event.data.verificationCwd : undefined,
      cwdResolution: typeof event.data?.verificationCwdResolution === "string" ? event.data.verificationCwdResolution : undefined,
      selectionSource: typeof event.data?.verificationSelectionSource === "string" ? event.data.verificationSelectionSource : undefined,
      rationale: typeof event.data?.verificationRationale === "string" ? event.data.verificationRationale : undefined,
      failureKind: typeof event.data?.verificationFailureKind === "string" ? event.data.verificationFailureKind : undefined,
      failureReason: typeof event.data?.verificationFailureReason === "string" ? event.data.verificationFailureReason : undefined,
      evidence: recordValue(event.data?.verificationEvidence),
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
  if (type === "acceptance.accepted" || type === "acceptance.rejected" || type === "acceptance.revise_requested") {
    return `${timestamp} ${type.replace("acceptance.", "acceptance ")}${typeof event.data?.feedback === "string" ? ` | feedback: ${event.data.feedback}` : ""}`;
  }
  if (type === "landing.guard_blocked_recorded" || type === "landing.post_verification_failed_recorded") {
    return `${timestamp} ${type} | reason: ${typeof event.data?.reason === "string" ? event.data.reason : "unknown"}`;
  }
  if (type === "run.resumed" || type === "run.resume_requested") {
    return `${timestamp} ${type}${typeof event.data?.suggestedPhase === "string" ? ` | suggested phase: ${event.data.suggestedPhase}` : ""}${typeof event.data?.nextStatus === "string" ? ` | next status: ${event.data.nextStatus}` : ""}${typeof event.data?.policyReason === "string" ? ` | policy: ${event.data.policyReason}` : ""}`;
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
  if (type === "verification.commands_detected") {
    return `${timestamp} verification commands detected | cwd: ${typeof event.data?.verificationCwd === "string" ? event.data.verificationCwd : "unknown"} | resolution: ${typeof event.data?.verificationCwdResolution === "string" ? event.data.verificationCwdResolution : "unknown"} | source: ${typeof event.data?.verificationSelectionSource === "string" ? event.data.verificationSelectionSource : "unknown"}${typeof event.data?.verificationFailureKind === "string" ? ` | failure: ${event.data.verificationFailureKind}` : ""}`;
  }
  return `${timestamp} ${type}${event.data ? ` | ${JSON.stringify(event.data)}` : ""}`;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function detailArray(value: unknown): Array<{ path: string; score: number; reason: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is { path?: unknown; score?: unknown; reason?: unknown } => Boolean(item) && typeof item === "object")
    .map((item) => ({
      path: typeof item.path === "string" ? item.path : "unknown",
      score: numberValue(item.score),
      reason: typeof item.reason === "string" ? item.reason : "unknown",
    }));
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

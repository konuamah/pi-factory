import fs from "node:fs/promises";
import path from "node:path";
import { summarizeGuidanceEvents, type GuidanceSummary } from "./guidance.js";
import { readRunToolActivity } from "./tool-activity.js";

export interface FactoryRunShowResult {
  runDir?: string;
  state?: Record<string, unknown>;
  summary?: Record<string, unknown>;
  plan?: Record<string, unknown>;
  plannerExecution?: Record<string, unknown>;
  repairExecutions?: Record<string, unknown>[];
  reviewerExecution?: Record<string, unknown>;
  verification?: Record<string, unknown>;
  finalMerge?: Record<string, unknown>;
  finalMergeStatus?: string;
  finalMergeOutcome?: string;
  postLandingVerification?: {
    status?: string;
    commands?: string[];
    reason?: string;
    repairAttempted?: boolean;
  };
  pullRequest?: {
    status?: string;
    url?: string;
    sourceBranch?: string;
    targetBranch?: string;
    reason?: string;
  };
  planDecision?: "approve" | "reject" | "revise";
  planFeedback?: string;
  implementationStarted?: boolean;
  toolActivity?: string[];
  runFailure?: {
    reason?: string;
  };
  taskFailure?: {
    taskId?: string;
    stage?: string;
    title?: string;
    reason?: string;
    builderStatus?: string;
    builderExecutionPath?: string;
    workspacePath?: string;
    workspaceBranch?: string;
  };
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
    decisionRequestId: string;
  }>;
}

export async function showFactoryRun(runsDir: string, runId: string): Promise<FactoryRunShowResult> {
  const runDir = path.join(runsDir, runId);
  if (!(await exists(runDir))) {
    return {};
  }

  const [state, summary, plan, plannerExecution, verification, finalMerge, repairExecutions, reviewerExecution, events] = await Promise.all([
    readJsonFile(path.join(runDir, "state.json")),
    readJsonFile(path.join(runDir, "summary.json")),
    readJsonFile(path.join(runDir, "plan.json")),
    readJsonFile(path.join(runDir, "planner-execution.json")),
    readJsonFile(path.join(runDir, "verification.json")),
    readJsonFile(path.join(runDir, "final-merge.json")),
    readRepairExecutions(runDir),
    readJsonFile(path.join(runDir, "reviewer-execution.json")),
    readJsonlFile(path.join(runDir, "events.jsonl")),
  ]);
  const planSummary = summarizePlanEvents(events);
  const runFailure = summarizeRunFailureEvents(events);
  const guidance = summarizeGuidanceEvents(events);
  const taskFailure = summarizeTaskFailureEvents(events);
  const integrationFailure = summarizeIntegrationFailureEvents(events);
  const verificationContext = summarizeVerificationEvents(events);

  return {
    runDir,
    state,
    summary,
    plan,
    plannerExecution,
    repairExecutions,
    reviewerExecution,
    verification,
    finalMerge,
    finalMergeStatus: stringValue(finalMerge?.status),
    finalMergeOutcome: stringValue(finalMerge?.outcome),
    postLandingVerification: finalMerge?.postLandingVerification && typeof finalMerge.postLandingVerification === "object"
      ? {
          status: stringValue((finalMerge.postLandingVerification as Record<string, unknown>).status),
          commands: stringArray((finalMerge.postLandingVerification as Record<string, unknown>).commands),
          reason: stringValue((finalMerge.postLandingVerification as Record<string, unknown>).reason),
          repairAttempted: booleanValue((finalMerge.postLandingVerification as Record<string, unknown>).repairAttempted),
        }
      : undefined,
    pullRequest: finalMerge?.pullRequest && typeof finalMerge.pullRequest === "object"
      ? finalMerge.pullRequest as FactoryRunShowResult["pullRequest"]
      : undefined,
    planDecision: planSummary.decision,
    planFeedback: planSummary.feedback,
    implementationStarted: planSummary.implementationStarted,
    toolActivity: await readRunToolActivity(runDir),
    runFailure,
    taskFailure,
    guidance,
    integrationFailure,
    verificationContext,
    decisions: await readRunDecisions(runDir),
    interviewDecisions: await readInterviewDecisions(runDir),
  };
}

function summarizeRunFailureEvents(events: Array<{ type?: string; data?: Record<string, unknown> }>): FactoryRunShowResult["runFailure"] {
  for (const event of events.slice().reverse()) {
    if (event.type !== "run.failed") {
      continue;
    }
    return { reason: stringValue(event.data?.reason) };
  }
  return undefined;
}

function summarizeTaskFailureEvents(events: Array<{ type?: string; data?: Record<string, unknown> }>): FactoryRunShowResult["taskFailure"] {
  for (const event of events.slice().reverse()) {
    if (event.type !== "task.failed") {
      continue;
    }
    return {
      taskId: stringValue(event.data?.taskId),
      stage: stringValue(event.data?.stage),
      title: stringValue(event.data?.title),
      reason: stringValue(event.data?.reason),
      builderStatus: stringValue(event.data?.builderStatus),
      builderExecutionPath: stringValue(event.data?.builderExecutionPath),
      workspacePath: stringValue(event.data?.workspacePath),
      workspaceBranch: stringValue(event.data?.workspaceBranch),
    };
  }
  return undefined;
}

async function readInterviewDecisions(runDir: string): Promise<NonNullable<FactoryRunShowResult["interviewDecisions"]>> {
  try {
    const raw = await fs.readFile(path.join(runDir, "interview-decisions.json"), "utf8");
    return JSON.parse(raw) as NonNullable<FactoryRunShowResult["interviewDecisions"]>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    return [];
  }
}

async function readRunDecisions(runDir: string): Promise<NonNullable<FactoryRunShowResult["decisions"]>> {
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

function summarizeIntegrationFailureEvents(events: Array<{ type?: string; data?: Record<string, unknown> }>): FactoryRunShowResult["integrationFailure"] {
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

function summarizeVerificationEvents(events: Array<{ type?: string; data?: Record<string, unknown> }>): FactoryRunShowResult["verificationContext"] {
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

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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

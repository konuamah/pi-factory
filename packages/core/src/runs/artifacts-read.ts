// Read-only typed view of everything one Factory run directory records, used by
// the benchmark scorer (docs/factory/bombsite-benchmark-plan.md). One owner for
// "what a run proves": files that are absent are reported through `missing`, and
// files that exist but cannot be parsed are reported through `errors` — never
// collapsed into "absent", because a silent fallback here would fake a signal.

import fs from "node:fs/promises";
import path from "node:path";
import type {
  PrototypeCompletedTaskArtifact,
  PrototypeFinalMergeArtifact,
  PrototypeLandingAttemptArtifact,
  PrototypeLandingDiagnosisArtifact,
  PrototypeLandingPlanArtifact,
  PrototypePlanArtifact,
  PrototypeSummaryArtifact,
} from "../runtime/artifacts.js";
import type { InterviewDecisionRecord } from "../runtime/controller.js";
import type { ModelLedgerEntry } from "./model-ledger.js";

export interface RunEvent {
  timestamp: string;
  type: string;
  data?: Record<string, unknown>;
}

export interface RunDecisionEntry {
  type: "request" | "resolution";
  requestId?: string;
  question?: string;
  title?: string;
  source?: string;
  reason?: string;
  optionId?: string;
  feedback?: string;
}

export interface RunExecutionArtifact {
  executionId?: string;
  status?: string;
  outputText?: string;
  errorMessage?: string;
  events?: Array<{ type: string; data?: Record<string, unknown> }>;
}

export interface RunArtifacts {
  runDir: string;
  runId: string;
  state?: Record<string, unknown>;
  summary?: PrototypeSummaryArtifact;
  plan?: PrototypePlanArtifact;
  verification?: Record<string, unknown>;
  discoveryExecution?: RunExecutionArtifact;
  plannerExecution?: RunExecutionArtifact;
  reviewerExecution?: RunExecutionArtifact;
  repairExecutions: RunExecutionArtifact[];
  interviewExecutions: Array<{ stage: string; artifact: RunExecutionArtifact }>;
  interviewDecisions: InterviewDecisionRecord[];
  decisions: RunDecisionEntry[];
  events: RunEvent[];
  modelLedger: ModelLedgerEntry[];
  completedTasks: PrototypeCompletedTaskArtifact[];
  landingPlan?: PrototypeLandingPlanArtifact;
  landingDiagnoses: PrototypeLandingDiagnosisArtifact[];
  landingAttempts: PrototypeLandingAttemptArtifact[];
  finalMerge?: PrototypeFinalMergeArtifact;
  missing: string[];
  errors: Array<{ file: string; error: string }>;
}

const JSON_ARTIFACTS = {
  state: "state.json",
  summary: "summary.json",
  plan: "plan.json",
  verification: "verification.json",
  discoveryExecution: "discovery-execution.json",
  plannerExecution: "planner-execution.json",
  reviewerExecution: "reviewer-execution.json",
  landingPlan: "landing-plan.json",
  finalMerge: "final-merge.json",
  interviewDecisions: "interview-decisions.json",
  completedTasks: "completed-tasks.json",
} as const;

const JSONL_ARTIFACTS = {
  events: "events.jsonl",
  decisions: "decisions.jsonl",
  landingAttempts: "landing-attempts.jsonl",
  modelLedger: "model-ledger.jsonl",
} as const;

export async function readRunArtifacts(runDir: string): Promise<RunArtifacts> {
  const missing: string[] = [];
  const errors: Array<{ file: string; error: string }> = [];
  const values: Record<string, unknown> = {};

  const record = (key: string, read: FileRead<unknown>) => {
    if (read.error) {
      errors.push({ file: read.file, error: read.error });
    } else if (read.value === undefined) {
      missing.push(key);
    }
    values[key] = read.value;
  };

  for (const [key, file] of Object.entries(JSON_ARTIFACTS)) {
    record(key, await readJson(runDir, file));
  }
  for (const [key, file] of Object.entries(JSONL_ARTIFACTS)) {
    record(key, await readJsonl(runDir, file));
  }

  const [repairExecutions, landingDiagnoses, interviewFiles] = await Promise.all([
    readMatching<RunExecutionArtifact>(runDir, /^repair-execution-\d+\.json$/),
    readMatching<PrototypeLandingDiagnosisArtifact>(runDir, /^landing-diagnosis-\d+\.json$/),
    readMatching<RunExecutionArtifact>(runDir, /-interview-execution\.json$/),
  ]);

  return {
    runDir,
    runId: path.basename(path.resolve(runDir)),
    state: values.state as RunArtifacts["state"],
    summary: values.summary as RunArtifacts["summary"],
    plan: values.plan as RunArtifacts["plan"],
    verification: values.verification as RunArtifacts["verification"],
    discoveryExecution: values.discoveryExecution as RunArtifacts["discoveryExecution"],
    plannerExecution: values.plannerExecution as RunArtifacts["plannerExecution"],
    reviewerExecution: values.reviewerExecution as RunArtifacts["reviewerExecution"],
    repairExecutions,
    interviewExecutions: interviewFiles.map((artifact) => ({
      stage: artifact.file.replace(/-interview-execution\.json$/, ""),
      artifact,
    })),
    interviewDecisions: (values.interviewDecisions as InterviewDecisionRecord[] | undefined) ?? [],
    decisions: (values.decisions as RunDecisionEntry[] | undefined) ?? [],
    events: (values.events as RunEvent[] | undefined) ?? [],
    modelLedger: (values.modelLedger as ModelLedgerEntry[] | undefined) ?? [],
    completedTasks: (values.completedTasks as PrototypeCompletedTaskArtifact[] | undefined) ?? [],
    landingPlan: values.landingPlan as RunArtifacts["landingPlan"],
    landingDiagnoses,
    landingAttempts: (values.landingAttempts as PrototypeLandingAttemptArtifact[] | undefined) ?? [],
    finalMerge: values.finalMerge as RunArtifacts["finalMerge"],
    missing,
    errors,
  };
}

interface FileRead<T> {
  file: string;
  value?: T;
  error?: string;
}

async function readJson<T>(runDir: string, file: string): Promise<FileRead<T | undefined>> {
  const raw = await readText(runDir, file);
  if (raw.error || raw.text === undefined) {
    return { file, error: raw.error };
  }
  try {
    return { file, value: JSON.parse(raw.text) as T };
  } catch (error) {
    return { file, error: asError(error) };
  }
}

async function readJsonl<T>(runDir: string, file: string): Promise<FileRead<T[]>> {
  const raw = await readText(runDir, file);
  if (raw.error) {
    return { file, value: [], error: raw.error };
  }
  if (raw.text === undefined) {
    return { file };
  }
  try {
    return { file, value: raw.text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as T) };
  } catch (error) {
    return { file, error: asError(error) };
  }
}

async function readMatching<T>(runDir: string, pattern: RegExp): Promise<Array<T & { file: string }>> {
  let entries: string[];
  try {
    entries = (await fs.readdir(runDir)).filter((entry) => pattern.test(entry)).sort();
  } catch {
    return [];
  }
  const results: Array<T & { file: string }> = [];
  for (const entry of entries) {
    const read = await readJson<T>(runDir, entry);
    if (read.value) {
      results.push({ ...read.value, file: entry });
    }
  }
  return results;
}

async function readText(runDir: string, file: string): Promise<{ text?: string; error?: string }> {
  try {
    return { text: await fs.readFile(path.join(runDir, file), "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    return { error: asError(error) };
  }
}

function asError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

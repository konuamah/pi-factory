// Benchmark types for scoring one Factory run (docs/factory/bombsite-benchmark-plan.md).
// Weights live in the task spec, never hard-coded at the call site, so the
// scoring model can be re-cut without touching code.

import type { RunArtifacts } from "../runs/artifacts-read.js";

export type PillarName =
  | "interviewQuality"
  | "handoffQuality"
  | "executionQuality"
  | "mergeQuality"
  | "adaptationQuality"
  | "scopeQuality"
  | "timeEfficiency";

export const DEFAULT_WEIGHTS: Record<PillarName, number> = {
  interviewQuality: 18,
  handoffQuality: 20,
  executionQuality: 15,
  mergeQuality: 12,
  adaptationQuality: 12,
  scopeQuality: 8,
  timeEfficiency: 10,
};

export interface BenchmarkTaskSpec {
  id: string;
  goal: string;
  /** Workflow for this task declares an interview stage. */
  interviewRequired: boolean;
  /** Round-level, not question-level: one DecisionRequest can hold many questions. */
  expectedInterviewRounds?: { min?: number; max?: number };
  /** Interview answer topics that should reappear in plan/execution. */
  expectedTopics?: string[];
  expectedPlanScope?: string[];
  expectedFiles?: string[];
  /** Files that must stay untouched — interview-established non-goals. */
  forbiddenFiles?: string[];
  expectedVerificationStatus?: "passed" | "failed" | "incomplete";
  /** Nested package root the verification planner should choose. */
  expectedVerificationCwd?: string;
  /** Command strings that are known-stale for this fixture. */
  staleCommands?: string[];
  /** Commands a verifier may run; anything else counts as invented. */
  allowedCommands?: string[];
  maxRepairAttempts?: number;
  /** Wall-clock budget for agent time in ms. */
  agentTimeBudgetMs?: number;
  weights?: Partial<Record<PillarName, number>>;
}

export interface PillarResult {
  /** null means "not measurable from this run" — excluded, never coerced to 0. */
  score: number | null;
  components: Record<string, number | null>;
  warnings: string[];
}

export interface RunTiming {
  totalMs: number;
  humanWaitMs: number;
  agentMs: number;
  phases: Record<string, number>;
  handoffs: Record<string, number | null>;
}

export interface BenchmarkReport {
  schemaVersion: 1;
  runId: string;
  taskId: string;
  trialKind: TrialKind;
  scores: { overall: number | null } & Record<PillarName, number | null>;
  weights: Record<PillarName, number>;
  pillars: Record<PillarName, PillarResult>;
  timing: RunTiming;
  signals: Record<string, unknown>;
  warnings: string[];
}

export type TrialKind = "oracle" | "agent";

export interface BenchmarkTrial {
  trialKind: TrialKind;
  report?: BenchmarkReport;
  taskSuccess?: number;
}

export type Artifacts = RunArtifacts;

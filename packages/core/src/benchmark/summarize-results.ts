// summarizeBenchmarkResults: repeated agent trials -> distribution.
// Oracle trials validate the task and verifier; they are excluded here entirely.
// Any ambiguity throws instead of coercing missing data into a number, because
// a silently-partial distribution looks exactly like a valid one.

import type { BenchmarkReport, BenchmarkTrial, PillarName } from "./types.js";

export interface BenchmarkSummary {
  taskIds: string[];
  attempts: number;
  successRate: number;
  meanScore: number;
  medianScore: number;
  bestScore: number;
  worstScore: number;
  meanRuntimeMs: number;
  meanAgentRuntimeMs: number;
  meanInterviewRounds: number;
  pillars: Partial<Record<PillarName, { mean: number; samples: number }>>;
  excludedOracleTrials: number;
}

export function summarizeBenchmarkResults(trials: BenchmarkTrial[]): BenchmarkSummary {
  if (trials.length === 0) {
    throw new Error("summarizeBenchmarkResults: no trials provided");
  }
  const oracle = trials.filter((trial) => trial.trialKind === "oracle");
  const unknown = trials.filter((trial) => trial.trialKind !== "oracle" && trial.trialKind !== "agent");
  if (unknown.length > 0) {
    throw new Error(
      `summarizeBenchmarkResults: ${unknown.length} trial(s) have unknown trialKind "${String(unknown[0].trialKind)}"; trialKind must be derived from the Harbor job agent name.`,
    );
  }
  const agents = trials.filter((trial) => trial.trialKind === "agent");
  if (agents.length === 0) {
    throw new Error(`summarizeBenchmarkResults: only ${oracle.length} oracle trial(s) present; benchmark statistics need at least one agent trial.`);
  }
  for (const trial of agents) {
    if (!trial.report) {
      throw new Error("summarizeBenchmarkResults: agent trial is missing factory score (report)");
    }
    if (trial.report.trialKind !== "agent") {
      throw new Error(`summarizeBenchmarkResults: agent trial report is labelled "${trial.report.trialKind}"`);
    }
    if (typeof trial.taskSuccess !== "number") {
      throw new Error("summarizeBenchmarkResults: agent trial is missing taskSuccess");
    }
  }

  const reports = agents.map((trial) => trial.report as BenchmarkReport);
  const taskIds = [...new Set(reports.map((report) => report.taskId))];
  const overalls = reports.map((report) => report.scores.overall);
  // An overall of null means no pillar was measurable; that is a data gap, not a 0.
  if (overalls.some((value) => value === null)) {
    throw new Error(
      `summarizeBenchmarkResults: ${overalls.filter((value) => value === null).length} agent trial(s) scored no measurable pillar; investigate before summarizing.`,
    );
  }
  const scored = overalls as number[];

  const pillars: BenchmarkSummary["pillars"] = {};
  for (const name of Object.keys(reports[0].scores)) {
    if (name === "overall") {
      continue;
    }
    const values = reports.map((report) => report.scores[name as PillarName]).filter((value): value is number => typeof value === "number");
    if (values.length) {
      pillars[name as PillarName] = { mean: mean(values), samples: values.length };
    }
  }

  return {
    taskIds,
    attempts: agents.length,
    successRate: mean(agents.map((trial) => trial.taskSuccess as number)),
    meanScore: mean(scored),
    medianScore: median(scored),
    bestScore: Math.max(...scored),
    worstScore: Math.min(...scored),
    meanRuntimeMs: mean(reports.map((report) => report.timing.totalMs)),
    meanAgentRuntimeMs: mean(reports.map((report) => report.timing.agentMs)),
    meanInterviewRounds: mean(reports.map((report) => Number(report.pillars.interviewQuality.components.roundCount ?? 0))),
    pillars,
    excludedOracleTrials: oracle.length,
  };
}

const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Performance report for one benchmark trial: where the wall clock went.
//
// Hierarchy (TOTAL is Harbor wall clock):
//   TOTAL
//   ├── HARNESS          environment_setup + agent_setup
//   ├── AGENT EXECUTION  Harbor agent_execution
//   │   ├── MODEL        assistant message_start -> message_end windows (LLM)
//   │   ├── TOOLS        union of tool_execution_start -> end intervals (parallel!)
//   │   ├── FACTORY VERIFY  Factory phase verification duration
//   │   └── UNATTRIBUTED  remainder (incl. unmeasured tool wall-time)
//   └── HARBOR VERIFIER  scoring duration
//
// MODEL measures ONLY assistant (model) messages — tool-result messages have
// their own message lifecycle and would inflate the model bucket.
// TOOLS uses the UNION of tool intervals, not the sum: Pi runs tools in
// parallel by default, so summed durations double-count overlapping work.
//
// Deterministic given its inputs; missing artifacts -> null + warning, never guessed.

import type { RunEvent, RunExecutionArtifact } from "../runs/artifacts-read.js";

export interface HarborPhaseTiming {
  startedAt: number;
  finishedAt: number;
}

export interface HarborTrialTiming {
  startedAt: number;
  finishedAt: number;
  environmentSetup?: HarborPhaseTiming;
  agentSetup?: HarborPhaseTiming;
  agentExecution?: HarborPhaseTiming;
  verifier?: HarborPhaseTiming;
}

export interface PerformanceReport {
  totalMs: number;
  // Harbor setup
  harnessMs: number;
  // Whole Harbor agent_execution phase
  agentMs: number;
  // Inside agent execution
  modelMs: number | null;
  toolsMs: number | null;
  factoryVerificationMs: number | null;
  unattributedAgentMs: number | null;
  // After agent execution
  harborVerifierMs: number | null;
  // Convenience combined metric
  evalMs: number | null;
  // Counts diagnose WHY time is high (slow calls vs churn)
  modelCallCount: number | null;
  toolCallCount: number | null;
  // Parallel-aware tool workload (sum of individual durations) vs wall clock
  toolExecutionSumMs: number | null;
  // Detect broken accounting
  unaccountedMs: number | null;
  // Fractions of total
  harnessFraction: number;
  modelFraction: number | null;
  toolsFraction: number | null;
  warnings: string[];
}

export function computePerformanceReport(
  harbor: HarborTrialTiming,
  events: RunEvent[],
  executionArtifacts: RunExecutionArtifact[],
): PerformanceReport {
  const warnings: string[] = [];
  const totalMs = Math.max(0, harbor.finishedAt - harbor.startedAt);

  const harnessMs = duration(harbor.environmentSetup) + duration(harbor.agentSetup);
  const agentMs = duration(harbor.agentExecution);
  const harborVerifierMs = duration(harbor.verifier);

  // MODEL + TOOLS from the executor event stream across all role artifacts.
  const allEvents = executionArtifacts.flatMap((artifact) => artifact.events ?? []);
  const { modelMs, toolsMs, toolExecutionSumMs, modelCallCount, toolCallCount } = sumWindows(allEvents);
  if (modelMs === null) warnings.push("no timestamped assistant message_start/end events; model time not measurable");
  if (toolsMs === null) warnings.push("no timestamped tool_execution_start/end events; tool time not measurable");

  // Factory verification is a phase INSIDE agent execution (the run's own
  // verify step), distinct from the Harbor verifier that scores afterward.
  let factoryVerificationMs: number | null = null;
  const verificationStart = events.find((event) => event.type === "phase.verification")?.timestamp;
  const verified = events.find((event) => event.type === "phase.verified")?.timestamp;
  if (verificationStart && verified) {
    const diff = Date.parse(verified) - Date.parse(verificationStart);
    if (Number.isFinite(diff) && diff >= 0) factoryVerificationMs = diff;
  }
  if (factoryVerificationMs === null) {
    warnings.push("verification phase timestamps missing; factory verification time not measurable");
  }

  const unattributedAgentMs = agentMs !== null && modelMs !== null && toolsMs !== null && factoryVerificationMs !== null
    ? Math.max(0, agentMs - modelMs - toolsMs - factoryVerificationMs)
    : null;
  const rawUnattributed = agentMs !== null && modelMs !== null && toolsMs !== null && factoryVerificationMs !== null
    ? agentMs - modelMs - toolsMs - factoryVerificationMs
    : null;
  if (rawUnattributed !== null && rawUnattributed < 0) {
    warnings.push("performance intervals overlap; wall-clock buckets cannot be reconciled (unattributedAgentMs < 0)");
  }

  const evalMs = factoryVerificationMs !== null && harborVerifierMs !== null
    ? factoryVerificationMs + harborVerifierMs
    : null;

  const unaccountedMs = agentMs !== null && modelMs !== null && toolsMs !== null && factoryVerificationMs !== null
    ? agentMs - modelMs - toolsMs - factoryVerificationMs
    : null;

  const harnessFraction = totalMs > 0 ? harnessMs / totalMs : 0;

  return {
    totalMs,
    harnessMs,
    agentMs,
    modelMs,
    toolsMs,
    factoryVerificationMs,
    unattributedAgentMs,
    harborVerifierMs,
    evalMs,
    modelCallCount,
    toolCallCount,
    toolExecutionSumMs,
    unaccountedMs,
    harnessFraction,
    modelFraction: totalMs > 0 && modelMs !== null ? modelMs / totalMs : null,
    toolsFraction: totalMs > 0 && toolsMs !== null ? toolsMs / totalMs : null,
    warnings,
  };
}

function duration(phase: HarborPhaseTiming | undefined): number {
  if (!phase) return 0;
  return Math.max(0, phase.finishedAt - phase.startedAt);
}

interface StampedEvent {
  type: string;
  at?: number;
  data?: { message?: { role?: string } };
}

function sumWindows(events: StampedEvent[]): {
  modelMs: number | null;
  toolsMs: number | null;
  toolExecutionSumMs: number | null;
  modelCallCount: number | null;
  toolCallCount: number | null;
} {
  const stamped = events.filter((event) => typeof event.at === "number");
  if (stamped.length === 0) {
    return { modelMs: null, toolsMs: null, toolExecutionSumMs: null, modelCallCount: null, toolCallCount: null };
  }

  // MODEL: assistant message windows. Tool-result messages are excluded so the
  // model bucket measures only actual model generation.
  const modelWindows: Array<[number, number]> = [];
  let modelStart: number | undefined;
  for (const event of stamped) {
    if (event.type === "message_start" && event.data?.message?.role === "assistant") {
      modelStart = event.at;
    } else if (event.type === "message_end" && event.data?.message?.role === "assistant" && modelStart !== undefined) {
      modelWindows.push([modelStart, event.at as number]);
      modelStart = undefined;
    }
  }

  // TOOLS: union of tool intervals (parallel execution -> overlap is NOT summed).
  const toolWindows: Array<[number, number]> = [];
  const toolStarts = new Map<string, number>();
  for (const event of stamped) {
    if (event.type === "tool_execution_start") {
      const id = String((event.data as { toolCallId?: string } | undefined)?.toolCallId ?? toolStarts.size);
      toolStarts.set(id, event.at as number);
    } else if (event.type === "tool_execution_end") {
      const id = String((event.data as { toolCallId?: string } | undefined)?.toolCallId ?? "");
      const start = id !== "" ? toolStarts.get(id) : undefined;
      if (start !== undefined) {
        toolWindows.push([start, event.at as number]);
        toolStarts.delete(id);
      } else {
        // No matching start (maybe started before collection); fall back to a
        // running window from the earliest tool start, to avoid losing the end.
        const earliest = [...toolStarts.values()].sort((a, b) => a - b)[0];
        if (earliest !== undefined) toolWindows.push([earliest, event.at as number]);
      }
    }
  }

  const modelMs = modelWindows.length > 0 ? sumIntervals(modelWindows) : null;
  const toolsMs = toolWindows.length > 0 ? unionDuration(toolWindows) : null;
  const toolExecutionSumMs = toolWindows.length > 0 ? sumIntervals(toolWindows) : null;

  return {
    modelMs,
    toolsMs,
    toolExecutionSumMs,
    modelCallCount: modelWindows.length > 0 ? modelWindows.length : null,
    toolCallCount: toolWindows.length > 0 ? toolWindows.length : null,
  };
}

function sumIntervals(windows: Array<[number, number]>): number {
  return windows.reduce((sum, [start, end]) => sum + Math.max(0, end - start), 0);
}

function unionDuration(windows: Array<[number, number]>): number {
  const sorted = [...windows].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let currentStart = sorted[0]?.[0];
  let currentEnd = sorted[0]?.[1];
  for (const [start, end] of sorted.slice(1)) {
    if (start <= (currentEnd ?? start)) {
      currentEnd = Math.max(currentEnd ?? start, end);
    } else {
      if (currentStart !== undefined && currentEnd !== undefined) {
        total += Math.max(0, currentEnd - currentStart);
      }
      currentStart = start;
      currentEnd = end;
    }
  }
  if (currentStart !== undefined && currentEnd !== undefined) {
    total += Math.max(0, currentEnd - currentStart);
  }
  return total;
}

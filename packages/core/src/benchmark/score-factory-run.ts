// scoreFactoryRun: one completed run directory + task spec -> benchmark report.
// Pure read, deterministic, never writes or mutates git. Pillars that the run
// cannot prove come back as null and are excluded from the weighted overall
// (weights renormalize), so missing evidence never reads as a zero or a pass.

import { readRunArtifacts, type RunArtifacts } from "../runs/artifacts-read.js";
import { computeRunTiming } from "./timing.js";
import {
  scoreAdaptation,
  scoreExecution,
  scoreHandoff,
  scoreInterview,
  scoreMerge,
  scoreScope,
  scoreTime,
} from "./scoring.js";
import { DEFAULT_WEIGHTS, type BenchmarkReport, type BenchmarkTaskSpec, type PillarName, type PillarResult, type TrialKind } from "./types.js";

export async function scoreFactoryRun(
  runDir: string,
  spec: BenchmarkTaskSpec,
  options: { trialKind?: TrialKind } = {},
): Promise<BenchmarkReport> {
  return scoreRunArtifacts(await readRunArtifacts(runDir), spec, options);
}

export function scoreRunArtifacts(
  artifacts: RunArtifacts,
  spec: BenchmarkTaskSpec,
  options: { trialKind?: TrialKind } = {},
): BenchmarkReport {
  const trialKind = options.trialKind ?? "agent";
  const timing = computeRunTiming(artifacts.events);
  const pillars: Record<PillarName, PillarResult> = {
    interviewQuality: scoreInterview(artifacts, spec),
    handoffQuality: scoreHandoff(artifacts, spec),
    executionQuality: scoreExecution(artifacts, spec),
    mergeQuality: scoreMerge(artifacts, spec),
    adaptationQuality: scoreAdaptation(artifacts, spec),
    scopeQuality: scoreScope(artifacts, spec),
    timeEfficiency: scoreTime(timing, spec),
  };

  const weights = { ...DEFAULT_WEIGHTS, ...spec.weights };
  const totalWeight = (Object.keys(pillars) as PillarName[]).reduce(
    (sum, name) => sum + (pillars[name].score === null ? 0 : weights[name]),
    0,
  );
  const overall = totalWeight === 0
    ? null
    : (Object.keys(pillars) as PillarName[]).reduce(
        (sum, name) => sum + (pillars[name].score ?? 0) * weights[name],
        0,
      ) / totalWeight;

  const scores = {
    overall: round(overall),
    ...Object.fromEntries(
      (Object.keys(pillars) as PillarName[]).map((name) => [name, round(pillars[name].score)]),
    ),
  } as BenchmarkReport["scores"];

  const warnings = [
    ...artifacts.missing.map((key) => `artifact missing: ${key}`),
    ...artifacts.errors.map((error) => `artifact unreadable: ${error.file} (${error.error})`),
    ...Object.entries(pillars).flatMap(([name, result]) => result.warnings.map((warning) => `${name}: ${warning}`)),
  ];
  if (Object.keys(weights).length !== Object.keys(pillars).length) {
    warnings.push("task spec weights do not match the known pillar set; unknown weight keys were ignored");
  }
  if (trialKind === "oracle") {
    warnings.push("oracle trial: pillar scores are diagnostics only and must not enter benchmark statistics");
  }

  return {
    schemaVersion: 1,
    runId: artifacts.runId,
    taskId: spec.id,
    trialKind,
    scores,
    weights,
    pillars,
    timing,
    signals: collectSignals(artifacts, spec),
    warnings,
  };
}

function collectSignals(artifacts: RunArtifacts, spec: BenchmarkTaskSpec): Record<string, unknown> {
  const roles = [...new Set(artifacts.modelLedger.map((entry) => entry.role))];
  const routing: Record<string, string[]> = {};
  for (const entry of artifacts.modelLedger) {
    routing[entry.role] = routing[entry.role] ?? [];
    if (!routing[entry.role].includes(entry.resolvedModel)) {
      routing[entry.role].push(entry.resolvedModel);
    }
  }
  const unstable = Object.entries(routing).filter(([, models]) => models.length > 1).map(([role]) => role);
  const verification = artifacts.verification as { failureClassification?: { classificationSource?: string } } | undefined;

  return {
    runStatus: artifacts.summary?.status ?? null,
    runPhase: artifacts.summary?.phase ?? artifacts.state?.phase ?? null,
    interviewRoundCount: artifacts.interviewDecisions.length,
    interviewRequired: spec.interviewRequired,
    repairAttempts: artifacts.repairExecutions.length,
    landingAttempts: artifacts.landingAttempts.length,
    finalMergeStatus: artifacts.finalMerge?.status ?? null,
    finalMergeOutcome: artifacts.finalMerge?.outcome ?? null,
    changedFiles: [...new Set(artifacts.completedTasks.flatMap((task) => task.changedFiles ?? []))],
    verificationStatus: artifacts.summary?.verificationStatus ?? (artifacts.verification?.overallStatus as string | undefined) ?? null,
    verificationContractRequirements: ((verification as { contract?: { requirements?: unknown[] } } | undefined)?.contract?.requirements ?? []).length,
    failureClassificationSource: verification?.failureClassification?.classificationSource ?? null,
    rolesObserved: roles.sort(),
    routingStableAcrossRetries: unstable.length === 0,
    routingUnstableRoles: unstable,
    taskType: artifacts.events.find((event) => event.type === "task.type_resolved")?.data?.taskType ?? null,
    taskTypeConfidence: artifacts.events.find((event) => event.type === "task.type_resolved")?.data?.confidence ?? null,
  };
}

function round(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1000) / 1000;
}

// Verification outcome handling (baseline-warning + failure exit) —
// extracted from verification-phase2.ts.

import { appendFactoryRunEvent, updateFactoryRunState, createFactoryRun } from "../runs/store.js";
import { appendRepoLearning } from "../learnings/store.js";
import { writePrototypeSummaryArtifact } from "./artifacts.js";
import { emitProgress } from "./phase-plumbing.js";
import { buildRunFailureResult } from "./controller-helpers.js";
import { loadEffectiveConfig } from "../config/loader.js";
import type { RunFactoryControllerInput, RunFactoryControllerResult } from "./controller.js";
import type { VerificationRunResult } from "./verification.js";
import type { VerificationFailureClassification } from "./failure-classification.js";

export interface VerificationOutcomeState {
  run: Awaited<ReturnType<typeof createFactoryRun>>;
  input: RunFactoryControllerInput;
  projectRoot: string;
  executionCwd: string;
  worktree: RunFactoryControllerResult["worktree"];
  phases: string[];
  delayMs: number;
  planPath: string;
  taskPaths: string[];
  discoveryExecutionPath: string | undefined;
  plannerExecutionPath: string | undefined;
  builderExecutionPaths: string[];
  integrationPath: string | undefined;
  repairExecutionPaths: string[];
  verificationPath: string;
  verification: VerificationRunResult;
  verificationFailureClassification: VerificationFailureClassification | undefined;
}

export async function handleVerificationOutcome(state: VerificationOutcomeState): Promise<RunFactoryControllerResult | undefined> {
  const {
    run, input, projectRoot, executionCwd, worktree, phases, delayMs, planPath, taskPaths,
    discoveryExecutionPath, plannerExecutionPath, builderExecutionPaths, integrationPath,
    repairExecutionPaths, verificationPath, verification, verificationFailureClassification,
  } = state;
  let reviewerExecutionPath: string | undefined;

const allFailuresBaseline = verification.overallStatus === "failed"
&& Boolean(verificationFailureClassification)
&& verificationFailureClassification!.perCommand.length > 0
&& verificationFailureClassification!.perCommand.every(
  (c) => c.category === "baseline-unrelated" || c.suggestedAction === "ignore",
);

if (verification.overallStatus === "failed" && allFailuresBaseline) {
await appendFactoryRunEvent(run.eventsPath, {
  timestamp: new Date().toISOString(),
  type: "verification.baseline_warning",
  data: {
    reason: verificationFailureClassification?.reason,
    perCommand: verificationFailureClassification?.perCommand,
  },
});
await emitProgress(input, {
  runId: run.runId,
  phase: "verification",
  status: "RUNNING",
  message: `Verification warnings (baseline-unrelated): ${verificationFailureClassification?.reason ?? "pre-existing repo issues"}`,
});
await appendRepoLearning({
  projectRoot,
  category: "verification-baseline-warning",
  summary: verificationFailureClassification?.reason ?? "Baseline-unrelated verification failure",
  data: {
    perCommand: verificationFailureClassification?.perCommand,
  },
});
} else if (verification.overallStatus === "failed") {
const failedState = await updateFactoryRunState({
  statePath: run.statePath,
  patch: { status: "FAILED", phase: "verification-failed" },
});
await appendFactoryRunEvent(run.eventsPath, {
  timestamp: new Date().toISOString(),
  type: "run.failed",
  data: { reason: "verification failed" },
});
const summaryPath = await writePrototypeSummaryArtifact(run.runDir, {
  runId: run.runId,
  goal: input.goal,
  status: "FAILED",
  phase: failedState.phase,
  approved: false,
  planPath,
  taskPaths,
  plannerExecutionPath,
  builderExecutionPaths,
  integrationPath,
  repairExecutionPaths,

  reviewerExecutionPath,
  verificationPath,
  verificationStatus: verification.overallStatus,
});

return buildRunFailureResult({
  run,
  executionCwd,
  worktree,
  phases,
  planPath,
  taskPaths,
  plannerExecutionPath,
  builderExecutionPaths,
  integrationPath,
  repairExecutionPaths,
  reviewerExecutionPath,
  verificationPath,
  summaryPath,
});
}

// Verified: only after all required checks pass.


  return undefined;
}

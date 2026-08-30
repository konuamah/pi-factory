// Final phases (verified/review/approval/merge) of the run controller —
// extracted from controller-run.ts. Always returns the final result.

import { createFactoryRun } from "../runs/store.js";
import { loadEffectiveConfig } from "../config/loader.js";

import { appendFactoryRunEvent, updateFactoryRunState } from "../runs/store.js";
import { writePrototypeReviewerExecutionArtifact, writePrototypeSummaryArtifact } from "./artifacts.js";
import { buildReviewerPrompt, renderSkillBundleForPrompt } from "./prompts.js";
import { emitProgress, movePhase, wait } from "./phase-plumbing.js";
import { readGitHeadSha } from "./git-ops.js";
import { buildRunFailureResult } from "./controller-helpers.js";
import { runLandingFlow } from "./landing.js";
import type { RunFactoryControllerInput, RunFactoryControllerResult } from "./controller.js";
import type { VerificationRunResult } from "./verification.js";
import type { VerificationFailureClassification } from "./failure-classification.js";
import type { VerificationEngineResult } from "../verification/index.js";
import type { SkillBundleSelection } from "../skills/index.js";
import type { InterviewDecisionRecord } from "./controller.js";
import type { VerificationPlan } from "./verification.js";
import type { PrototypeCompletedTaskArtifact } from "./artifacts.js";

export interface FinalPhasesState {
  run: Awaited<ReturnType<typeof createFactoryRun>>;
  input: RunFactoryControllerInput;
  loaded: Awaited<ReturnType<typeof loadEffectiveConfig>>;
  executionCwd: string;
  worktree: NonNullable<RunFactoryControllerResult["worktree"]>;
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
  verificationPlan: VerificationPlan;
  verificationFailureClassification: VerificationFailureClassification | undefined;
  contractResult: VerificationEngineResult;
  reviewerGuidanceText: string;
  reviewerSkills: SkillBundleSelection;
  interviewDecisions: InterviewDecisionRecord[];
  completedTasks: PrototypeCompletedTaskArtifact[];
}

export async function runFinalPhases(state: FinalPhasesState): Promise<RunFactoryControllerResult> {
  const {
    run, input, loaded, executionCwd, worktree, phases, delayMs, planPath, taskPaths,
    discoveryExecutionPath, plannerExecutionPath, builderExecutionPaths, integrationPath,
    repairExecutionPaths, verificationPath, verification, verificationPlan, verificationFailureClassification,
    contractResult, reviewerGuidanceText, reviewerSkills, interviewDecisions, completedTasks,
  } = state;
  const reviewerGuidance = { text: reviewerGuidanceText };
  let reviewerExecutionPath: string | undefined;
  let candidateSha: string | undefined;
  let finalMergePath: string | undefined;

await movePhase(run.statePath, run.eventsPath, run.runId, input, "verified", "Candidate verified");

// Contract completion gate: the run only proceeds to review/approval if the
// contract verification can complete. Otherwise it is BLOCKED.
if (!contractResult.canComplete) {
  const blockedState = await updateFactoryRunState({
    statePath: run.statePath,
    patch: { status: "BLOCKED", phase: "verification-blocked" },
  });
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "verification.blocked",
    data: {
      overallStatus: contractResult.overallStatus,
      failingRequirements: contractResult.results
        .filter((result) => result.blocking && result.status !== "PASS" && result.status !== "NOT_APPLICABLE")
        .map((result) => ({ requirementId: result.requirementId, status: result.status, reason: result.reason })),
    },
  });
  await emitProgress(input, {
    runId: run.runId,
    phase: "verification-blocked",
    status: "BLOCKED",
    message: "Contract verification cannot complete; run blocked",
  });
  const summaryPath = await writePrototypeSummaryArtifact(run.runDir, {
    runId: run.runId,
    goal: input.goal,
    status: "BLOCKED",
    phase: blockedState.phase,
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

await wait(delayMs);

await movePhase(run.statePath, run.eventsPath, run.runId, input, "review", "Reviewing verified candidate");
if (input.reviewerExecutor) {
  const reviewerResult = await input.reviewerExecutor.execute({
    executionId: `${run.runId}-reviewer`,
    cwd: executionCwd,
    prompt: buildReviewerPrompt(input.goal, verification, reviewerGuidance.text, renderSkillBundleForPrompt(reviewerSkills), interviewDecisions),
    model: loaded.effectiveConfig.models.reviewer,
    tools: ["read", "grep", "find", "ls"],
    metadata: {
      role: "reviewer",
      runId: run.runId,
    },
  });
  reviewerExecutionPath = await writePrototypeReviewerExecutionArtifact(run.runDir, reviewerResult);
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "review.completed",
    data: {
      reviewerExecutionPath,
      reviewerStatus: reviewerResult.status,
    },
  });
  await emitProgress(input, {
    runId: run.runId,
    phase: "review",
    status: reviewerResult.status === "failed" ? "FAILED" : "RUNNING",
    message: `Reviewer ${reviewerResult.status}`,
  });

  if (reviewerResult.status === "failed") {
    const failedState = await updateFactoryRunState({
      statePath: run.statePath,
      patch: { status: "FAILED", phase: "review-failed" },
    });
    await appendFactoryRunEvent(run.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "run.failed",
      data: { reason: "review failed" },
    });
    const summaryPath = await writePrototypeSummaryArtifact(run.runDir, {
      runId: run.runId,
      goal: input.goal,
      status: "FAILED",
      phase: failedState.phase,
      approved: false,
      planPath,
      taskPaths,
      discoveryExecutionPath,
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
}

await wait(delayMs);

candidateSha = await readGitHeadSha(executionCwd);

await movePhase(run.statePath, run.eventsPath, run.runId, input, "approval-ready", "Candidate ready for approval");
await appendFactoryRunEvent(run.eventsPath, {
  timestamp: new Date().toISOString(),
  type: "approval.required",
  data: {
    finalMerge: loaded.effectiveConfig.approval.finalMerge,
    candidateSha,
    candidateBranch: worktree.branch,
  },
});

await emitProgress(input, {
  runId: run.runId,
  phase: "approval-ready",
  status: "RUNNING",
  message: "Waiting for human approval",
});

const baselineDebt = (verificationFailureClassification?.perCommand ?? [])
  .filter((c) => c.category === "baseline-unrelated" || c.suggestedAction === "ignore")
  .map((c) => ({
    commandName: c.commandName,
    category: c.category,
    reason: c.reason,
    suggestedAction: c.suggestedAction,
    ...(c.implicatedFiles?.length ? { implicatedFiles: c.implicatedFiles } : {}),
  }));
const approved = (await input.requestApproval?.({
  runId: run.runId,
  goal: input.goal,
  candidateSha,
  baselineDebt: baselineDebt.length > 0 ? baselineDebt : undefined,
  contractComplete: contractResult.canComplete,
  verificationStatus: verification.overallStatus,
})) ?? true;
await appendFactoryRunEvent(run.eventsPath, {
  timestamp: new Date().toISOString(),
  type: approved ? "approval.approved" : "approval.rejected",
  data: { goal: input.goal, candidateSha },
});

if (!approved) {
  const cancelledState = await updateFactoryRunState({
    statePath: run.statePath,
    patch: { status: "CANCELLED", phase: "approval-rejected" },
  });
  await emitProgress(input, {
    runId: run.runId,
    phase: "approval-rejected",
    status: "CANCELLED",
    message: "Run stopped: approval rejected",
  });
  const summaryPath = await writePrototypeSummaryArtifact(run.runDir, {
    runId: run.runId,
    goal: input.goal,
    status: "CANCELLED",
    phase: cancelledState.phase,
    approved: false,
    candidateSha,
    planPath,
    taskPaths,
    discoveryExecutionPath,
    plannerExecutionPath,
    builderExecutionPaths,
    integrationPath,
    finalMergePath,
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
    finalMergePath,
    candidateSha,
    repairExecutionPaths,
    reviewerExecutionPath,
    verificationPath,
    summaryPath,
  });
}

await wait(delayMs);

await movePhase(run.statePath, run.eventsPath, run.runId, input, "landing-planning", "Planning final landing");
const landingResult = await runLandingFlow({
  runDir: run.runDir,
  runId: run.runId,
  eventsPath: run.eventsPath,
  goal: input.goal,
  mergeCwd: input.cwd,
  taskType: "general",
  config: loaded.effectiveConfig,
  completedTasks,
  candidateSha,
  candidateBranch: worktree.branch,
  verificationPlan,
  verification,
  controllerInput: input,
  repairGuidanceText: reviewerGuidance.text,
});
finalMergePath = landingResult.finalMergePath;

await wait(delayMs);

const completedState = await updateFactoryRunState({
  statePath: run.statePath,
  patch: { status: landingResult.status, phase: landingResult.phase },
});
await appendFactoryRunEvent(run.eventsPath, {
  timestamp: new Date().toISOString(),
  type: landingResult.status === "COMPLETED" ? "run.completed" : "run.blocked",
  data: landingResult.status === "COMPLETED"
    ? { goal: input.goal }
    : { goal: input.goal, reason: landingResult.recoveryHint ?? "final landing did not complete" },
});
await emitProgress(input, {
  runId: run.runId,
  phase: completedState.phase,
  status: landingResult.status,
  message: landingResult.status === "COMPLETED"
    ? "Prototype controller run completed"
    : landingResult.recoveryHint ?? "Landing blocked",
});

const summaryPath = await writePrototypeSummaryArtifact(run.runDir, {
  runId: run.runId,
  goal: input.goal,
  status: landingResult.status,
  phase: completedState.phase,
  approved: landingResult.approved,
  candidateSha,
  planPath,
  taskPaths,
  discoveryExecutionPath,
  plannerExecutionPath,
  builderExecutionPaths,
  integrationPath,
  finalMergePath,
  landingStatus: landingResult.landingStatus,
  landingAttempts: landingResult.landingAttempts,
  recoveryHint: landingResult.recoveryHint,
  repairExecutionPaths,
  reviewerExecutionPath,
  verificationPath,
  verificationStatus: verification.overallStatus,
});

if (landingResult.status !== "COMPLETED") {
  return buildRunFailureResult({
    run,
    executionCwd,
    worktree,
    phases,
    planPath,
    taskPaths,
    discoveryExecutionPath,
    plannerExecutionPath,
    builderExecutionPaths,
    integrationPath,
    finalMergePath,
    candidateSha,
    repairExecutionPaths,
    reviewerExecutionPath,
    verificationPath,
    summaryPath,
  });
}

return {
  runId: run.runId,
  runDir: run.runDir,
  executionCwd,
  worktree,
  statePath: run.statePath,
  eventsPath: run.eventsPath,
  phases,
  approved: true,
  planPath,
  taskPaths,
  plannerExecutionPath,
  builderExecutionPaths,
  integrationPath,
  finalMergePath,
  candidateSha,
  repairExecutionPaths,
  reviewerExecutionPath,
  verificationPath,
  summaryPath,
};
}

// Final phases (verified/review/approval/merge) of the run controller —
// extracted from controller-run.ts. Always returns the final result.

import { createFactoryRun } from "../runs/store.js";
import { loadEffectiveConfig } from "../config/loader.js";

import { appendFactoryRunEvent, updateFactoryRunState } from "../runs/store.js";
import { writePrototypeReviewerExecutionArtifact, writePrototypeSummaryArtifact } from "./artifacts.js";
import { buildReviewerPrompt, renderSkillBundleForPrompt } from "./prompts.js";
import { emitProgress, movePhase, requestHumanDecision, wait } from "./phase-plumbing.js";
import { readGitHeadSha } from "./git-ops.js";
import { buildRunFailureResult } from "./controller-helpers.js";
import { requestFailureRecovery } from "./failure-recovery.js";
import { runLandingFlow } from "./landing.js";
import { nonGoalViolations, loadPlanContract } from "./scope-check.js";
import { buildDeterministicReviewerText, buildReviewSurface, evaluateDeterministicReview, classifyReviewerVerdict, type ReviewerVerdict } from "./review-surface.js";
import { parseFindings } from "../verification/providers/review.js";
import type { FinalApprovalDecision, RunFactoryControllerInput, RunFactoryControllerResult } from "./controller.js";
import type { AgentExecutionResult } from "./interfaces.js";
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
  taskType: string;
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
    repairExecutionPaths, verificationPath, verification, verificationPlan, taskType, verificationFailureClassification,
    contractResult, reviewerGuidanceText, reviewerSkills, interviewDecisions, completedTasks,
  } = state;
  const reviewerGuidance = { text: reviewerGuidanceText };
  let reviewerExecutionPath: string | undefined;
  let reviewerVerdict: { verdict: ReviewerVerdict; summary: string } | undefined;
  let candidateSha: string | undefined;
  let finalMergePath: string | undefined;

await movePhase(run.statePath, run.eventsPath, run.runId, input, "verified", "Candidate verified");

// Contract completion gate: the run only proceeds to review/approval if the
// contract verification can complete. Otherwise it is BLOCKED.
if (!contractResult.canComplete) {
  const failingRequirements = contractResult.results
    .filter((result) => result.blocking && result.status !== "PASS" && result.status !== "NOT_APPLICABLE")
    .map((result) => `${result.requirementId}: ${result.reason ?? result.status}`);
  if (!contractResult.results.some((result) => result.decision)) {
    const recovery = await requestFailureRecovery({
      controllerInput: input,
      runDir: run.runDir,
      statePath: run.statePath,
      eventsPath: run.eventsPath,
      runId: run.runId,
      checkpoint: buildFinalPhaseCheckpoint(state, "verification-blocked", candidateSha, finalMergePath),
      context: {
        phase: "verification-blocked",
        title: "contract verification is blocked",
        reason: failingRequirements.join("; ") || "Contract verification cannot complete.",
        category: "contract-verification",
        retryable: true,
        canRepair: Boolean(input.repairExecutor && loaded.effectiveConfig.repair.enabled),
        canRevise: true,
        evidenceRefs: [verificationPath],
        attempt: nextRecoveryAttempt(state, "verification-blocked"),
      },
    });
    if (recovery.action === "retry" || recovery.action === "repair" || recovery.action === "revise") {
      return runFinalPhases(state);
    }
  }
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

const planContract = await loadPlanContract(planPath);
// Build the review surface unconditionally: deterministic review must be able
// to run even when no reviewer executor is configured, so final approval never
// happens without review evidence (deterministic or executor-based).
let reviewSurface: Awaited<ReturnType<typeof buildReviewSurface>> | undefined;
try {
  reviewSurface = await buildReviewSurface({
    cwd: executionCwd,
    completedTasks,
    baseBranch: loaded.effectiveConfig.git.baseBranch,
    planContract,
  });
} catch (error) {
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "review.surface_failed",
    data: {
      reason: error instanceof Error ? error.message : String(error),
    },
  });
}

await wait(delayMs);

await movePhase(run.statePath, run.eventsPath, run.runId, input, "review", "Reviewing verified candidate");
const deterministicReview = reviewSurface
  ? evaluateDeterministicReview(reviewSurface, verification, verificationFailureClassification)
  : { eligible: false, reasons: ["review surface unavailable"] };
const reviewerTools = reviewSurface ? ["read"] : ["read", "grep", "find", "ls"];
let reviewerResult: AgentExecutionResult | undefined;

if (deterministicReview.eligible) {
  reviewerResult = {
    executionId: `${run.runId}-reviewer`,
    status: "completed",
    outputText: buildDeterministicReviewerText(reviewSurface!, verification),
    events: [{
      type: "review.deterministic",
      data: {
        changedFiles: reviewSurface!.changedFiles,
        fileCount: reviewSurface!.diff.fileCount,
        additions: reviewSurface!.diff.additions,
        deletions: reviewSurface!.diff.deletions,
        strategy: reviewSurface!.diff.strategy,
      },
    }],
  };
} else if (input.reviewerExecutor) {
  reviewerResult = await input.reviewerExecutor.execute({
    executionId: `${run.runId}-reviewer`,
    cwd: executionCwd,
    prompt: buildReviewerPrompt(input.goal, verification, reviewerGuidance.text, renderSkillBundleForPrompt(reviewerSkills), interviewDecisions, reviewSurface),
    model: loaded.effectiveConfig.models.reviewer,
    tools: reviewerTools,
    limits: loaded.effectiveConfig.runtime.limits,
    metadata: {
      role: "reviewer",
      runId: run.runId,
    },
  });
} else {
  // No reviewer executor AND deterministic review is not eligible: fail loud
  // instead of opening final approval without any review evidence.
  const reason = [
    "No reviewer executor configured and deterministic review was not eligible; refusing to request final approval without review.",
    ...deterministicReview.reasons.map((item) => `Reason: ${item}`),
  ].join(" ");
  const unavailableState = await updateFactoryRunState({
    statePath: run.statePath,
    patch: { status: "FAILED", phase: "review-unavailable" },
  });
  const recovery = await requestFailureRecovery({
    controllerInput: input,
    runDir: run.runDir,
    statePath: run.statePath,
    eventsPath: run.eventsPath,
    runId: run.runId,
    checkpoint: buildFinalPhaseCheckpoint(state, "review", candidateSha, finalMergePath),
    context: {
      phase: "review",
      title: "review is unavailable",
      reason,
      category: "review-unavailable",
      retryable: true,
      canRepair: false,
      canRevise: true,
      evidenceRefs: [planPath, verificationPath],
      attempt: nextRecoveryAttempt(state, "review-unavailable"),
    },
  });
  if (recovery.action === "retry" || recovery.action === "revise") {
    return runFinalPhases(state);
  }
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "review.unavailable",
    data: { reason, deterministicReviewReasons: deterministicReview.reasons },
  });
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "run.failed",
    data: { reason, phase: "review-unavailable" },
  });
  await emitProgress(input, {
    runId: run.runId,
    phase: "review-unavailable",
    status: "FAILED",
    message: reason,
  });
  const summaryPath = await writePrototypeSummaryArtifact(run.runDir, {
    runId: run.runId,
    goal: input.goal,
    status: "FAILED",
    phase: unavailableState.phase,
    approved: false,
    candidateSha: await readGitHeadSha(executionCwd).catch(() => undefined),
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
    recoveryHint: reason,
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
    repairExecutionPaths,
    reviewerExecutionPath,
    verificationPath,
    summaryPath,
  });
}

reviewerExecutionPath = await writePrototypeReviewerExecutionArtifact(run.runDir, reviewerResult);
if (!deterministicReview.eligible) {
  const decision = parseFindings(reviewerResult.outputText).find((finding) => finding.decision)?.decision;
  if (decision) {
    await requestHumanDecision({
      controllerInput: input,
      runDir: run.runDir,
      statePath: run.statePath,
      eventsPath: run.eventsPath,
      runId: run.runId,
      request: {
        ...decision,
        id: `${run.runId}-reviewer-${decision.id}`,
        evidenceRefs: [reviewerExecutionPath],
      },
    });
  }
}
reviewerVerdict = deterministicReview.eligible
  ? { verdict: "pass", summary: reviewerResult.outputText }
  : { verdict: classifyReviewerVerdict(reviewerResult.outputText), summary: reviewerResult.outputText.slice(0, 1200) };
if (deterministicReview.eligible && reviewSurface) {
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "review.deterministic",
    data: {
      reviewerExecutionPath,
      changedFiles: reviewSurface.changedFiles,
      fileCount: reviewSurface.diff.fileCount,
      additions: reviewSurface.diff.additions,
      deletions: reviewSurface.diff.deletions,
      strategy: reviewSurface.diff.strategy,
    },
  });
}
await appendFactoryRunEvent(run.eventsPath, {
  timestamp: new Date().toISOString(),
  type: "review.completed",
  data: {
    reviewerExecutionPath,
    reviewerStatus: reviewerResult.status,
    deterministic: deterministicReview.eligible || undefined,
    reviewerTools: deterministicReview.eligible ? [] : reviewerTools,
  },
});
if (reviewerVerdict) {
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "review.verdict",
    data: {
      verdict: reviewerVerdict.verdict,
      reviewerExecutionPath,
    },
  });
}
await emitProgress(input, {
  runId: run.runId,
  phase: "review",
  status: reviewerResult.status === "failed" ? "FAILED" : "RUNNING",
  message: deterministicReview.eligible ? "Reviewer completed deterministically" : `Reviewer ${reviewerResult.status}`,
});

if (reviewerResult.status === "failed") {
  const recovery = await requestFailureRecovery({
    controllerInput: input,
    runDir: run.runDir,
    statePath: run.statePath,
    eventsPath: run.eventsPath,
    runId: run.runId,
    checkpoint: buildFinalPhaseCheckpoint(state, "review", candidateSha, finalMergePath),
    context: {
      phase: "review",
      title: "review failed",
      reason: reviewerResult.outputText || "Reviewer executor failed.",
      category: "review-failed",
      retryable: true,
      canRepair: false,
      canRevise: true,
      evidenceRefs: [reviewerExecutionPath, verificationPath].filter((item): item is string => Boolean(item)),
      attempt: nextRecoveryAttempt(state, "review-failed"),
    },
  });
  if (recovery.action === "retry" || recovery.action === "revise") {
    return runFinalPhases(state);
  }
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

await wait(delayMs);

candidateSha = await readGitHeadSha(executionCwd);

await movePhase(run.statePath, run.eventsPath, run.runId, input, "approval-ready", "Review complete; candidate ready for approval");
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
  message: "Review complete; waiting for human approval",
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
const scopeWarnings = await (async (): Promise<Array<{ file: string; nonGoal: string }> | undefined> => {
  const violations = reviewSurface?.nonGoalViolations ?? nonGoalViolations(
    completedTasks.flatMap((task) => task.changedFiles ?? []),
    planContract?.nonGoals ?? [],
  );
  return violations.length > 0
    ? violations.map((violation) => ({ file: violation.file, nonGoal: violation.nonGoal }))
    : undefined;
})();
if (scopeWarnings?.length) {
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "approval.scope_warning",
    data: { goal: input.goal, scopeWarnings },
  });
}
if (!input.requestApproval) {
  const recovery = await requestFailureRecovery({
    controllerInput: input,
    runDir: run.runDir,
    statePath: run.statePath,
    eventsPath: run.eventsPath,
    runId: run.runId,
    checkpoint: buildFinalPhaseCheckpoint(state, "approval-ready", candidateSha, finalMergePath),
    context: {
      phase: "approval-ready",
      title: "final approval is unavailable",
      reason: "No final approval handler configured; refusing to auto-approve.",
      category: "approval-unavailable",
      retryable: false,
      canRepair: false,
      canRevise: true,
      evidenceRefs: [planPath, verificationPath, reviewerExecutionPath].filter((item): item is string => Boolean(item)),
      attempt: nextRecoveryAttempt(state, "approval-unavailable"),
    },
  });
  if (recovery.action === "revise") {
    return runFinalPhases(state);
  }
  // No final-approval handler configured: fail loud instead of silently
  // approving the merge (a real deployment must not auto-approve).
  const unavailableState = await updateFactoryRunState({
    statePath: run.statePath,
    patch: { status: "FAILED", phase: "approval-unavailable" },
  });
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "run.failed",
    data: { reason: "No final approval handler configured; refusing to auto-approve", phase: "approval-unavailable" },
  });
  await emitProgress(input, {
    runId: run.runId,
    phase: "approval-unavailable",
    status: "FAILED",
    message: "No final approval handler configured; refusing to auto-approve",
  });
  const summaryPath = await writePrototypeSummaryArtifact(run.runDir, {
    runId: run.runId,
    goal: input.goal,
    status: "FAILED",
    phase: "approval-unavailable",
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
    recoveryHint: "No final approval handler configured; refusing to auto-approve",
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
const approvalDecision = normalizeFinalApprovalDecision(await input.requestApproval({
  runId: run.runId,
  goal: input.goal,
  candidateSha,
  baselineDebt: baselineDebt.length > 0 ? baselineDebt : undefined,
  contractComplete: contractResult.canComplete,
  verificationStatus: verification.overallStatus,
  scopeWarnings,
  reviewerVerdict,
}));
const approved = approvalDecision.approved;
await appendFactoryRunEvent(run.eventsPath, {
  timestamp: new Date().toISOString(),
  type: approved ? "approval.approved" : "approval.rejected",
  data: { goal: input.goal, candidateSha, feedback: approvalDecision.feedback },
});

if (!approved) {
  const recovery = await requestFailureRecovery({
    controllerInput: input,
    runDir: run.runDir,
    statePath: run.statePath,
    eventsPath: run.eventsPath,
    runId: run.runId,
    checkpoint: buildFinalPhaseCheckpoint(state, "approval-ready", candidateSha, finalMergePath),
    context: {
      phase: "approval-ready",
      title: "final approval was rejected",
      reason: approvalDecision.feedback ?? "The human approver rejected the candidate.",
      category: "approval-rejected",
      retryable: false,
      canRepair: false,
      canRevise: true,
      evidenceRefs: [planPath, verificationPath, reviewerExecutionPath].filter((item): item is string => Boolean(item)),
      attempt: nextRecoveryAttempt(state, "approval-rejected"),
    },
  });
  if (recovery.action === "revise") {
    return runFinalPhases(state);
  }
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
  statePath: run.statePath,
  goal: input.goal,
  mergeCwd: input.cwd,
  taskType,
  config: loaded.effectiveConfig,
  completedTasks,
  candidateSha,
  candidateBranch: worktree.branch,
  verificationPlan,
  verification,
  verificationFailureClassification,
  contractCanComplete: contractResult.canComplete,
  controllerInput: input,
  repairGuidanceText: reviewerGuidance.text,
  planContract,
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
  pullRequest: landingResult.pullRequest,
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

function normalizeFinalApprovalDecision(value: boolean | FinalApprovalDecision): FinalApprovalDecision {
  return typeof value === "boolean"
    ? { approved: value, decision: value ? "approve" : "reject" }
    : {
        approved: value.approved,
        decision: value.decision ?? (value.approved ? "approve" : "reject"),
        feedback: value.feedback?.trim() || undefined,
      };
}

function nextRecoveryAttempt(state: FinalPhasesState, key: string): number {
  const holder = state as FinalPhasesState & { recoveryAttempts?: Record<string, number> };
  holder.recoveryAttempts ??= {};
  holder.recoveryAttempts[key] = (holder.recoveryAttempts[key] ?? 0) + 1;
  return holder.recoveryAttempts[key];
}

function buildFinalPhaseCheckpoint(
  state: FinalPhasesState,
  phase: "verification-blocked" | "review" | "approval-ready" | "landing-planning" | "post-landing-verification",
  candidateSha?: string,
  finalMergePath?: string,
) {
  return {
    runId: state.run.runId,
    goal: state.input.goal,
    phase,
    executionCwd: state.executionCwd,
    projectRoot: state.executionCwd,
    worktree: state.worktree,
    planPath: state.planPath,
    taskPaths: state.taskPaths,
    discoveryExecutionPath: state.discoveryExecutionPath,
    plannerExecutionPath: state.plannerExecutionPath,
    builderExecutionPaths: state.builderExecutionPaths,
    integrationPath: state.integrationPath,
    repairExecutionPaths: state.repairExecutionPaths,
    verificationPath: state.verificationPath,
    finalMergePath,
    candidateSha,
  };
}

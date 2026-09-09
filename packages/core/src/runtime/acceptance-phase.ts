import { appendFactoryRunEvent, updateFactoryRunState } from "../runs/store.js";
import { writePrototypeSummaryArtifact } from "./artifacts.js";
import { emitProgress, movePhase } from "./phase-plumbing.js";
import { buildRunFailureResult } from "./controller-helpers.js";
import type { AcceptanceEvidence, AcceptanceDecision, RunFactoryControllerInput, RunFactoryControllerResult } from "./controller.js";
import type { LandingResult } from "./landing-types.js";
import type { FinalPhasesState } from "./controller-final-phases.js";
import { requestRuntimePolicy } from "./policy.js";

export async function runAcceptancePhase(
  state: FinalPhasesState & {
    reviewerExecutionPath?: string;
    candidateSha?: string;
    landingResult: LandingResult;
    reviewerVerdict?: AcceptanceEvidence["reviewVerdict"];
    baselineDebt?: AcceptanceEvidence["baselineDebt"];
    scopeWarnings?: AcceptanceEvidence["scopeWarnings"];
  },
): Promise<RunFactoryControllerResult> {
  const { run, input, landingResult, candidateSha } = state;
  await movePhase(run.statePath, run.eventsPath, run.runId, input, "acceptance", "Landing evidence collected; awaiting acceptance");

  const evidence: AcceptanceEvidence = {
    ...(state.reviewerVerdict ? { reviewVerdict: state.reviewerVerdict } : {}),
    ...(state.baselineDebt?.length ? { baselineDebt: state.baselineDebt } : {}),
    ...(state.scopeWarnings?.length ? { scopeWarnings: state.scopeWarnings } : {}),
    verificationStatus: state.verification.overallStatus,
    contractComplete: state.contractResult.canComplete,
    landingOutcome: {
      status: landingResult.landingStatus === "landed" ? "landed" : landingResult.landingStatus === "pull-request" ? "pull-request" : landingResult.landingStatus === "skipped" ? "skipped" : "blocked",
      phase: landingResult.phase,
      reason: landingResult.recoveryHint,
      targetHeadBefore: landingResult.targetHeadBefore,
      targetHeadAfter: landingResult.targetHeadAfter,
      ...(landingResult.pullRequest ? { pullRequest: { ...landingResult.pullRequest, status: landingResult.pullRequest.status === "skipped" ? "failed" : landingResult.pullRequest.status } } : {}),
    },
    ...(landingResult.postLandingVerification ? { postLandingVerification: {
      overallStatus: landingResult.postLandingVerification.status,
      commands: landingResult.postLandingVerification.commands,
      reason: landingResult.postLandingVerification.reason,
      repairAttempted: landingResult.postLandingVerification.repairAttempted,
    } } : {}),
  };
  const handler = input.requestAcceptance;
  if (input.policyExecutor) {
    const decision = await requestRuntimePolicy({
      controllerInput: input, runDir: run.runDir, statePath: run.statePath, eventsPath: run.eventsPath, runId: run.runId,
      context: {
        runId: run.runId, goal: input.goal, currentPhase: "acceptance", evidence: evidence as unknown as Record<string, unknown>,
        attempt: 0, maxAttempts: input.policy?.maxAttempts ?? 3, allowedNextPhases: [],
        constraints: { retryable: true, repairEnabled: false, hasRepairExecutor: false, completedTasksRerunnable: true },
      },
    });
    await appendFactoryRunEvent(run.eventsPath, { timestamp: new Date().toISOString(), type: decision.action === "continue" ? "acceptance.accepted" : decision.action === "revise" ? "acceptance.revise_requested" : "acceptance.rejected", data: { candidateSha, feedback: decision.feedback, evidence } });
    if (decision.action === "continue") return finalizeAcceptance(state, "COMPLETED", landingResult.landingStatus === "pull-request" ? "accepted-with-pr" : "accepted", true);
    if (decision.action === "revise" && input.onAcceptanceRevise) return input.onAcceptanceRevise(decision.feedback);
    return finalizeAcceptance(state, decision.action === "abort" ? "CANCELLED" : "BLOCKED", decision.action === "abort" ? "rejected" : "acceptance-revise-requested", false, decision.feedback ?? "Policy did not accept the run.");
  }
  if (!handler) {
    return finalizeAcceptance(state, "FAILED", "acceptance-blocked", false, "No acceptance handler configured; refusing to auto-accept.");
  }
  let decision: AcceptanceDecision;
  try {
    decision = await handler({ runId: run.runId, goal: input.goal, candidateSha, evidence });
  } catch (error) {
    await appendFactoryRunEvent(run.eventsPath, { timestamp: new Date().toISOString(), type: "decision.invalid", data: { decisionRequestId: run.runId, reason: error instanceof Error ? error.message : String(error) } });
    return finalizeAcceptance(state, "FAILED", "acceptance-blocked", false, `Acceptance handler failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!decision || !["accept", "revise", "reject"].includes(decision.decision)) {
    await appendFactoryRunEvent(run.eventsPath, { timestamp: new Date().toISOString(), type: "decision.invalid", data: { decisionRequestId: run.runId, payload: decision } });
    return finalizeAcceptance(state, "FAILED", "acceptance-blocked", false, "Invalid acceptance decision; refusing to guess.");
  }
  await appendFactoryRunEvent(run.eventsPath, { timestamp: new Date().toISOString(), type: decision.decision === "accept" ? "acceptance.accepted" : decision.decision === "revise" ? "acceptance.revise_requested" : "acceptance.rejected", data: { candidateSha, feedback: decision.feedback, landingStatus: landingResult.landingStatus, evidence } });
  if (decision.decision === "revise") {
    if (input.onAcceptanceRevise) {
      return input.onAcceptanceRevise(decision.feedback);
    }
    return finalizeAcceptance(
      state,
      "BLOCKED",
      "acceptance-revise-requested",
      false,
      decision.feedback
        ? `Revision requested: ${decision.feedback}`
        : "Revision requested. Apply the requested changes and start a new run.",
    );
  }
  if (decision.decision === "reject") return finalizeAcceptance(state, "CANCELLED", "rejected", false, decision.feedback ?? "Run rejected at acceptance.");
  return finalizeAcceptance(state, "COMPLETED", landingResult.landingStatus === "pull-request" ? "accepted-with-pr" : "accepted", true);
}

async function finalizeAcceptance(
  state: Parameters<typeof runAcceptancePhase>[0],
  status: "COMPLETED" | "FAILED" | "CANCELLED" | "BLOCKED",
  phase: string,
  approved: boolean,
  recoveryHint?: string,
): Promise<RunFactoryControllerResult> {
  const { run, input, landingResult, candidateSha } = state;
  await updateFactoryRunState({ statePath: run.statePath, patch: { status, phase } });
  await appendFactoryRunEvent(run.eventsPath, { timestamp: new Date().toISOString(), type: status === "COMPLETED" ? "run.completed" : status === "CANCELLED" ? "run.cancelled" : "run.failed", data: { phase, recoveryHint } });
  await emitProgress(input, { runId: run.runId, phase, status, message: recoveryHint ?? (approved ? "Factory run accepted" : "Factory run stopped") });
  const summaryPath = await writePrototypeSummaryArtifact(run.runDir, {
    runId: run.runId, goal: input.goal, status, phase, approved, candidateSha,
    planPath: state.planPath, taskPaths: state.taskPaths,
    discoveryExecutionPath: state.discoveryExecutionPath, plannerExecutionPath: state.plannerExecutionPath,
    builderExecutionPaths: state.builderExecutionPaths, integrationPath: state.integrationPath,
    finalMergePath: landingResult.finalMergePath, repairExecutionPaths: state.repairExecutionPaths,
    reviewerExecutionPath: state.reviewerExecutionPath, verificationPath: state.verificationPath,
    verificationStatus: state.verification.overallStatus, landingStatus: landingResult.landingStatus,
    landingAttempts: landingResult.landingAttempts, recoveryHint: recoveryHint ?? landingResult.recoveryHint,
    pullRequest: landingResult.pullRequest,
  });
  if (status === "COMPLETED") return { runId: run.runId, runDir: run.runDir, executionCwd: state.executionCwd, worktree: state.worktree, statePath: run.statePath, eventsPath: run.eventsPath, phases: state.phases, approved, planPath: state.planPath, taskPaths: state.taskPaths, discoveryExecutionPath: state.discoveryExecutionPath, plannerExecutionPath: state.plannerExecutionPath, builderExecutionPaths: state.builderExecutionPaths, integrationPath: state.integrationPath, finalMergePath: landingResult.finalMergePath, candidateSha, repairExecutionPaths: state.repairExecutionPaths, reviewerExecutionPath: state.reviewerExecutionPath, verificationPath: state.verificationPath, summaryPath };
  return buildRunFailureResult({ run, executionCwd: state.executionCwd, worktree: state.worktree, phases: state.phases, planPath: state.planPath, taskPaths: state.taskPaths, discoveryExecutionPath: state.discoveryExecutionPath, plannerExecutionPath: state.plannerExecutionPath, builderExecutionPaths: state.builderExecutionPaths, integrationPath: state.integrationPath, finalMergePath: landingResult.finalMergePath, candidateSha, repairExecutionPaths: state.repairExecutionPaths, reviewerExecutionPath: state.reviewerExecutionPath, verificationPath: state.verificationPath, summaryPath });
}

import path from "node:path";
import { appendModelLedgerEntry } from "../runs/model-ledger.js";
import { appendFactoryRunEvent, updateFactoryRunState } from "../runs/store.js";
import { buildRepairPrompt } from "./prompts.js";
import { classifyVerificationFailure, isIgnorableBaselineFailure, type VerificationFailureClassification } from "./failure-classification.js";
import { createRecoveryPullRequest, type RecoveryPullRequestResult } from "../git/pull-request.js";
import { runVerificationCommands, type VerificationPlan, type VerificationRunResult } from "./verification.js";
import {
  type PrototypeCompletedTaskArtifact,
  type PrototypeLandingDiagnosisArtifact,
  type PrototypeLandingPlanArtifact,
} from "./artifacts.js";
import {
  appendPrototypeLandingAttemptArtifact,
  writePrototypeCompletedTasksArtifact,
  writePrototypeFinalMergeArtifact,
  writePrototypeLandingDiagnosisArtifact,
  writePrototypeLandingPlanArtifact,
} from "./artifact-writers.js";
import {
  buildLandingPlan,
  diagnoseLandingFailure,
  resolveLandingModel,
} from "./landing-ai.js";
import {
  classifyDirtyFiles,
  executeLandingStrategy,
  mapDiagnosisToOutcome,
  readDirtyFiles,
  readGitRemotes,
  validateLandingPlan,
} from "./landing-git.js";
import type { EffectiveFactoryConfig, ModelSelection } from "@factory/schemas";
import type { TaskWorkspaceSelection, RunFactoryControllerInput } from "./controller.js";
import type { PlanContract } from "./scope-check.js";
import { derivedLandingStrategy, type LandingPlan, type LandingResult } from "./landing-types.js";
import { readGitHeadSha } from "./git-ops.js";
import { requestFailureRecovery, shouldUseInteractiveRecovery, type FailureRecoveryResolution } from "./failure-recovery.js";

export function buildCompletedTasks(
  workspaces: TaskWorkspaceSelection[],
  targetBranch: string,
): PrototypeCompletedTaskArtifact[] {
  return workspaces
    .filter((workspace) => workspace.commitSha && (workspace.changedFiles?.length ?? 0) > 0)
    .map((workspace) => ({
      taskId: workspace.taskId,
      targetBranch,
      sourceBranch: workspace.branch,
      commitSha: workspace.commitSha!,
      changedFiles: workspace.changedFiles ?? [],
      workspaceMode: workspace.mode,
      worktreePath: workspace.mode === "in-place" ? undefined : workspace.path,
    }));
}

export async function runLandingFlow(input: {
  runDir: string;
  runId: string;
  eventsPath: string;
  statePath?: string;
  goal: string;
  mergeCwd: string;
  taskType: string;
  config: EffectiveFactoryConfig;
  completedTasks: PrototypeCompletedTaskArtifact[];
  candidateSha?: string;
  candidateBranch?: string;
  verificationPlan: VerificationPlan;
  verification: VerificationRunResult;
  verificationFailureClassification?: VerificationFailureClassification | undefined;
  contractCanComplete: boolean;
  controllerInput: RunFactoryControllerInput;
  repairGuidanceText?: string;
  /** Plan-declared non-goal file paths; candidate changes must not touch them. */
  planContract?: PlanContract;
  recoveryAttempts?: Record<string, number>;
}): Promise<LandingResult> {
  await writePrototypeCompletedTasksArtifact(input.runDir, input.completedTasks);
  const dirtyFiles = await readDirtyFiles(input.mergeCwd);
  const dirtyContext = classifyDirtyFiles(dirtyFiles, input.completedTasks);
  const executor = input.controllerInput.landingExecutor ?? input.controllerInput.reviewerExecutor;
  let modelSelection: { model: ModelSelection; source: string } | undefined;
  let plan: LandingPlan;
  try {
    modelSelection = resolveLandingModel(input.config, input.taskType);
    await recordLandingModel(input, modelSelection);
    plan = (await buildLandingPlanWithRecovery(input, executor, modelSelection, dirtyContext)).plan;
  } catch (error) {
    plan = buildBlockingLandingPlan(input, `Landing planner failed: ${formatError(error)}`);
  }
  let guardVerdict = await validateLandingPlan({
    mergeCwd: input.mergeCwd,
    plan,
    dirtyRelevantFiles: dirtyContext.relevant,
    dirtyUnrelatedFiles: dirtyContext.unrelated,
    finalMergePolicy: input.config.approval.finalMerge,
    completedTasks: input.completedTasks,
    verificationStatus: input.verification.overallStatus,
    nonGoals: input.planContract?.nonGoals,
    scopeGuardBlocking: input.config.scope?.landing === "block",
    allowedRemotes: await readGitRemotes(input.mergeCwd),
  });
  let landingPlanArtifact: PrototypeLandingPlanArtifact = { ...plan, guardVerdict };
  await writePrototypeLandingPlanArtifact(input.runDir, landingPlanArtifact);
  await appendFactoryRunEvent(input.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "landing.plan_selected",
    data: landingPlanArtifact as unknown as Record<string, unknown>,
  });

  for (;;) {
    if (guardVerdict.ok) break;
    const recoveryReason = guardVerdict.reasons.join("; ");
    const recovery = await landingRecovery(input, "landing-guard", "landing guard blocked the candidate", recoveryReason, true);
    if (recovery.action !== "retry" && recovery.action !== "revise") {
      await appendFactoryRunEvent(input.eventsPath, { timestamp: new Date().toISOString(), type: "landing.guard_blocked_recorded", data: { reason: recoveryReason, dirtyFiles: dirtyContext.relevant, unrelatedFiles: dirtyContext.unrelated } });
      const diagnosis = await diagnoseOrFallback({
        executor,
        model: modelSelection?.model,
        plan,
        reason: recoveryReason,
        dirtyFiles: dirtyContext.relevant,
        verification: input.verification,
        limits: input.config.runtime.limits,
      });
      const pullRequest = await publishBlockedCandidate(input, recoveryReason);
      return finishBlockedLanding(input, landingPlanArtifact, diagnosis, pullRequest?.reason ?? recoveryReason, pullRequest);
    }
    const replanned = await buildLandingPlanWithRecovery(input, executor, modelSelection, dirtyContext, recovery.feedback);
    plan = replanned.plan;
    guardVerdict = await validateLandingPlan({
      mergeCwd: input.mergeCwd,
      plan,
      dirtyRelevantFiles: dirtyContext.relevant,
      dirtyUnrelatedFiles: dirtyContext.unrelated,
      finalMergePolicy: input.config.approval.finalMerge,
      completedTasks: input.completedTasks,
      verificationStatus: input.verification.overallStatus,
      nonGoals: input.planContract?.nonGoals,
      scopeGuardBlocking: input.config.scope?.landing === "block",
      allowedRemotes: await readGitRemotes(input.mergeCwd),
    });
    landingPlanArtifact = { ...plan, guardVerdict };
    await writePrototypeLandingPlanArtifact(input.runDir, landingPlanArtifact);
    await appendFactoryRunEvent(input.eventsPath, { timestamp: new Date().toISOString(), type: "landing.plan_selected", data: landingPlanArtifact as unknown as Record<string, unknown> });
  }

  const targetHeadBefore = await readGitHeadSha(input.mergeCwd);
  await appendPrototypeLandingAttemptArtifact(input.runDir, {
    attempt: 1,
    stage: "started",
    plan: landingPlanArtifact,
    execution: {
      status: "blocked",
      outcome: "pending",
      reason: "Landing attempt started.",
      targetHeadBefore,
    },
    verification: { overallStatus: "pending", commands: [] },
  });

  let execution = await executeLandingStrategy({ cwd: input.mergeCwd, plan });
  await recordLandingSteps(input.eventsPath, execution);
  while (execution.status === "blocked") {
    const recovery = await landingRecovery(input, "landing-execution", "landing execution failed", execution.reason ?? execution.outcome, true);
    if (recovery.action !== "retry" && recovery.action !== "revise") break;
    if (recovery.action === "revise") {
      await appendFactoryRunEvent(input.eventsPath, {
        timestamp: new Date().toISOString(),
        type: "landing.execution_retry_with_feedback",
        data: { feedback: recovery.feedback, attempt: input.recoveryAttempts?.["landing-execution"] },
      });
    }
    execution = await executeLandingStrategy({ cwd: input.mergeCwd, plan });
    await recordLandingSteps(input.eventsPath, execution);
  }
  const targetHeadAfter = execution.status === "landed" ? await readGitHeadSha(input.mergeCwd) : undefined;
  let diagnosis: PrototypeLandingDiagnosisArtifact | undefined;
  let landingStatus: LandingResult["landingStatus"] = execution.status;
  let recoveryHint = execution.reason;
  let verificationResult = input.verification;
  let verificationCommands = Object.keys(input.verificationPlan.commands);
  let postLandingVerification: {
    overallStatus: "pending" | "passed" | "failed" | "incomplete" | "error";
    commands: string[];
    reason?: string;
    repairAttempted?: boolean;
  } | undefined;
  let repairAttempted = false;

  if (execution.status === "landed") {
    verificationCommands = resolveVerificationCommands(plan.verification, input.verificationPlan);
    postLandingVerification = { overallStatus: "pending", commands: verificationCommands };
    await appendFactoryRunEvent(input.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "landing.applied",
      data: {
        strategy: derivedLandingStrategy(plan),
        candidateSha: plan.candidateSha,
        sourceBranch: plan.sourceBranch,
        targetBranch: plan.targetBranch,
        targetHeadBefore,
        targetHeadAfter,
      },
    });
    await writePrototypeFinalMergeArtifact(input.runDir, {
      mergeBaseBranch: input.config.git.baseBranch,
      candidateBranch: input.candidateBranch,
      candidateSha: input.candidateSha,
      mergeCwd: input.mergeCwd,
      targetBranch: plan.targetBranch,
      sourceBranch: plan.sourceBranch,
      strategy: derivedLandingStrategy(plan),
      status: "landed",
      outcome: "landed",
      reason: execution.reason,
      targetHeadBefore,
      targetHeadAfter,
      postLandingVerification: {
        status: postLandingVerification.overallStatus,
        commands: postLandingVerification.commands,
        reason: postLandingVerification.reason,
        repairAttempted: postLandingVerification.repairAttempted,
      },
    });
    await appendPrototypeLandingAttemptArtifact(input.runDir, {
      attempt: 1,
      stage: "applied",
      plan: landingPlanArtifact,
      execution: {
        status: "landed",
        outcome: execution.outcome,
        reason: execution.reason,
        targetHeadBefore,
        targetHeadAfter,
      },
      verification: {
        overallStatus: postLandingVerification.overallStatus,
        commands: postLandingVerification.commands,
        reason: postLandingVerification.reason,
        repairAttempted: postLandingVerification.repairAttempted,
      },
    });
    await markPostLandingVerificationStarted(input, plan, verificationCommands, targetHeadAfter);
    try {
      verificationResult = await rerunLandingVerification(input.mergeCwd, input.verificationPlan, verificationCommands, input.config.runtime.limits?.toolTimeoutMs);
      postLandingVerification = { overallStatus: verificationResult.overallStatus, commands: verificationCommands, repairAttempted };
      if (verificationResult.overallStatus === "failed") {
        const failedCommandNames = verificationResult.commands
          .filter((command) => command.status === "failed")
          .map((command) => command.name);
        // The candidate already landed. If the only failures are baseline debt
        // that was classified ignore + non-retryable before landing, launching
        // a repair agent would be wasted work (its edits could not change the
        // already-landed commit in a meaningful way). Record the honest state
        // instead: landed, with post-landing verification failing on known
        // baseline debt that no repair should chase.
        if (isIgnorableBaselineFailure(input.verificationFailureClassification, failedCommandNames)) {
          repairAttempted = false;
          postLandingVerification = {
            overallStatus: verificationResult.overallStatus,
            commands: verificationCommands,
            reason: "Post-landing verification failed on baseline-unrelated non-retryable debt; repair skipped.",
            repairAttempted: false,
          };
          await appendFactoryRunEvent(input.eventsPath, {
            timestamp: new Date().toISOString(),
            type: "landing.post_verification_repair_skipped",
            data: {
              reason: postLandingVerification.reason,
              commands: verificationCommands,
              failureKind: input.verificationFailureClassification?.kind,
              targetBranch: plan.targetBranch,
              targetHeadAfter,
            },
          });
        } else {
          postLandingVerification = {
            overallStatus: verificationResult.overallStatus,
            commands: verificationCommands,
            reason: "Post-landing verification failed; awaiting recovery decision.",
            repairAttempted: false,
          };
          if (!shouldUseInteractiveRecovery(input.controllerInput) && input.controllerInput.repairExecutor) {
            repairAttempted = await attemptLandingRepair(input.controllerInput, input.goal, input.mergeCwd, verificationResult, input.repairGuidanceText, modelSelection?.model, input.config.runtime.limits);
            if (repairAttempted) {
              verificationResult = await rerunLandingVerification(input.mergeCwd, input.verificationPlan, verificationCommands, input.config.runtime.limits?.toolTimeoutMs);
              postLandingVerification = {
                overallStatus: verificationResult.overallStatus,
                commands: verificationCommands,
                reason: verificationResult.overallStatus === "passed"
                  ? "Post-landing verification passed after repair."
                  : "Post-landing verification failed after repair; recorded as evidence for acceptance.",
                repairAttempted: true,
              };
            }
          }
          const recovery = repairAttempted
            ? { action: "stop" as const, requestId: "" }
            : await landingRecovery(input, "post-landing-verification", "post-landing verification failed", postLandingVerification.reason ?? "Verification failed.", true);
          if (recovery.action === "retry" || recovery.action === "revise") {
            const guidance = [input.repairGuidanceText, recovery.action === "revise" ? recovery.feedback : undefined].filter(Boolean).join("\n\n");
            repairAttempted = await attemptLandingRepair(input.controllerInput, input.goal, input.mergeCwd, verificationResult, guidance, modelSelection?.model, input.config.runtime.limits);
            if (repairAttempted) {
              verificationResult = await rerunLandingVerification(input.mergeCwd, input.verificationPlan, verificationCommands, input.config.runtime.limits?.toolTimeoutMs);
              postLandingVerification = {
                overallStatus: verificationResult.overallStatus,
                commands: verificationCommands,
                reason: verificationResult.overallStatus === "passed"
                  ? "Post-landing verification passed after recovery repair."
                  : "Post-landing verification failed after recovery repair; recorded as evidence for acceptance.",
                repairAttempted: true,
              };
            }
          }
          if (!repairAttempted) {
            postLandingVerification = {
              ...postLandingVerification,
              reason: "Post-landing verification failed; recorded as evidence for acceptance.",
            };
            await appendFactoryRunEvent(input.eventsPath, { timestamp: new Date().toISOString(), type: "landing.post_verification_failed_recorded", data: { reason: postLandingVerification.reason, commands: verificationCommands, targetBranch: plan.targetBranch, targetHeadAfter } });
          }
        }
      }
      await appendFactoryRunEvent(input.eventsPath, {
        timestamp: new Date().toISOString(),
        type: "landing.post_verification_completed",
        data: {
          overallStatus: postLandingVerification.overallStatus,
          commands: verificationCommands,
          reason: postLandingVerification.reason,
          repairAttempted: postLandingVerification.repairAttempted,
          targetBranch: plan.targetBranch,
          targetHeadAfter,
        },
      });
    } catch (error) {
      postLandingVerification = {
        overallStatus: "error",
        commands: verificationCommands,
        reason: `Post-landing verification failed to complete: ${formatError(error)}`,
        repairAttempted,
      };
      await appendFactoryRunEvent(input.eventsPath, {
        timestamp: new Date().toISOString(),
        type: "landing.post_verification_failed",
        data: {
          reason: postLandingVerification.reason,
          commands: verificationCommands,
          targetBranch: plan.targetBranch,
          targetHeadAfter,
        },
      });
    }
  } else if (execution.status !== "skipped") {
    diagnosis = await diagnoseOrFallback({
      executor,
      model: modelSelection?.model,
      plan,
      reason: execution.reason ?? execution.outcome,
      dirtyFiles,
      verification: input.verification,
      limits: input.config.runtime.limits,
    });
    recoveryHint = diagnosis.recoveryHint;
  }

  if (landingStatus === "blocked") {
    await appendFactoryRunEvent(input.eventsPath, { timestamp: new Date().toISOString(), type: "landing.blocked_recorded", data: { reason: recoveryHint ?? execution.reason ?? execution.outcome } });
  }

  const pullRequest = landingStatus === "blocked"
    ? await publishBlockedCandidate(input, recoveryHint ?? execution.reason ?? execution.outcome)
    : undefined;
  if (pullRequest?.status === "created" || pullRequest?.status === "existing") {
    landingStatus = "pull-request";
    recoveryHint = `${pullRequest.reason} ${pullRequest.url ?? ""}`.trim();
  } else if (pullRequest?.status === "failed") {
    recoveryHint = `${recoveryHint ?? "Landing blocked"} PR fallback failed: ${pullRequest.reason}`;
  }

  if (diagnosis) await writePrototypeLandingDiagnosisArtifact(input.runDir, 1, diagnosis);
  await appendPrototypeLandingAttemptArtifact(input.runDir, {
    attempt: 1,
    stage: "finalized",
    plan: landingPlanArtifact,
    execution: {
      status: landingStatus,
      outcome: pullRequest?.status === "created"
        ? "pull-request-created"
        : pullRequest?.status === "existing"
          ? "pull-request-existing"
          : pullRequest?.status === "failed"
            ? "pull-request-failed"
            : diagnosis?.kind ?? execution.outcome,
      reason: recoveryHint,
      targetHeadBefore,
      targetHeadAfter,
    },
    verification: postLandingVerification ?? { overallStatus: verificationResult.overallStatus, commands: verificationCommands, repairAttempted },
    diagnosis,
  });
  return finishLanding(input, landingPlanArtifact, landingStatus, recoveryHint, execution.reason, diagnosis, pullRequest, {
    targetHeadBefore,
    targetHeadAfter,
    postLandingVerification: postLandingVerification
      ? {
          status: postLandingVerification.overallStatus,
          commands: postLandingVerification.commands,
          reason: postLandingVerification.reason,
          repairAttempted: postLandingVerification.repairAttempted,
        }
      : { status: verificationResult.overallStatus, commands: verificationCommands, repairAttempted },
  });
}

async function recordLandingSteps(eventsPath: string, execution: { steps?: Array<{ index: number; args: string[]; status: string; exitCode?: number; stderr?: string }> }): Promise<void> {
  if (!execution.steps) return;
  for (const step of execution.steps) {
    await appendFactoryRunEvent(eventsPath, {
      timestamp: new Date().toISOString(),
      type: step.status === "applied" ? "landing.step_applied" : "landing.step_blocked",
      data: step,
    });
  }
}

async function markPostLandingVerificationStarted(
  input: Parameters<typeof runLandingFlow>[0],
  plan: LandingPlan,
  commands: string[],
  targetHeadAfter?: string,
): Promise<void> {
  if (input.statePath) {
    await updateFactoryRunState({
      statePath: input.statePath,
      patch: { status: "RUNNING", phase: "landing" },
    });
  }
  await appendFactoryRunEvent(input.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "landing.post_verification_started",
    data: {
      commands,
      targetBranch: plan.targetBranch,
      targetHeadAfter,
    },
  });
  await input.controllerInput.onProgress?.({
    runId: input.runId,
    phase: "landing",
    status: "RUNNING",
    message: "Candidate landed; running post-landing verification",
  });
}

async function diagnoseOrFallback(input: {
  executor?: RunFactoryControllerInput["reviewerExecutor"];
  model?: ModelSelection;
  plan: LandingPlan;
  reason: string;
  dirtyFiles: string[];
  verification: VerificationRunResult;
  limits?: EffectiveFactoryConfig["runtime"]["limits"];
}): Promise<PrototypeLandingDiagnosisArtifact> {
  if (!input.model) {
    return buildLocalLandingDiagnosis(input.reason, input.dirtyFiles, input.verification.overallStatus);
  }
  return diagnoseLandingFailure({
    executor: input.executor,
    model: input.model,
    plan: input.plan,
    reason: input.reason,
    dirtyFiles: input.dirtyFiles,
    verification: input.verification,
    limits: input.limits,
  });
}

function buildBlockingLandingPlan(input: Parameters<typeof runLandingFlow>[0], reason: string): LandingPlan {
  return {
    actions: [],
    targetBranch: input.config.git.baseBranch,
    candidateSha: input.candidateSha,
    sourceBranch: input.candidateBranch,
    rationale: reason,
    verification: [],
    risk: "high",
    expectedFiles: input.completedTasks.flatMap((task) => task.changedFiles),
    recoveryPlan: reason,
  };
}

function buildLocalLandingDiagnosis(
  reason: string,
  dirtyFiles: string[],
  verificationStatus: string,
): PrototypeLandingDiagnosisArtifact {
  return {
    kind: dirtyFiles.length > 0
      ? "dirty-target"
      : verificationStatus === "incomplete"
        ? "verification-missing"
        : "unsafe-risk",
    reasoning: [reason],
    retryable: false,
    recoveryAction: "block",
    risk: "high",
    recoveryHint: reason,
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function recordLandingModel(
  input: { runDir: string; runId: string; taskType: string },
  modelSelection: { model: ModelSelection; source: string },
): Promise<void> {
  await appendModelLedgerEntry(input.runDir, {
    operationId: `${input.runId}-landing`,
    nodeId: "landing",
    role: "landing",
    taskType: input.taskType,
    taskTypeSource: "run",
    requestedModel: modelSelection.model.model,
    resolvedModel: modelSelection.model.model,
    provider: modelSelection.model.provider,
    modelSource: modelSelection.source,
  });
}

async function finishBlockedLanding(
  input: Parameters<typeof runLandingFlow>[0],
  plan: PrototypeLandingPlanArtifact,
  diagnosis: PrototypeLandingDiagnosisArtifact,
  reason: string,
  pullRequest?: RecoveryPullRequestResult,
): Promise<LandingResult> {
  await writePrototypeLandingDiagnosisArtifact(input.runDir, 1, diagnosis);
  const blockedHint = pullRequest?.url
    ? `${pullRequest.reason} ${pullRequest.url}`
    : pullRequest?.status === "failed"
      ? `${diagnosis.recoveryHint} PR fallback failed: ${pullRequest.reason}`
      : diagnosis.recoveryHint;
  await appendPrototypeLandingAttemptArtifact(input.runDir, {
    attempt: 1,
    plan,
    execution: {
      status: "blocked",
      outcome: pullRequest?.status === "created" || pullRequest?.status === "existing"
        ? `pull-request-${pullRequest.status}`
        : pullRequest?.status === "failed"
          ? "pull-request-failed"
          : diagnosis.kind,
      reason: blockedHint,
    },
    diagnosis,
  });
  const finalStatus = pullRequest?.status === "created" || pullRequest?.status === "existing"
    ? "pull-request"
    : "blocked";
  return finishLanding(input, plan, finalStatus, blockedHint, reason, diagnosis, pullRequest);
}

async function finishLanding(
  input: Parameters<typeof runLandingFlow>[0],
  plan: PrototypeLandingPlanArtifact,
  landingStatus: LandingResult["landingStatus"],
  recoveryHint: string | undefined,
  reason: string | undefined,
  diagnosis?: PrototypeLandingDiagnosisArtifact,
  pullRequest?: RecoveryPullRequestResult,
  landingEvidence?: {
    targetHeadBefore?: string;
    targetHeadAfter?: string;
    postLandingVerification?: {
      status: "pending" | "passed" | "failed" | "incomplete" | "error";
      commands: string[];
      reason?: string;
      repairAttempted?: boolean;
    };
  },
): Promise<LandingResult> {
  const outcome = pullRequest?.status === "created"
    ? "pull-request-created"
    : pullRequest?.status === "existing"
      ? "pull-request-existing"
      : pullRequest?.status === "failed"
        ? "pull-request-failed"
        : landingStatus === "landed"
        ? "landed"
        : landingStatus === "skipped"
          ? "policy-skipped"
          : mapDiagnosisToOutcome(diagnosis?.kind ?? "unknown");
  const finalMergePath = await writePrototypeFinalMergeArtifact(input.runDir, {
    mergeBaseBranch: input.config.git.baseBranch,
    candidateBranch: input.candidateBranch,
    candidateSha: input.candidateSha,
    mergeCwd: input.mergeCwd,
    targetBranch: plan.targetBranch,
    sourceBranch: plan.sourceBranch,
    strategy: derivedLandingStrategy(plan),
    status: pullRequest?.status === "created"
      ? "pull-request-created"
      : pullRequest?.status === "existing"
        ? "pull-request-existing"
        : landingStatus === "pull-request"
          ? "blocked"
          : landingStatus,
    outcome,
    recoveryHint,
    reason,
    pullRequest,
    targetHeadBefore: landingEvidence?.targetHeadBefore,
    targetHeadAfter: landingEvidence?.targetHeadAfter,
    postLandingVerification: landingEvidence?.postLandingVerification,
  });
  const completed = landingStatus === "landed" || landingStatus === "skipped" || landingStatus === "pull-request";
  return {
    finalMergePath,
    status: completed ? "COMPLETED" : "BLOCKED",
    phase: landingStatus === "pull-request" ? "pull-request-opened" : completed ? "complete" : "merge-blocked",
    approved: completed,
    landingStatus,
    landingAttempts: 1,
    recoveryHint,
    pullRequest,
    targetHeadBefore: landingEvidence?.targetHeadBefore,
    targetHeadAfter: landingEvidence?.targetHeadAfter,
    postLandingVerification: landingEvidence?.postLandingVerification,
  };
}

async function publishBlockedCandidate(
  input: Parameters<typeof runLandingFlow>[0],
  reason: string,
): Promise<RecoveryPullRequestResult | undefined> {
  if (!input.candidateBranch || input.completedTasks.length === 0) {
    return undefined;
  }
  const targetBranch = input.config.git.pullRequest.baseBranch ?? input.config.git.baseBranch;
  if (input.candidateBranch === targetBranch) {
    return {
      status: "failed",
      sourceBranch: input.candidateBranch,
      targetBranch,
      reason: "Cannot create a recovery pull request from the target branch itself; preserve the candidate commit and create a distinct source branch.",
    };
  }
  const result = await createRecoveryPullRequest({
    cwd: input.mergeCwd,
    sourceBranch: input.candidateBranch,
    targetBranch,
    runId: input.runId,
    goal: input.goal,
    reason,
    candidateSha: input.candidateSha ?? input.completedTasks[0]?.commitSha,
    enabled: input.config.git.pullRequest.enabled,
    provider: input.config.git.pullRequest.provider,
    cli: input.config.git.pullRequest.cli,
    draft: input.config.git.pullRequest.draft,
  });
  await appendFactoryRunEvent(input.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "landing.pull_request",
    data: result as unknown as Record<string, unknown>,
  });
  return result;
}

async function buildLandingPlanWithRecovery(
  input: Parameters<typeof runLandingFlow>[0],
  executor: RunFactoryControllerInput["landingExecutor"] | RunFactoryControllerInput["reviewerExecutor"],
  modelSelection: { model: ModelSelection; source: string } | undefined,
  dirtyContext: ReturnType<typeof classifyDirtyFiles>,
  recoveryFeedback?: string,
): Promise<{ plan: LandingPlan; lastRecovery?: FailureRecoveryResolution }> {
  let feedback = recoveryFeedback;
  let lastRecovery: FailureRecoveryResolution | undefined;
  for (;;) {
    const attempt = nextLandingRecoveryAttempt(input, "landing-planner");
    try {
      if (!modelSelection) throw new Error("Landing model was not resolved.");
      const builtPlan = await buildLandingPlan({
          executor,
          model: modelSelection.model,
          goal: input.goal,
          mergeCwd: input.mergeCwd,
          baseBranch: input.config.git.baseBranch,
          finalMergePolicy: input.config.approval.finalMerge,
          dirtyFiles: dirtyContext.all,
          dirtyRelevantFiles: dirtyContext.relevant,
          dirtyUnrelatedFiles: dirtyContext.unrelated,
          completedTasks: input.completedTasks,
          candidateSha: input.candidateSha,
          candidateBranch: input.candidateBranch,
          verification: input.verification,
          verificationFailureClassification: input.verificationFailureClassification,
          limits: input.config.runtime.limits,
          recoveryFeedback: feedback,
          recoveryAttempt: attempt,
        });
      return {
        plan: feedback
          ? { ...builtPlan, rationale: `${builtPlan.rationale}\nRecovery guidance applied: ${feedback.slice(0, 8000)}` }
          : builtPlan,
        lastRecovery,
      };
    } catch (error) {
      const reason = `Landing planner failed: ${formatError(error)}`;
      lastRecovery = await landingRecovery(input, "landing-planner", "landing planner failed", reason, true);
      if (lastRecovery.action !== "retry" && lastRecovery.action !== "revise") {
        return { plan: buildBlockingLandingPlan(input, reason), lastRecovery };
      }
      feedback = lastRecovery.action === "revise" ? lastRecovery.feedback : undefined;
    }
  }
}

async function landingRecovery(
  input: Parameters<typeof runLandingFlow>[0],
  key: string,
  title: string,
  reason: string,
  canRevise: boolean,
): Promise<FailureRecoveryResolution> {
  const attempt = nextLandingRecoveryAttempt(input, key);
  const maxAttempts = input.controllerInput.failureRecovery?.maxAttempts ?? 3;
  if (attempt > maxAttempts || !shouldUseInteractiveRecovery(input.controllerInput)) {
    return { action: "stop", requestId: "" };
  }
  return requestFailureRecovery({
    controllerInput: input.controllerInput,
    runDir: input.runDir,
    statePath: input.statePath ?? path.join(input.runDir, "state.json"),
    eventsPath: input.eventsPath,
    runId: input.runId,
    context: {
      phase: "landing",
      title,
      reason,
      category: key,
      retryable: true,
      canRepair: key === "post-landing-verification" && Boolean(input.controllerInput.repairExecutor),
      canRevise,
      evidenceRefs: [path.join(input.runDir, "landing-plan.json")],
      attempt,
      maxAttempts,
    },
  });
}

function nextLandingRecoveryAttempt(input: Parameters<typeof runLandingFlow>[0], key: string): number {
  input.recoveryAttempts ??= {};
  input.recoveryAttempts[key] = (input.recoveryAttempts[key] ?? 0) + 1;
  return input.recoveryAttempts[key];
}

async function attemptLandingRepair(
  controllerInput: RunFactoryControllerInput,
  goal: string,
  cwd: string,
  verificationResult: VerificationRunResult,
  repairGuidanceText?: string,
  model?: ModelSelection,
  limits?: EffectiveFactoryConfig["runtime"]["limits"],
): Promise<boolean> {
  const repairExecutor = controllerInput.repairExecutor;
  if (!repairExecutor) return false;
  await repairExecutor.execute({
    executionId: `landing-repair-${Date.now()}`,
    cwd,
    prompt: buildRepairPrompt(goal, verificationResult, repairGuidanceText, undefined, classifyLandingRepairReason(cwd, verificationResult)),
    model,
    tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
    limits,
    metadata: { role: "repair", stage: "landing-repair" },
  });
  return true;
}

function classifyLandingRepairReason(cwd: string, result: VerificationRunResult): string | undefined {
  return classifyVerificationFailure({
    plan: {
      cwd,
      cwdResolution: "default-root",
      commands: {},
      selectionSource: "deterministic",
      skill: { id: "landing-repair", version: "1.0.0", mode: "repair", selectionReasons: ["Synthetic landing repair plan."] },
      evidence: { rootCwd: cwd, configuredCommands: {}, allowedCommands: [], rootScripts: [], candidateCwds: [], commandDecisions: [] },
    },
    result,
  })?.reason;
}

async function rerunLandingVerification(cwd: string, plan: VerificationPlan, commandNames: string[], timeoutMs?: number): Promise<VerificationRunResult> {
  return runVerificationCommands({
    cwd,
    commands: pickVerificationCommands(plan.commands, commandNames),
    timeoutMs,
  });
}

function pickVerificationCommands(allCommands: VerificationPlan["commands"], names: string[]): VerificationPlan["commands"] {
  const picked = Object.fromEntries(Object.entries(allCommands).filter(([name]) => names.includes(name)));
  return Object.keys(picked).length > 0 ? picked : allCommands;
}

function resolveVerificationCommands(requested: string[], verificationPlan: VerificationPlan): string[] {
  const available = new Set(Object.keys(verificationPlan.commands));
  const selected = requested.filter((name) => available.has(name));
  return selected.length > 0 ? selected : Object.keys(verificationPlan.commands);
}

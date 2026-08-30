import { appendModelLedgerEntry } from "../runs/model-ledger.js";
import { appendFactoryRunEvent } from "../runs/store.js";
import { buildRepairPrompt } from "./prompts.js";
import { classifyVerificationFailure } from "./failure-classification.js";
import { runVerificationCommands, type VerificationPlan, type VerificationRunResult } from "./verification.js";
import {
  appendPrototypeLandingAttemptArtifact,
  writePrototypeCompletedTasksArtifact,
  writePrototypeFinalMergeArtifact,
  writePrototypeLandingDiagnosisArtifact,
  writePrototypeLandingPlanArtifact,
  type PrototypeCompletedTaskArtifact,
  type PrototypeLandingDiagnosisArtifact,
  type PrototypeLandingPlanArtifact,
} from "./artifacts.js";
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
  validateLandingPlan,
} from "./landing-git.js";
import type { EffectiveFactoryConfig, ModelSelection } from "@factory/schemas";
import type { TaskWorkspaceSelection, RunFactoryControllerInput } from "./controller.js";
import type { LandingPlan, LandingResult } from "./landing-types.js";

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
  goal: string;
  mergeCwd: string;
  taskType: string;
  config: EffectiveFactoryConfig;
  completedTasks: PrototypeCompletedTaskArtifact[];
  candidateSha?: string;
  candidateBranch?: string;
  verificationPlan: VerificationPlan;
  verification: VerificationRunResult;
  contractCanComplete: boolean;
  controllerInput: RunFactoryControllerInput;
  repairGuidanceText?: string;
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
    plan = await buildLandingPlan({
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
    });
  } catch (error) {
    plan = buildBlockingLandingPlan(input, `Landing planner failed: ${formatError(error)}`);
  }
  const guardVerdict = await validateLandingPlan({
    mergeCwd: input.mergeCwd,
    plan,
    dirtyRelevantFiles: dirtyContext.relevant,
    dirtyUnrelatedFiles: dirtyContext.unrelated,
    finalMergePolicy: input.config.approval.finalMerge,
    completedTasks: input.completedTasks,
    verificationStatus: input.verification.overallStatus,
  });
  const landingPlanArtifact: PrototypeLandingPlanArtifact = { ...plan, guardVerdict };
  await writePrototypeLandingPlanArtifact(input.runDir, landingPlanArtifact);
  await appendFactoryRunEvent(input.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "landing.plan_selected",
    data: landingPlanArtifact as unknown as Record<string, unknown>,
  });

  if (!guardVerdict.ok) {
    const diagnosis = await diagnoseOrFallback({
      executor,
      model: modelSelection?.model,
      plan,
      reason: guardVerdict.reasons.join("; "),
      // The guard reasons already name every file they blocked on; handing the
      // diagnoser all dirty files made it mislabel unrelated dirties as the cause.
      dirtyFiles: dirtyContext.relevant,
      verification: input.verification,
    });
    return finishBlockedLanding(input, landingPlanArtifact, diagnosis, guardVerdict.reasons.join("; "));
  }

  const execution = await executeLandingStrategy({ cwd: input.mergeCwd, plan });
  let diagnosis: PrototypeLandingDiagnosisArtifact | undefined;
  let landingStatus: LandingResult["landingStatus"] = execution.status;
  let recoveryHint = execution.reason;
  let verificationResult = input.verification;
  let verificationCommands = Object.keys(input.verificationPlan.commands);

  if (execution.status === "landed") {
    verificationCommands = resolveVerificationCommands(plan.verification, input.verificationPlan);
    verificationResult = await rerunLandingVerification(input.verificationPlan, verificationCommands);
    if (verificationResult.overallStatus === "failed") {
      await attemptLandingRepair(input.controllerInput, input.goal, input.verificationPlan.cwd, verificationResult, input.repairGuidanceText, input.config.models.repair);
      verificationResult = await rerunLandingVerification(input.verificationPlan, verificationCommands);
    }
    if (verificationResult.overallStatus !== "passed" && !input.contractCanComplete) {
      diagnosis = await diagnoseOrFallback({
        executor,
        model: modelSelection?.model,
        plan,
        reason: `Post-landing verification ${verificationResult.overallStatus}`,
        dirtyFiles: [],
        verification: verificationResult,
      });
      landingStatus = "blocked";
      recoveryHint = diagnosis.recoveryHint;
    }
  } else if (execution.status !== "skipped") {
    diagnosis = await diagnoseOrFallback({
      executor,
      model: modelSelection?.model,
      plan,
      reason: execution.reason ?? execution.outcome,
      dirtyFiles,
      verification: input.verification,
    });
    recoveryHint = diagnosis.recoveryHint;
  }

  if (diagnosis) await writePrototypeLandingDiagnosisArtifact(input.runDir, 1, diagnosis);
  await appendPrototypeLandingAttemptArtifact(input.runDir, {
    attempt: 1,
    plan: landingPlanArtifact,
    execution: { status: landingStatus, outcome: diagnosis?.kind ?? execution.outcome, reason: recoveryHint },
    verification: { overallStatus: verificationResult.overallStatus, commands: verificationCommands },
    diagnosis,
  });
  return finishLanding(input, landingPlanArtifact, landingStatus, recoveryHint, execution.reason, diagnosis);
}

async function diagnoseOrFallback(input: {
  executor?: RunFactoryControllerInput["reviewerExecutor"];
  model?: ModelSelection;
  plan: LandingPlan;
  reason: string;
  dirtyFiles: string[];
  verification: VerificationRunResult;
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
  });
}

function buildBlockingLandingPlan(input: Parameters<typeof runLandingFlow>[0], reason: string): LandingPlan {
  return {
    strategy: "block",
    targetBranch: input.config.git.baseBranch,
    candidateSha: input.candidateSha,
    sourceBranch: input.candidateBranch,
    reasoning: [reason],
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
): Promise<LandingResult> {
  await writePrototypeLandingDiagnosisArtifact(input.runDir, 1, diagnosis);
  await appendPrototypeLandingAttemptArtifact(input.runDir, {
    attempt: 1,
    plan,
    execution: { status: "blocked", outcome: diagnosis.kind, reason: diagnosis.recoveryHint },
    diagnosis,
  });
  return finishLanding(input, plan, "blocked", diagnosis.recoveryHint, reason, diagnosis);
}

async function finishLanding(
  input: Parameters<typeof runLandingFlow>[0],
  plan: PrototypeLandingPlanArtifact,
  landingStatus: LandingResult["landingStatus"],
  recoveryHint: string | undefined,
  reason: string | undefined,
  diagnosis?: PrototypeLandingDiagnosisArtifact,
): Promise<LandingResult> {
  const outcome = landingStatus === "landed"
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
    strategy: plan.strategy,
    status: landingStatus,
    outcome,
    recoveryHint,
    reason,
  });
  const completed = landingStatus === "landed" || landingStatus === "skipped";
  return {
    finalMergePath,
    status: completed ? "COMPLETED" : "BLOCKED",
    phase: completed ? "complete" : "merge-blocked",
    approved: completed,
    landingStatus,
    landingAttempts: 1,
    recoveryHint,
  };
}

async function attemptLandingRepair(
  controllerInput: RunFactoryControllerInput,
  goal: string,
  cwd: string,
  verificationResult: VerificationRunResult,
  repairGuidanceText?: string,
  model?: ModelSelection,
): Promise<void> {
  const repairExecutor = controllerInput.repairExecutor;
  if (!repairExecutor) return;
  await repairExecutor.execute({
    executionId: `landing-repair-${Date.now()}`,
    cwd,
    prompt: buildRepairPrompt(goal, verificationResult, repairGuidanceText, undefined, classifyLandingRepairReason(cwd, verificationResult)),
    model,
    tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
    metadata: { role: "repair", stage: "landing-repair" },
  });
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

async function rerunLandingVerification(plan: VerificationPlan, commandNames: string[]): Promise<VerificationRunResult> {
  return runVerificationCommands({
    cwd: plan.cwd,
    commands: pickVerificationCommands(plan.commands, commandNames),
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
